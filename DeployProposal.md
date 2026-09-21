# Sneakernet — End-User Deployment Proposal

**Audience:** non-technical end users. The deployment experience should be as
easy as installing a normal desktop app: download, double-click, done. No
terminal, no Node.js, no manual native-module compilation.

## Constraints that shape the proposal

1. The app is a **local web app**: a SvelteKit server (Node) + browser UI +
   a **native addon** (`sneakernet_native.node`) that must match the host
   OS/architecture (macOS arm64/x64, Windows x64, potentially Linux).
2. The native addon cannot be shipped as a single cross-platform binary —
   it must be **prebuilt per platform** and bundled with the installer
   (N-API/Node-API guarantees binary compatibility across Node versions, so
   one build per OS/arch is enough).
3. The per-user **data directory** (sync sets, logs) must live in a
   user-writable, per-user location — never inside the app bundle. (Sync
   sources/destinations are ordinary absolute folders the user picks per
   sync set with the native directory picker; there is no app-owned
   "sync root" anymore.)

## Recommendation (in order of preference)

### Option A — Desktop app shell (recommended) — IMPLEMENTED

**Status:** the Tauri shell is implemented in `desktop/` and builds locally
(`npm run desktop:build` on macOS; see the README "Desktop app (Tauri)"
section). Remaining for a production launch: code signing + notarization
secrets in CI.

Package the existing Node server + the UI as a desktop application using
**Tauri** (preferred) or **Electron**:

> LAN sharing is implemented as an opt-in feature of the Tauri shell: the
> in-app Desktop Settings dialog (loopback-only, never accessible to remote
> users) can expose the embedded server to the network on a stable port
> (default 8787) behind a token-protected shareable access link. The server
> binds localhost only when sharing is off. Directory picking is done with
> the OS-native chooser in the app window; remote users cannot change
> directories.

- The server runs as a **hidden background process** (sidecar) started by the
  shell; the UI opens in the shell's webview instead of the system browser
  (looks and behaves like a native app).
- Ship **prebuilt native addons** for each supported platform
  (`prebuilds/darwin-arm64/`, `prebuilds/win32-x64/`, …). At startup the
  loader (`src/lib/server/native.ts`) picks the one matching the current OS.
  No user ever compiles anything.
- **Installers:** `.dmg` (with drag-to-Applications) for macOS,
  `.msi`/`.exe` (NSIS or WiX) for Windows. Code-sign both (Apple Developer ID
  + notarization; Windows Authenticode) so installers don't scare users with
  security warnings.
- ~~**First-run wizard:**~~ no longer needed — there is no sync root to
  choose; the user picks ordinary folders per sync set in the app. (Earlier
  versions asked where the sync root should live; that concept was
  removed in favor of absolute, native-picked directories.)
- **Auto-update:** built-in updater (Tauri updater / electron-updater /
  Squirrel) so users never re-download installs. Updates ship new server
  code and new prebuilt addons together — they always match.
- **Tray presence** while the app runs (open/quit items); closing the window
  quits the whole app behind a native confirmation that warns about
  in-progress syncs. Start on login (opt-in checkbox in settings).

**Tauri vs Electron tradeoff:** Tauri produces ~10 MB installers and uses
the OS webview, but needs a Node sidecar process (Tauri's shell is Rust;
Node runs as a child process — a well-supported pattern). Electron is a
single runtime (Node built-in), larger (~100 MB) and heavier in memory, but
mature and simpler to wire. For this app either works; choose Tauri if
download size and memory matter most, Electron if development speed and
ecosystem maturity matter most.

### Option B — Single self-contained executable

Compile the server into one native executable using **Bun's `--compile`**
(or `pkg`/Node SEA) and drive the UI through the user's default browser:

- One file per platform, e.g. `Sneakernet-macOS-arm64`,
  `Sneakernet-Windows-x64.exe`.
- On first run it opens the browser at `http://localhost:<port>` (with a
  fixed port + tray/menu-bar helper to re-open and quit).
- Native addon still needs to be prebuilt per platform and embedded in the
  executable (Bun supports embedding; `pkg` requires packaging assets).
- Distribution is trivially simple ("download & run"), but the browser-based
  UX is weaker (no tray, awkward app identity, port conflicts), and macOS
  Gatekeeper makes unsigned binaries painful. **Best as a companion to
  Option A** (e.g. for NAS/advanced users), not as the primary path.

### Option C — Appliance / NAS / server deployment (secondary)

For users who want Sneakernet running on a NAS or home server:

- Provide a **Docker image** (`ghcr.io/…/sneakernet`) with the native addon
  prebuilt for linux/amd64+arm64, a volume for the data dir (sync sets and
  logs); synced source/destination folders are bind-mounted host paths.
- Provide a one-click **Compose template** and, ideally, an app package for
  the common consumer NAS platforms (Synology DSM Package Center, QNAP
  Qstore) — this is what non-technical NAS users expect.
- This path targets a smaller but loyal audience; it should not block Option A.

## Recommended rollout plan

1. **CI builds for every commit:** build the native addon on the three
   targets (macos-latest, windows-latest, ubuntu-latest) plus `npm run build`
   for the web app. Artifacts are already separated
   (`native/build/Release/sneakernet_native.node`).
2. **Add a prebuilds loader:** extend `native.ts` to try
   `native/prebuilds/<platform>-<arch>/sneakernet_native.node` before the
   local build (this also lets developers run without a C++ toolchain).
3. **Pick the shell (Tauri recommended)**, wrap the existing server
   (`node build/index.js` equivalent), embed prebuilds, implement the
   first-run wizard and auto-updater.
4. **Installer production:** GitHub Releases carrying
   `Sneakernet-x.y.z-arm64.dmg`, `Sneakernet-Setup-x.y.z.exe` (and the
   plain server bundle as a zip for Option B users). Sign and notarize in CI.
5. **Update channel:** publish the app version + a release feed for the
   updater; keep sync-set JSON fully backward compatible (it already is —
   unknown fields are ignored, ids are stable).
6. **Telemetry-free crash reporting:** optional "send logs" button that
   exports the sync logs the app already keeps (respecting the retention
   setting) — valuable for supporting non-technical users without a
   monitoring backend.

## Why not "just host it"?

A cloud-hosted web app would be the simplest install (just a URL) but is
the wrong architecture: the app exists to move files **on the user's own
machine** with native-speed copies, and users' media libraries are exactly
what they don't want in the cloud. Keep the app local; the web stack stays
exactly as it is today.

## Summary table

| Option | Install UX | Effort | Size | Best for |
|---|---|---|---|---|
| A. Tauri/Electron shell | Double-click installer, auto-updates | Medium | 10–100 MB | **Primary recommendation** |
| B. Single executable | Download & run | Low–Medium | ~50 MB | Advanced users, NAS-adjacent |
| C. Docker/NAS package | App store one-click (NAS UIs) | Medium | image | Home-server users |
