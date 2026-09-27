mod private_store;

use std::path::PathBuf;
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            register_gallery_root,
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
