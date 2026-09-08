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

## Configuration (server-side, never client-supplied)

Resolution order: environment variable → `config.json` in the working
directory → default.

| Setting | Env var | `config.json` key | Default | Meaning |
|---|---|---|---|---|
| Sync root | `METFILESYNC_ROOT` | `root` | `./data/root` | All source/destination directories must live under this |
| Data dir | `METFILESYNC_DATA` | `data` | `./data` | Where `syncsets.json` is stored |
| Native addon | `METFILESYNC_NATIVE` | — | `./native/build/Release/metfilesync_native.node` | Path to the `.node` binary |
| Disable clone | `METFILESYNC_NO_CLONE=1` | — | off | Force the chunked copy loop (progress even on APFS) |

Example `config.json`:

```json
{ "root": "/Volumes/Media/sync-root" }
```

## Using the app

1. Pick or create a sync set (left panel), set the **source directory** and one
   or more **destinations** (paths are relative to the root; use the folder
   icon to browse). Give each destination a **group** if you want ordering.
2. Configure options: datestamp delta (seconds), sync deletions, error policy,
   include/exclude filters.
3. **Save**, then press **Compare**. Review the table; deselect anything you
   don't want.
4. Press **Sync selected** — the Sync tab shows live progress per destination.
   Errors pause the destination and ask how to proceed (unless the policy says
   otherwise). **Stop all** or per-card stop aborts the run and removes temp
   files.

## Development

```sh
npm run dev        # dev server
npm test           # rebuild native addon + run the vitest suite
npm run check      # svelte-check (types)
```

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

## Notes & limitations

- `*` in filters matches any characters, including `/`.
- Only files are synced/deleted; directories are created as needed but empty
  directories are never removed.
- Symlinks are followed (copied as their targets).
- The native addon currently ships macOS (Darwin) and generic POSIX paths; the
  clone fast path is macOS/APFS only and falls back automatically elsewhere.
