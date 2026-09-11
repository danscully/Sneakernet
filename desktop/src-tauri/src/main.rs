// Sneakernet desktop shell (Option A, DeployProposal.md).
//
// The shell launches the bundled Node runtime with the adapter-node server
// (resources/server) as a hidden child process, waits until it accepts
// connections, then navigates the main webview to the local server URL
// exactly once.
// Per-user data lives under the OS application-support directory:
//   <app-data>/sync-root     - default sync root (SNEAKERNET_ROOT)
//   <app-data>/app-data      - sync sets / logs (SNEAKERNET_DATA)
//   <app-data>/desktop-settings.json - this app's settings
// Closing the window quits the whole app: a native confirmation dialog
// warns first (quitting stops the embedded server and any in-progress
// syncs). Cmd+Q and the Dock's Quit confirm the same way; the tray's Quit
// (whose label states the consequence) and the dialog's own Quit exit
// immediately. The tray offers Open/Quit while the app runs.
//
// LAN sharing (opt-in, off by default): configured in the in-app Desktop
// Settings dialog (loopback-only endpoints in the web app). When enabled,
// the server binds 0.0.0.0 on a stable port and requires an access token
// (shareable link); when disabled, it binds 127.0.0.1 only.
//
// The server gets the settings file path via SNEAKERNET_DESKTOP_SETTINGS
// and writes changes there (from the Desktop Settings dialog). A watcher
// thread polls the file; whenever its contents change, the shell restarts
// the server child with the new binding/root and re-navigates the window.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs::{self, File};
use std::io::Write;
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream, UdpSocket};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{
    menu::{Menu, MenuBuilder, MenuItem, PredefinedMenuItem, SubmenuBuilder},
    tray::TrayIconBuilder,
    AppHandle, Manager, RunEvent,
};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

// ---------------------------------------------------------------- logging --

/// Everything the shell and the embedded server print is written to
/// `<app-data>/logs/shell.log` so GUI installs (Windows in particular has no
/// console) can be diagnosed. Lines are mirrored to stdout for `cargo run`.
static LOGGER: OnceLock<Mutex<File>> = OnceLock::new();

/// Rotate the log once it exceeds this size (the previous run is kept as
/// shell.log.old).
const LOG_MAX_BYTES: u64 = 1 << 20;

fn init_logging(app_data: &Path) {
    let dir = app_data.join("logs");
    if fs::create_dir_all(&dir).is_err() {
        return; // fall back to stdout-only logging
    }
    let path = dir.join("shell.log");
    let oversized = fs::metadata(&path).map(|m| m.len() > LOG_MAX_BYTES).unwrap_or(false);
    if oversized {
        let _ = fs::remove_file(dir.join("shell.log.old"));
        let _ = fs::rename(&path, dir.join("shell.log.old"));
    }
    if let Ok(file) = fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = LOGGER.set(Mutex::new(file));
        logln(&format!(
            "Sneakernet shell starting (pid {})",
            std::process::id()
        ));
    }
}

/// Append one line to the log (and stdout, where a console exists).
fn logln(line: &str) {
    println!("[shell] {line}");
    if let Some(logger) = LOGGER.get() {
        if let Ok(mut file) = logger.lock() {
            let _ = file.write_all(format!("[{ts}] {line}\n", ts = timestamp()).as_bytes());
        }
    }
}

/// UTC timestamp `YYYY-MM-DDThh:mm:ssZ` (no chrono dependency needed).
fn timestamp() -> String {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    let secs = now.as_secs();
    let (days, rem) = (secs / 86_400, secs % 86_400);
    // civil_from_days (Howard Hinnant) - calendar date from a day count
    let z = days as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 - doe / 36524 + doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + if month <= 2 { 1 } else { 0 };
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

/// Shared shell state.
struct AppState {
    child: Mutex<Option<Child>>,
    settings: Mutex<DesktopSettings>,
    port: Mutex<u16>,
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopSettings {
    lan_sharing: bool,
    lan_port: u16,
    access_token: String,
    /// Absolute path of the sync root; None = <app-data>/sync-root.
    #[serde(default)]
    root_directory: Option<String>,
}

impl Default for DesktopSettings {
    fn default() -> Self {
        Self {
            lan_sharing: false,
            lan_port: 8787,
            access_token: String::new(),
            root_directory: None,
        }
    }
}

// ---------------------------------------------------------------- helpers --

/// Pick a free localhost port.
fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .expect("cannot bind localhost")
        .local_addr()
        .expect("cannot read local address")
        .port()
}

/// The machine's LAN IPv4 address (no packets are sent for UDP connect).
fn lan_ip() -> Option<Ipv4Addr> {
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("8.8.8.8:80").ok()?;
    match socket.local_addr() {
        Ok(SocketAddr::V4(addr)) => Some(*addr.ip()),
        _ => None,
    }
}

/// Random hex token (32 chars) for the LAN access link.
fn generate_token() -> String {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).expect("no system randomness available");
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Hide the console window on Windows.
#[cfg(windows)]
fn hide_console(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn hide_console(_cmd: &mut Command) {}

/// Wait until the server accepts TCP connections (up to `timeout`).
fn wait_for_server(port: u16, timeout: Duration) -> bool {
    let start = Instant::now();
    loop {
        if TcpStream::connect(("127.0.0.1", port)).is_ok() {
            return true;
        }
        if start.elapsed() > timeout {
            return false;
        }
        thread::sleep(Duration::from_millis(150));
    }
}

fn settings_path(app_data: &Path) -> PathBuf {
    app_data.join("desktop-settings.json")
}

fn load_settings(app_data: &Path) -> DesktopSettings {
    let mut settings = std::fs::read_to_string(settings_path(app_data))
        .ok()
        .and_then(|raw| serde_json::from_str::<DesktopSettings>(&raw).ok())
        .unwrap_or_default();
    if settings.access_token.is_empty() {
        settings.access_token = generate_token();
        let _ = save_settings(app_data, &settings);
    }
    settings
}

fn save_settings(app_data: &Path, settings: &DesktopSettings) -> std::io::Result<()> {
    let raw = serde_json::to_string_pretty(settings).expect("serialize settings");
    std::fs::write(settings_path(app_data), raw)
}

/// The effective sync root for the given settings (created if missing).
fn effective_root(app_data: &Path, settings: &DesktopSettings) -> PathBuf {
    let root = settings
        .root_directory
        .as_deref()
        .filter(|p| !p.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| app_data.join("sync-root"));
    let _ = std::fs::create_dir_all(&root);
    root
}

/// The full access link remote users open (only meaningful when sharing).
fn lan_url(settings: &DesktopSettings, port: u16) -> String {
    let ip = lan_ip().unwrap_or(Ipv4Addr::LOCALHOST);
    format!("http://{ip}:{port}/?token={}", settings.access_token)
}

/// The URL the local webview uses.
fn boot_url(settings: &DesktopSettings, port: u16) -> String {
    if settings.lan_sharing {
        // Same guard as remote users: pass the token once; the server
        // exchanges it for a cookie.
        format!("http://127.0.0.1:{port}/?token={}", settings.access_token)
    } else {
        format!("http://127.0.0.1:{port}")
    }
}

// ------------------------------------------------------------- server proc --

/// Start (or restart) the server child process and navigate the window to it.
fn spawn_server(handle: &AppHandle) {
    let state = handle.state::<AppState>();
    let app_data = handle
        .path()
        .app_data_dir()
        .expect("cannot resolve the app data directory");

    // Stop any previous instance (settings changes restart the server).
    if let Some(mut previous) = state.child.lock().unwrap().take() {
        logln("stopping the previous server instance");
        let _ = previous.kill();
        let _ = previous.wait();
    }

    let settings = state.settings.lock().unwrap().clone();
    let (host, port) = if settings.lan_sharing {
        // Stable port when possible; fall back to a free one if taken.
        let port = if TcpListener::bind(("0.0.0.0", settings.lan_port)).is_ok() {
            settings.lan_port
        } else {
            let fallback = free_port();
            logln(&format!(
                "port {} is busy - using {fallback} instead",
                settings.lan_port
            ));
            fallback
        };
        ("0.0.0.0", port)
    } else {
        // Localhost only: nothing on the network can reach the server.
        ("127.0.0.1", free_port())
    };

    let resources = handle
        .path()
        .resource_dir()
        .expect("cannot resolve the resources directory");
    let node = resources
        .join("runtime")
        .join(if cfg!(windows) { "node.exe" } else { "node" });
    let server_dir = resources.join("server");
    let wrapper = server_dir.join("server-wrapper.mjs");
    let addon = resources.join("native").join("sneakernet_native.node");
    let sync_root = effective_root(&app_data, &settings);
    let server_data = app_data.join("app-data");
    let _ = std::fs::create_dir_all(&server_data);

    let mut cmd = Command::new(&node);
    // The wrapper watches stdin: if the shell dies without a chance to kill
    // the server, the pipe closes and the server exits itself.
    cmd.arg(&wrapper)
        .env("PORT", port.to_string())
        .env("HOST", host)
        .env("NODE_ENV", "production")
        .env("SNEAKERNET_ROOT", &sync_root)
        .env("SNEAKERNET_DATA", &server_data)
        .env("SNEAKERNET_NATIVE", &addon)
        // Lets the server read/write desktop settings (Desktop Settings
        // dialog) and know it is running under this shell.
        .env("SNEAKERNET_DESKTOP_SETTINGS", settings_path(&app_data))
        .current_dir(&server_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if settings.lan_sharing {
        cmd.env("SNEAKERNET_ACCESS_TOKEN", &settings.access_token);
        cmd.env("SNEAKERNET_LAN_URL", lan_url(&settings, port));
    }
    hide_console(&mut cmd);

    logln(&format!(
        "starting server: {} (host {host}, port {port}, root {})",
        wrapper.display(),
        sync_root.display()
    ));
    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(err) => {
            logln(&format!("cannot start the Sneakernet server process: {err}"));
            panic!("cannot start the Sneakernet server process: {err}");
        }
    };
    logln(&format!("server child spawned (pid {})", child.id()));

    // Capture the server's output into the shell log (it is also the only
    // place server crashes - e.g. module resolution errors - become visible
    // on GUI installs).
    if let Some(out) = child.stdout.take() {
        thread::spawn(move || {
            use std::io::{BufRead, BufReader};
            for line in BufReader::new(out).lines().flatten() {
                logln(&format!("[server] {line}"));
            }
        });
    }
    if let Some(err) = child.stderr.take() {
        thread::spawn(move || {
            use std::io::{BufRead, BufReader};
            for line in BufReader::new(err).lines().flatten() {
                logln(&format!("[server:err] {line}"));
            }
        });
    }

    *state.child.lock().unwrap() = Some(child);
    *state.port.lock().unwrap() = port;

    // Navigate the window to the app once the server is up. The first eval
    // performs the navigation (or, after a same-port restart, a deliberate
    // one-time reload); every later eval is idempotent: it only navigates
    // when the page is not already served by this server instance, so the
    // retries (which only guard against the eval being lost during the
    // placeholder page's load) never cause additional reloads.
    //
    // The comparison uses the origin, not the full URL: with LAN sharing
    // on, the boot URL carries ?token=..., and the server redirects to a
    // clean URL right after - a full-URL check would re-navigate forever.
    let window = handle
        .get_webview_window("main")
        .expect("main window is declared in tauri.conf.json");
    let url = boot_url(&settings, port);
    let origin = format!("http://127.0.0.1:{port}");
    let url_for_nav = url.clone();
    let origin_check = origin.clone();
    thread::spawn(move || {
        if !wait_for_server(port, Duration::from_secs(60)) {
            logln("server did not become ready within 60s - the window will stay on the loading page; check for [server:err] lines above");
            return;
        }
        logln(&format!("server ready on port {port} - navigating the window"));
        for i in 0..10 {
            let script = if i == 0 {
                format!("window.location.replace({url_for_nav:?});")
            } else {
                format!(
                    "if (window.location.origin !== {origin_check:?}) \
                     window.location.replace({url_for_nav:?});"
                )
            };
            let _ = window.eval(&script);
            thread::sleep(Duration::from_millis(300));
        }
    });
}

// ------------------------------------------------------------ quit confirm --

/// Ask the user to confirm quitting (a native dialog attached to the main
/// window). Any in-progress sync stops with the app, so every user-facing
/// quit path except the explicit tray item confirms first. The tray's Quit
/// is exempt because its label already states the consequence.
fn confirm_quit(handle: &AppHandle) {
    let quit_handle = handle.clone();
    let builder = handle
        .dialog()
        .message(
            "Quitting stops the sync engine — any in-progress syncs will stop. \
             Quit anyway?",
        )
        .title("Quit Sneakernet?")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            String::from("Quit"),
            String::from("Cancel"),
        ));
    // Attach to the window when it exists so the dialog is clearly tied to
    // the app (on macOS it appears as a sheet over the window).
    let builder = match handle.get_webview_window("main") {
        Some(window) => builder.parent(&window),
        None => builder,
    };
    builder.show(move |confirmed| {
        if confirmed {
            // ExitRequested carries a code, so the run handler lets this
            // exit through (no second dialog).
            quit_handle.exit(0);
        }
    });
}

// ----------------------------------------------------------- settings watch --

/// Watch `desktop-settings.json` for changes written by the server (the
/// in-app Desktop Settings dialog) and restart the server on any change.
fn watch_settings(handle: AppHandle) {
    thread::spawn(move || {
        let app_data = handle
            .path()
            .app_data_dir()
            .expect("cannot resolve the app data directory");
        let mut last = load_settings(&app_data);
        loop {
            thread::sleep(Duration::from_secs(1));
            let current = load_settings(&app_data);
            if current == last {
                continue;
            }
            logln("desktop settings changed - restarting the server");
            *handle.state::<AppState>().settings.lock().unwrap() = current.clone();
            last = current;
            spawn_server(&handle);
        }
    });
}

// -------------------------------------------------------------------- main --

fn main() {
    tauri::Builder::default()
        // Only one instance: a second launch focuses the existing window
        // (otherwise two servers would fight over the same sync data).
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let handle = app.handle().clone();

            let app_data: PathBuf = handle
                .path()
                .app_data_dir()
                .expect("cannot resolve the app data directory");
            // One-time migration from the pre-rename bundle identifier
            // (com.metfilesync.desktop was this app's name until v0.1): carry
            // the sync root, sync sets, settings and logs over so existing
            // installs keep working after the rename.
            init_logging(&app_data);
            let old_app_data = app_data.with_file_name("com.metfilesync.desktop");
            if !app_data.exists() && old_app_data.exists() {
                match std::fs::rename(&old_app_data, &app_data) {
                    Ok(()) => logln(&format!(
                        "migrated app data from {}",
                        old_app_data.display()
                    )),
                    Err(err) => logln(&format!(
                        "could not migrate app data from {}: {err}",
                        old_app_data.display()
                    )),
                }
            }
            let settings = load_settings(&app_data);
            // The managed state was created with defaults in `.manage()`;
            // now that the app data dir is available, install the real ones.
            *handle.state::<AppState>().settings.lock().unwrap() = settings.clone();
            logln(&format!(
                "starting with LAN sharing {}",
                if settings.lan_sharing { "on" } else { "off" }
            ));

            // LAN sharing and the sync root are managed from the in-app
            // Desktop Settings dialog; the tray just opens/quits the app.
            let show = MenuItem::with_id(&handle, "show", "Open Sneakernet", true, None::<&str>)?;
            let quit = MenuItem::with_id(
                &handle,
                "quit",
                "Quit (stops running syncs)",
                true,
                None::<&str>,
            )?;
            let menu = Menu::with_items(&handle, &[&show, &quit])?;
            TrayIconBuilder::with_id("tray")
                .icon(handle.default_window_icon().unwrap().clone())
                .tooltip("Sneakernet")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "quit" => {
                        app.exit(0);
                    }
                    _ => {}
                })
                .build(&handle)?;

            // macOS menu bar: a minimal, native-feeling menu whose Quit
            // item (Cmd+Q) routes through the same confirmation dialog as
            // closing the window. Without it the system's Cmd+Q terminates
            // the app immediately (macOS quit events bypass Tauri's exit
            // hooks; the stdin watchdog would still clean up the server,
            // but the user would get no warning). The Edit submenu keeps
            // the standard webview text shortcuts working. Windows is left
            // untouched (a menu there would attach to the window).
            #[cfg(target_os = "macos")]
            {
                let quit = MenuItem::with_id(
                    &handle,
                    "app-quit",
                    "Quit Sneakernet",
                    true,
                    Some("CmdOrCtrl+Q"),
                )?;
                let app_menu = SubmenuBuilder::new(&handle, "Sneakernet")
                    .item(&quit)
                    .build()?;
                let edit_menu = SubmenuBuilder::new(&handle, "Edit")
                    .item(&PredefinedMenuItem::undo(&handle, None)?)
                    .item(&PredefinedMenuItem::redo(&handle, None)?)
                    .item(&PredefinedMenuItem::separator(&handle)?)
                    .item(&PredefinedMenuItem::cut(&handle, None)?)
                    .item(&PredefinedMenuItem::copy(&handle, None)?)
                    .item(&PredefinedMenuItem::paste(&handle, None)?)
                    .item(&PredefinedMenuItem::select_all(&handle, None)?)
                    .build()?;
                let menu = MenuBuilder::new(&handle)
                    .item(&app_menu)
                    .item(&edit_menu)
                    .build()?;
                handle.set_menu(menu)?;
                handle.on_menu_event(|app, event| {
                    if event.id.as_ref() == "app-quit" {
                        confirm_quit(app);
                    }
                });
            }

            spawn_server(&handle);
            watch_settings(handle);

            Ok(())
        })
        .manage(AppState {
            child: Mutex::new(None),
            settings: Mutex::new(DesktopSettings::default()), // replaced below
            port: Mutex::new(0),
        })
        .on_window_event(|window, event| {
            // Closing the window quits the whole app. Confirm first with a
            // native dialog: quitting stops the embedded server, and with it
            // any sync that is still running.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                confirm_quit(window.app_handle());
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building Sneakernet")
        .run(|app, event| {
            match event {
                // User/system quit without a code (Cmd+Q, the Dock's Quit,
                // logoff): confirm first, exactly like closing the window.
                // Deliberate exits (the dialog's Quit, the tray's Quit) carry
                // a code and fall through to the shutdown path below.
                RunEvent::ExitRequested { code: None, api, .. } => {
                    api.prevent_exit();
                    confirm_quit(app);
                }
                // Stop the server on every exit path; the stdin watchdog
                // covers anything the shell misses.
                RunEvent::ExitRequested { .. } | RunEvent::Exit => {
                    logln("exiting - stopping the embedded server");
                    if let Some(mut child) = app.state::<AppState>().child.lock().unwrap().take() {
                        let _ = child.kill();
                        let _ = child.wait();
                    }
                }
                _ => {}
            }
        });
}
