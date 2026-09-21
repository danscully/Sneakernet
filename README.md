# Sneakernet

Sneakernet is a dense, dark-themed web app that syncs a directory on the server
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
- **Absolute paths, local-only changes** — every sync set stores absolute
  source/destination paths, chosen on the machine running the server with
  the OS-native directory picker. Only local users (loopback connections:
  the desktop app's webview, the dev browser, the operator at a standalone
  server) may create sets or change their directories; remote LAN users can
  change the other settings only. Old root-relative data is migrated to
  absolute paths once on load.
- **Destination semaphore** — a lock file (`.sneakernet-lock`) at each destination
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
  `native/build/Release/sneakernet_native.node`. The APFS `clonefile` fast
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
| Legacy root | `SNEAKERNET_ROOT` | `root` | `./data/root` | Migration base only: old root-relative sync-set paths are resolved against it once on load. New data is always absolute |
| Data dir | `SNEAKERNET_DATA` | `data` | `./data` | Where `syncsets.json` is stored |
| Native addon | `SNEAKERNET_NATIVE` | — | `./native/build/Release/sneakernet_native.node` | Path to the `.node` binary |
| Disable clone | `SNEAKERNET_NO_CLONE=1` | — | off | Force the chunked copy loop (progress even on APFS) |
| Log retention | `SNEAKERNET_LOG_RETENTION_DAYS` | `logRetentionDays` | `7` | Days sync log files are kept in `data/logs` |

Windows note: `config.json` is read from the working directory of the server
process, same as macOS/Linux.

Example `config.json`:

```json
{
  "logRetentionDays": 7
}
```

## Using the app

1. Pick a sync set from the header dropdown (or **Create New SyncSet...** below
   the divider in that dropdown — local users only; remote users cannot
   create sets). The left sidebar summarizes the set; press **Edit** to open
   the settings modal and set the **source directory** and **destinations**
   (absolute paths; the folder icon opens the OS-native directory picker —
   available only to local users; remote users see the directories read-only
   and can change the other settings). Give each destination a **group** if
   you want ordering.
2. Configure options: datestamp delta (seconds), sync deletions, error policy,
   include/exclude filters.
3. Press **Compare**. Review the **File List** table (sortable by Name, Path,
   Size, Modified); deselect anything you don't want.
4. Press **Sync Selected** (green when ready). If a destination would be left
   with under 1 GB free, a warning dialog appears first. Errors pause the
   destination and ask how to proceed (unless the policy says otherwise);
   a per-run **Stop** (or per-card stop) aborts the run and removes temp
   files.
5. The **Status** tab shows **every** sync of this server — every sync set
   and every user (including remote LAN users), running or finished. Each
   run is separated by a divider and shows its sync set name, when it
   started (and when it finished), live per-destination progress, and a
   running/done/stopped badge. Finished runs stay until you press
   **Clear completed** (which never touches running syncs and updates every
   connected user's view).
6. Every run is logged — the **Logs** tab shows the current session's runs
   (newest first) or all recent runs, with the full text of each log. Log
   lines are tab-delimited (`timestamp \t destination \t action \t path \t
   statistics`) with destination names, and status lines only appear when a
   destination's status actually changes — so logs paste cleanly into a
   spreadsheet.

## Desktop app (Tauri) — distribution

The app ships as a native desktop application (Option A of
[DeployProposal.md](DeployProposal.md)):

- a Tauri shell (`desktop/src-tauri`) launches the bundled **Node runtime**
  with the adapter-node **server** as a hidden background process, then opens
  the UI in a native window;
- per-user data lives in the OS application-support directory
  (`~/Library/Application Support/com.sneakernet.desktop` on macOS,
  `%APPDATA%\com.sneakernet.desktop` on Windows): `app-data/` holds sync
  sets and logs (`sync-root/` remains as the legacy migration base);
- closing the window **quits the whole app**: a native confirmation dialog
  warns first that quitting stops the sync engine and any in-progress syncs
  (**Quit** / **Cancel**). Cmd+Q and the Dock's Quit confirm the same way;
  the tray's Quit item (whose label states the consequence) exits
  immediately — and if the shell is ever killed abruptly, a stdin watchdog
  makes the server exit on its own;
- only one instance can run (a second launch focuses the existing window);
- the webview navigates to the embedded server exactly once on startup and
  once per settings change (no reload loops);
- **diagnostics**: the shell and the embedded server log to
  `<app-data>/logs/shell.log` (macOS:
  `~/Library/Application Support/com.sneakernet.desktop/logs/shell.log`,
  Windows: `%APPDATA%\com.sneakernet.desktop\logs\shell.log`). Startup,
  server output/errors, restarts and shutdown are recorded there - this is
  the first place to look when the window sits on the loading page. The log
  rotates to `shell.log.old` at 1 MiB. (Sync-run logs are separate:
  `<app-data>/app-data/logs/`, viewable in the app's Logs tab.)

### Building locally (macOS)

Prerequisites: Xcode Command Line Tools, the Rust toolchain
(`curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y`),
and `npm i` in the project root. Then:

```sh
npm run desktop:build
```

This builds the web app + native addon, assembles `desktop/src-tauri/resources/`
(server bundle **with a pruned production `node_modules/`** — the SSR bundle
keeps `package.json` `dependencies` external, so they ship inside the app —
plus `sneakernet_native.node`, and a standalone Node runtime —
downloaded from nodejs.org and cached in `desktop/.node-cache/`; set
`SNEAKERNET_NODE_RUNTIME_DIR` to use a local Node binary instead), and runs
`tauri build`. The outputs are:

- `desktop/src-tauri/target/release/bundle/macos/Sneakernet.app`
- `desktop/src-tauri/target/release/bundle/dmg/Sneakernet_<version>_aarch64.dmg`

**Run the app from `/Applications`** (copy the built `.app` there), not from
the project directory: macOS TCC restricts apps that execute from inside
`~/Documents`, so a build launched from there pops a one-time "would like to
access files in your Documents folder" prompt per rebuilt binary (and the
server would otherwise resolve packages from the project's `node_modules`).

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

### Desktop Settings (app only) & LAN access for remote users (opt-in)

The embedded server binds **localhost only** by default. The **Desktop
Settings** dialog — opened with the cog/monitor icon in the app window's
header — manages the machine's settings:

- **Allow access from other devices**: when enabled, the server restarts
  bound to all interfaces on a stable port (default **8787**, editable next
  to the switch, with an automatic fallback if the port is taken);
- **Access link**: `http://<lan-address>:<port>/?token=<token>` is shown in
  the dialog (selectable to copy) and in the Sync Set settings dialog —
  every request must present the **access token** (a persistent random token
  generated on first run); the UI and API accept `?token=...` once and then
  exchange it for an `sneakernet_token` cookie, so remote users just open the link;
- **Apply** persists the settings to `<app-data>/desktop-settings.json`;
  the shell watches that file and restarts the server within ~1s (applying
  settings aborts any sync in flight — leftover `.sneakernet-tmp-` files are ignored
  by future compares and overwritten by the next sync).

The Desktop Settings dialog and its `/api/desktop/*` endpoints are visible
and usable **only inside the app window** (loopback + desktop mode);
remote users — even with the access link — get a 403 and cannot change the
port or LAN sharing. Likewise, creating sync sets and changing a set's
source/destination directories is limited to local (loopback) users —
remote users may edit the other settings only, and `/api/space` answers
only for paths registered as a sync destination, so remote users cannot
probe arbitrary disks. Remote users also see the "Sneakernet"
page title, which is hidden in the app window (the window title already
shows it).

Security notes: the link grants full control of syncs on the machine (same
app, no per-user accounts) — share it only on networks and with people you
trust. macOS will ask once to allow incoming connections for the bundled
Node runtime; on Windows allow Sneakernet through Windows Firewall when
prompted.


### Type-checking Windows code from macOS

The shell has Windows-only code paths (cfg'd out on macOS, so `cargo check`
cannot see them). From macOS, run:

```sh
npm run desktop:check-windows
```

to type-check the `x86_64-pc-windows-msvc` target locally (requires
`rustup target add x86_64-pc-windows-msvc` and `brew install llvm` for
`llvm-rc`; no linking is performed). Run it before pushing Windows-touching
shell changes - it catches cfg(windows) compile errors that would otherwise
only surface in CI.

### Making a release (macOS + Windows)

Releases are built by CI — no local Windows machine needed. The workflow
([.github/workflows/desktop-build.yml](.github/workflows/desktop-build.yml))
runs on every `v*` tag push: `macos-latest` (arm64) produces the `.dmg` +
`.app`, `windows-latest` (x64) produces the MSI + NSIS `.exe`, and the
installers are attached to a **draft GitHub Release** for that tag.

Steps:

1. **One-time** — push the repo to GitHub (`git remote add origin <url>` +
   `git push -u origin main`) and confirm the workflow file landed on `main`.
2. Bump the version **everywhere it appears** (keep them in sync):
   `package.json`, `desktop/src-tauri/tauri.conf.json`, and
   `desktop/src-tauri/Cargo.toml` (all `0.1.0` today).
3. Commit, then tag and push the tag:
   ```sh
   git tag v0.1.0
   git push origin main --tags
   ```
4. Watch the **Actions** tab: both jobs build (~5–10 min), then a draft
   release named after the tag appears under **Releases** with the
   `Sneakernet_<version>_aarch64.dmg`, `.msi`, and `.exe` installers
   attached. Write the release notes and hit **Publish**.

Notes:

- Installers are **unsigned** until signing secrets are configured. macOS
  users must right-click the app → Open (or run
  `xattr -cr /Applications/Sneakernet.app`) the first time; Windows shows a
  SmartScreen prompt (More info → Run anyway). To sign instead: add the
  `APPLE_CERTIFICATE`/`APPLE_ID` (+ related) secrets for macOS signing &
  notarization, and a Windows code-signing certificate — the workflow picks
  them up automatically.
- Raw artifacts are also downloadable from each workflow run (Actions → run →
  Artifacts), including the macOS `.app` bundle.
- A build can also be triggered manually (Actions → Desktop builds → Run
  workflow) without creating a release.

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
  config.ts               data dir + legacy root resolution
  paths.ts                absolute-path validation (+ legacy root-relative helpers)
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
src/lib/components/       app components (CompareTable, DestCard,
                          ConfirmDialog, SyncSetEditor; PathPicker retained
                          but unused) + shadcn-svelte UI kit
src/routes/api/            REST endpoints + /api/sync/stream (SSE)
tests/                    vitest suites: native addon, filters, paths, compare,
                          engine (copy/delete/errors/stops/groups), persistence
```

### API surface

| Method & path | Purpose |
|---|---|
| `GET/POST /api/syncsets` | list / create (POST: local users only) |
| `GET/PUT/DELETE /api/syncsets/[id]` | fetch / update (path changes: local users only) / delete |
| `POST /api/compare` | run a Compare (returns the plan) |
| `GET /api/compare?setId=` | fetch the latest plan |
| `POST /api/sync/start` | start syncing a selection |
| `POST /api/sync/stop` | stop one destination (`destId`) or all (`null`) |
| `POST /api/sync/confirm` | answer a pause prompt |
| `GET /api/sync/stream?setId=` | SSE event stream (+ initial snapshot) |
| `GET /api/tree?path=` | directory listing under the legacy root (unused path picker, retained) |
| `POST /api/tree` | create a subdirectory under the legacy root (retained) |
| `GET /api/config` | read-only server info (LAN link, desktop/local client flags) |
| `GET /api/space?path=` | free/total space of a registered destination (nearest existing ancestor) |
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
