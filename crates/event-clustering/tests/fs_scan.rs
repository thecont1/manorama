#![cfg(feature = "fs-scan")]
use manorama_events::{fs_scan::*, parser::*, *};
use serde_json::json;
use std::{
    fs, io,
    path::{Path, PathBuf},
    sync::atomic::{AtomicUsize, Ordering},
};
static NEXT: AtomicUsize = AtomicUsize::new(0);
struct Scratch(PathBuf);
impl Scratch {
    fn new() -> Self {
        let base = std::env::var_os("CARGO_TARGET_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        let path = base.join(format!(
            "fs-scan-test-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }
    fn put(&self, name: &str, data: &[u8]) -> PathBuf {
        let path = self.0.join(name);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, data).unwrap();
        path
    }
}
impl Drop for Scratch {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}
fn file(path: &Path) -> DumpedFile {
    // Only enumeration can mint authority; tests may override metadata for the
    // injected provider but cannot manufacture an ambient-open descriptor.
    fs::write(path, b"header-provider-test").unwrap();
    let mut file = enumerate(path.parent().unwrap())
        .unwrap()
        .into_iter()
        .find(|f| f.path == path)
        .unwrap();
    file.relative_path = "a.jpg".into();
    file.modification_time = Some(2000.0);
    file.creation_time = Some(1000.0);
    file.pixels_are_local = true;
    file.windows_attributes = 0;
    file
}
fn index(items: Vec<MediaMetadataItem>) -> EventIndex {
    let mut index = EventIndex::new(
        SourceFingerprint {
            device_id: "device".into(),
            source_id: "dump".into(),
            source_kind: "folder".into(),
            label: "Backup".into(),
            last_indexed_at: 0.0,
        },
        ClusteringConfig::default(),
    );
    index.item_cache = items.into_iter().map(|i| (i.id.clone(), i)).collect();
    index
}
fn header() -> ImageHeaderProperties {
    ImageHeaderProperties {
        exif: json!({"DateTimeOriginal":"2026:03:14 08:45:12", "OffsetTimeOriginal":"+09:00"})
            .as_object()
            .unwrap()
            .clone(),
        tiff: json!({"Make":"Canon"}).as_object().unwrap().clone(),
        gps: json!({"Latitude":18.5,"Longitude":73.9})
            .as_object()
            .unwrap()
            .clone(),
    }
}
#[test]
fn raw_dump_recurses_where_gallery_equivalent_is_root_only() {
    let s = Scratch::new();
    s.put("root.jpg", b"bad-header");
    s.put("2026/03/nested.heic", b"bad-header");
    s.put("2026/03/readme.txt", b"not-image");
    s.put(".hidden.jpg", b"bad-header");
    s.put(".sync/hidden.jpg", b"bad-header");
    s.put("Photos.photoslibrary/private.jpg", b"bad-header");
    // Equivalent root-only gallery enumeration, not a change to either shell.
    let gallery: Vec<_> = fs::read_dir(&s.0)
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| {
            p.is_file()
                && !p.file_name().unwrap().to_str().unwrap().starts_with('.')
                && p.extension()
                    .and_then(|e| e.to_str())
                    .is_some_and(|e| IMAGE_EXTENSIONS.contains(&e))
        })
        .collect();
    assert_eq!(gallery.len(), 1);
    let dump = enumerate(&s.0).unwrap();
    assert_eq!(
        dump.iter()
            .map(|f| f.relative_path.as_str())
            .collect::<Vec<_>>(),
        ["2026/03/nested.heic", "root.jpg"]
    );
    let result = scan(&s.0, None, &Calendar::default()).unwrap();
    assert_eq!(result.item_cache.len(), 2);
    assert_eq!(result.metadata_read_count, 2);
    assert!(result.unplaced_item_ids.is_empty());
}
#[test]
fn locality_change_after_enumeration_invalidates_fallback_modtime() {
    let s = Scratch::new();
    let descriptor = file(&s.0.join("transition.jpg"));
    let fallback = ingest_with_header(&descriptor, &Calendar::default(), |_| {
        Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "file became offline",
        ))
    });
    assert!(!fallback.header_was_opened);
    let fallback = fallback.item.unwrap();
    assert_eq!(fallback.file_mod_time, None);
    assert_eq!(fallback.timestamp, 1000.0);
    let cache = index(vec![fallback]);
    assert!(cache.needs_metadata_read("a.jpg", Some(2000.0)));
    let hydrated = ingest_with_header(&descriptor, &Calendar::default(), |_| Ok(header()))
        .item
        .unwrap();
    assert_eq!(hydrated.file_mod_time, Some(2000.0));
    assert_ne!(hydrated.timestamp, 1000.0);
    assert_eq!(hydrated.coordinate(), Some((18.5, 73.9)));
}
#[test]
fn recursive_errors_are_not_partial_success() {
    let s = Scratch::new();
    let path = s.put("not-a-folder.jpg", b"bad");
    assert!(enumerate(&path).is_err());
    assert!(scan(&s.0.join("missing"), None, &Calendar::default()).is_err());
}
#[cfg(unix)]
#[test]
fn symlinks_inside_or_outside_root_never_become_members() {
    use std::os::unix::fs::symlink;
    let s = Scratch::new();
    let outside = Scratch::new();
    let original = s.put("original.jpg", b"bad");
    let escaped = outside.put("private.jpg", b"bad");
    symlink(&original, s.0.join("duplicate.jpg")).unwrap();
    symlink(&escaped, s.0.join("escape.jpg")).unwrap();
    symlink(&outside.0, s.0.join("escaped-directory")).unwrap();
    let files = enumerate(&s.0).unwrap();
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].relative_path, "original.jpg");
}
#[test]
fn offline_and_recall_attributes_prevent_header_open_before_shell() {
    let s = Scratch::new();
    let path = s.0.join("does-not-exist.jpg");
    for attrs in [
        FILE_ATTRIBUTE_OFFLINE,
        FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS,
        FILE_ATTRIBUTE_OFFLINE | FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS,
    ] {
        assert!(!windows_pixels_are_local(attrs));
        let mut f = file(&path);
        f.windows_attributes = attrs;
        let result = ingest_with_header(&f, &Calendar::default(), |_| {
            panic!("placeholder was opened")
        });
        assert!(!result.header_was_opened);
        let item = result.item.unwrap();
        assert_eq!(item.timestamp, 1000.0);
        assert_eq!(item.file_mod_time, None);
        assert!(
            index(vec![item]).needs_metadata_read("a.jpg", Some(2000.0)),
            "hydration must re-read"
        );
    }
    assert!(windows_pixels_are_local(0));
    let mut f = file(&path);
    f.pixels_are_local = false;
    assert!(
        !ingest_with_header(&f, &Calendar::default(), |_| panic!("dataless file opened"))
            .header_was_opened
    );
}
#[test]
fn ingest_timestamp_fallbacks_and_screenshot_inference() {
    let s = Scratch::new();
    let mut f = file(&s.0.join("a.jpg"));
    let parsed = ingest_with_header(&f, &Calendar::default(), |_| Ok(header()));
    assert!(parsed.header_was_opened);
    let parsed = parsed.item.unwrap();
    assert_eq!(
        parsed.timestamp,
        capture_date(&header().exif, &Calendar::default()).unwrap()
    );
    assert_eq!(parsed.coordinate(), Some((18.5, 73.9)));
    assert_eq!(parsed.file_mod_time, Some(2000.0));
    let fallback = ingest_with_header(&f, &Calendar::default(), |_| {
        Err(io::Error::other("unreadable"))
    })
    .item
    .unwrap();
    assert_eq!(fallback.timestamp, 1000.0);
    f.creation_time = None;
    assert_eq!(
        ingest_with_header(&f, &Calendar::default(), |_| Ok(
            ImageHeaderProperties::default()
        ))
        .item
        .unwrap()
        .timestamp,
        2000.0
    );
    f.modification_time = None;
    assert!(ingest_with_header(&f, &Calendar::default(), |_| Ok(
        ImageHeaderProperties::default()
    ))
    .item
    .is_none());
    f.creation_time = Some(1000.0);
    f.path = s.0.join("Screenshot.png");
    assert!(
        ingest_with_header(&f, &Calendar::default(), |_| Ok(
            ImageHeaderProperties::default()
        ))
        .item
        .unwrap()
        .is_screenshot
    );
    assert!(
        !ingest_with_header(&f, &Calendar::default(), |_| Ok(header()))
            .item
            .unwrap()
            .is_screenshot
    );
}
#[test]
fn unchanged_scan_opens_zero_headers_and_modified_entry_only_reloads_itself() {
    let s = Scratch::new();
    let a = s.put("a.jpg", b"not-an-image");
    s.put("b.jpg", b"bad-header");
    let first = scan(&s.0, None, &Calendar::default()).unwrap();
    assert_eq!(first.metadata_read_count, 2);
    let cache = index(first.item_cache.values().cloned().collect());
    let second = scan(&s.0, Some(&cache), &Calendar::default()).unwrap();
    assert_eq!(second.metadata_read_count, 0);
    assert_eq!(second.item_cache, cache.item_cache);
    let modification =
        fs::metadata(&a).unwrap().modified().unwrap() + std::time::Duration::from_secs(2);
    fs::File::options()
        .write(true)
        .open(&a)
        .unwrap()
        .set_times(fs::FileTimes::new().set_modified(modification))
        .unwrap();
    let third = scan(&s.0, Some(&cache), &Calendar::default()).unwrap();
    assert_eq!(third.metadata_read_count, 1);
    fs::remove_file(&a).unwrap();
    assert_eq!(
        scan(&s.0, Some(&cache), &Calendar::default())
            .unwrap()
            .item_cache
            .len(),
        1
    );
}
fn entry(tiff: &mut Vec<u8>, tag: u16, count: u32, value: u32, kind: u16) {
    tiff.extend(tag.to_le_bytes());
    tiff.extend(kind.to_le_bytes());
    tiff.extend(count.to_le_bytes());
    tiff.extend(value.to_le_bytes());
}
fn metadata_only_jpeg() -> Vec<u8> {
    // Synthetic APP1/EXIF, no image pixels or golden output data.
    let mut tiff = b"II\x2a\0\x08\0\0\0".to_vec();
    tiff.extend(3u16.to_le_bytes());
    entry(&mut tiff, 0x010f, 6, 50, 2); // Make
    entry(&mut tiff, 0x0110, 7, 56, 2); // Model
    entry(&mut tiff, 0x8769, 1, 64, 4); // ExifIFD
    tiff.extend(0u32.to_le_bytes());
    tiff.extend(b"Canon\0EOS R5\0\0");
    assert_eq!(tiff.len(), 64);
    tiff.extend(2u16.to_le_bytes());
    entry(&mut tiff, 0x9003, 20, 94, 2); // DateTimeOriginal
    entry(&mut tiff, 0x9011, 7, 114, 2); // OffsetTimeOriginal
    tiff.extend(0u32.to_le_bytes());
    tiff.extend(b"2026:03:14 08:45:12\0+09:00\0");
    let mut jpeg = vec![0xff, 0xd8, 0xff, 0xe1];
    jpeg.extend(((tiff.len() + 8) as u16).to_be_bytes());
    jpeg.extend(b"Exif\0\0");
    jpeg.extend(tiff);
    jpeg.extend([0xff, 0xd9]);
    jpeg
}
#[test]
fn real_kamadak_header_path_reads_capture_offset_without_bitmap() {
    let s = Scratch::new();
    let original = metadata_only_jpeg();
    let path = s.put("a.jpg", &original);
    let result = scan(&s.0, None, &Calendar::default()).unwrap();
    assert_eq!(result.metadata_read_count, 1);
    assert_eq!(
        result.item_cache["a.jpg"].timestamp,
        capture_date(&header().exif, &Calendar::default()).unwrap()
    );
    assert!(!result.item_cache["a.jpg"].is_screenshot);
    assert_eq!(
        fs::read(path).unwrap(),
        original,
        "indexing never writes source bytes"
    );
    assert_eq!(
        fs::read_dir(&s.0).unwrap().count(),
        1,
        "no pixel or metadata sidecar persistence"
    );
}

#[cfg(unix)]
#[test]
fn ancestor_swap_after_enumeration_cannot_read_foreign_header_or_metadata() {
    use std::os::unix::fs::symlink;
    let root = Scratch::new();
    let outside = Scratch::new();
    root.put("sub/photo.jpg", b"local-invalid-header");
    outside.put("photo.jpg", &metadata_only_jpeg());
    let files = enumerate(&root.0).unwrap();
    let f = &files[0];
    let fallback = f.creation_time.or(f.modification_time).unwrap();
    fs::rename(root.0.join("sub"), root.0.join("original-sub")).unwrap();
    symlink(&outside.0, root.0.join("sub")).unwrap();
    let item = ingest(f, &Calendar::default()).item.unwrap();
    assert_eq!(
        item.timestamp,
        MediaMetadataItem::new("x", fallback).timestamp
    );
    assert_eq!(item.file_mod_time, f.modification_time);
    assert_ne!(
        item.timestamp,
        capture_date(&header().exif, &Calendar::default()).unwrap()
    );
    // Nor can mutating a presentation path redirect the pinned header read.
    let mut f = f.clone();
    f.path = outside.0.join("photo.jpg");
    assert_eq!(ingest(&f, &Calendar::default()).item.unwrap(), item);
}

#[test]
fn cloud_reparse_tags_are_visible_hydrated_or_metadata_only() {
    let s = Scratch::new();
    let path = s.0.join("a.jpg");
    // IsReparseTagNameSurrogate is bit 29. All CLOUD variants lack it;
    // SYMLINK and MOUNT_POINT (junction) have it. This models FileType, not
    // the REPARSE_POINT attribute, which is set for every one of these.
    for tag in (0..=15)
        .map(|variant| 0x9000_001au32 | (variant << 12))
        .chain([0x8000_0008])
    {
        let attrs = 0x400;
        assert!(windows_entry_is_visible(attrs, tag & 0x2000_0000 != 0));
        let mut f = file(&path);
        f.windows_attributes = attrs;
        assert!(ingest_with_header(&f, &Calendar::default(), |_| Ok(header())).header_was_opened);
        for offline in [FILE_ATTRIBUTE_OFFLINE, FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS] {
            f.windows_attributes = attrs | offline;
            assert!(windows_entry_is_visible(f.windows_attributes, false));
            let result = ingest_with_header(&f, &Calendar::default(), |_| panic!("cloud download"));
            assert!(!result.header_was_opened);
            assert_eq!(result.item.unwrap().file_mod_time, None);
        }
    }
    for tag in [0xa000_000cu32, 0xa000_0003] {
        assert!(!windows_entry_is_visible(0x400, tag & 0x2000_0000 != 0));
    }
    assert!(!windows_entry_is_visible(0x402, false));
}

#[cfg(windows)]
#[test]
fn windows_real_symlink_and_offline_attribute_metadata_gate() {
    use std::os::windows::fs::symlink_file;
    use std::process::Command;
    let root = Scratch::new();
    let path = root.put("a.jpg", &metadata_only_jpeg());
    // Windows runner needs Developer Mode or symlink privilege; do not silently
    // skip a missing prerequisite on an actual Windows verification run.
    symlink_file(&path, root.0.join("link.jpg")).unwrap();
    assert_eq!(enumerate(&root.0).unwrap().len(), 1);
    assert!(Command::new("attrib")
        .args(["+O"])
        .arg(&path)
        .status()
        .unwrap()
        .success());
    let files = enumerate(&root.0).unwrap();
    assert_eq!(files.len(), 1);
    assert!(!files[0].pixels_are_local);
    assert!(!ingest(&files[0], &Calendar::default()).header_was_opened);
    assert_eq!(
        ingest(&files[0], &Calendar::default())
            .item
            .unwrap()
            .file_mod_time,
        None
    );
    assert!(Command::new("attrib")
        .args(["-O"])
        .arg(&path)
        .status()
        .unwrap()
        .success());
    assert!(ingest(&enumerate(&root.0).unwrap()[0], &Calendar::default()).header_was_opened);
}
