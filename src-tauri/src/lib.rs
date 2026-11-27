mod event_clustering;
mod private_store;

use std::io::{Read, Seek, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_fs::FsExt;

/// Grants the gallery filesystem scope to one directory. The scope lets
/// `readDir`/`exists` list inside it and never contains `**`; event media uses
/// separate opaque leases instead of renderer-constructed file URLs.
fn allow_root(app: &AppHandle, dir: &PathBuf) -> Result<(), String> {
    // The raw dump can never reach here — picker and drop both guard against
    // it before granting — so gallery roots keep the asset-protocol grant
    // their convertFileSrc display path needs. Event media stays behind the
    // opaque manorama-event leases either way.
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
/// Ask the user for a local gallery folder and grant the app persistent
/// access to it.
///
// Async, not sync: a non-async command runs inline in the IPC handler — the
// main thread on macOS — and blocking_pick_folder would park that thread on
// a channel while the dialog it queued waits for the same thread. Deadlock.
#[tauri::command]
async fn pick_gallery_root(app: AppHandle) -> Result<Option<String>, String> {
    let Some(picked) = app.dialog().file().blocking_pick_folder() else {
        return Ok(None);
    };
    let Some(dir) = picked.as_path().map(|p| p.to_path_buf()) else {
        return Ok(None);
    };
    let state = app.state::<event_clustering::EventState>();
    let inner = state.0.lock().map_err(|e| e.to_string())?;
    inner.guard_gallery_roots(std::slice::from_ref(&dir))?;
    allow_root(&app, &dir)?;
    private_store::record_roots(&inner.paths, std::slice::from_ref(&dir))?;
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

// MARK: - Drag-and-drop folder add
//
// The dropped-directory counterpart of the macOS shell's pendingDrops. A
// drop grants the gallery fs scope at once — the review sheet's `readDir`
// scan must work before any commit — and holds the directories here, never in
// renderer-reachable state. `roots.json` is touched only by commit, so an
// uncommitted drop can never become durable.

/// Directories the OS delivered on a drop that the page has not yet
/// committed or discarded, plus the sequence that identifies this drop.
/// The set is the provenance boundary: the commit and discard commands
/// only act on paths already held here, so a path the renderer merely
/// names is a lookup key and can never invent a grant. The sequence is
/// the epoch a commit echoes back — a commit naming a superseded drop is
/// rejected, so an in-flight stale commit cannot spend the newer drop's
/// pending set.
struct PendingDrops(Mutex<(u64, Vec<PathBuf>)>);

/// Component-wise path equality, with a canonicalised fallback — the page
/// echoes back the strings the drop emitted after normalising separators,
/// and a symlinked root can legitimately arrive spelled two ways.
fn same_path(a: &Path, b: &Path) -> bool {
    if a == b {
        return true;
    }
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

/// Counts dragged paths for the hover veil — there are no package
/// directories to exclude on this path (that distinction is the macOS
/// shell's), so `is_dir` is the whole check; everything else is a loose
/// file the drop ignores.
fn classify_drag_paths(paths: &[PathBuf]) -> (usize, usize) {
    let folders = paths.iter().filter(|path| path.is_dir()).count();
    (folders, paths.len() - folders)
}

/// OS drag events → the page's three folder-drop events. Hover and leave
/// only describe; the drop is what grants. Tauri's built-in handler keeps
/// emitting `tauri://drag-*` in parallel and grants the asset scope on its
/// own — the page listens only to these, and `allow_root` below covers the
/// fs scope the built-in handler does not.
fn handle_folder_drag(app: &AppHandle, event: &tauri::DragDropEvent) {
    match event {
        tauri::DragDropEvent::Enter { paths, .. } => {
            let (folders, files) = classify_drag_paths(paths);
            let _ = app.emit(
                "manorama://folder-drag-enter",
                serde_json::json!({ "folders": folders, "files": files }),
            );
        }
        tauri::DragDropEvent::Drop { paths, .. } => {
            let dirs: Vec<PathBuf> = paths.iter().filter(|path| path.is_dir()).cloned().collect();
            let files = paths.len() - dirs.len();
            let drop = {
                let pending = app.state::<PendingDrops>();
                let Ok(mut pending) = pending.0.lock() else {
                    return;
                };
                // A fresh drop replaces the pending set — entries it drops
                // lose their lookup status, exactly like a discard — and
                // bumps the sequence commits echo back.
                pending.0 += 1;
                pending.1 = dirs.clone();
                pending.0
            };
            // Scope first, emit second — the page scans the moment the event
            // lands, and the scan must not race its grant. The raw-dump
            // conflict is checked before granting, not only at commit: event
            // media must stay behind opaque leases, never a renderer scope.
            for dir in &dirs {
                let conflicted = app
                    .state::<event_clustering::EventState>()
                    .0
                    .lock()
                    .map(|inner| {
                        inner
                            .guard_gallery_roots(std::slice::from_ref(dir))
                            .is_err()
                    })
                    .unwrap_or(true);
                if !conflicted {
                    let _ = allow_root(app, dir);
                }
            }
            let emitted: Vec<String> = dirs
                .iter()
                .map(|dir| dir.to_string_lossy().to_string())
                .collect();
            let _ = app.emit(
                "manorama://folders-dropped",
                serde_json::json!({ "paths": emitted, "files": files, "drop": drop }),
            );
        }
        tauri::DragDropEvent::Leave => {
            let _ = app.emit("manorama://folder-drag-leave", serde_json::json!({}));
        }
        // Over carries only the cursor position, and DragDropEvent is
        // non_exhaustive — anything newer lands here too.
        _ => {}
    }
}

/// Turns pending drops into durable roots: re-runs the drop-time scope
/// grant (runtime scopes do not outlive the process, so the command stays
/// correct even after a mid-review reset) and records each root in
/// `roots.json`, the provenance `register_saved_gallery_roots` re-grants
/// at launch. Only paths the pending set holds are answered — the page
/// cannot commit a root it merely names.
#[tauri::command]
fn commit_dropped_roots(
    app: AppHandle,
    state: tauri::State<PendingDrops>,
    paths: Vec<String>,
    drop: Option<u64>,
) -> Result<Vec<String>, String> {
    let mut pending = state.0.lock().map_err(|e| e.to_string())?;
    // The page echoes the drop's sequence — a commit for a replaced drop
    // must not spend the pending set its successor now owns.
    if let Some(drop) = drop {
        if drop != pending.0 {
            return Err("the drop was replaced".to_string());
        }
    }
    let events = app.state::<event_clustering::EventState>();
    let inner = events.0.lock().map_err(|e| e.to_string())?;
    // Validate the whole provenanced batch before the first durable commit.
    // A dump alias later in the list cannot leave earlier gallery roots saved.
    let selected: Vec<PathBuf> = paths
        .iter()
        .filter_map(|named| {
            pending
                .1
                .iter()
                .find(|dir| same_path(dir, Path::new(named)))
                .cloned()
        })
        .collect();
    inner.guard_gallery_roots(&selected)?;
    let mut committed = Vec::new();
    for named in &paths {
        let candidate = PathBuf::from(named);
        let Some(index) = pending.1.iter().position(|dir| same_path(dir, &candidate)) else {
            continue;
        };
        let dir = pending.1[index].clone();
        // Per-path, never `?`: a root already committed is durable in
        // roots.json whether or not the command answers Err, so rejecting
        // mid-list would hide real commits from the caller. A failed path
        // stays pending — the page's discard collects it and a retry can
        // still name it — while the reply lists only what committed.
        if let Err(error) = allow_root(&app, &dir)
            .and_then(|_| private_store::record_roots(&inner.paths, std::slice::from_ref(&dir)))
        {
            eprintln!(
                "commit_dropped_roots: {} failed to commit: {error}",
                dir.display()
            );
            continue;
        }
        pending.1.remove(index);
        committed.push(dir.to_string_lossy().to_string());
    }
    Ok(committed)
}

/// Releases pending drops — all of them when `paths` is absent, else the
/// named ones. The runtime scope grant is deliberately NOT revoked: Tauri
/// scopes have no un-grant, and `forbid_directory` is a permanent veto
/// that would also block a later re-drop or picker selection of the same
/// folder. So a discarded root keeps its session scope until exit — the
/// same posture Tauri's built-in drop handler takes for the asset
/// protocol — while its provenance is gone: it was never recorded, and a
/// relaunch knows nothing of it.
#[tauri::command]
fn discard_dropped_roots(
    state: tauri::State<PendingDrops>,
    paths: Option<Vec<String>>,
) -> Result<(), String> {
    let mut pending = state.0.lock().map_err(|e| e.to_string())?;
    match paths {
        None => pending.1.clear(),
        Some(named) => pending.1.retain(|dir| {
            !named
                .iter()
                .any(|path| same_path(dir, &PathBuf::from(path)))
        }),
    }
    Ok(())
}

/// `read_file_range` answers at most this many bytes — the probe's head
/// and extent reads are small by contract, and a bounded reply keeps a
/// compromised renderer from turning the command into a bulk reader.
const READ_FILE_RANGE_MAX_BYTES: u64 = 4 * 1024 * 1024;

/// A bounded window of one granted file's bytes — the metadata probe's
/// head/extent reads for the share pipeline, never whole photographs.
/// `start` is unsigned by construction: a negative or fractional JSON
/// number fails deserialization and rejects before the body runs. The
/// path gate is the fs scope itself — only a path under a picked or
/// pending root is allowed, so a renderer-supplied path outside every
/// grant rejects. Raw bytes over IPC: serde_json would carry the reply
/// as a number array at four times the size.
#[tauri::command]
async fn read_file_range(
    app: AppHandle,
    path: String,
    start: u64,
    length: u64,
) -> Result<tauri::ipc::Response, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if length == 0 || length > READ_FILE_RANGE_MAX_BYTES {
            return Err(format!(
                "read_file_range length must stay within 1..={READ_FILE_RANGE_MAX_BYTES}"
            ));
        }
        let target = PathBuf::from(&path);
        if !app.fs_scope().is_allowed(&target) {
            return Err("read_file_range path is outside the granted roots".to_string());
        }
        let mut file = std::fs::File::open(&target).map_err(|e| e.to_string())?;
        file.seek(std::io::SeekFrom::Start(start))
            .map_err(|e| e.to_string())?;
        let mut buffer = Vec::new();
        file.take(length)
            .read_to_end(&mut buffer)
            .map_err(|e| e.to_string())?;
        Ok(tauri::ipc::Response::new(buffer))
    })
    .await
    .map_err(|e| e.to_string())?
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

/// The name the Mac's owner gave the machine ("Mahesh's MacBook Air"). It
/// stays on this Mac: the catalogue shows it in Settings, and the account's
/// device list deliberately holds no name at all — only the random device id
/// and the generic kind below. No serial, MAC address or hardware UUID is
/// ever read.
#[tauri::command]
fn device_label() -> String {
    let run = |program: &str, args: &[&str]| {
        std::process::Command::new(program)
            .args(args)
            .output()
            .ok()
            .filter(|o| o.status.success())
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    };
    if let Some(name) = run("scutil", &["--get", "ComputerName"]) {
        return name;
    }
    run("hostname", &[])
        .map(|s| s.trim_end_matches(".local").to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "This Mac".to_string())
}

/// The generic kind the account's device list records. Never the model, the
/// name or anything identifying — just the platform family, so the owner's
/// pills can read "Mac" or "Windows".
#[tauri::command]
fn device_kind() -> String {
    match std::env::consts::OS {
        "macos" => "mac",
        "windows" => "windows",
        "linux" => "linux",
        // iOS and Android are reported by the Capacitor shells, never here.
        _ => "mac",
    }
    .to_string()
}

/// Vault ciphertext lives under the app's own Application Support directory.
/// Every path the renderer supplies is validated to stay inside
/// `manorama-vault-v1` — no absolute paths, no traversal — so the capability
/// layer can keep its "no fs write" posture for the rest of the filesystem
/// while the vault writes freely in its own root.
const VAULT_DIR_NAME: &str = "manorama-vault-v1";
/// Per-gallery AES-256 keys live in the login Keychain under this service.
/// Without them the ciphertext is dead bytes — that, not file permissions,
/// is what keeps the vault readable only through this app. Entries are
/// addressed by the vault's own names, so only vault keys are ever touched.
const VAULT_KEYCHAIN_SERVICE: &str = "in.thecontrarian.manorama.vault";

/// The vault's root under the app's own local-data directory — every vault
/// command resolves renderer paths relative to it and nowhere else.
fn vault_root(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_local_data_dir()
        .map(|dir| dir.join(VAULT_DIR_NAME))
        .map_err(|e| e.to_string())
}

/// Maps a renderer-supplied logical path (`manorama-vault-v1/<entry>`) to a
/// real path inside the vault root. Segments that could escape — `..`, `.`,
/// backslashes, a missing prefix — are rejected outright.
fn vault_entry_path(app: &AppHandle, path: &str) -> Result<PathBuf, String> {
    let relative = path
        .strip_prefix(&format!("{VAULT_DIR_NAME}/"))
        .ok_or_else(|| "Vault paths must stay inside the vault root".to_string())?;
    if relative.is_empty()
        || relative.contains('\\')
        || relative
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err("Vault paths must stay inside the vault root".to_string());
    }
    Ok(vault_root(app)?.join(relative))
}

/// Raw bytes over IPC, not a JSON number array — a multi-MB record must
/// cross the webview boundary unchanged, and serde_json would carry it at
/// four times the size. An absent file answers an empty body. The read runs
/// on a blocking thread: synchronous commands run on the main thread, where
/// a large file would stall the webview's own event loop.
#[tauri::command]
async fn vault_read(app: AppHandle, path: String) -> Result<tauri::ipc::Response, String> {
    tauri::async_runtime::spawn_blocking(move || {
        match std::fs::read(vault_entry_path(&app, &path)?) {
            Ok(bytes) => Ok(tauri::ipc::Response::new(bytes)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                Ok(tauri::ipc::Response::new(Vec::new()))
            }
            Err(error) => Err(error.to_string()),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The ciphertext arrives as the raw request body; the logical path rides in
/// the `x-vault-path` header so the body stays pure record bytes.
#[tauri::command]
async fn vault_write(app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let path = request
        .headers()
        .get("x-vault-path")
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned)
        .ok_or_else(|| "vault_write needs the x-vault-path header".to_string())?;
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("vault_write expects a raw byte body".to_string());
    };
    let bytes = bytes.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let target = vault_entry_path(&app, &path)?;
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(&target, &bytes).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Atomic rename inside the vault root — the temp-file commit step that keeps
/// a half-written record from ever being indexed.
#[tauri::command]
async fn vault_move(app: AppHandle, from: String, to: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::rename(vault_entry_path(&app, &from)?, vault_entry_path(&app, &to)?)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// "Already missing" is the only absorbed outcome — a delete that could leave
/// a real file behind must report so purge never claims an unproven removal.
#[tauri::command]
async fn vault_remove(app: AppHandle, path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        match std::fs::remove_file(vault_entry_path(&app, &path)?) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.to_string()),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// One file in the vault walk: the renderer's logical path plus its byte
/// length, so usage and purge agree on what a file costs.
#[derive(serde::Serialize)]
struct VaultFileStat {
    path: String,
    bytes: u64,
}

/// Recursively collect every file under `dir`, building logical
/// `manorama-vault-v1/...` paths — a missing root is an empty walk, not an
/// error, so a fresh vault reports zero files.
fn walk_vault(dir: &PathBuf, prefix: &str, files: &mut Vec<VaultFileStat>) -> Result<(), String> {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.to_string()),
    };
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().to_string();
        let logical = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{prefix}/{name}")
        };
        if entry.file_type().map_err(|e| e.to_string())?.is_dir() {
            walk_vault(&entry.path(), &logical, files)?;
        } else {
            files.push(VaultFileStat {
                path: format!("{VAULT_DIR_NAME}/{logical}"),
                bytes: entry.metadata().map(|meta| meta.len()).unwrap_or(0),
            });
        }
    }
    Ok(())
}

/// Every file under the vault root, with logical byte lengths and paths in
/// the renderer's `manorama-vault-v1/...` shape — usage accounting and purge
/// verification read it identically on both shells.
#[tauri::command]
async fn vault_list(app: AppHandle) -> Result<Vec<VaultFileStat>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut files = Vec::new();
        walk_vault(&vault_root(&app)?, "", &mut files)?;
        Ok(files)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The debug log is a diagnostic aid, not a journal — past this many bytes it
/// starts over rather than growing without bound.
const VAULT_LOG_MAX_BYTES: u64 = 512 * 1024;

/// Diagnostic sink for the vault's serialized internals — the renderer cannot
/// see inside them and the unified log does not capture stderr from an
/// open-launched app. The file lives inside the vault root so the vault's own
/// clear flow removes its gallery identifiers with everything else.
#[tauri::command]
async fn vault_log(app: AppHandle, line: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        use std::io::Write as _;
        // The pre-move location outside the vault root still holds identifiers
        // on older installs — drop it whenever the sink runs.
        if let Ok(dir) = app.path().app_local_data_dir() {
            let _ = std::fs::remove_file(dir.join("vault-debug.log"));
        }
        let target = vault_root(&app)?.join("vault-debug.log");
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let oversized = std::fs::metadata(&target)
            .map(|meta| meta.len() > VAULT_LOG_MAX_BYTES)
            .unwrap_or(false);
        // truncate() alone grants no access — write(true) is what lets the
        // oversized branch actually replace the file.
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .append(!oversized)
            .truncate(oversized)
            .open(&target)
            .map_err(|e| e.to_string())?;
        let millis = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        if oversized {
            writeln!(
                file,
                "{millis} vault-debug.log rotated past {VAULT_LOG_MAX_BYTES} bytes"
            )
            .map_err(|e| e.to_string())?;
        }
        writeln!(file, "{millis} {line}").map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Build a Keychain entry handle for a vault key name — creation is cheap
/// and does not touch the keychain until an operation runs on it.
fn vault_key_entry(name: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(VAULT_KEYCHAIN_SERVICE, name).map_err(|e| e.to_string())
}

/// The identity a synced row names. A random UUID minted once and kept in
/// the platform credential store — the same place vault keys live — so a
/// catalogue reset or reinstall stops orphaning the device's own synced
/// rows as un-openable mirrors. It is not a serial, MAC address or
/// hardware UUID: the privacy rule `device_label` documents stays true.
#[tauri::command]
async fn device_id() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let entry = vault_key_entry("device-id")?;
        match entry.get_password() {
            Ok(existing) if !existing.is_empty() => Ok(existing),
            _ => {
                let minted = uuid::Uuid::new_v4().to_string();
                entry.set_password(&minted).map_err(|e| e.to_string())?;
                Ok(minted)
            }
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Fetch one gallery key. Absent and "could not read" are deliberately
/// different answers: the vault treats absent as a clean miss but a storage
/// error must surface, never read back as a deleted key.
#[tauri::command]
async fn vault_key_get(name: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || match vault_key_entry(&name)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(error.to_string()),
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Store one gallery key — the only write the Keychain ever sees from this
/// app, under the vault's own service.
#[tauri::command]
async fn vault_key_set(name: String, value: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        vault_key_entry(&name)?
            .set_password(&value)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// A key that survives removal must fail loudly — a verified purge depends on
/// knowing the ciphertext really is unreachable. "Already absent" passes.
#[tauri::command]
async fn vault_key_remove(name: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        match vault_key_entry(&name)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(error.to_string()),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Binds 127.0.0.1 on an ephemeral port and returns the port. Beginning a
/// new flow cancels any listener still waiting on an abandoned one.
#[tauri::command]
fn oauth_loopback_begin(state: tauri::State<LoopbackState>) -> Result<u16, String> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
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

/// The desktop app's entry point — registers every command and starts the
/// Tauri event loop.
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
        // Native reqwest transport for calls CORS forbids a webview —
        // Proton Drive's API answers only drive.proton.me origins, so the
        // shared link verifier routes through this instead.
        .plugin(tauri_plugin_http::init())
        // Persists and restores the window's size, position and maximised
        // state — the restore hooks into window creation, so the saved frame
        // lands before the config's default 1280x840 can flash on screen.
        // FULLSCREEN is excluded: the app declares it in tauri.conf.json and
        // must always open fullscreen, so a state saved while the user had
        // stepped out of it must not restore `fullscreen: false` next launch.
        // The saved size/position still apply the moment fullscreen is left.
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::all()
                        - tauri_plugin_window_state::StateFlags::FULLSCREEN,
                )
                .build(),
        )
        .manage(LoopbackState(Mutex::new(None)))
        .manage(PendingDrops(Mutex::new((0, Vec::new()))))
        .register_asynchronous_uri_scheme_protocol(
            event_clustering::EVENT_SCHEME,
            event_clustering::serve_event_asset,
        )
        .invoke_handler(tauri::generate_handler![
            device_label,
            device_kind,
            device_id,
            pick_gallery_root,
            register_saved_gallery_roots,
            commit_dropped_roots,
            discard_dropped_roots,
            read_file_range,
            oauth_loopback_begin,
            oauth_loopback_cancel,
            oauth_loopback_finish,
            private_store::read_private_file,
            private_store::write_private_file,
            private_store::delete_private_file,
            event_clustering::pick_raw_dump_root,
            event_clustering::get_raw_dump_status,
            event_clustering::scan_raw_dump_events,
            event_clustering::clear_raw_dump_root,
            event_clustering::get_event_asset_image,
            event_clustering::reveal_event_asset,
            vault_read,
            vault_write,
            vault_move,
            vault_remove,
            vault_list,
            vault_key_get,
            vault_key_set,
            vault_key_remove,
            vault_log,
        ])
        .setup(|app| {
            let paths = private_store::StorePaths::from_args(
                app.path().app_config_dir()?,
                std::env::args_os().skip(1),
            )
            .map_err(std::io::Error::other)?;
            let events =
                event_clustering::EventState::load(paths.clone()).map_err(std::io::Error::other)?;
            app.manage(paths);
            app.manage(events);
            app.state::<event_clustering::EventState>()
                .restore_watcher(app.handle().clone())
                .map_err(std::io::Error::other)?;
            // A cold start via the custom scheme delivers the launch URLs
            // here instead of through on_open_url — forward them so the
            // front end sees one delivery path either way.
            if let Ok(Some(urls)) = app.deep_link().get_current() {
                for url in urls {
                    let _ = app.emit("manorama://deep-link", url.to_string());
                }
            }
            // Folder drag-and-drop → the page's manorama:// events plus the
            // pending set the commit/discard commands look up. The listener
            // is additive: Tauri's own tauri://drag-* emits keep firing.
            if let Some(window) = app.get_webview_window("main") {
                let app_handle = app.handle().clone();
                window.on_webview_event(move |event| {
                    if let tauri::WebviewEvent::DragDrop(drag) = event {
                        handle_folder_drag(&app_handle, drag);
                    }
                });
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running manorama desktop");
}
