use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

// Renderer writes never include provenance, the dump declaration or its index.
const PRIVATE_FILES: &[&str] = &[
    "session.json",
    "catalogue.json",
    "providers.json",
    "library-prefs.json",
    "device.json",
];
const ROOTS_FILE: &str = "roots.json";
const DUMP_ROOTS_FILE: &str = "raw-dump-roots.json";

#[derive(Clone, Debug)]
pub(crate) struct StorePaths {
    pub config: PathBuf,
    pub store: PathBuf,
}

impl StorePaths {
    /// CLI isolation affects only app-owned documents. Roots remain in the old
    /// config directory unless --store is explicitly supplied; neither override
    /// is ever accepted over IPC.
    pub fn from_args(
        default: PathBuf,
        args: impl IntoIterator<Item = std::ffi::OsString>,
    ) -> Result<Self, String> {
        let mut paths = Self {
            config: default.clone(),
            store: default,
        };
        let mut args = args.into_iter();
        while let Some(arg) = args.next() {
            let destination = if arg == "--config" {
                &mut paths.config
            } else if arg == "--store" {
                &mut paths.store
            } else {
                continue;
            };
            let path = PathBuf::from(args.next().ok_or("Missing isolation directory")?);
            if !path.is_absolute() {
                return Err("Isolation directories must be absolute".into());
            }
            *destination = path;
        }
        Ok(paths)
    }
    pub fn roots_path(&self) -> PathBuf {
        self.store.join(ROOTS_FILE)
    }
    pub fn raw_dump_roots_path(&self) -> PathBuf {
        self.config.join(DUMP_ROOTS_FILE)
    }
}

fn private_path(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    if !PRIVATE_FILES.contains(&name) {
        return Err("Unknown private file".into());
    }
    Ok(app.state::<StorePaths>().config.join(name))
}

pub(crate) fn read_optional(path: &Path) -> Result<Option<Vec<u8>>, String> {
    match fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

pub(crate) fn remove_private(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn read_private_file(app: AppHandle, name: String) -> Result<Option<String>, String> {
    read_optional(&private_path(&app, &name)?)?
        .map(|bytes| String::from_utf8(bytes).map_err(|e| e.to_string()))
        .transpose()
}

/// Unique create-new temporary files cannot follow a leftover symlink or race
/// another writer. Event/source/catalogue writes additionally share one mutex.
pub(crate) fn write_0600(path: &Path, contents: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("Private file needs a parent")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    #[cfg(windows)]
    windows_private_parent(parent)?;
    let tmp = parent.join(format!(
        ".{}.{}.tmp",
        path.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("private"),
        uuid::Uuid::new_v4()
    ));
    let result = (|| {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        options.mode(0o600);
        let mut file = options.open(&tmp).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        file.set_permissions(fs::Permissions::from_mode(0o600))
            .map_err(|e| e.to_string())?;
        file.write_all(contents).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        drop(file);
        #[cfg(not(windows))]
        fs::rename(&tmp, path).map_err(|e| e.to_string())?;
        #[cfg(windows)]
        {
            use std::os::windows::ffi::OsStrExt;
            use windows_sys::Win32::Storage::FileSystem::{
                MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
            };
            let wide = |p: &Path| {
                p.as_os_str()
                    .encode_wide()
                    .chain(Some(0))
                    .collect::<Vec<_>>()
            };
            if unsafe {
                MoveFileExW(
                    wide(&tmp).as_ptr(),
                    wide(path).as_ptr(),
                    MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
                )
            } == 0
            {
                return Err(std::io::Error::last_os_error().to_string());
            }
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(tmp);
    }
    result
}

/// A protected DACL containing only the process user's SID. New temporary
/// files inherit it before bytes are written; no username/env lookup or shell.
#[cfg(windows)]
fn windows_private_parent(parent: &Path) -> Result<(), String> {
    use std::{os::windows::ffi::OsStrExt, ptr};
    use windows_sys::Win32::{
        Foundation::{CloseHandle, LocalFree},
        Security::Authorization::{
            ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
            SDDL_REVISION_1,
        },
        Security::{
            GetTokenInformation, SetFileSecurityW, TokenUser, DACL_SECURITY_INFORMATION,
            PROTECTED_DACL_SECURITY_INFORMATION, TOKEN_QUERY, TOKEN_USER,
        },
        System::Threading::{GetCurrentProcess, OpenProcessToken},
    };
    unsafe {
        let mut token = ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        let result = (|| {
            let mut size = 0;
            GetTokenInformation(token, TokenUser, ptr::null_mut(), 0, &mut size);
            // Aligned storage for TOKEN_USER, including its variable-length SID.
            let mut buffer = vec![0usize; (size as usize).div_ceil(std::mem::size_of::<usize>())];
            if GetTokenInformation(
                token,
                TokenUser,
                buffer.as_mut_ptr().cast(),
                size,
                &mut size,
            ) == 0
            {
                return Err(std::io::Error::last_os_error().to_string());
            }
            let user = &*(buffer.as_ptr().cast::<TOKEN_USER>());
            let mut sid_text = ptr::null_mut();
            if ConvertSidToStringSidW(user.User.Sid, &mut sid_text) == 0 {
                return Err(std::io::Error::last_os_error().to_string());
            }
            let mut len = 0;
            while *sid_text.add(len) != 0 {
                len += 1;
            }
            let sid = String::from_utf16_lossy(std::slice::from_raw_parts(sid_text, len));
            LocalFree(sid_text.cast());
            let sddl: Vec<u16> = format!("D:P(A;OICI;FA;;;{sid})")
                .encode_utf16()
                .chain(Some(0))
                .collect();
            let mut descriptor = ptr::null_mut();
            if ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                SDDL_REVISION_1,
                &mut descriptor,
                ptr::null_mut(),
            ) == 0
            {
                return Err(std::io::Error::last_os_error().to_string());
            }
            let path: Vec<u16> = parent.as_os_str().encode_wide().chain(Some(0)).collect();
            let ok = SetFileSecurityW(
                path.as_ptr(),
                DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                descriptor,
            );
            let error = std::io::Error::last_os_error();
            LocalFree(descriptor.cast());
            if ok == 0 {
                Err(error.to_string())
            } else {
                Ok(())
            }
        })();
        CloseHandle(token);
        result
    }
}

#[tauri::command]
pub fn write_private_file(app: AppHandle, name: String, contents: String) -> Result<(), String> {
    let path = private_path(&app, &name)?;
    let state = app.state::<crate::event_clustering::EventState>();
    let state = state.0.lock().map_err(|e| e.to_string())?;
    if name == "catalogue.json" {
        state.guard_catalogue(&contents)?;
    }
    write_0600(&path, contents.as_bytes())
}

pub(crate) fn roots_at(paths: &StorePaths) -> Result<Vec<String>, String> {
    match read_optional(&paths.roots_path())? {
        Some(bytes) => serde_json::from_slice(&bytes).map_err(|e| e.to_string()),
        None => Ok(vec![]),
    }
}

// Caller holds EventState: source declaration and gallery commits cannot race.
pub(crate) fn record_roots(paths: &StorePaths, selected: &[PathBuf]) -> Result<(), String> {
    let mut roots = roots_at(paths)?;
    for root in selected {
        let text = root.to_str().ok_or("Root path is not UTF-8")?;
        if !roots
            .iter()
            .any(|saved| crate::same_path(Path::new(saved), root))
        {
            roots.push(text.to_owned());
        }
    }
    write_0600(
        &paths.roots_path(),
        &serde_json::to_vec(&roots).map_err(|e| e.to_string())?,
    )
}

pub(crate) fn saved_gallery_roots(app: &AppHandle) -> Vec<String> {
    roots_at(&app.state::<StorePaths>()).unwrap_or_default()
}

pub(crate) fn raw_dump_roots_at(paths: &StorePaths) -> Result<Vec<String>, String> {
    match read_optional(&paths.raw_dump_roots_path())? {
        Some(bytes) => serde_json::from_slice(&bytes).map_err(|e| e.to_string()),
        None => Ok(vec![]),
    }
}

// Dump approval survives clearing the declaration but never becomes a renderer
// filesystem or asset-protocol grant.
pub(crate) fn record_raw_dump_root(paths: &StorePaths, selected: &Path) -> Result<(), String> {
    let mut roots = raw_dump_roots_at(paths)?;
    let text = selected
        .to_str()
        .ok_or("Root path is not UTF-8")?
        .to_owned();
    if !roots
        .iter()
        .any(|saved| crate::same_path(Path::new(saved), selected))
    {
        roots.push(text);
    }
    write_0600(
        &paths.raw_dump_roots_path(),
        &serde_json::to_vec(&roots).map_err(|e| e.to_string())?,
    )
}

#[tauri::command]
pub fn delete_private_file(app: AppHandle, name: String) -> Result<(), String> {
    let path = private_path(&app, &name)?;
    let state = app.state::<crate::event_clustering::EventState>();
    let _guard = state.0.lock().map_err(|e| e.to_string())?;
    remove_private(&path)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn isolated_directories_do_not_mix_config_and_provenance() {
        let tmp = tempfile::tempdir().unwrap();
        let default = tmp.path().join("default");
        let config = tmp.path().join("config");
        let store = tmp.path().join("store");
        let paths = StorePaths::from_args(
            default.clone(),
            [
                "--config".into(),
                config.clone().into(),
                "--store".into(),
                store.clone().into(),
            ],
        )
        .unwrap();
        write_0600(&paths.config.join("events-index.json"), b"private").unwrap();
        record_roots(&paths, &[tmp.path().to_path_buf()]).unwrap();
        assert!(config.join("events-index.json").exists());
        assert!(store.join("roots.json").exists());
        assert!(!config.join("roots.json").exists());
        assert!(!default.exists());
        assert_eq!(
            StorePaths::from_args(default.clone(), ["--config".into(), config.into()])
                .unwrap()
                .store,
            default
        );
        assert!(
            StorePaths::from_args(tmp.path().into(), ["--config".into(), "relative".into()])
                .is_err()
        );
    }
    #[test]
    fn native_documents_are_not_renderer_writable() {
        for name in [
            "roots.json",
            "raw-dump-roots.json",
            "raw-dump.json",
            "events-index.json",
            "../session.json",
        ] {
            assert!(!PRIVATE_FILES.contains(&name));
        }
    }
    #[cfg(windows)]
    #[test]
    fn windows_parent_and_replaced_file_have_only_the_current_user_ace() {
        use std::{os::windows::ffi::OsStrExt, ptr};
        use windows_sys::Win32::{
            Foundation::LocalFree,
            Security::Authorization::{
                ConvertSecurityDescriptorToStringSecurityDescriptorW, SDDL_REVISION_1,
            },
            Security::{GetFileSecurityW, DACL_SECURITY_INFORMATION},
        };
        let temp = tempfile::tempdir().unwrap();
        let parent = temp.path().join("private");
        let file = parent.join("index.json");
        write_0600(&file, b"first").unwrap();
        write_0600(&file, b"replacement").unwrap();
        for path in [&parent, &file] {
            let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
            unsafe {
                let mut size = 0;
                GetFileSecurityW(
                    wide.as_ptr(),
                    DACL_SECURITY_INFORMATION,
                    ptr::null_mut(),
                    0,
                    &mut size,
                );
                let mut bytes =
                    vec![0usize; (size as usize).div_ceil(std::mem::size_of::<usize>())];
                assert_ne!(
                    GetFileSecurityW(
                        wide.as_ptr(),
                        DACL_SECURITY_INFORMATION,
                        bytes.as_mut_ptr().cast(),
                        size,
                        &mut size
                    ),
                    0
                );
                let mut text = ptr::null_mut();
                assert_ne!(
                    ConvertSecurityDescriptorToStringSecurityDescriptorW(
                        bytes.as_ptr() as *mut _,
                        SDDL_REVISION_1,
                        DACL_SECURITY_INFORMATION,
                        &mut text,
                        ptr::null_mut()
                    ),
                    0
                );
                let mut len = 0;
                while *text.add(len) != 0 {
                    len += 1;
                }
                let sddl = String::from_utf16_lossy(std::slice::from_raw_parts(text, len));
                LocalFree(text.cast());
                assert_eq!(sddl.matches("(A;").count(), 1, "{sddl}");
                assert_eq!(sddl.matches("(").count(), 1, "{sddl}");
                assert!(sddl.contains(";FA;;;S-1-5-"), "{sddl}");
            }
        }
    }

    #[test]
    fn writer_replaces_complete_documents_and_leaves_no_temp() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("private.json");
        write_0600(&path, b"long document").unwrap();
        write_0600(&path, b"new").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"new");
        assert_eq!(fs::read_dir(tmp.path()).unwrap().count(), 1);
        #[cfg(unix)]
        assert_eq!(
            fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}
