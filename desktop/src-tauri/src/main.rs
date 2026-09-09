// MetFileSync desktop shell (Option A, DeployProposal.md).
//
// The shell launches the bundled Node runtime with the adapter-node server
// (resources/server) as a hidden child process, waits until it accepts
// connections, then navigates the main webview to the local server URL.
// Per-user data lives under the OS application-support directory:
//   <app-data>/sync-root     - default sync root (METFILESYNC_ROOT)
//   <app-data>/app-data      - sync sets / logs (METFILESYNC_DATA)
//   <app-data>/desktop-settings.json - this app's settings
// Closing the window hides to the tray (syncs keep running); Quit from the
// tray stops the server and exits.
//
// LAN sharing (opt-in, off by default): configured in the in-app Desktop
// Settings dialog (loopback-only endpoints in the web app). When enabled,
// the server binds 0.0.0.0 on a stable port and requires an access token
// (shareable link); when disabled, it binds 127.0.0.1 only.
//
// The server gets the settings file path via METFILESYNC_DESKTOP_SETTINGS
// and writes changes there (from the Desktop Settings dialog). A watcher
// thread polls the file; whenever its contents change, the shell restarts
// the server child with the new binding/root and re-navigates the window.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream, UdpSocket};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Manager, RunEvent,
};

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
            println!(
                "[shell] port {} is busy - using {fallback} instead",
                settings.lan_port
            );
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
    let addon = resources.join("native").join("metfilesync_native.node");
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
        .env("METFILESYNC_ROOT", &sync_root)
        .env("METFILESYNC_DATA", &server_data)
        .env("METFILESYNC_NATIVE", &addon)
        // Lets the server read/write desktop settings (Desktop Settings
        // dialog) and know it is running under this shell.
        .env("METFILESYNC_DESKTOP_SETTINGS", settings_path(&app_data))
        .current_dir(&server_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if settings.lan_sharing {
        cmd.env("METFILESYNC_ACCESS_TOKEN", &settings.access_token);
        cmd.env("METFILESYNC_LAN_URL", lan_url(&settings, port));
    }
    hide_console(&mut cmd);

    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(err) => {
            panic!("cannot start the MetFileSync server process: {err}");
        }
    };

    // Log server output to the shell's stdout/stderr for diagnostics.
    if let Some(out) = child.stdout.take() {
        thread::spawn(move || {
            use std::io::{BufRead, BufReader};
            for line in BufReader::new(out).lines().flatten() {
                println!("[server] {line}");
            }
        });
    }
    if let Some(err) = child.stderr.take() {
        thread::spawn(move || {
            use std::io::{BufRead, BufReader};
            for line in BufReader::new(err).lines().flatten() {
                eprintln!("[server] {line}");
            }
        });
    }

    *state.child.lock().unwrap() = Some(child);
    *state.port.lock().unwrap() = port;

    // Navigate the window to the app once the server is up. Repeated evals
    // guard against races with the page's load.
    let window = handle
        .get_webview_window("main")
        .expect("main window is declared in tauri.conf.json");
    let url = boot_url(&settings, port);
    let url_for_nav = url.clone();
    thread::spawn(move || {
        if !wait_for_server(port, Duration::from_secs(60)) {
            eprintln!("[shell] server did not become ready within 60s");
            return;
        }
        for _ in 0..10 {
            let _ = window.eval(&format!(
                "window.location.replace({url_for_nav:?});"
            ));
            thread::sleep(Duration::from_millis(300));
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
            println!("[shell] desktop settings changed - restarting the server");
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
        .setup(|app| {
            let handle = app.handle().clone();

            let app_data: PathBuf = handle
                .path()
                .app_data_dir()
                .expect("cannot resolve the app data directory");
            let settings = load_settings(&app_data);
            // The managed state was created with defaults in `.manage()`;
            // now that the app data dir is available, install the real ones.
            *handle.state::<AppState>().settings.lock().unwrap() = settings.clone();
            println!(
                "[shell] starting with LAN sharing {}",
                if settings.lan_sharing { "on" } else { "off" }
            );

            // LAN sharing and the sync root are managed from the in-app
            // Desktop Settings dialog; the tray just opens/quits the app.
            let show = MenuItem::with_id(&handle, "show", "Open MetFileSync", true, None::<&str>)?;
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
                .tooltip("MetFileSync")
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
            // Closing the window hides to the tray; syncs keep running until
            // the user quits from the tray.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building MetFileSync")
        .run(|app, event| {
            // Stop the server on every exit path (system quit, tray quit,
            // abrupt teardown); the stdin watchdog covers anything else.
            if matches!(
                event,
                RunEvent::ExitRequested { .. } | RunEvent::Exit
            ) {
                if let Some(mut child) = app.state::<AppState>().child.lock().unwrap().take() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
        });
}
