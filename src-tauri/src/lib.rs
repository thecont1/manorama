mod private_store;

use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_fs::FsExt;

/// Widens both runtime scopes by exactly one user-picked root. The fs
/// plugin scope lets `readDir`/`exists` list inside it; the asset protocol
/// scope lets `convertFileSrc` URLs resolve. Neither scope ever contains
/// `**` — a root only enters through the directory picker.
#[tauri::command]
fn register_gallery_root(app: AppHandle, path: String) -> Result<(), String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("An empty path cannot be a gallery root".into());
    }
    let dir = PathBuf::from(trimmed);
    app.asset_protocol_scope()
        .allow_directory(&dir, true)
        .map_err(|e| e.to_string())?;
    app.fs_scope()
        .allow_directory(&dir, true)
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// One in-flight loopback listener for Google's installed-app OAuth. Google
/// forbids custom-scheme redirects for desktop clients; the documented path
/// is an ephemeral http://127.0.0.1:<port> receiver, which a plain
/// TcpListener provides — no extra crates, no fixed port to collide with.
struct LoopbackState(Mutex<Option<TcpListener>>);

/// Binds 127.0.0.1 on an ephemeral port and returns the port. The listener
/// is held in app state until `oauth_loopback_finish` accepts exactly one
/// request; beginning a new flow replaces any abandoned listener.
#[tauri::command]
fn oauth_loopback_begin(state: tauri::State<LoopbackState>) -> Result<u16, String> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = listener
        .local_addr()
        .map_err(|e| e.to_string())?
        .port();
    let mut slot = state.0.lock().map_err(|e| e.to_string())?;
    *slot = Some(listener);
    Ok(port)
}

/// Waits for the browser's one redirect, answers with a "return to the app"
/// page, and resolves with the request target (`/?code=…&state=…`) for the
/// front end to parse. Runs on a blocking thread so the async runtime is
/// never stalled while the user is in the consent screen.
#[tauri::command]
async fn oauth_loopback_finish(state: tauri::State<'_, LoopbackState>) -> Result<String, String> {
    let listener = {
        let mut slot = state.0.lock().map_err(|e| e.to_string())?;
        slot.take().ok_or("No loopback listener is waiting")?
    };
    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let (mut stream, _) = listener.accept().map_err(|e| e.to_string())?;
        let mut buffer = [0u8; 16 * 1024];
        let read = stream.read(&mut buffer).map_err(|e| e.to_string())?;
        let request = String::from_utf8_lossy(&buffer[..read]);
        let line = request.lines().next().unwrap_or_default();
        let target = line
            .split_whitespace()
            .nth(1)
            .ok_or("The loopback request was malformed")?
            .to_string();
        let page = "<!doctype html><title>manorama</title>\
            <p>Connected. You can close this tab and return to manorama.</p>";
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            page.len(),
            page
        );
        stream.write_all(response.as_bytes()).map_err(|e| e.to_string())?;
        Ok(target)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .manage(LoopbackState(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            register_gallery_root,
            oauth_loopback_begin,
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
