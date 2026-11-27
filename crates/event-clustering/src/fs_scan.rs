//! Recursive raw-dump ingestion, not a gallery scanner. No persistence, image
//! decoding, network access or watcher lives here; the shell owns those policies.
use crate::{
    parser::{self, ImageHeaderProperties},
    Calendar, EventIndex, MediaMetadataItem,
};
use cap_fs_ext::{DirExt, FollowSymlinks, OpenOptionsFollowExt};
use cap_std::{
    ambient_authority,
    fs::{Dir, Metadata, OpenOptions},
};
use exif::{In, Tag, Value as ExifValue};
use serde_json::Value;
use std::sync::Arc;
use std::{
    collections::BTreeMap,
    fs,
    io::{self, BufReader, Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

pub const FILE_ATTRIBUTE_OFFLINE: u32 = 0x1000;
pub const FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS: u32 = 0x400000;
const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
/// std/cap FileType::is_symlink uses name-surrogate tags on Windows (including
/// junctions), not the generic REPARSE_POINT flag. Cloud tags are not links.
pub fn windows_entry_is_visible(attributes: u32, is_symlink: bool) -> bool {
    attributes & FILE_ATTRIBUTE_HIDDEN == 0 && !is_symlink
}
const MAX_HEADER_BYTES: u64 = 4 * 1024 * 1024;
pub const IMAGE_EXTENSIONS: &[&str] = &["jpg", "jpeg", "png", "webp", "avif", "heic", "heif"];

pub fn windows_pixels_are_local(attributes: u32) -> bool {
    attributes & (FILE_ATTRIBUTE_OFFLINE | FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS) == 0
}
#[derive(Clone, Debug)]
pub struct DumpedFile {
    pub path: PathBuf,
    pub relative_path: String,
    pub modification_time: Option<f64>,
    pub creation_time: Option<f64>,
    pub pixels_are_local: bool,
    pub windows_attributes: u32,
    // Display paths are never authority. Pin the enumerated parent even if an
    // ancestor is renamed and replaced before header ingestion.
    parent: Arc<Dir>,
    bound_name: PathBuf,
}
#[derive(Debug)]
pub struct DumpIngest {
    pub item: Option<MediaMetadataItem>,
    pub header_was_opened: bool,
}
#[derive(Debug, Default)]
pub struct ScanResult {
    pub item_cache: BTreeMap<String, MediaMetadataItem>,
    pub metadata_read_count: usize,
    pub unplaced_item_ids: Vec<String>,
}
fn epoch(time: cap_std::time::SystemTime) -> f64 {
    match time.into_std().duration_since(UNIX_EPOCH) {
        Ok(d) => d.as_secs_f64(),
        Err(e) => -e.duration().as_secs_f64(),
    }
}
fn attributes(metadata: &Metadata) -> u32 {
    #[cfg(windows)]
    {
        use cap_std::fs::MetadataExt;
        metadata.file_attributes()
    }
    #[cfg(not(windows))]
    {
        let _ = metadata;
        0
    }
}
fn local(metadata: &Metadata) -> bool {
    if !windows_pixels_are_local(attributes(metadata)) {
        return false;
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
fn walk(
    dir: Arc<Dir>,
    display_root: &Path,
    relative_dir: &Path,
    found: &mut Vec<DumpedFile>,
    before_child: &mut impl FnMut(&Path),
) -> io::Result<()> {
    for entry in dir.entries()? {
        let name = PathBuf::from(entry?.file_name());
        let Some(text) = name.to_str() else { continue };
        if text.starts_with('.') {
            continue;
        }
        let metadata = dir.symlink_metadata(&name)?;
        if !windows_entry_is_visible(attributes(&metadata), metadata.file_type().is_symlink()) {
            continue;
        }
        let relative = relative_dir.join(&name);
        if metadata.is_dir() {
            if ["app", "photoslibrary", "imoviewindow"].iter().any(|ext| {
                name.extension()
                    .is_some_and(|s| s.eq_ignore_ascii_case(ext))
            }) {
                continue;
            }
            before_child(&relative);
            // Even a replacement between metadata and open is confined by dir;
            // never retry via an ambient path on a capability rejection.
            let child = Arc::new(dir.open_dir_nofollow(&name)?);
            walk(child, display_root, &relative, found, before_child)?;
        } else if metadata.is_file() {
            let ext = name
                .extension()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            if !IMAGE_EXTENSIONS.contains(&ext.as_str()) {
                continue;
            }
            found.push(DumpedFile {
                path: display_root.join(&relative),
                relative_path: relative
                    .to_str()
                    .unwrap()
                    .replace(std::path::MAIN_SEPARATOR, "/"),
                modification_time: metadata.modified().ok().map(epoch),
                creation_time: metadata.created().ok().map(epoch),
                pixels_are_local: local(&metadata),
                windows_attributes: attributes(&metadata),
                parent: dir.clone(),
                bound_name: name,
            });
        }
    }
    Ok(())
}
pub fn enumerate(root: &Path) -> io::Result<Vec<DumpedFile>> {
    // This is the sole ambient operation: establish trust at the chosen root
    // boundary before any enumeration, metadata lookup or header read.
    let dir = Arc::new(Dir::open_ambient_dir(root, ambient_authority())?);
    let mut found = vec![];
    walk(dir, root, Path::new(""), &mut found, &mut |_| {})?;
    found.sort_by(|a, b| a.relative_path.as_bytes().cmp(b.relative_path.as_bytes()));
    Ok(found)
}

// A broken container cannot cause an unbounded read (notably TIFF in EXIF
// readers). This is a metadata parser, never a decoder. Missing/oversized or
// unsupported container headers use creation/mtime instead of inventing dates.
struct HeaderWindow {
    file: fs::File,
    position: u64,
}
impl Read for HeaderWindow {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        let remaining = MAX_HEADER_BYTES.saturating_sub(self.position) as usize;
        let count = buffer.len().min(remaining);
        if count == 0 {
            return Ok(0);
        }
        let n = self.file.read(&mut buffer[..count])?;
        self.position += n as u64;
        Ok(n)
    }
}
impl Seek for HeaderWindow {
    fn seek(&mut self, from: SeekFrom) -> io::Result<u64> {
        let target = match from {
            SeekFrom::Start(n) => i128::from(n),
            SeekFrom::Current(n) => i128::from(self.position) + i128::from(n),
            SeekFrom::End(n) => {
                i128::from(self.file.metadata()?.len().min(MAX_HEADER_BYTES)) + i128::from(n)
            }
        };
        if !(0..=i128::from(MAX_HEADER_BYTES)).contains(&target) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "header exceeds read window",
            ));
        }
        self.position = self.file.seek(SeekFrom::Start(target as u64))?;
        Ok(self.position)
    }
}
fn read_header(file: &DumpedFile) -> io::Result<ImageHeaderProperties> {
    // Recheck directory attributes immediately before opening; a cached local
    // descriptor is not permission to hydrate a file that is now offline.
    let meta = file.parent.symlink_metadata(&file.bound_name)?;
    if meta.file_type().is_symlink() || !meta.is_file() || !local(&meta) {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "header is not local",
        ));
    }
    let mut options = OpenOptions::new();
    options.read(true).follow(FollowSymlinks::No);
    let handle = file.parent.open_with(&file.bound_name, &options)?;
    // A metadata-only handle lookup cannot read pixels. Recheck the opened
    // object too, before the EXIF reader, if its cloud state changed meanwhile.
    if !local(&handle.metadata()?) {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "header is not local",
        ));
    }
    let mut reader = BufReader::new(HeaderWindow {
        file: handle.into_std(),
        position: 0,
    });
    let exif = exif::Reader::new()
        .read_from_container(&mut reader)
        .map_err(io::Error::other)?;
    let mut header = ImageHeaderProperties::default();
    let string = |tag| {
        exif.get_field(tag, In::PRIMARY)
            .and_then(|field| match &field.value {
                ExifValue::Ascii(values) => values
                    .first()
                    .and_then(|bytes| std::str::from_utf8(bytes).ok())
                    .map(|s| Value::String(s.trim_end_matches('\0').into())),
                _ => None,
            })
    };
    for (tag, key) in [
        (Tag::DateTimeOriginal, "DateTimeOriginal"),
        (Tag::DateTimeDigitized, "DateTimeDigitized"),
        (Tag::OffsetTimeOriginal, "OffsetTimeOriginal"),
        (Tag::OffsetTime, "OffsetTime"),
    ] {
        if let Some(value) = string(tag) {
            header.exif.insert(key.into(), value);
        }
    }
    for (tag, key) in [(Tag::Make, "Make"), (Tag::Model, "Model")] {
        if let Some(value) = string(tag) {
            header.tiff.insert(key.into(), value);
        }
    }
    for (tag, key) in [
        (Tag::GPSLatitudeRef, "LatitudeRef"),
        (Tag::GPSLongitudeRef, "LongitudeRef"),
    ] {
        if let Some(value) = string(tag) {
            header.gps.insert(key.into(), value);
        }
    }
    for (tag, key) in [
        (Tag::GPSLatitude, "Latitude"),
        (Tag::GPSLongitude, "Longitude"),
    ] {
        if let Some(field) = exif.get_field(tag, In::PRIMARY) {
            if let ExifValue::Rational(values) = &field.value {
                if values.len() == 3 {
                    header.gps.insert(
                        key.into(),
                        Value::Array(values.iter().map(|r| Value::from(r.to_f64())).collect()),
                    );
                }
            }
        }
    }
    Ok(header)
}

/// Injection is for header-provider tests; the locality gate runs BEFORE the
/// callback, including Windows attributes even on a non-Windows test host.
pub fn ingest_with_header<F>(file: &DumpedFile, calendar: &Calendar, reader: F) -> DumpIngest
where
    F: FnOnce(&Path) -> io::Result<ImageHeaderProperties>,
{
    let local = file.pixels_are_local && windows_pixels_are_local(file.windows_attributes);
    let (header, header_was_opened) = if local {
        match reader(&file.path) {
            Ok(header) => (header, true),
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::PermissionDenied | io::ErrorKind::NotFound
                ) =>
            {
                (ImageHeaderProperties::default(), false)
            }
            Err(_) => (ImageHeaderProperties::default(), true),
        }
    } else {
        (ImageHeaderProperties::default(), false)
    };
    let timestamp = parser::capture_date(&header.exif, calendar)
        .or(file.creation_time)
        .or(file.modification_time);
    let item = timestamp.map(|time| {
        let mut item = MediaMetadataItem::new(&file.relative_path, time);
        if let Some((lat, lon)) = parser::coordinate(&header.gps) {
            item.latitude = Some(lat);
            item.longitude = Some(lon);
        }
        item.is_screenshot = parser::is_screenshot(
            &header.tiff,
            file.path.extension().and_then(|s| s.to_str()).unwrap_or(""),
            file.path.file_name().and_then(|s| s.to_str()).unwrap_or(""),
        );
        item.file_mod_time = if header_was_opened {
            file.modification_time
        } else {
            None
        };
        item
    });
    DumpIngest {
        item,
        header_was_opened,
    }
}
pub fn ingest(file: &DumpedFile, calendar: &Calendar) -> DumpIngest {
    ingest_with_header(file, calendar, |_| read_header(file))
}

fn ingest_scanned_file(
    file: &DumpedFile,
    cache: Option<&EventIndex>,
    calendar: &Calendar,
    result: &mut ScanResult,
) {
    let mod_time = if file.pixels_are_local && windows_pixels_are_local(file.windows_attributes) {
        file.modification_time
    } else {
        None
    };
    if let Some(cache) = cache {
        if !cache.needs_metadata_read(&file.relative_path, mod_time) {
            result.item_cache.insert(
                file.relative_path.clone(),
                cache.item_cache[&file.relative_path].clone(),
            );
            return;
        }
    }
    let ingested = ingest(file, calendar);
    result.metadata_read_count += usize::from(ingested.header_was_opened);
    if let Some(item) = ingested.item {
        result.item_cache.insert(item.id.clone(), item);
    } else {
        result.unplaced_item_ids.push(file.relative_path.clone());
    }
}

/// Depth-first scan through an already verified root capability. Each file is
/// ingested while its parent handle is naturally open, so populated folders do
/// not accumulate one descriptor per entry across the scan.
fn scan_walk(
    dir: Arc<Dir>,
    display_root: &Path,
    relative_dir: &Path,
    cache: Option<&EventIndex>,
    calendar: &Calendar,
    result: &mut ScanResult,
) -> io::Result<()> {
    for entry in dir.entries()? {
        let name = PathBuf::from(entry?.file_name());
        let Some(text) = name.to_str() else { continue };
        if text.starts_with('.') {
            continue;
        }
        let metadata = dir.symlink_metadata(&name)?;
        if !windows_entry_is_visible(attributes(&metadata), metadata.file_type().is_symlink()) {
            continue;
        }
        let relative = relative_dir.join(&name);
        if metadata.is_dir() {
            if ["app", "photoslibrary", "imoviewindow"].iter().any(|ext| {
                name.extension()
                    .is_some_and(|s| s.eq_ignore_ascii_case(ext))
            }) {
                continue;
            }
            let child = Arc::new(dir.open_dir_nofollow(&name)?);
            scan_walk(child, display_root, &relative, cache, calendar, result)?;
        } else if metadata.is_file() {
            let ext = name
                .extension()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            if !IMAGE_EXTENSIONS.contains(&ext.as_str()) {
                continue;
            }
            let file = DumpedFile {
                path: display_root.join(&relative),
                relative_path: relative
                    .to_str()
                    .unwrap()
                    .replace(std::path::MAIN_SEPARATOR, "/"),
                modification_time: metadata.modified().ok().map(epoch),
                creation_time: metadata.created().ok().map(epoch),
                pixels_are_local: local(&metadata),
                windows_attributes: attributes(&metadata),
                parent: dir.clone(),
                bound_name: name,
            };
            ingest_scanned_file(&file, cache, calendar, result);
        }
    }
    Ok(())
}

/// Scan through a root handle that the caller has already verified. The path is
/// used only for display names and header-provider compatibility, never to open
/// the root again.
pub fn scan_open_root(
    root_dir: &Dir,
    display_root: &Path,
    cache: Option<&EventIndex>,
    calendar: &Calendar,
) -> io::Result<ScanResult> {
    // The consumer must pass a fingerprint-checked index (EventIndex::reusable).
    let mut result = ScanResult::default();
    let root = root_dir.try_clone()?;
    scan_walk(
        Arc::new(root),
        display_root,
        Path::new(""),
        cache,
        calendar,
        &mut result,
    )?;
    result.unplaced_item_ids.sort();
    Ok(result)
}

pub fn scan(
    root: &Path,
    cache: Option<&EventIndex>,
    calendar: &Calendar,
) -> io::Result<ScanResult> {
    let dir = Dir::open_ambient_dir(root, ambient_authority())?;
    scan_open_root(&dir, root, cache, calendar)
}

#[cfg(all(test, unix))]
mod capability_tests {
    use super::*;
    use std::os::unix::fs::symlink;

    struct TestDir(PathBuf);
    impl TestDir {
        fn new(prefix: &str) -> Self {
            let root = PathBuf::from(
                std::env::var_os("CARGO_TARGET_DIR").unwrap_or_else(|| std::env::temp_dir().into()),
            );
            for suffix in 0..100u32 {
                let path = root.join(format!("{prefix}-{}-{suffix}", std::process::id()));
                if fs::create_dir(&path).is_ok() {
                    return Self(path);
                }
            }
            panic!("could not create an isolated capability-test directory");
        }
    }
    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn directory_replacement_before_open_is_rejected_without_foreign_names() {
        let base = TestDir::new("cap-before");
        fs::create_dir_all(base.0.join("root/sub")).unwrap();
        fs::create_dir_all(base.0.join("outside")).unwrap();
        fs::write(base.0.join("outside/private.jpg"), b"foreign").unwrap();
        let dir =
            Arc::new(Dir::open_ambient_dir(base.0.join("root"), ambient_authority()).unwrap());
        let mut found = vec![];
        let result = walk(
            dir,
            &base.0.join("root"),
            Path::new(""),
            &mut found,
            &mut |_| {
                fs::rename(base.0.join("root/sub"), base.0.join("root/old-sub")).unwrap();
                symlink(base.0.join("outside"), base.0.join("root/sub")).unwrap();
            },
        );
        assert!(result.is_err());
        assert!(found.is_empty());
    }
    #[test]
    fn ancestor_replacement_during_walk_keeps_child_directory_pinned() {
        let base = TestDir::new("cap-during");
        fs::create_dir_all(base.0.join("root/sub/nested")).unwrap();
        fs::create_dir_all(base.0.join("outside/nested")).unwrap();
        fs::write(base.0.join("root/sub/nested/local.jpg"), b"local").unwrap();
        fs::write(base.0.join("outside/nested/private.jpg"), b"foreign").unwrap();
        let dir =
            Arc::new(Dir::open_ambient_dir(base.0.join("root"), ambient_authority()).unwrap());
        let mut found = vec![];
        walk(
            dir,
            &base.0.join("root"),
            Path::new(""),
            &mut found,
            &mut |relative| {
                if relative == Path::new("sub/nested") {
                    fs::rename(base.0.join("root/sub"), base.0.join("root/old-sub")).unwrap();
                    symlink(base.0.join("outside"), base.0.join("root/sub")).unwrap();
                }
            },
        )
        .unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].relative_path, "sub/nested/local.jpg");
        assert_eq!(
            found[0].parent.read(&found[0].bound_name).unwrap(),
            b"local"
        );
    }
}
