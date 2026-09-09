# MetFileSync

MetFileSync is a dense, dark-themed web app that syncs a directory on the server
to other directories **on the same server**, as fast as the filesystem allows.
Files are compared by **size and datestamp within a configurable delta**, and
copies are performed by a **native C++ Node addon** (raw `pread`/`pwrite` or an
APFS `clonefile` fast path) with progress streamed back into the UI.

## Features

- **Two-phase workflow** — *Compare* examines every destination in parallel and
  lists exactly what would happen (copy / delete / create dir). *Sync* then
  executes only what you selected.
  - Per-file: name, path, size, modified date.
  - Deselect a row to exclude it everywhere; deselect a single cell to exclude
    it for one destination only.
  - Files added to the source after the Compare never sync.
  - If a source file changed since the Compare, you are asked to confirm.
- **Fast native copies** — N-API addon with chunked copy loop, progress
  callbacks into JavaScript, mid-file cancellation, temp-file + atomic rename,
  and timestamp preservation so re-compares come back clean.
- **Sync Sets** — savable as JSON, switchable from the header, import/export
  as `.syncset.json` files.
- **Sync deletions** option — remove destination files that vanished from the
  source.
- **Include / Exclude filters** — partial paths with `*` wildcards; a filter
  matching a directory matches its whole subtree; excludes apply after includes.
- **Error policies** — stop on error / ignore all errors / ask user (pauses the
  destination; then stop, skip, or ignore-all).
- **Groups** — each destination belongs to a group 1–10. Groups run in
  numerical order; destinations in the same group sync in parallel.
- **Live progress** — per destination: current file, rolling MB/s, elapsed,
  remaining time, copied / remaining bytes, progress bar, files done/total.
  Stop buttons per destination and for the whole run. Stopping cleans up
  temp files.
- **Path safety** — all directories live under a single root path from the
  server deployment config; user-entered paths are sanitized and cannot escape
  it.
- **Destination semaphore** — a lock file (`.mfs-lock`) at each destination
  root prevents two syncs from targeting the same directory at once. The
  holder touches it every 5 seconds; a sync that finds a lock reports
  "waiting" and, after 10 seconds without a touch, breaks it as stale.
- **Free-space preflight** — before a sync starts, the transfer size is
  compared against each destination's free space; if a destination would end
  with less than 1 GB free, a warning dialog asks before proceeding. The
  sidebar shows live free space per destination.
- **Sync logs** — every run writes a timestamped log (file copies, deletions,
  skips, errors, lock waits). View the last run or all runs in the Logs tab;
  logs are pruned after a configurable retention (default 7 days).
- **Sortable file list** — click Name / Path / Size / Modified to sort
  (click again to reverse; a third click returns to plan order).

## Quick start

```sh
npm install
npm run build:native   # compile the native addon (requires Xcode tools / a C++ toolchain)
npm run seed           # optional: demo content + a demo sync set
npm run dev            # http://localhost:5173
```

Production build & run:

```sh
npm run build           # builds native addon + SvelteKit app
node build              # adapter-node server (PORT env, default 3000)
```

#### Building the native addon per platform

`npm run build:native` compiles the addon for the machine you run it on —
native modules cannot be cross-compiled from one OS to another, so build on
each target platform (or in CI).

- **macOS** (arm64 / x64): requires Xcode Command Line Tools
  (`xcode-select --install`). `npm run build:native` produces
  `native/build/Release/metfilesync_native.node`. The APFS `clonefile` fast
  path is used automatically when the filesystem supports it.
- **Windows** (x64): requires Visual Studio Build Tools 2022 (the
  "Desktop development with C++" workload) and Python 3 (node-gyp uses it).
  Then:
  ```powershell
  npm run build:native
  ```
  The addon is written against the same N-API v8 on both platforms: the copy
  loop uses positioned `ReadFile`/`WriteFile` on Windows and `pread`/`pwrite`
  on POSIX; rename/delete/mkdir/timestamp calls map to their Win32
  equivalents (`MoveFileEx`, `DeleteFileW`, `CreateDirectoryW`, `SetFileTime`).
  Note that `node-gyp` needs the msvs toolchain on `PATH`; if Visual Studio
  is installed for the current user, run the build from a
  "Developer Command Prompt" or `npm config set msvs_version 2022`.
- **Linux** (optional): needs a C++17 toolchain (`build-essential` /
  `g++`); the POSIX path is shared with macOS minus clonefile.

## Configuration (server-side, never client-supplied)

Resolution order: environment variable → `config.json` in the working
directory → default.

| Setting | Env var | `config.json` key | Default | Meaning |
|---|---|---|---|---|
| Sync root | `METFILESYNC_ROOT` | `root` | `./data/root` | All source/destination directories must live under this |
| Data dir | `METFILESYNC_DATA` | `data` | `./data` | Where `syncsets.json` is stored |
| Native addon | `METFILESYNC_NATIVE` | — | `./native/build/Release/metfilesync_native.node` | Path to the `.node` binary |
| Disable clone | `METFILESYNC_NO_CLONE=1` | — | off | Force the chunked copy loop (progress even on APFS) |
| Log retention | `METFILESYNC_LOG_RETENTION_DAYS` | `logRetentionDays` | `7` | Days sync log files are kept in `data/logs` |

Windows note: `config.json` is read from the working directory of the server
process, same as macOS/Linux.

Example `config.json`:

```json
{
  "root": "/Volumes/Media/sync-root",
  "logRetentionDays": 7
}
```

## Using the app

1. Pick a sync set from the header dropdown (or **Create New SyncSet...** below
   the divider in that dropdown). The left sidebar summarizes the set; press
   **Edit** to open the settings modal and set the **source directory** and
   **destinations** (paths are relative to the root; the folder icon browses
   and can create new subdirectories). Give each destination a **group** if
   you want ordering.
2. Configure options: datestamp delta (seconds), sync deletions, error policy,
   include/exclude filters.
3. Press **Compare**. Review the **File List** table (sortable by Name, Path,
   Size, Modified); deselect anything you don't want.
4. Press **Sync Selected** (green when ready). If a destination would be left
   with under 1 GB free, a warning dialog appears first. The **In Progress**
   tab shows live per-destination progress; it only exists while a run is
   active. Errors pause the destination and ask how to proceed (unless the
   policy says otherwise). **Stop all** or per-card stop aborts the run and
   removes temp files.
5. Every run is logged — the **Logs** tab shows the current session's runs
   (newest first) or all recent runs, with the full text of each log.

## Desktop app (Tauri) — distribution

The app ships as a native desktop application (Option A of
[DeployProposal.md](DeployProposal.md)):

- a Tauri shell (`desktop/src-tauri`) launches the bundled **Node runtime**
  with the adapter-node **server** as a hidden background process, then opens
  the UI in a native window;
- per-user data lives in the OS application-support directory
  (`~/Library/Application Support/com.metfilesync.desktop` on macOS,
  `%APPDATA%\com.metfilesync.desktop` on Windows): `sync-root/` is the sync
  root, `app-data/` holds sync sets and logs;
- closing the window hides to the tray (syncs keep running); **Quit** in the
  tray menu stops the server and exits — and if the shell is ever killed
  abruptly, a stdin watchdog makes the server exit on its own;
- only one instance can run (a second launch focuses the existing window).

### Building locally (macOS)

Prerequisites: Xcode Command Line Tools, the Rust toolchain
(`curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y`),
and `npm i` in the project root. Then:

```sh
npm run desktop:build
```

This builds the web app + native addon, assembles `desktop/src-tauri/resources/`
(server bundle, `metfilesync_native.node`, and a standalone Node runtime —
downloaded from nodejs.org and cached in `desktop/.node-cache/`; set
`MFS_NODE_RUNTIME_DIR` to use a local Node binary instead), and runs
`tauri build`. The outputs are:

- `desktop/src-tauri/target/release/bundle/macos/MetFileSync.app`
- `desktop/src-tauri/target/release/bundle/dmg/MetFileSync_<version>_aarch64.dmg`

To cross-prepare Windows resources on a Mac (e.g. for inspection):
`node scripts/prepare-desktop.mjs --platform win32 --arch x64`.

### Building for Windows

Native addons cannot be cross-compiled, so build on Windows with
**Visual Studio Build Tools 2022** (C++ workload), Python 3 and the Rust
toolchain installed:

```powershell
npm ci
npm run desktop:build
# -> desktop/src-tauri/target/release/bundle/{msi,nsis}/
```

### LAN access for remote users (opt-in)

The embedded server binds **localhost only** by default. The tray menu offers
**"Allow access from other devices"**:

- when enabled, the server restarts bound to all interfaces on a stable port
  (default **8787**; configurable via `lanPort` in
  `<app-data>/desktop-settings.json`, with an automatic fallback if the port
  is taken);
- every request must present the **access token** (a persistent random token
  generated on first run) — the UI and API accept `?token=...` once and then
  exchange it for an `mfs_token` cookie, so remote users just open the
  **access link**;
- **"Copy network access link"** in the tray copies
  `http://<lan-address>:8787/?token=<token>` to the clipboard, and the link is
  also shown in the Sync Set settings dialog ("Network access");
- toggling sharing restarts the server (it aborts any sync in flight —
  leftover `.mfs-tmp-` files are ignored by future compares and overwritten
  by the next sync).

Security notes: the link grants full control of syncs on the machine (same
app, no per-user accounts) — share it only on networks and with people you
trust. macOS will ask once to allow incoming connections for the bundled
Node runtime; on Windows allow MetFileSync through Windows Firewall when
prompted.

### CI builds (macOS + Windows)

[.github/workflows/desktop-build.yml](.github/workflows/desktop-build.yml)
builds signed-ready artifacts on `macos-latest` (arm64 .dmg) and
`windows-latest` (MSI + NSIS .exe) on every `v*` tag push, uploading a draft
GitHub Release with the installers. Add `APPLE_CERTIFICATE`/`APPLE_ID`
and a Windows code-signing certificate as repository secrets to enable
signing + notarization.

## Development

```sh
npm run dev        # dev server
npm test           # rebuild native addon + run the vitest suite
npm run check      # svelte-check (types)
```

### Notes on the vendored UI kit

The shadcn-svelte components in `src/lib/components/ui/` are vendored from the
official registry (the `shadcn-svelte` CLI `add` command). A few of them target
a newer bits-ui major than what is installed here; their state variants were
adjusted to the `data-state` attributes that bits-ui v2 sets at runtime
(checkbox, switch, tabs, select, dialog, scroll-area).

### Architecture

```
native/fastcopy.cc        N-API addon: copy (chunked pread/pwrite + clonefile fast
                          path), cancel, rename, unlink, mkdirp, utimes, progress
                          callbacks via AsyncProgressQueueWorker
src/lib/server/
  native.ts               typed wrapper around the addon
  config.ts               root/data dir resolution
  paths.ts                path sanitization (root confinement)
  filters.ts              include/exclude pattern matching (* wildcards)
  walker.ts               directory walker used by Compare
  compare.ts              parallel Compare planner
  engine.ts               SyncManager: grouped runner, temp files, error policy,
                          confirmations, event bus
  syncsets.ts             validation + JSON persistence of sync sets
  space.ts                free-space accounting (pre-sync warning + sidebar)
  logger.ts               per-run sync log files + retention cleanup
src/lib/types.ts          shared client/server types
src/lib/state.svelte.ts   client state (Svelte 5 runes) + SSE handling
src/lib/components/       app components (CompareTable, DestCard, PathPicker,
                          ConfirmDialog, SyncSetEditor) + shadcn-svelte UI kit
src/routes/api/            REST endpoints + /api/sync/stream (SSE)
tests/                    vitest suites: native addon, filters, paths, compare,
                          engine (copy/delete/errors/stops/groups), persistence
```

### API surface

| Method & path | Purpose |
|---|---|
| `GET/POST /api/syncsets` | list / create |
| `GET/PUT/DELETE /api/syncsets/[id]` | fetch / update / delete |
| `POST /api/compare` | run a Compare (returns the plan) |
| `GET /api/compare?setId=` | fetch the latest plan |
| `POST /api/sync/start` | start syncing a selection |
| `POST /api/sync/stop` | stop one destination (`destId`) or all (`null`) |
| `POST /api/sync/confirm` | answer a pause prompt |
| `GET /api/sync/stream?setId=` | SSE event stream (+ initial snapshot) |
| `GET /api/tree?path=` | directory listing under the root (path picker) |
| `POST /api/tree` | create a subdirectory (path picker "Create") |
| `GET /api/config` | read-only server info (sync root path) |
| `GET /api/space?path=` | free/total space of a directory (nearest existing ancestor) |
| `GET /api/logs` | list sync run logs (newest first, with retention info) |
| `GET /api/logs/[runId]` | full text of one sync run log |

## Notes & limitations

- `*` in filters matches any characters, including `/`.
- Only files are synced/deleted; directories are created as needed but empty
  directories are never removed.
- Symlinks are followed (copied as their targets).
- The native addon supports macOS (POSIX + APFS clonefile fast path), Linux
  (POSIX) and Windows (Win32); the clone fast path is macOS-only and falls
  back to the chunked copy loop automatically elsewhere.
