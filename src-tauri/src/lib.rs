mod private_store;

use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_fs::FsExt;

/// Grants both runtime scopes to one directory. The fs plugin scope lets
/// `readDir`/`exists` list inside it; the asset protocol scope lets
/// `convertFileSrc` URLs resolve. Neither scope ever contains `**`.
fn allow_root(app: &AppHandle, dir: &PathBuf) -> Result<(), String> {
    app.asset_protocol_scope()
        .allow_directory(dir, true)
        .map_err(|e| e.to_string())?;
    app.fs_scope()
        .allow_directory(dir, true)
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// The only way a path enters a scope: the renderer asks for a pick, Rust
/// shows the folder dialog, and the directory the user picked — never a
/// path the renderer supplied — is what gets granted. The pick is then
/// recorded as provenance so launch-time re-grants stay inside it.
#[tauri::command]
fn pick_gallery_root(app: AppHandle) -> Result<Option<String>, String> {
    let Some(picked) = app.dialog().file().blocking_pick_folder() else {
        return Ok(None);
    };
    let Some(dir) = picked.as_path().map(|p| p.to_path_buf()) else {
        return Ok(None);
    };
    allow_root(&app, &dir)?;
    private_store::record_gallery_root(&app, &dir.to_string_lossy())?;
    Ok(Some(dir.to_string_lossy().to_string()))
}

/// Re-grants every picker-approved root — runtime scopes reset each launch,
/// so approval is re-registered on start and after a card remounts. The
/// catalogue is renderer-writable and cannot be trusted for grants; the
/// provenance file can only be appended to by the picker itself.
#[tauri::command]
fn register_saved_gallery_roots(app: AppHandle) -> Result<(), String> {
    for root in private_store::saved_gallery_roots(&app) {
        // A vanished mount (ejected card) must not fail the batch.
        let _ = allow_root(&app, &PathBuf::from(root));
    }
    Ok(())
}

/// One in-flight loopback listener for Google's installed-app OAuth. Google
/// forbids custom-scheme redirects for desktop clients; the documented path
/// is an ephemeral http://127.0.0.1:<port> receiver, which a plain
/// TcpListener provides — no extra crates, no fixed port to collide with.
struct LoopbackHandle {
    listener: TcpListener,
    /// A finish() is already draining this listener — it stays single-consumer.
    claimed: AtomicBool,
    cancelled: AtomicBool,
}

struct LoopbackState(Mutex<Option<Arc<LoopbackHandle>>>);

/// Bounds on the wait: consent screens get minutes, stray connections get
/// seconds, and a cancelled or abandoned flow frees the thread instead of
/// parking in accept() forever.
const LOOPBACK_TIMEOUT: Duration = Duration::from_secs(300);
const LOOPBACK_READ_TIMEOUT: Duration = Duration::from_secs(5);
const LOOPBACK_POLL: Duration = Duration::from_millis(50);

/// Only the provider redirect carries OAuth response params — anything else
/// on the port (a probe, a favicon fetch, local noise) is not allowed to
/// consume the one connection the flow is waiting for.
fn oauth_target_from(request_line: &str) -> Option<&str> {
    let mut parts = request_line.split_whitespace();
    if parts.next() != Some("GET") {
        return None;
    }
    let target = parts.next()?;
    (target.starts_with("/?") && (target.contains("code=") || target.contains("error=")))
        .then_some(target)
}

/// Binds 127.0.0.1 on an ephemeral port and returns the port. Beginning a
/// new flow cancels any listener still waiting on an abandoned one.
#[tauri::command]
fn oauth_loopback_begin(state: tauri::State<LoopbackState>) -> Result<u16, String> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = listener
        .local_addr()
        .map_err(|e| e.to_string())?
        .port();
    let handle = Arc::new(LoopbackHandle {
        listener,
        claimed: AtomicBool::new(false),
        cancelled: AtomicBool::new(false),
    });
    let mut slot = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(previous) = slot.replace(handle) {
        previous.cancelled.store(true, Ordering::SeqCst);
    }
    Ok(port)
}

/// Releases a waiting receiver when the front end abandons the flow —
/// without this the blocking accept outlives the cancellation.
#[tauri::command]
fn oauth_loopback_cancel(state: tauri::State<LoopbackState>) -> Result<(), String> {
    if let Some(handle) = state.0.lock().map_err(|e| e.to_string())?.take() {
        handle.cancelled.store(true, Ordering::SeqCst);
    }
    Ok(())
}

/// Waits for the browser's redirect, answers the matching request with a
/// "return to the app" page, and resolves with its request target
/// (`/?code=…&state=…`) for the front end to parse. Runs on a blocking
/// thread so the async runtime is never stalled while the user is in the
/// consent screen.
#[tauri::command]
async fn oauth_loopback_finish(state: tauri::State<'_, LoopbackState>) -> Result<String, String> {
    let handle = {
        let slot = state.0.lock().map_err(|e| e.to_string())?;
        slot.clone().ok_or("No loopback listener is waiting")?
    };
    if handle.claimed.swap(true, Ordering::SeqCst) {
        return Err("No loopback listener is waiting".into());
    }
    let worker = Arc::clone(&handle);
    let result = tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        worker
            .listener
            .set_nonblocking(true)
            .map_err(|e| e.to_string())?;
        let deadline = Instant::now() + LOOPBACK_TIMEOUT;
        loop {
            if worker.cancelled.load(Ordering::SeqCst) {
                return Err("The provider connection was cancelled".into());
            }
            if Instant::now() >= deadline {
                return Err("Timed out waiting for the provider redirect".into());
            }
            match worker.listener.accept() {
                Ok((mut stream, _)) => {
                    stream
                        .set_read_timeout(Some(LOOPBACK_READ_TIMEOUT))
                        .map_err(|e| e.to_string())?;
                    let mut buffer = [0u8; 16 * 1024];
                    let request = match stream.read(&mut buffer) {
                        Ok(read) => String::from_utf8_lossy(&buffer[..read]).into_owned(),
                        Err(_) => continue,
                    };
                    let line = request.lines().next().unwrap_or_default();
                    let Some(target) = oauth_target_from(line).map(|t| t.to_string()) else {
                        let _ = stream.write_all(
                            b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                        );
                        continue;
                    };
                    let page = "<!doctype html><title>manorama</title>\
                        <p>Connected. You can close this tab and return to manorama.</p>";
                    let response = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        page.len(),
                        page
                    );
                    stream.write_all(response.as_bytes()).map_err(|e| e.to_string())?;
                    return Ok(target);
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(LOOPBACK_POLL);
                }
                Err(e) => return Err(e.to_string()),
            }
        }
    })
    .await
    .map_err(|e| e.to_string())?;
    // Free the slot — but only while it still holds THIS listener, never a
    // newer flow that replaced us mid-wait.
    if let Ok(mut slot) = state.0.lock() {
        if slot.as_ref().is_some_and(|h| Arc::ptr_eq(h, &handle)) {
            *slot = None;
        }
    }
    result
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // First plugin, as its docs require — the sign-in verifier lives
        // in this process's memory, and on Windows/Linux every deep link
        // spawns a NEW process that would receive the handoff without it.
        // With the deep-link feature the killed second process's argv is
        // re-delivered to our onOpenUrl listener before the callback runs.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .manage(LoopbackState(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            pick_gallery_root,
            register_saved_gallery_roots,
            oauth_loopback_begin,
            oauth_loopback_cancel,
            oauth_loopback_finish,
            private_store::read_private_file,
            private_store::write_private_file,
            private_store::delete_private_file,
        ])
        .setup(|app| {
            // A cold start via the custom scheme delivers the launch URLs
            // here instead of through on_open_url — forward them so the
            // front end sees one delivery path either way.
            if let Ok(Some(urls)) = app.deep_link().get_current() {
                for url in urls {
                    let _ = app.emit("manorama://deep-link", url.to_string());
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running manorama desktop");
}
