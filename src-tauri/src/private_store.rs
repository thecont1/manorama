use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

/// App-private JSON documents under the app config dir: the session token,
/// the local gallery catalogue, the provider OAuth grants for the upload
/// lane, and the install-stable device record.
///
/// A fixed allowlist — never a caller-supplied path — keeps these three
/// commands from becoming a general file-write primitive. The fs plugin's
/// JS surface stays read-only, so the only writer in the whole app is this
/// file, and it only writes inside the app config dir.
///
/// `providers.json` holds refresh tokens for Dropbox/Drive upload access —
/// more sensitive than the session file and stored at the same 0600 mode.
/// A keychain plugin is the documented upgrade path for both.
const PRIVATE_FILES: &[&str] = &["session.json", "catalogue.json", "providers.json"];

fn private_path(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    if !PRIVATE_FILES.contains(&name) {
        return Err("Unknown private file".into());
    }
    Ok(app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join(name))
}

#[tauri::command]
pub fn read_private_file(app: AppHandle, name: String) -> Result<Option<String>, String> {
    let path = private_path(&app, &name)?;
    match fs::read_to_string(&path) {
        Ok(contents) => Ok(Some(contents)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn write_private_file(app: AppHandle, name: String, contents: String) -> Result<(), String> {
    let path = private_path(&app, &name)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    // Write-then-rename so a crash mid-write never leaves half a session or
    // half a catalogue behind.
    let tmp = path.with_file_name(format!(
        ".{}.tmp",
        path.file_name().and_then(|n| n.to_str()).unwrap_or("private")
    ));
    fs::write(&tmp, contents.as_bytes()).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600)).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn delete_private_file(app: AppHandle, name: String) -> Result<(), String> {
    let path = private_path(&app, &name)?;
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}
