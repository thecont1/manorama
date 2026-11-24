//! Rust-owned raw-dump policy. No renderer paths, pixel decoding, provider
//! mutation or network access. The portable core owns metadata and grouping.
use crate::private_store::{self, StorePaths};
use cap_fs_ext::{DirExt, FollowSymlinks, OpenOptionsFollowExt};
use cap_std::fs::{Dir, Metadata, OpenOptions};
use manorama_events::{
    fs_scan, Calendar, ClusteringConfig, EventCluster, EventClusterer, EventIndex,
    SourceFingerprint,
};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, VecDeque},
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex, Weak,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{
    http::{header, Method, Request, Response, StatusCode},
    AppHandle, Emitter, Manager, Runtime, UriSchemeContext, UriSchemeResponder,
};
use tauri_plugin_dialog::DialogExt;

const DECLARATION_FILE: &str = "raw-dump.json";
const INDEX_FILE: &str = "events-index.json";
const CHANGED_EVENT: &str = "manorama://raw-dump-changed";
const DEBOUNCE: Duration = Duration::from_millis(350);
const HEADER_LIMIT: u64 = 4 * 1024 * 1024;
pub(crate) const EVENT_SCHEME: &str = "manorama-event";
const ASSET_LEASE_LIMIT: usize = 256;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
struct FileIdentity {
    device: u64,
    inode: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Declaration {
    root_path: PathBuf,
    #[serde(default)]
    root_identity: Option<FileIdentity>,
    source_id: String,
    label: String,
    #[serde(default)]
    indexed_zone: Option<String>,
}

// The device UUID survives clearing a source, without touching the Keychain or
// the renderer-owned device record. A source UUID changes with each new pick.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SavedDeclaration {
    device_id: String,
    source: Option<Declaration>,
}

pub(crate) struct EventState(pub Arc<Mutex<Inner>>);

#[derive(Default)]
struct AssetLeases {
    order: VecDeque<String>,
    entries: HashMap<String, VerifiedAsset>,
}

impl AssetLeases {
    fn insert(&mut self, token: String, asset: VerifiedAsset) {
        if self.entries.insert(token.clone(), asset).is_none() {
            self.order.push_back(token);
        }
        while self.order.len() > ASSET_LEASE_LIMIT {
            if let Some(oldest) = self.order.pop_front() {
                self.entries.remove(&oldest);
            }
        }
    }

    fn get(&self, token: &str) -> Option<&VerifiedAsset> {
        self.entries.get(token)
    }

    fn clear(&mut self) {
        self.order.clear();
        self.entries.clear();
    }
}

#[derive(Clone)]
struct VerifiedAsset {
    generation: u64,
    root_identity: FileIdentity,
    member: VerifiedMember,
}

#[derive(Clone)]
struct VerifiedMember {
    parent: Arc<Dir>,
    name: PathBuf,
    identity: FileIdentity,
    mime: &'static str,
    ancestors: Vec<(PathBuf, FileIdentity)>,
}

pub(crate) struct Inner {
    pub paths: StorePaths,
    device_id: String,
    source: Option<Declaration>,
    index: Option<EventIndex>,
    generation: u64,
    scan_sequence: u64,
    watcher: Option<DumpWatcher>,
    assets: AssetLeases,
}

impl EventState {
    pub fn load(paths: StorePaths) -> Result<Self, String> {
        let saved = match private_store::read_optional(&paths.config.join(DECLARATION_FILE))? {
            Some(bytes) => {
                serde_json::from_slice::<SavedDeclaration>(&bytes).map_err(|e| e.to_string())?
            }
            None => SavedDeclaration {
                device_id: uuid::Uuid::new_v4().to_string(),
                source: None,
            },
        };
        if uuid::Uuid::parse_str(&saved.device_id).is_err() {
            return Err("Invalid private device identity".into());
        }
        let mut inner = Inner {
            paths,
            device_id: saved.device_id,
            source: saved.source,
            index: None,
            generation: 0,
            scan_sequence: 0,
            watcher: None,
            assets: AssetLeases::default(),
        };
        if let Some(source) = &inner.source {
            let approved = private_store::raw_dump_roots_at(&inner.paths)?
                .iter()
                .any(|root| crate::same_path(Path::new(root), &source.root_path));
            if !approved
                || source.root_identity.is_none()
                || uuid::Uuid::parse_str(&source.source_id).is_err()
            {
                inner.source = None;
                private_store::remove_private(&inner.paths.config.join(INDEX_FILE))?;
                inner.save_declaration()?;
            } else {
                guard_dump_candidate(&inner.paths, &source.root_path)?;
                let bytes = private_store::read_optional(&inner.paths.config.join(INDEX_FILE))?;
                inner.index = bytes
                    .as_deref()
                    .and_then(|bytes| {
                        EventIndex::reusable(bytes, &inner.device_id, &source.source_id)
                    })
                    .filter(|index| {
                        index.source.source_kind == EventIndex::FOLDER_SOURCE_KIND
                            && index.source.label == source.label
                            && index.config == ClusteringConfig::default()
                    });
                if bytes.is_some() && inner.index.is_none() {
                    private_store::remove_private(&inner.paths.config.join(INDEX_FILE))?;
                }
            }
        } else {
            // A crash after clearing the declaration but before index deletion
            // must not restore even a correctly encoded old-source cache.
            private_store::remove_private(&inner.paths.config.join(INDEX_FILE))?;
        }
        Ok(Self(Arc::new(Mutex::new(inner))))
    }

    pub fn restore_watcher(&self, app: AppHandle) -> Result<(), String> {
        let mut inner = self.0.lock().map_err(|e| e.to_string())?;
        if let Some(source) = &inner.source {
            if open_source_root(source).is_ok() {
                install_watcher(&mut inner, Arc::downgrade(&self.0), app);
            }
        }
        Ok(())
    }
}

fn open_root(root: &Path) -> Result<Dir, String> {
    Dir::open_ambient_dir(root, cap_std::ambient_authority())
        .map_err(|_| "Raw dump is unavailable".into())
}

fn root_path_identity(root: &Path) -> Result<FileIdentity, String> {
    let metadata = std::fs::symlink_metadata(root).map_err(|_| "Raw dump is unavailable")?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("Raw dump is unavailable".into());
    }
    #[cfg(unix)]
    {
        Ok(FileIdentity {
            device: std::os::unix::fs::MetadataExt::dev(&metadata),
            inode: std::os::unix::fs::MetadataExt::ino(&metadata),
        })
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        Ok(FileIdentity {
            device: u64::from(metadata.volume_serial_number()),
            inode: metadata.file_index(),
        })
    }
}

fn open_source_root(source: &Declaration) -> Result<Dir, String> {
    let expected = source
        .root_identity
        .ok_or("Raw dump grant must be selected again")?;
    if root_path_identity(&source.root_path)? != expected {
        return Err("Raw dump changed since it was selected".into());
    }
    let root = open_root(&source.root_path)?;
    let actual =
        FileIdentity::from_handle(&root.dir_metadata().map_err(|_| "Raw dump is unavailable")?)?;
    if actual != expected {
        return Err("Raw dump changed since it was selected".into());
    }
    Ok(root)
}

fn catalogue_roots(contents: &str) -> Result<Vec<PathBuf>, String> {
    let body: serde_json::Value =
        serde_json::from_str(contents).map_err(|_| "Invalid catalogue".to_string())?;
    let galleries = body
        .get("galleries")
        .and_then(|v| v.as_array())
        .ok_or("Invalid catalogue galleries")?;
    galleries
        .iter()
        .map(|gallery| {
            gallery
                .get("rootPath")
                .and_then(|v| v.as_str())
                .filter(|path| !path.is_empty())
                .map(PathBuf::from)
                .ok_or_else(|| "Invalid gallery root".into())
        })
        .collect()
}

fn guard_dump_candidate(paths: &StorePaths, root: &Path) -> Result<(), String> {
    if let Some(bytes) = private_store::read_optional(&paths.config.join("catalogue.json"))? {
        let contents = std::str::from_utf8(&bytes).map_err(|_| "Invalid catalogue")?;
        if catalogue_roots(contents)?
            .iter()
            .any(|gallery| crate::same_path(gallery, root))
        {
            return Err("A curated gallery cannot also be the raw dump".into());
        }
    }
    Ok(())
}

impl Inner {
    pub fn guard_gallery_roots(&self, roots: &[PathBuf]) -> Result<(), String> {
        if self.source.as_ref().is_some_and(|source| {
            roots
                .iter()
                .any(|root| crate::same_path(root, &source.root_path))
        }) {
            return Err("The raw dump cannot also be a curated gallery".into());
        }
        Ok(())
    }
    pub fn guard_catalogue(&self, contents: &str) -> Result<(), String> {
        // Parse even when unconfigured: corrupt catalogue input must not become
        // a declaration that a later picker silently overlooks.
        self.guard_gallery_roots(&catalogue_roots(contents)?)
    }
    fn save_declaration(&self) -> Result<(), String> {
        let saved = SavedDeclaration {
            device_id: self.device_id.clone(),
            source: self.source.clone(),
        };
        private_store::write_0600(
            &self.paths.config.join(DECLARATION_FILE),
            &serde_json::to_vec(&saved).map_err(|e| e.to_string())?,
        )
    }
    fn replace_source(&mut self, picked: &Path) -> Result<PickReply, String> {
        let picked_root = open_root(picked)?;
        let root_identity = FileIdentity::from_handle(
            &picked_root
                .dir_metadata()
                .map_err(|_| "Raw dump is unavailable")?,
        )?;
        let root = std::fs::canonicalize(picked).map_err(|_| "Raw dump is unavailable")?;
        if root_path_identity(&root)? != root_identity {
            return Err("Raw dump changed while it was selected".into());
        }
        guard_dump_candidate(&self.paths, &root)?;
        let label = root
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("Raw dump")
            .chars()
            .filter(|c| !c.is_control())
            .take(120)
            .collect::<String>();
        let label = if label.trim().is_empty() {
            "Raw dump".into()
        } else {
            label.trim().to_owned()
        };
        // The picker grants access only to this declaration. Generic renderer
        // fs and asset scopes never include the raw dump.
        private_store::record_raw_dump_root(&self.paths, &root)?;
        self.generation += 1;
        self.assets.clear();
        self.watcher = None;
        self.index = None;
        self.source = Some(Declaration {
            root_path: root.clone(),
            root_identity: Some(root_identity),
            source_id: uuid::Uuid::new_v4().to_string(),
            label: label.clone(),
            indexed_zone: None,
        });
        // Invalidate before writing a new declaration; a late scan is now barred
        // even if a disk failure makes this command reject.
        private_store::remove_private(&self.paths.config.join(INDEX_FILE))?;
        self.save_declaration()?;
        Ok(PickReply {
            label,
            item_count: 0,
            root_path: root,
        })
    }
    fn clear(&mut self) -> Result<(), String> {
        self.generation += 1;
        self.watcher = None;
        self.source = None;
        self.index = None;
        self.assets.clear();
        // Forget only this source; its selection was never a generic renderer grant.
        let saved = self.save_declaration();
        let removed = private_store::remove_private(&self.paths.config.join(INDEX_FILE));
        saved.and(removed)
    }
    fn status(&mut self) -> StatusReply {
        if let Some(source) = &self.source {
            // Only the root is opened: no recursive enumeration or photo reads.
            let available = open_source_root(source).is_ok();
            StatusReply {
                configured: true,
                label: Some(source.label.clone()),
                is_available: available,
                last_indexed_at: self
                    .index
                    .as_ref()
                    .map(|i| i.source.last_indexed_at * 1000.0),
                event_count: self.index.as_ref().map_or(0, |i| i.events.len()),
            }
        } else {
            StatusReply {
                configured: false,
                label: None,
                is_available: false,
                last_indexed_at: None,
                event_count: 0,
            }
        }
    }
    fn begin_scan(&mut self, force: bool, zone: String) -> Result<ScanTicket, String> {
        let source = self.source.clone().ok_or("No raw dump configured")?;
        open_source_root(&source)?;
        self.scan_sequence += 1;
        let cache = if !force && source.indexed_zone.as_deref() == Some(&zone) {
            self.index.clone()
        } else {
            None
        };
        Ok(ScanTicket {
            generation: self.generation,
            sequence: self.scan_sequence,
            device_id: self.device_id.clone(),
            source,
            cache,
            zone,
        })
    }
    fn finish_scan(
        &mut self,
        ticket: &ScanTicket,
        index: EventIndex,
        reads: usize,
    ) -> Result<ScanReply, String> {
        if self.generation != ticket.generation || self.scan_sequence != ticket.sequence {
            return Err("Raw dump changed during scan".into());
        }
        open_source_root(&ticket.source)?;
        private_store::write_0600(
            &self.paths.config.join(INDEX_FILE),
            &index.encode().map_err(|e| e.to_string())?,
        )?;
        if let Some(source) = &mut self.source {
            source.indexed_zone = Some(ticket.zone.clone());
        }
        self.save_declaration()?;
        let reply = scan_reply(&index, &ticket.source.root_path, reads);
        self.index = Some(index);
        Ok(reply)
    }
}

struct ScanTicket {
    generation: u64,
    sequence: u64,
    device_id: String,
    source: Declaration,
    cache: Option<EventIndex>,
    zone: String,
}
impl ScanTicket {
    fn run(&self) -> Result<(EventIndex, usize), String> {
        open_source_root(&self.source)?;
        let calendar = Calendar::iana(&self.zone).map_err(|e| e.to_string())?;
        let config = ClusteringConfig::default();
        let scan = fs_scan::scan(&self.source.root_path, self.cache.as_ref(), &calendar)
            .map_err(|_| "Raw dump is unavailable or could not be scanned".to_string())?;
        let items = scan.item_cache.values().cloned().collect::<Vec<_>>();
        let result = EventClusterer::new(&self.source.source_id, config.clone(), calendar)
            .map_err(|e| e.to_string())?
            .cluster(&items)
            .map_err(|e| e.to_string())?;
        let source = SourceFingerprint {
            device_id: self.device_id.clone(),
            source_id: self.source.source_id.clone(),
            source_kind: EventIndex::FOLDER_SOURCE_KIND.into(),
            label: self.source.label.clone(),
            last_indexed_at: 0.0,
        };
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_secs_f64();
        let index = EventIndex::new(source, config)
            .applying(&result, scan.item_cache, now)
            .map_err(|e| e.to_string())?;
        open_source_root(&self.source)?;
        Ok((index, scan.metadata_read_count))
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StatusReply {
    configured: bool,
    label: Option<String>,
    is_available: bool,
    last_indexed_at: Option<f64>,
    event_count: usize,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PickReply {
    label: String,
    item_count: usize,
    root_path: PathBuf,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScanReply {
    clusters: serde_json::Value,
    screenshot_count: usize,
    root_path: PathBuf,
    metadata_read_count: usize,
    event_count: usize,
    last_indexed_at: f64,
}
fn wire_clusters(events: &[EventCluster]) -> serde_json::Value {
    // Explicit conversion only at the bridge; portable index dates stay seconds.
    let mut value = serde_json::to_value(events).expect("validated core events");
    for event in value.as_array_mut().expect("event array") {
        for field in ["startDate", "endDate"] {
            event[field] = serde_json::json!(event[field].as_f64().unwrap() * 1000.0);
        }
        if let Some(days) = event.get_mut("subDays").and_then(|v| v.as_array_mut()) {
            for day in days {
                day["date"] = serde_json::json!(day["date"].as_f64().unwrap() * 1000.0);
            }
        }
    }
    value
}
fn scan_reply(index: &EventIndex, root: &Path, reads: usize) -> ScanReply {
    ScanReply {
        clusters: wire_clusters(&index.events),
        screenshot_count: index.screenshot_item_ids.len(),
        root_path: root.into(),
        metadata_read_count: reads,
        event_count: index.events.len(),
        last_indexed_at: index.source.last_indexed_at * 1000.0,
    }
}

fn declare_raw_dump_root(inner: &mut Inner, root: &Path) -> Result<PickReply, String> {
    // Selecting a folder declares it only; Camera Roll activation owns the scan.
    inner.replace_source(root)
}

#[tauri::command]
pub(crate) async fn pick_raw_dump_root(app: AppHandle) -> Result<Option<PickReply>, String> {
    let Some(picked) = app.dialog().file().blocking_pick_folder() else {
        return Ok(None);
    };
    let Some(root) = picked.as_path().map(Path::to_path_buf) else {
        return Ok(None);
    };
    let worker = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = worker.state::<EventState>();
        let mut inner = state.0.lock().map_err(|e| e.to_string())?;
        let reply = declare_raw_dump_root(&mut inner, &root)?;
        install_watcher(&mut inner, Arc::downgrade(&state.0), worker.clone());
        Ok(Some(reply))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) fn get_raw_dump_status(app: AppHandle) -> Result<StatusReply, String> {
    let state = app.state::<EventState>();
    let mut inner = state.0.lock().map_err(|e| e.to_string())?;
    let status = inner.status();
    if status.is_available && inner.watcher.is_none() {
        install_watcher(&mut inner, Arc::downgrade(&state.0), app.clone());
    }
    Ok(status)
}

#[tauri::command]
pub(crate) async fn scan_raw_dump_events(
    app: AppHandle,
    force: Option<bool>,
) -> Result<ScanReply, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let zone =
            iana_time_zone::get_timezone().map_err(|_| "Could not resolve OS capture timezone")?;
        let state = app.state::<EventState>();
        let ticket = state
            .0
            .lock()
            .map_err(|e| e.to_string())?
            .begin_scan(force.unwrap_or(false), zone)?;
        // No state lock is held while scanning or clustering. Clear/change wins
        // publication, including every cache write, by generation comparison.
        let (index, reads) = ticket.run()?;
        let result = state
            .0
            .lock()
            .map_err(|e| e.to_string())?
            .finish_scan(&ticket, index, reads);
        result
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) fn clear_raw_dump_root(app: AppHandle) -> Result<(), String> {
    app.state::<EventState>()
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .clear()
}

struct DumpWatcher {
    _watcher: RecommendedWatcher,
    cancelled: Arc<AtomicBool>,
}
impl Drop for DumpWatcher {
    fn drop(&mut self) {
        self.cancelled.store(true, Ordering::SeqCst);
    }
}
fn change_payload() -> serde_json::Value {
    serde_json::json!({})
}
fn install_watcher(inner: &mut Inner, state: Weak<Mutex<Inner>>, app: AppHandle) {
    inner.watcher = None;
    let Some(source) = &inner.source else { return };
    let generation = inner.generation;
    let Ok(watcher) = start_watcher(&source.root_path, move || {
        let Some(state) = state.upgrade() else { return };
        let Ok(inner) = state.lock() else { return };
        if inner.generation == generation && inner.source.is_some() {
            let _ = app.emit(CHANGED_EVENT, change_payload());
        }
    }) else {
        return;
    };
    inner.watcher = Some(watcher);
}
fn start_watcher(root: &Path, emit: impl Fn() + Send + 'static) -> Result<DumpWatcher, String> {
    let (tx, rx) = mpsc::sync_channel(1);
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        if event.is_ok_and(|event| !matches!(event.kind, notify::EventKind::Access(_))) {
            let _ = tx.try_send(());
        }
    })
    .map_err(|e| e.to_string())?;
    watcher
        .watch(root, RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;
    let cancelled = Arc::new(AtomicBool::new(false));
    let stop = cancelled.clone();
    std::thread::spawn(move || {
        while rx.recv().is_ok() {
            loop {
                if stop.load(Ordering::SeqCst) {
                    return;
                }
                match rx.recv_timeout(DEBOUNCE) {
                    Ok(()) => continue,
                    Err(mpsc::RecvTimeoutError::Disconnected) => return,
                    Err(mpsc::RecvTimeoutError::Timeout) => break,
                }
            }
            if !stop.load(Ordering::SeqCst) {
                emit();
            }
        }
    });
    Ok(DumpWatcher {
        _watcher: watcher,
        cancelled,
    })
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AssetPurpose {
    Thumbnail,
    Viewer,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AssetReply {
    items: Vec<AssetItem>,
}
#[derive(Debug, Serialize)]
pub(crate) struct AssetItem {
    id: String,
    url: Option<String>,
    width: u32,
    height: u32,
    state: &'static str,
}
fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 4096
        && !id.chars().any(|c| c.is_control())
        && !id.contains(['\\', ':'])
        && !id.starts_with('/')
        && id
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..")
        && Path::new(id)
            .extension()
            .and_then(|s| s.to_str())
            .is_some_and(|s| fs_scan::IMAGE_EXTENSIONS.contains(&s.to_ascii_lowercase().as_str()))
}
fn local(metadata: &Metadata) -> bool {
    #[cfg(windows)]
    {
        use cap_std::fs::MetadataExt;
        if !fs_scan::windows_pixels_are_local(metadata.file_attributes()) {
            return false;
        }
    }
    #[cfg(unix)]
    {
        use cap_std::fs::MetadataExt;
        if metadata.len() > 0 && metadata.blocks() == 0 {
            return false;
        }
    }
    true
}
type BoundMember = (Dir, PathBuf, Vec<(PathBuf, FileIdentity)>);

// Traverse no-follow directory handles and return a pinned parent + leaf. The
// pathname identities let a later request reject an ancestor replacement even
// though the pinned handle still refers to the original directory.
fn bound_member(root: &Dir, root_path: &Path, id: &str) -> Result<BoundMember, String> {
    if !valid_id(id) {
        return Err("Invalid event asset id".into());
    }
    let root_identity =
        FileIdentity::from_handle(&root.dir_metadata().map_err(|_| "Raw dump is unavailable")?)?;
    let mut parent = root.try_clone().map_err(|_| "Raw dump is unavailable")?;
    let mut parent_path = root_path.to_path_buf();
    let mut ancestors = vec![(parent_path.clone(), root_identity)];
    let mut parts = id.split('/').peekable();
    while let Some(part) = parts.next() {
        if parts.peek().is_none() {
            return Ok((parent, PathBuf::from(part), ancestors));
        }
        parent = parent
            .open_dir_nofollow(part)
            .map_err(|_| "Event asset parent is unavailable")?;
        parent_path.push(part);
        let identity = FileIdentity::from_handle(
            &parent
                .dir_metadata()
                .map_err(|_| "Event asset parent is unavailable")?,
        )?;
        ancestors.push((parent_path.clone(), identity));
    }
    Err("Invalid event asset id".into())
}

fn member_chain_is_current(member: &VerifiedMember) -> bool {
    member
        .ancestors
        .iter()
        .all(|(path, expected)| root_path_identity(path).ok() == Some(*expected))
}

impl FileIdentity {
    #[cfg(unix)]
    fn from_handle(metadata: &Metadata) -> Result<Self, String> {
        Ok(Self {
            device: cap_std::fs::MetadataExt::dev(metadata),
            inode: cap_std::fs::MetadataExt::ino(metadata),
        })
    }

    #[cfg(windows)]
    fn from_handle(metadata: &Metadata) -> Result<Self, String> {
        use cap_std::fs::MetadataExt;
        let device = metadata
            .volume_serial_number()
            .ok_or("Event identity is unavailable")?;
        let inode = metadata
            .file_index()
            .ok_or("Event identity is unavailable")?;
        Ok(Self {
            device: u64::from(device),
            inode,
        })
    }

    #[cfg(unix)]
    fn from_path(path: &Path) -> Result<Self, String> {
        let metadata = std::fs::symlink_metadata(path).map_err(|_| "Event asset is missing")?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err("Event asset is missing".into());
        }
        Ok(Self {
            device: std::os::unix::fs::MetadataExt::dev(&metadata),
            inode: std::os::unix::fs::MetadataExt::ino(&metadata),
        })
    }

    #[cfg(windows)]
    fn from_path(path: &Path) -> Result<Self, String> {
        let parent = path.parent().ok_or("Event asset is missing")?;
        let name = path.file_name().ok_or("Event asset is missing")?;
        let parent = Dir::open_ambient_dir(parent, cap_std::ambient_authority())
            .map_err(|_| "Event asset parent is unavailable")?;
        let file = open_for_identity(&parent, name)?;
        let metadata = file.metadata().map_err(|_| "Event asset is missing")?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err("Event asset is missing".into());
        }
        Self::from_handle(&metadata)
    }

    #[cfg(windows)]
    fn from_member(parent: &Dir, name: &Path, metadata: &Metadata) -> Result<Self, String> {
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err("Event asset is missing".into());
        }
        let file = open_for_identity(parent, name)?;
        let metadata = file.metadata().map_err(|_| "Event asset is missing")?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err("Event asset is missing".into());
        }
        Self::from_handle(&metadata)
    }

    #[cfg(unix)]
    fn from_member(parent: &Dir, name: &Path, metadata: &Metadata) -> Result<Self, String> {
        let _ = parent;
        let _ = name;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err("Event asset is missing".into());
        }
        Self::from_handle(metadata)
    }
}

#[cfg(windows)]
fn open_for_identity(parent: &Dir, name: &Path) -> Result<cap_std::fs::File, String> {
    use cap_fs_ext::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::{FILE_FLAG_OPEN_NO_RECALL, FILE_READ_ATTRIBUTES};
    let mut options = OpenOptions::new();
    options.read(true).follow(FollowSymlinks::No);
    options
        .access_mode(FILE_READ_ATTRIBUTES)
        .custom_flags(FILE_FLAG_OPEN_NO_RECALL);
    parent
        .open_with(name, &options)
        .map_err(|_| "Event asset is unavailable".into())
}

fn open_verified_file(member: &VerifiedMember) -> Result<cap_std::fs::File, String> {
    if !member_chain_is_current(member) {
        return Err("Event asset directory changed since it was verified".into());
    }
    let mut options = OpenOptions::new();
    options.read(true).follow(FollowSymlinks::No);
    let file = member
        .parent
        .open_with(&member.name, &options)
        .map_err(|_| "Event asset is unavailable".to_string())?;
    if !member_chain_is_current(member) {
        return Err("Event asset directory changed since it was verified".into());
    }
    let metadata = file.metadata().map_err(|_| "Event asset is unavailable")?;
    if !local(&metadata) || FileIdentity::from_handle(&metadata)? != member.identity {
        return Err("Event asset changed since it was verified".into());
    }
    Ok(file)
}

fn prepare_asset(root: &Dir, root_path: &Path, id: String) -> (AssetItem, Option<VerifiedMember>) {
    let mut item = AssetItem {
        id: id.clone(),
        url: None,
        width: 0,
        height: 0,
        state: "missing",
    };
    let Some((parent, name, ancestors)) = bound_member(root, root_path, &id).ok() else {
        return (item, None);
    };
    let Ok(meta) = parent.symlink_metadata(&name) else {
        return (item, None);
    };
    if meta.file_type().is_symlink() || !meta.is_file() {
        return (item, None);
    }
    if !local(&meta) {
        item.state = "cloudOnly";
        return (item, None);
    }
    let mut options = OpenOptions::new();
    options.read(true).follow(FollowSymlinks::No);
    let Ok(mut file) = parent.open_with(&name, &options) else {
        item.state = "failed";
        return (item, None);
    };
    let Ok(meta) = file.metadata() else {
        item.state = "failed";
        return (item, None);
    };
    if !local(&meta) {
        item.state = "cloudOnly";
        return (item, None);
    }
    let Ok(bytes) = read_header_prefix(&mut file) else {
        item.state = "failed";
        return (item, None);
    };
    let Some((width, height)) = header_dimensions(&bytes) else {
        item.state = "failed";
        return (item, None);
    };
    let Ok(identity) = FileIdentity::from_handle(&meta) else {
        item.state = "failed";
        return (item, None);
    };
    item.width = width;
    item.height = height;
    item.state = "ready";
    (
        item,
        Some(VerifiedMember {
            parent: Arc::new(parent),
            name,
            identity,
            mime: image_mime(&id),
            ancestors,
        }),
    )
}

fn image_mime(id: &str) -> &'static str {
    match Path::new(id)
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("png") => "image/png",
        Some("webp") => "image/webp",
        Some("heic" | "heif") => "image/heic",
        Some("avif") => "image/avif",
        _ => "application/octet-stream",
    }
}

fn lease_asset(
    generation: u64,
    root_identity: FileIdentity,
    member: VerifiedMember,
    leases: &mut AssetLeases,
) -> String {
    let token = uuid::Uuid::new_v4().simple().to_string();
    leases.insert(
        token.clone(),
        VerifiedAsset {
            generation,
            root_identity,
            member,
        },
    );
    #[cfg(windows)]
    let url = format!("http://{EVENT_SCHEME}.localhost/{token}");
    #[cfg(not(windows))]
    let url = format!("{EVENT_SCHEME}://localhost/{token}");
    url
}

fn request_token(raw: &str) -> Option<&str> {
    let unix = format!("{EVENT_SCHEME}://localhost/");
    let windows = format!("http://{EVENT_SCHEME}.localhost/");
    let token = raw
        .strip_prefix(&unix)
        .or_else(|| raw.strip_prefix(&windows))?;
    (token.len() == 32 && token.bytes().all(|byte| byte.is_ascii_hexdigit())).then_some(token)
}

fn lease_is_current(inner: &Inner, asset: &VerifiedAsset) -> bool {
    inner.generation == asset.generation
        && member_chain_is_current(&asset.member)
        && inner.source.as_ref().is_some_and(|source| {
            source.root_identity == Some(asset.root_identity)
                && root_path_identity(&source.root_path).ok() == Some(asset.root_identity)
        })
}

fn byte_range(value: Option<&str>, length: u64) -> Result<Option<(u64, u64)>, String> {
    let Some(value) = value else { return Ok(None) };
    let Some(value) = value.strip_prefix("bytes=") else {
        return Err("Unsupported range unit".into());
    };
    if value.contains(',') {
        return Err("Multiple ranges are not supported".into());
    }
    let (start, end) = value.split_once('-').ok_or("Invalid byte range")?;
    let (start, end) = if start.is_empty() {
        let suffix: u64 = end.parse().map_err(|_| "Invalid byte range")?;
        if suffix == 0 || length == 0 {
            return Err("Unsatisfiable byte range".into());
        }
        (length.saturating_sub(suffix), length - 1)
    } else {
        let start: u64 = start.parse().map_err(|_| "Invalid byte range")?;
        let end = if end.is_empty() {
            length.saturating_sub(1)
        } else {
            end.parse::<u64>().map_err(|_| "Invalid byte range")?
        };
        (start, end.min(length.saturating_sub(1)))
    };
    if length == 0 || start > end || start >= length {
        return Err("Unsatisfiable byte range".into());
    }
    Ok(Some((start, end)))
}

fn asset_error(status: StatusCode) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::CACHE_CONTROL, "private, no-store")
        .body(Vec::new())
        .expect("valid empty response")
}

fn asset_response(asset: &VerifiedAsset, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    if request_token(request.uri().to_string().as_str()).is_none() {
        return asset_error(StatusCode::NOT_FOUND);
    }
    if request.method() != Method::GET && request.method() != Method::HEAD {
        return Response::builder()
            .status(StatusCode::METHOD_NOT_ALLOWED)
            .header(header::ALLOW, "GET, HEAD")
            .header(header::CACHE_CONTROL, "private, no-store")
            .body(Vec::new())
            .expect("valid method response");
    }
    let mut file = match open_verified_file(&asset.member) {
        Ok(file) => file,
        Err(_) => return asset_error(StatusCode::NOT_FOUND),
    };
    let length = match file.metadata().map(|metadata| metadata.len()) {
        Ok(length) if length > 0 => length,
        _ => return asset_error(StatusCode::NOT_FOUND),
    };
    let range = match request
        .headers()
        .get(header::RANGE)
        .and_then(|value| value.to_str().ok())
        .map(|value| byte_range(Some(value), length))
    {
        None | Some(Ok(None)) => None,
        Some(Ok(Some(range))) => Some(range),
        Some(Err(_)) => {
            return Response::builder()
                .status(StatusCode::RANGE_NOT_SATISFIABLE)
                .header(header::CONTENT_RANGE, format!("bytes */{length}"))
                .header(header::CACHE_CONTROL, "private, no-store")
                .body(Vec::new())
                .expect("valid range response");
        }
    };
    let (start, end, status) = range.map_or(
        (0, length.saturating_sub(1), StatusCode::OK),
        |(start, end)| (start, end, StatusCode::PARTIAL_CONTENT),
    );
    let mut builder = Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, asset.member.mime)
        .header(header::CACHE_CONTROL, "private, no-store")
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CONTENT_LENGTH, (end - start + 1).to_string());
    if status == StatusCode::PARTIAL_CONTENT {
        builder = builder.header(
            header::CONTENT_RANGE,
            format!("bytes {start}-{end}/{length}"),
        );
    }
    if request.method() == Method::HEAD {
        return builder.body(Vec::new()).expect("valid head response");
    }
    if file.seek(SeekFrom::Start(start)).is_err() {
        return asset_error(StatusCode::INTERNAL_SERVER_ERROR);
    }
    let mut bytes = Vec::new();
    if file.take(end - start + 1).read_to_end(&mut bytes).is_err() {
        return asset_error(StatusCode::INTERNAL_SERVER_ERROR);
    }
    if !member_chain_is_current(&asset.member) {
        return asset_error(StatusCode::NOT_FOUND);
    }
    builder.body(bytes).expect("valid asset response")
}

fn respond_event_asset(
    state: &Arc<Mutex<Inner>>,
    request: &Request<Vec<u8>>,
    respond: impl FnOnce(Response<Vec<u8>>),
) {
    // Keep clear/change serialized through the response handoff. A cloned lease
    // must not return bytes after the source has already been forgotten.
    let Ok(inner) = state.lock() else {
        respond(asset_error(StatusCode::NOT_FOUND));
        return;
    };
    let response = inner
        .assets
        .get(request_token(request.uri().to_string().as_str()).unwrap_or_default())
        .filter(|asset| lease_is_current(&inner, asset))
        .map_or_else(
            || asset_error(StatusCode::NOT_FOUND),
            |asset| asset_response(asset, request),
        );
    respond(response);
}

pub(crate) fn serve_event_asset<R: Runtime>(
    context: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    if request_token(request.uri().to_string().as_str()).is_none() {
        responder.respond(asset_error(StatusCode::NOT_FOUND));
        return;
    }
    let app = context.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<EventState>();
        respond_event_asset(&state.0, &request, |response| responder.respond(response));
    });
}

struct VerifiedReveal<'a> {
    root: &'a Dir,
    source: &'a Declaration,
    id: &'a str,
    member: &'a VerifiedMember,
}

impl VerifiedReveal<'_> {
    fn path_at_handoff(&self) -> Result<PathBuf, String> {
        if !member_chain_is_current(self.member) {
            return Err("Event asset directory changed since it was verified".into());
        }
        let expected = self
            .source
            .root_identity
            .ok_or("Raw dump grant must be selected again")?;
        if FileIdentity::from_handle(
            &self
                .root
                .dir_metadata()
                .map_err(|_| "Raw dump is unavailable")?,
        )? != expected
            || root_path_identity(&self.source.root_path)? != expected
        {
            return Err("Raw dump changed since it was selected".into());
        }
        let (parent, name, _) = bound_member(self.root, &self.source.root_path, self.id)?;
        let metadata = parent
            .symlink_metadata(&name)
            .map_err(|_| "Event asset is missing")?;
        if FileIdentity::from_member(&parent, &name, &metadata)? != self.member.identity {
            return Err("Event asset changed since it was verified".into());
        }
        let canonical_root =
            std::fs::canonicalize(&self.source.root_path).map_err(|_| "Raw dump is unavailable")?;
        let candidate = canonical_root.join(self.id);
        if FileIdentity::from_path(&candidate)? != self.member.identity
            || std::fs::canonicalize(&candidate).ok().as_ref() != Some(&candidate)
        {
            return Err("Event asset changed since it was verified".into());
        }
        Ok(candidate)
    }
}

fn reveal_verified_member(
    root: &Dir,
    source: &Declaration,
    id: &str,
    reveal: impl FnOnce(VerifiedReveal<'_>) -> Result<(), String>,
) -> Result<(), String> {
    let (parent, name, ancestors) = bound_member(root, &source.root_path, id)?;
    let metadata = parent
        .symlink_metadata(&name)
        .map_err(|_| "Event asset is missing")?;
    let identity = FileIdentity::from_member(&parent, &name, &metadata)?;
    let member = VerifiedMember {
        parent: Arc::new(parent),
        name,
        identity,
        mime: image_mime(id),
        ancestors,
    };
    reveal(VerifiedReveal {
        root,
        source,
        id,
        member: &member,
    })
}
fn validate_batch(
    ids: &[String],
    max_pixel_size: Option<u32>,
    allow_network: Option<bool>,
) -> Result<(), String> {
    if ids.is_empty() || ids.len() > 64 {
        return Err("Event asset batch must contain 1 to 64 ids".into());
    }
    if ids.iter().any(|id| !valid_id(id)) {
        return Err("Invalid event asset id".into());
    }
    let unique: std::collections::HashSet<&str> = ids.iter().map(String::as_str).collect();
    if unique.len() != ids.len() {
        return Err("Duplicate event asset id".into());
    }
    if max_pixel_size.is_some_and(|size| size == 0 || size > 8192) {
        return Err("maxPixelSize must be an integer from 1 to 8192".into());
    }
    if allow_network.unwrap_or(false) {
        return Err("Desktop event assets never download".into());
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn get_event_asset_image(
    app: AppHandle,
    ids: Vec<String>,
    purpose: AssetPurpose,
    max_pixel_size: Option<u32>,
    allow_network: Option<bool>,
) -> Result<AssetReply, String> {
    validate_batch(&ids, max_pixel_size, allow_network)?;
    // Purpose and size are presentation hints only; originals stay byte-exact.
    let _ = purpose;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<EventState>();
        let (generation, source, root) = {
            let inner = state.0.lock().map_err(|e| e.to_string())?;
            let source = inner.source.clone().ok_or("No raw dump configured")?;
            let root = open_source_root(&source)?;
            (inner.generation, source, root)
        };
        let root_identity = source
            .root_identity
            .ok_or("Raw dump grant must be selected again")?;
        let prepared = ids
            .into_iter()
            .map(|id| prepare_asset(&root, &source.root_path, id))
            .collect::<Vec<_>>();
        let mut items = Vec::with_capacity(prepared.len());
        let mut inner = state.0.lock().map_err(|e| e.to_string())?;
        if inner.generation != generation
            || root_path_identity(&source.root_path).ok() != Some(root_identity)
        {
            return Err("Raw dump changed during asset read".into());
        }
        for (mut item, member) in prepared {
            if let Some(member) = member {
                if !member_chain_is_current(&member) {
                    return Err("Raw dump changed during asset read".into());
                }
                item.url = Some(lease_asset(
                    generation,
                    root_identity,
                    member,
                    &mut inner.assets,
                ));
            }
            items.push(item);
        }
        Ok(AssetReply { items })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn reveal_event_asset(app: AppHandle, id: String) -> Result<(), String> {
    if !valid_id(&id) {
        return Err("Invalid event asset id".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<EventState>();
        // Hold the generation lock through launching reveal: clear cannot hand
        // an old source to the OS after it has answered success.
        let inner = state.0.lock().map_err(|e| e.to_string())?;
        let source = inner.source.clone().ok_or("No raw dump configured")?;
        let root = open_source_root(&source)?;
        reveal_verified_member(&root, &source, &id, |target| {
            let path = target.path_at_handoff()?;
            // Public desktop reveal APIs accept pathnames, not directory handles.
            // Revalidate the pinned member at this final boundary; a swap after
            // the OS accepts the path remains an OS handoff limitation.
            tauri_plugin_opener::OpenerExt::opener(&app)
                .reveal_item_in_dir(path)
                .map_err(|e| e.to_string())
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

fn read_header_prefix(reader: impl Read) -> std::io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    reader.take(HEADER_LIMIT).read_to_end(&mut bytes)?;
    Ok(bytes)
}

// Header parsing lives here instead of introducing a bitmap/image framework.
// EXIF supplies dimensions/orientation where present; containers supply a safe
// bounded fallback for photographs with no EXIF. No compressed pixels decode.
fn be16(bytes: &[u8], at: usize) -> Option<u32> {
    Some(u16::from_be_bytes(bytes.get(at..at.checked_add(2)?)?.try_into().ok()?) as u32)
}
fn be32(bytes: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_be_bytes(
        bytes.get(at..at.checked_add(4)?)?.try_into().ok()?,
    ))
}
fn extent(width: u32, height: u32) -> Option<(u32, u32)> {
    (width > 0 && height > 0 && width <= 65535 && height <= 65535).then_some((width, height))
}
fn header_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    let exif = exif::Reader::new()
        .read_from_container(&mut std::io::Cursor::new(bytes))
        .ok();
    let field = |tag| {
        exif.as_ref()?
            .get_field(tag, exif::In::PRIMARY)?
            .value
            .get_uint(0)
    };
    let dimensions = container_dimensions(bytes).or_else(|| {
        extent(
            field(exif::Tag::PixelXDimension)?,
            field(exif::Tag::PixelYDimension)?,
        )
    })?;
    let swap = field(exif::Tag::Orientation).is_some_and(|o| (5..=8).contains(&o));
    Some(if swap {
        (dimensions.1, dimensions.0)
    } else {
        dimensions
    })
}
fn container_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") && bytes.get(12..16) == Some(b"IHDR") {
        return extent(be32(bytes, 16)?, be32(bytes, 20)?);
    }
    if bytes.starts_with(b"\xff\xd8") {
        let mut offset = 2;
        while offset + 4 <= bytes.len() {
            if bytes[offset] != 0xff {
                offset += 1;
                continue;
            }
            let marker = bytes[offset + 1];
            if marker == 0xda || marker == 0xd9 {
                break;
            }
            if marker == 0xff || marker == 0x00 || marker == 0xd8 || (0xd0..=0xd7).contains(&marker)
            {
                offset += 2;
                continue;
            }
            let length = be16(bytes, offset + 2)? as usize;
            if length < 2 || offset.checked_add(length + 2)? > bytes.len() {
                return None;
            }
            if matches!(marker, 0xc0..=0xc3 | 0xc5..=0xc7 | 0xc9..=0xcb | 0xcd..=0xcf) {
                return extent(be16(bytes, offset + 7)?, be16(bytes, offset + 5)?);
            }
            offset += length + 2;
        }
    }
    if bytes.get(..4) == Some(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        let mut offset = 12usize;
        while offset + 8 <= bytes.len() {
            let size =
                u32::from_le_bytes(bytes.get(offset + 4..offset + 8)?.try_into().ok()?) as usize;
            let end = offset.checked_add(8 + size)?;
            // A compressed VP8 payload may exceed the header window. Its first
            // ten bytes still contain the honest extent; never require pixels.
            let data = bytes.get(offset + 8..end.min(bytes.len()))?;
            match bytes.get(offset..offset + 4)? {
                b"VP8X" if data.len() >= 10 => {
                    let le24 = |i| {
                        u32::from(data[i])
                            | u32::from(data[i + 1]) << 8
                            | u32::from(data[i + 2]) << 16
                    };
                    return extent(1 + le24(4), 1 + le24(7));
                }
                b"VP8 " if data.len() >= 10 && data.get(3..6) == Some(b"\x9d\x01\x2a") => {
                    return extent(
                        u16::from_le_bytes(data[6..8].try_into().ok()?) as u32 & 0x3fff,
                        u16::from_le_bytes(data[8..10].try_into().ok()?) as u32 & 0x3fff,
                    )
                }
                b"VP8L" if data.len() >= 5 && data[0] == 0x2f => {
                    let bits = u32::from_le_bytes(data[1..5].try_into().ok()?);
                    return extent((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1);
                }
                _ => {}
            }
            offset = offset.checked_add(8 + size + size % 2)?;
        }
    }
    if bytes.get(4..8) == Some(b"ftyp") {
        return iso_dimensions(bytes);
    }
    None
}

// Walk actual box boundaries (not a byte-pattern search into compressed data).
// Primary-item property associations choose its ispe/irot rather than a preview.
fn iso_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    fn boxes(bytes: &[u8]) -> Vec<(&[u8], &[u8])> {
        let mut found = Vec::new();
        let mut at = 0usize;
        while at + 8 <= bytes.len() {
            let Some(size) = be32(bytes, at) else { break };
            let (size, head) = if size == 1 {
                let Some(data) = bytes.get(at + 8..at + 16) else {
                    break;
                };
                let Ok(size) = usize::try_from(u64::from_be_bytes(data.try_into().unwrap())) else {
                    break;
                };
                (size, 16)
            } else if size == 0 {
                (bytes.len() - at, 8)
            } else {
                (size as usize, 8)
            };
            if size < head {
                break;
            }
            let Some(end) = at.checked_add(size).filter(|end| *end <= bytes.len()) else {
                break;
            };
            found.push((&bytes[at + 4..at + 8], &bytes[at + head..end]));
            at = end;
        }
        found
    }
    let meta = boxes(bytes)
        .into_iter()
        .find(|(kind, _)| *kind == b"meta")?
        .1;
    let children = boxes(meta.get(4..)?);
    let primary = children
        .iter()
        .find(|(kind, _)| *kind == b"pitm")
        .and_then(|(_, data)| {
            if *data.first()? == 0 {
                be16(data, 4)
            } else {
                be32(data, 4)
            }
        });
    let iprp = children.iter().find(|(kind, _)| *kind == b"iprp")?.1;
    let properties = boxes(iprp);
    let ipco = properties.iter().find(|(kind, _)| *kind == b"ipco")?.1;
    let props = boxes(ipco);
    let associations = properties
        .iter()
        .find(|(kind, _)| *kind == b"ipma")
        .and_then(|(_, data)| {
            let primary = primary?;
            let version = *data.first()?;
            let large = *data.get(3)? & 1 != 0;
            let count = be32(data, 4)? as usize;
            if count > 100_000 {
                return None;
            }
            let mut at = 8;
            let mut selected = None;
            for _ in 0..count {
                let id = if version < 1 {
                    let id = be16(data, at)?;
                    at += 2;
                    id
                } else {
                    let id = be32(data, at)?;
                    at += 4;
                    id
                };
                let count = *data.get(at)?;
                at += 1;
                let mut ids = vec![];
                for _ in 0..count {
                    let index = if large {
                        let n = be16(data, at)? as usize & 0x7fff;
                        at += 2;
                        n
                    } else {
                        let n = *data.get(at)? as usize & 0x7f;
                        at += 1;
                        n
                    };
                    if index > 0 {
                        ids.push(index - 1)
                    }
                }
                if id == primary {
                    selected = Some(ids)
                }
            }
            selected
        });
    // Ambiguous secondary extents are not permission to reserve a larger box
    // than the primary photograph. A missing association fails closed unless
    // there is exactly one pixel extent in the container.
    if associations.is_none() && props.iter().filter(|(kind, _)| *kind == b"ispe").count() != 1 {
        return None;
    }
    let indices = associations.unwrap_or_else(|| (0..props.len()).collect());
    let mut best = None;
    let mut rotate = false;
    for index in indices {
        let (kind, data) = *props.get(index)?;
        if kind == b"ispe" {
            let dim = extent(be32(data, 4)?, be32(data, 8)?)?;
            if best.map_or(true, |(w, h)| {
                u64::from(dim.0) * u64::from(dim.1) > u64::from(w) * u64::from(h)
            }) {
                best = Some(dim)
            }
        } else if kind == b"irot" {
            rotate = *data.first()? & 1 != 0;
        }
    }
    let (w, h) = best?;
    Some(if rotate { (h, w) } else { (w, h) })
}

#[cfg(test)]
#[path = "event_clustering_tests.rs"]
mod tests;
