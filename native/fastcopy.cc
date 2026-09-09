/**
 * MetFileSync native copy engine.
 *
 * A Node N-API addon (C++) that performs file copy / move operations with
 * raw OS syscalls and reports progress back into JavaScript.
 *
 * Cross-platform: POSIX (macOS/Linux) and Windows (Win32). The copy loop uses
 * pread/pwrite on POSIX and positioned ReadFile/WriteFile on Windows.
 * The clonefile fast path is macOS/APFS only and falls back automatically.
 *
 * - copy(src, dest, opts, onProgress, onDone) -> jobId
 *     Copies `src` to `dest` on a libuv worker thread.
 *     Fast path: clonefile() on APFS (instant CoW clone, falls back on error).
 *     Normal path: chunked positioned read/write loop.
 *     Progress: onProgress({bytes, total}) delivered on the JS thread
 *     (guaranteed, in order, via AsyncProgressQueueWorker).
 *     Cancellation: cancel(jobId) aborts mid-copy and removes the partial
 *     destination file.
 *     onDone(errMsg|null, result|{cancelled, bytes, total, cloned}|null)
 *
 * - cancel(jobId) -> bool
 * - rename(src, dest)            (rename(2) / MoveFileEx REPLACE_EXISTING)
 * - unlink(p)                    (unlink(2) / DeleteFileW, tolerant of missing)
 * - mkdirp(p)                    (recursive mkdir)
 * - utimes(p, atimeMs, mtimeMs)  (timestamp preservation)
 */

#include <napi.h>

#include <atomic>
#include <cerrno>
#include <cstdio>
#include <cstring>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>

#if defined(_WIN32)

#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#include <sys/stat.h>
#include <sys/types.h>

#else  // POSIX

#include <fcntl.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>
#if defined(__APPLE__)
#include <sys/clonefile.h>
#endif

#endif

namespace {

// ---------------------------------------------------------------------------
// Job registry (for cancellation)
// ---------------------------------------------------------------------------

struct CopyState {
	std::atomic<bool> cancelled{false};
};

std::mutex g_registryMutex;
std::unordered_map<uint32_t, std::shared_ptr<CopyState>> g_registry;
std::atomic<uint32_t> g_nextJobId{1};

void registerJob(uint32_t id, std::shared_ptr<CopyState> state) {
	std::lock_guard<std::mutex> lock(g_registryMutex);
	g_registry[id] = std::move(state);
}

std::shared_ptr<CopyState> findJob(uint32_t id) {
	std::lock_guard<std::mutex> lock(g_registryMutex);
	auto it = g_registry.find(id);
	return it == g_registry.end() ? nullptr : it->second;
}

void unregisterJob(uint32_t id) {
	std::lock_guard<std::mutex> lock(g_registryMutex);
	g_registry.erase(id);
}

// ---------------------------------------------------------------------------
// Platform layer
// ---------------------------------------------------------------------------

#if defined(_WIN32)

typedef HANDLE FileHandle;

static std::wstring toWide(const std::string& s) {
	if (s.empty()) return std::wstring();
	int len = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), (int)s.size(), nullptr, 0);
	std::wstring w((size_t)len, L'\0');
	MultiByteToWideChar(CP_UTF8, 0, s.c_str(), (int)s.size(), &w[0], len);
	return w;
}

static std::string winError(const char* what) {
	char buf[256];
	snprintf(buf, sizeof(buf), "%s: Windows error %lu", what, (unsigned long)GetLastError());
	return std::string(buf);
}

static bool fileSize(const std::string& p, uint64_t& out, uint32_t& modeOut, std::string* err) {
	struct _stat64 st{};
	if (_wstat64(toWide(p).c_str(), &st) != 0) {
		if (err) *err = winError("stat source");
		return false;
	}
	out = (uint64_t)st.st_size;
	modeOut = 0;  // Windows: attributes are not POSIX modes
	return true;
}

static bool openSource(const std::string& p, FileHandle& out, std::string* err) {
	HANDLE h = CreateFileW(toWide(p).c_str(), GENERIC_READ,
	                       FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL,
	                       OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_SEQUENTIAL_SCAN, NULL);
	if (h == INVALID_HANDLE_VALUE) {
		if (err) *err = winError("open source");
		return false;
	}
	out = h;
	return true;
}

static bool createDest(const std::string& p, FileHandle& out, std::string* err) {
	HANDLE h = CreateFileW(toWide(p).c_str(), GENERIC_WRITE, 0, NULL,
	                       CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
	if (h == INVALID_HANDLE_VALUE) {
		if (err) *err = winError("open destination");
		return false;
	}
	out = h;
	return true;
}

static void closeFile(FileHandle h) {
	CloseHandle(h);
}

/** Positioned read; returns bytes read (0 = EOF), or -1 on error. */
static int64_t readChunk(FileHandle h, char* buf, uint64_t len, uint64_t offset, std::string* err) {
	OVERLAPPED ov{};
	ov.Offset = (DWORD)(offset & 0xFFFFFFFFull);
	ov.OffsetHigh = (DWORD)(offset >> 32);
	DWORD got = 0;
	if (!ReadFile(h, buf, (DWORD)len, &got, &ov)) {
		// Reading at/after EOF returns FALSE with ERROR_HANDLE_EOF and got == 0.
		if (GetLastError() == ERROR_HANDLE_EOF) return 0;
		if (err) *err = winError("ReadFile source");
		return -1;
	}
	return (int64_t)got;
}

static bool writeAll(FileHandle h, const char* buf, size_t len, uint64_t offset, std::string* err) {
	size_t written = 0;
	while (written < len) {
		OVERLAPPED ov{};
		ov.Offset = (DWORD)((offset + written) & 0xFFFFFFFFull);
		ov.OffsetHigh = (DWORD)((offset + written) >> 32);
		DWORD put = 0;
		if (!WriteFile(h, buf + written, (DWORD)(len - written), &put, &ov) || put == 0) {
			if (err) *err = winError("WriteFile destination");
			return false;
		}
		written += put;
	}
	return true;
}

static bool renameFile(const std::string& src, const std::string& dest, std::string* err) {
	if (!MoveFileExW(toWide(src).c_str(), toWide(dest).c_str(),
	                 MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) {
		if (err) *err = winError("rename");
		return false;
	}
	return true;
}

static bool unlinkFile(const std::string& p, std::string* err) {
	if (!DeleteFileW(toWide(p).c_str())) {
		DWORD e = GetLastError();
		if (e != ERROR_FILE_NOT_FOUND && e != ERROR_PATH_NOT_FOUND) {
			if (err) *err = winError("unlink");
			return false;
		}
	}
	return true;
}

static bool isDirectory(const std::string& p) {
	DWORD a = GetFileAttributesW(toWide(p).c_str());
	return a != INVALID_FILE_ATTRIBUTES && (a & FILE_ATTRIBUTE_DIRECTORY) != 0;
}

static bool makeDirs(const std::string& p, std::string* err) {
	if (p.empty()) return true;
	// Normalize separators and create each segment (drive letters included).
	std::string cur;
	size_t i = 0;
	// Skip a UNC prefix or drive letter so it is not passed to CreateDirectory.
	if (p.size() >= 2 && p[1] == ':') {
		cur = p.substr(0, 2);
		i = 2;
	} else if (p.size() >= 2 && p[0] == '\\' && p[1] == '\\') {
		size_t next = p.find('\\', 2);
		if (next == std::string::npos) return true;  // bare UNC prefix
		next = p.find('\\', next + 1);
		if (next == std::string::npos) return true;  // no share path yet
		cur = p.substr(0, next);
		i = next;
	}
	while (i < p.size()) {
		size_t next = p.find_first_of("\\/", i);
		if (next == std::string::npos) next = p.size();
		if (next > i) {
			if (!cur.empty() && cur.back() != '\\' && cur.back() != '/') cur += '\\';
			cur.append(p, i, next - i);
			if (!isDirectory(cur)) {
				if (!CreateDirectoryW(toWide(cur).c_str(), NULL)) {
					if (GetLastError() != ERROR_ALREADY_EXISTS) {
						if (err) *err = winError("mkdir");
						return false;
					}
				}
			}
		}
		i = next + 1;
	}
	return true;
}

static bool setTimes(const std::string& p, double atimeMs, double mtimeMs, std::string* err) {
	// Windows FILETIME: 100ns intervals since 1601-01-01.
	const uint64_t EPOCH_DIFF_100NS = 116444736000000000ull;
	uint64_t a = (uint64_t)(atimeMs * 10000.0) + EPOCH_DIFF_100NS;
	uint64_t m = (uint64_t)(mtimeMs * 10000.0) + EPOCH_DIFF_100NS;
	FILETIME fa{}, fm{};
	fa.dwLowDateTime = (DWORD)(a & 0xFFFFFFFFull);
	fa.dwHighDateTime = (DWORD)(a >> 32);
	fm.dwLowDateTime = (DWORD)(m & 0xFFFFFFFFull);
	fm.dwHighDateTime = (DWORD)(m >> 32);
	HANDLE h = CreateFileW(toWide(p).c_str(), FILE_WRITE_ATTRIBUTES,
	                       FILE_SHARE_READ | FILE_SHARE_WRITE, NULL, OPEN_EXISTING,
	                       FILE_ATTRIBUTE_NORMAL, NULL);
	if (h == INVALID_HANDLE_VALUE) {
		if (err) *err = winError("utimes open");
		return false;
	}
	bool ok = SetFileTime(h, &fa, NULL, &fm) != 0;
	CloseHandle(h);
	if (!ok && err) *err = winError("utimes");
	return ok;
}

#else  // POSIX

typedef int FileHandle;  // -1 = invalid

static std::string errnoMessage(const char* what) {
	char buf[256];
#if defined(_MSC_VER)
	strerror_s(buf, sizeof(buf), errno);
#else
	strerror_r(errno, buf, sizeof(buf));
#endif
	return std::string(what) + ": " + buf;
}

static bool fileSize(const std::string& p, uint64_t& out, uint32_t& modeOut, std::string* err) {
	struct stat st{};
	if (::stat(p.c_str(), &st) != 0) {
		if (err) *err = errnoMessage("stat source");
		return false;
	}
	if (!S_ISREG(st.st_mode)) {
		if (err) *err = "source is not a regular file";
		return false;
	}
	out = (uint64_t)st.st_size;
	modeOut = (uint32_t)st.st_mode & 07777;
	return true;
}

static bool openSource(const std::string& p, FileHandle& out, std::string* err) {
	int fd = ::open(p.c_str(), O_RDONLY | O_CLOEXEC);
	if (fd < 0) {
		if (err) *err = errnoMessage("open source");
		return false;
	}
	out = fd;
	return true;
}

static bool createDest(const std::string& p, mode_t mode, FileHandle& out, std::string* err) {
	int fd = ::open(p.c_str(), O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, mode);
	if (fd < 0) {
		if (err) *err = errnoMessage("open destination");
		return false;
	}
	out = fd;
	return true;
}

static void closeFile(FileHandle h) {
	::close(h);
}

static int64_t readChunk(FileHandle h, char* buf, uint64_t len, uint64_t offset, std::string* err) {
	ssize_t r = ::pread(h, buf, (size_t)len, (off_t)offset);
	if (r < 0) {
		if (errno == EINTR) return -2;  // retry
		if (err) *err = errnoMessage("pread source");
		return -1;
	}
	return (int64_t)r;
}

static bool writeAll(FileHandle h, const char* buf, size_t len, uint64_t offset, std::string* err) {
	size_t written = 0;
	while (written < len) {
		ssize_t w = ::pwrite(h, buf + written, len - written, offset + (uint64_t)written);
		if (w < 0) {
			if (errno == EINTR) continue;
			if (err) *err = errnoMessage("pwrite destination");
			return false;
		}
		written += (size_t)w;
	}
	return true;
}

static bool renameFile(const std::string& src, const std::string& dest, std::string* err) {
	if (::rename(src.c_str(), dest.c_str()) != 0) {
		if (err) *err = errnoMessage("rename");
		return false;
	}
	return true;
}

static bool unlinkFile(const std::string& p, std::string* err) {
	if (::unlink(p.c_str()) != 0 && errno != ENOENT) {
		if (err) *err = errnoMessage("unlink");
		return false;
	}
	return true;
}

static bool makeDirs(const std::string& p, std::string* err) {
	if (p.empty()) return true;
	std::string cur;
	size_t i = 0;
	if (p[0] == '/') {
		cur = "/";
		i = 1;
	}
	while (i < p.size()) {
		size_t next = p.find('/', i);
		if (next == std::string::npos) next = p.size();
		if (next > i) {
			if (!cur.empty() && cur.back() != '/') cur += '/';
			cur.append(p, i, next - i);
			if (::mkdir(cur.c_str(), 0777) != 0 && errno != EEXIST) {
				if (err) *err = errnoMessage("mkdir");
				return false;
			}
		}
		i = next + 1;
	}
	return true;
}

static bool setTimes(const std::string& p, double atimeMs, double mtimeMs, std::string* err) {
	struct timespec times[2];
	times[0].tv_sec = (time_t)(atimeMs / 1000.0);
	times[0].tv_nsec = (long)((atimeMs - (double)times[0].tv_sec * 1000.0) * 1e6);
	times[1].tv_sec = (time_t)(mtimeMs / 1000.0);
	times[1].tv_nsec = (long)((mtimeMs - (double)times[1].tv_sec * 1000.0) * 1e6);
	if (::utimensat(AT_FDCWD, p.c_str(), times, 0) != 0) {
		if (err) *err = errnoMessage("utimensat");
		return false;
	}
	return true;
}

#endif  // platform

// ---------------------------------------------------------------------------
// Copy worker
// ---------------------------------------------------------------------------

struct ProgressData {
	uint64_t bytes;
	uint64_t total;
};

class CopyWorker final : public Napi::AsyncProgressQueueWorker<ProgressData> {
public:
	CopyWorker(Napi::Env env,
	           Napi::Function onProgress,
	           Napi::Function onDone,
	           std::string src,
	           std::string dest,
	           uint64_t chunkSize,
	           uint64_t reportEveryBytes,
	           bool useClone,
	           uint32_t jobId,
	           std::shared_ptr<CopyState> state)
		: Napi::AsyncProgressQueueWorker<ProgressData>(env, "MetFileSyncCopy"),
		  onProgress_(Napi::Persistent(onProgress)),
		  onDone_(Napi::Persistent(onDone)),
		  src_(std::move(src)),
		  dest_(std::move(dest)),
		  chunkSize_(chunkSize == 0 ? (8u << 20) : chunkSize),
		  reportEveryBytes_(reportEveryBytes == 0 ? (32u << 20) : reportEveryBytes),
		  useClone_(useClone),
		  jobId_(jobId),
		  state_(std::move(state)) {}

	void Execute(const ExecutionProgress& progress) override {
		uint64_t total = 0;
		uint32_t srcMode = 0644;
		std::string err;

		if (!fileSize(src_, total, srcMode, &err)) {
			SetError(err);
			return;
		}
		total_ = total;

#if defined(__APPLE__)
		// Fast path: APFS clone (copy-on-write). Falls back silently when the
		// filesystem does not support it.
		if (useClone_ && total > 0 && ::clonefile(src_.c_str(), dest_.c_str(), 0) == 0) {
			cloned_ = true;
			done_ = total;
			ProgressData d{done_, total_};
			progress.Send(&d, 1);
			return;
		}
#endif

		FileHandle in;
		if (!openSource(src_, in, &err)) {
			SetError(err);
			return;
		}
		FileHandle out;
#if defined(_WIN32)
		if (!createDest(dest_, out, &err)) {
#else
		if (!createDest(dest_, (mode_t)srcMode, out, &err)) {
#endif
			closeFile(in);
			SetError(err);
			return;
		}

		std::vector<char> buf(chunkSize_);
		uint64_t lastReport = 0;
		while (done_ < total_) {
			if (state_->cancelled.load(std::memory_order_acquire)) {
				cancelled_ = true;
				break;
			}
			uint64_t want = total - done_;
			if (want > chunkSize_) want = chunkSize_;
			int64_t r = readChunk(in, buf.data(), (size_t)want, done_, &err);
			if (r == -2) continue;  // EINTR - retry
			if (r < 0) break;
			if (r == 0) {
				err = "source file was truncated during copy";
				break;
			}
			if (!writeAll(out, buf.data(), (size_t)r, done_, &err)) break;
			done_ += (uint64_t)r;

			if (done_ - lastReport >= reportEveryBytes_ || done_ == total_) {
				ProgressData d{done_, total_};
				progress.Send(&d, 1);
				lastReport = done_;
			}
		}

		closeFile(in);
		closeFile(out);

		if (cancelled_ || !err.empty()) {
			// Best-effort removal of the partial destination file.
			std::string unlinkErr;
			unlinkFile(dest_, &unlinkErr);
			if (!err.empty()) SetError(err);
		}
	}

	void OnProgress(const ProgressData* data, size_t count) override {
		Napi::HandleScope scope(Env());
		(void)count;
		Napi::Object obj = Napi::Object::New(Env());
		obj.Set("bytes", Napi::Number::New(Env(), (double)data->bytes));
		obj.Set("total", Napi::Number::New(Env(), (double)data->total));
		onProgress_.Call({obj});
		if (Env().IsExceptionPending()) {
			// A throwing progress callback must not kill the copy; log and continue.
			Napi::Error caught = Env().GetAndClearPendingException();
			fprintf(stderr, "MetFileSync native: onProgress callback threw: %s\n",
			        caught.Message().c_str());
		}
	}

	void OnOK() override {
		Napi::HandleScope scope(Env());
		unregisterJob(jobId_);
		Napi::Object res = Napi::Object::New(Env());
		res.Set("cancelled", Napi::Boolean::New(Env(), cancelled_));
		res.Set("bytes", Napi::Number::New(Env(), (double)done_));
		res.Set("total", Napi::Number::New(Env(), (double)total_));
		res.Set("cloned", Napi::Boolean::New(Env(), cloned_));
		callDone(nullptr, res);
	}

	void OnError(const Napi::Error& e) override {
		Napi::HandleScope scope(Env());
		unregisterJob(jobId_);
		callDone(e.Message().c_str(), Env().Null());
	}

private:
	void callDone(const char* err, Napi::Value result) {
		Napi::Value errVal =
			err != nullptr ? static_cast<Napi::Value>(Napi::String::New(Env(), err))
			               : static_cast<Napi::Value>(Env().Null());
		onDone_.Call({errVal, result});
		if (Env().IsExceptionPending()) {
			// A throwing done-callback is a programming error upstream; do not
			// bring the process down, but surface it on the console.
			Napi::Error caught = Env().GetAndClearPendingException();
			fprintf(stderr, "MetFileSync native: onDone callback threw: %s\n",
			        caught.Message().c_str());
		}
	}

	Napi::FunctionReference onProgress_;
	Napi::FunctionReference onDone_;
	std::string src_;
	std::string dest_;
	uint64_t chunkSize_;
	uint64_t reportEveryBytes_;
	bool useClone_;
	uint32_t jobId_;
	std::shared_ptr<CopyState> state_;

	uint64_t total_ = 0;
	uint64_t done_ = 0;
	bool cancelled_ = false;
	bool cloned_ = false;
};

// ---------------------------------------------------------------------------
// Exported functions
// ---------------------------------------------------------------------------

Napi::Value Copy(const Napi::CallbackInfo& info) {
	Napi::Env env = info.Env();
	if (info.Length() < 5 ||
	    !info[0].IsString() || !info[1].IsString() ||
	    !info[2].IsObject() || !info[3].IsFunction() || !info[4].IsFunction()) {
		Napi::TypeError::New(env, "copy(src: string, dest: string, opts: object, onProgress: fn, onDone: fn)")
			.ThrowAsJavaScriptException();
		return env.Undefined();
	}
	std::string src = info[0].As<Napi::String>();
	std::string dest = info[1].As<Napi::String>();
	Napi::Object opts = info[2].As<Napi::Object>();
	uint64_t chunkSize = 0;
	uint64_t reportEveryBytes = 0;
	bool useClone = true;
	if (opts.Has("chunkSize")) {
		Napi::Value v = opts.Get("chunkSize");
		if (v.IsNumber()) chunkSize = (uint64_t)v.As<Napi::Number>().Int64Value();
	}
	if (opts.Has("reportEveryBytes")) {
		Napi::Value v = opts.Get("reportEveryBytes");
		if (v.IsNumber()) reportEveryBytes = (uint64_t)v.As<Napi::Number>().Int64Value();
	}
	if (opts.Has("useClone") && opts.Get("useClone").IsBoolean()) {
		useClone = opts.Get("useClone").As<Napi::Boolean>();
	}

	uint32_t jobId = g_nextJobId.fetch_add(1);
	auto state = std::make_shared<CopyState>();
	registerJob(jobId, state);

	auto* worker = new CopyWorker(env, info[3].As<Napi::Function>(), info[4].As<Napi::Function>(),
	                              std::move(src), std::move(dest), chunkSize, reportEveryBytes,
	                              useClone, jobId, state);
	worker->Queue();
	return Napi::Number::New(env, jobId);
}

Napi::Value Cancel(const Napi::CallbackInfo& info) {
	Napi::Env env = info.Env();
	if (info.Length() < 1 || !info[0].IsNumber()) {
		Napi::TypeError::New(env, "cancel(jobId: number)").ThrowAsJavaScriptException();
		return env.Undefined();
	}
	uint32_t jobId = info[0].As<Napi::Number>().Uint32Value();
	auto state = findJob(jobId);
	if (!state) return Napi::Boolean::New(env, false);
	state->cancelled.store(true, std::memory_order_release);
	return Napi::Boolean::New(env, true);
}

/** Helper: run a void boolean-style native op and throw on error. */
template <bool (*OpFn)(const std::string&, const std::string&, std::string*)>
Napi::Value TwoPathOp(const Napi::CallbackInfo& info) {
	Napi::Env env = info.Env();
	if (info.Length() < 2 || !info[0].IsString() || !info[1].IsString()) {
		Napi::TypeError::New(env, "expected (src: string, dest: string)")
			.ThrowAsJavaScriptException();
		return env.Undefined();
	}
	std::string err;
	if (!OpFn(info[0].As<Napi::String>(), info[1].As<Napi::String>(), &err)) {
		Napi::Error::New(env, err).ThrowAsJavaScriptException();
	}
	return env.Undefined();
}

Napi::Value Rename(const Napi::CallbackInfo& info) {
	return TwoPathOp<renameFile>(info);
}

/** Helper for single-path void ops. */
template <bool (*OpFn1)(const std::string&, std::string*)>
Napi::Value OnePathOp(const Napi::CallbackInfo& info) {
	Napi::Env env = info.Env();
	if (info.Length() < 1 || !info[0].IsString()) {
		Napi::TypeError::New(env, "expected (path: string)").ThrowAsJavaScriptException();
		return env.Undefined();
	}
	std::string err;
	if (!OpFn1(info[0].As<Napi::String>(), &err)) {
		Napi::Error::New(env, err).ThrowAsJavaScriptException();
	}
	return env.Undefined();
}

Napi::Value Unlink(const Napi::CallbackInfo& info) {
	return OnePathOp<unlinkFile>(info);
}

Napi::Value Mkdirp(const Napi::CallbackInfo& info) {
	return OnePathOp<makeDirs>(info);
}

Napi::Value Utimes(const Napi::CallbackInfo& info) {
	Napi::Env env = info.Env();
	if (info.Length() < 3 || !info[0].IsString() || !info[1].IsNumber() || !info[2].IsNumber()) {
		Napi::TypeError::New(env, "utimes(path: string, atimeMs: number, mtimeMs: number)")
			.ThrowAsJavaScriptException();
		return env.Undefined();
	}
	std::string p = info[0].As<Napi::String>();
	double atimeMs = info[1].As<Napi::Number>().DoubleValue();
	double mtimeMs = info[2].As<Napi::Number>().DoubleValue();
	std::string err;
	if (!setTimes(p, atimeMs, mtimeMs, &err)) {
		Napi::Error::New(env, err).ThrowAsJavaScriptException();
	}
	return env.Undefined();
}

Napi::Object InitAll(Napi::Env env, Napi::Object exports) {
	exports.Set("copy", Napi::Function::New(env, Copy));
	exports.Set("cancel", Napi::Function::New(env, Cancel));
	exports.Set("rename", Napi::Function::New(env, Rename));
	exports.Set("unlink", Napi::Function::New(env, Unlink));
	exports.Set("mkdirp", Napi::Function::New(env, Mkdirp));
	exports.Set("utimes", Napi::Function::New(env, Utimes));
	return exports;
}

}  // namespace

NODE_API_MODULE(metfilesync_native, InitAll)
