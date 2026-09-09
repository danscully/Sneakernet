// MetFileSync desktop shell (Option A, DeployProposal.md).
//
// The shell launches the bundled Node runtime with the adapter-node server
// (resources/server) as a hidden child process, waits until it accepts
// connections, then navigates the main webview to the local server URL.
// Per-user data lives under the OS application-support directory:
//   <app-data>/sync-root   - the sync root (METFILESYNC_ROOT)
//   <app-data>/app-data    - sync sets / logs (METFILESYNC_DATA)
// Closing the window hides to the tray (syncs keep running); Quit from the
// tray stops the server and exits.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::net::TcpListener;
use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager, RunEvent,
};

/// The running server process, kept alive until the app exits.
struct ServerState {
    child: Mutex<Option<Child>>,
}

/// Pick a free localhost port for the server.
fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .expect("cannot bind localhost")
        .local_addr()
        .expect("cannot read local address")
        .port()
}

/// Hide the console window on Windows.
#[cfg(windows)]
fn hide_console(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    // CREATE_NO_WINDOW
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
        .manage(ServerState {
            child: Mutex::new(None),
        })
        .setup(|app| {
            let handle = app.handle().clone();

            // ---- Per-user data directories ---------------------------------
            let app_data: PathBuf = handle
                .path()
                .app_data_dir()
                .expect("cannot resolve the app data directory");
            let sync_root = app_data.join("sync-root");
            let server_data = app_data.join("app-data");
            std::fs::create_dir_all(&sync_root)
                .expect("cannot create the sync root directory");
            std::fs::create_dir_all(&server_data)
                .expect("cannot create the app data directory");

            // ---- Bundled resources -----------------------------------------
            let resources = handle
                .path()
                .resource_dir()
                .expect("cannot resolve the resources directory");
            let node = resources
                .join("runtime")
                .join(if cfg!(windows) { "node.exe" } else { "node" });
            let server_dir = resources.join("server");
            let entry = server_dir.join("index.js");
            let addon = resources.join("native").join("metfilesync_native.node");
            if !node.exists() || !entry.exists() || !addon.exists() {
                panic!(
                    "MetFileSync resources are missing - the app bundle is incomplete.\n\
                     node: {}\n server: {}\n addon: {}",
                    node.display(),
                    entry.display(),
                    addon.display()
                );
            }

            // ---- Start the server -------------------------------------------
            let port = free_port();
            let mut cmd = Command::new(&node);
            // The wrapper watches stdin: if the shell dies without a chance to
            // kill the server, the pipe closes and the server exits itself.
            cmd.arg(server_dir.join("server-wrapper.mjs"))
                .env("PORT", port.to_string())
                .env("NODE_ENV", "production")
                .env("METFILESYNC_ROOT", &sync_root)
                .env("METFILESYNC_DATA", &server_data)
                .env("METFILESYNC_NATIVE", &addon)
                .current_dir(&server_dir)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            hide_console(&mut cmd);
            let mut child = cmd
                .spawn()
                .expect("cannot start the MetFileSync server process");

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

            *handle
                .state::<ServerState>()
                .child
                .lock()
                .unwrap() = Some(child);

            // ---- Navigate the window to the app once the server is up -------
            let window = handle
                .get_webview_window("main")
                .expect("main window is declared in tauri.conf.json");
            let boot_url = format!("http://127.0.0.1:{port}");
            thread::spawn(move || {
                let ready = wait_for_server(port, Duration::from_secs(60));
                if !ready {
                    eprintln!("[server] did not become ready within 60s");
                    return;
                }
                // Retry: the eval can race the splash page's load.
                for _ in 0..10 {
                    let _ = window.eval(&format!(
                        "window.__MFS_BOOT_URL = {boot_url:?};"
                    ));
                    thread::sleep(Duration::from_millis(300));
                }
            });

            // ---- Tray -------------------------------------------------------
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

            Ok(())
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
                if let Some(mut child) = app.state::<ServerState>().child.lock().unwrap().take() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
        });
}
