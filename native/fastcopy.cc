/**
 * MetFileSync native copy engine.
 *
 * A Node N-API addon (C++) that performs file copy / move operations with
 * raw OS syscalls and reports progress back into JavaScript.
 *
 * - copy(src, dest, opts, onProgress, onDone) -> jobId
 *     Copies `src` to `dest` on a libuv worker thread.
 *     Fast path: clonefile() on APFS (instant CoW clone, falls back on error).
 *     Normal path: pread/pwrite loop with configurable chunk size.
 *     Progress: onProgress({bytes, total}) delivered on the JS thread
 *     (guaranteed, in order, via AsyncProgressQueueWorker).
 *     Cancellation: cancel(jobId) aborts mid-copy and removes the partial
 *     destination file.
 *     onDone(errMsg|null, result|{cancelled, bytes, total, cloned}|null)
 *
 * - cancel(jobId) -> bool
 * - rename(src, dest)            (rename(2) - atomic replace on POSIX)
 * - unlink(p)                    (unlink(2), tolerant of ENOENT)
 * - mkdirp(p)                    (recursive mkdir(2), tolerant of EEXIST)
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

#include <fcntl.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

#if defined(__APPLE__)
#include <sys/clonefile.h>
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
// Helpers
// ---------------------------------------------------------------------------

std::string errnoMessage(const char* what) {
	char buf[256];
#if defined(_MSC_VER)
	strerror_s(buf, sizeof(buf), errno);
#else
	strerror_r(errno, buf, sizeof(buf));
#endif
	return std::string(what) + ": " + buf;
}

bool writeAll(int fd, const char* buf, size_t len, uint64_t offset, std::string* err) {
	size_t written = 0;
	while (written < len) {
		ssize_t w = ::pwrite(fd, buf + written, len - written, offset + (uint64_t)written);
		if (w < 0) {
			if (errno == EINTR) continue;
			*err = errnoMessage("pwrite");
			return false;
		}
		written += (size_t)w;
	}
	return true;
}

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
		struct stat st{};
		if (::stat(src_.c_str(), &st) != 0) {
			SetError(errnoMessage("stat source"));
			return;
		}
		if (!S_ISREG(st.st_mode)) {
			SetError("source is not a regular file");
			return;
		}
		total_ = (uint64_t)st.st_size;

#if defined(__APPLE__)
		// Fast path: APFS clone (copy-on-write). Falls back silently when the
		// filesystem does not support it.
		if (useClone_ && total_ > 0 && ::clonefile(src_.c_str(), dest_.c_str(), 0) == 0) {
			cloned_ = true;
			done_ = total_;
			ProgressData d{done_, total_};
			progress.Send(&d, 1);
			return;
		}
#endif

		int in = ::open(src_.c_str(), O_RDONLY | O_CLOEXEC);
		if (in < 0) {
			SetError(errnoMessage("open source"));
			return;
		}
		int out = ::open(dest_.c_str(), O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, st.st_mode & 07777);
		if (out < 0) {
			::close(in);
			SetError(errnoMessage("open destination"));
			return;
		}

		std::vector<char> buf(chunkSize_);
		std::string err;
		uint64_t lastReport = 0;
		while (done_ < total_) {
			if (state_->cancelled.load(std::memory_order_acquire)) {
				cancelled_ = true;
				break;
			}
			uint64_t want = total_ - done_;
			if (want > chunkSize_) want = chunkSize_;
			ssize_t r = ::pread(in, buf.data(), (size_t)want, (off_t)done_);
			if (r < 0) {
				if (errno == EINTR) continue;
				err = errnoMessage("pread source");
				break;
			}
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

		::close(in);
		::close(out);

		if (cancelled_ || !err.empty()) {
			// Best-effort removal of the partial destination file.
			::unlink(dest_.c_str());
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

Napi::Value Rename(const Napi::CallbackInfo& info) {
	Napi::Env env = info.Env();
	if (info.Length() < 2 || !info[0].IsString() || !info[1].IsString()) {
		Napi::TypeError::New(env, "rename(src: string, dest: string)").ThrowAsJavaScriptException();
		return env.Undefined();
	}
	std::string src = info[0].As<Napi::String>();
	std::string dest = info[1].As<Napi::String>();
	if (::rename(src.c_str(), dest.c_str()) != 0) {
		Napi::Error::New(env, errnoMessage("rename")).ThrowAsJavaScriptException();
		return env.Undefined();
	}
	return env.Undefined();
}

Napi::Value Unlink(const Napi::CallbackInfo& info) {
	Napi::Env env = info.Env();
	if (info.Length() < 1 || !info[0].IsString()) {
		Napi::TypeError::New(env, "unlink(path: string)").ThrowAsJavaScriptException();
		return env.Undefined();
	}
	std::string p = info[0].As<Napi::String>();
	if (::unlink(p.c_str()) != 0 && errno != ENOENT) {
		Napi::Error::New(env, errnoMessage("unlink")).ThrowAsJavaScriptException();
	}
	return env.Undefined();
}

Napi::Value Mkdirp(const Napi::CallbackInfo& info) {
	Napi::Env env = info.Env();
	if (info.Length() < 1 || !info[0].IsString()) {
		Napi::TypeError::New(env, "mkdirp(path: string)").ThrowAsJavaScriptException();
		return env.Undefined();
	}
	std::string p = info[0].As<Napi::String>();
	if (p.empty()) return env.Undefined();
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
				Napi::Error::New(env, errnoMessage("mkdir")).ThrowAsJavaScriptException();
				return env.Undefined();
			}
		}
		i = next + 1;
	}
	return env.Undefined();
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
	struct timespec times[2];
	times[0].tv_sec = (time_t)(atimeMs / 1000.0);
	times[0].tv_nsec = (long)((atimeMs - (double)times[0].tv_sec * 1000.0) * 1e6);
	times[1].tv_sec = (time_t)(mtimeMs / 1000.0);
	times[1].tv_nsec = (long)((mtimeMs - (double)times[1].tv_sec * 1000.0) * 1e6);
	if (::utimensat(AT_FDCWD, p.c_str(), times, 0) != 0) {
		Napi::Error::New(env, errnoMessage("utimensat")).ThrowAsJavaScriptException();
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
