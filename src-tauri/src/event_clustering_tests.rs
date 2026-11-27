use super::*;
use std::fs;

struct Fixture {
    _temp: tempfile::TempDir,
    paths: StorePaths,
    a: PathBuf,
    b: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let paths = StorePaths {
            config: temp.path().join("config"),
            store: temp.path().join("store"),
        };
        let a = temp.path().join("dump-a");
        let b = temp.path().join("dump-b");
        fs::create_dir_all(&a).unwrap();
        fs::create_dir_all(&b).unwrap();
        Self {
            _temp: temp,
            paths,
            a,
            b,
        }
    }
    fn state(&self) -> EventState {
        EventState::load(self.paths.clone()).unwrap()
    }
    fn picked(&self) -> EventState {
        let state = self.state();
        state.0.lock().unwrap().replace_source(&self.a).unwrap();
        state
    }
    fn photo(&self, name: &str) {
        fs::write(self.a.join(name), png(640, 480)).unwrap();
    }
    fn scan(&self, state: &EventState, force: bool) -> ScanReply {
        let ticket = state
            .0
            .lock()
            .unwrap()
            .begin_scan(force, "America/New_York".into())
            .unwrap();
        let (index, reads) = ticket.run().unwrap();
        state
            .0
            .lock()
            .unwrap()
            .finish_scan(&ticket, index, reads)
            .unwrap()
    }
    fn catalogue(&self, roots: &[&Path]) -> String {
        serde_json::json!({"version":1,"galleries":roots.iter().map(|root| serde_json::json!({"rootPath":root})).collect::<Vec<_>>()}).to_string()
    }
}
fn asset_item(root: &Dir, root_path: &Path, id: &str) -> AssetItem {
    prepare_asset(root, root_path, id.to_string()).0
}

fn png(w: u32, h: u32) -> Vec<u8> {
    let mut bytes = b"\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR".to_vec();
    bytes.extend(w.to_be_bytes());
    bytes.extend(h.to_be_bytes());
    bytes
}
fn box_bytes(kind: &[u8; 4], body: &[u8]) -> Vec<u8> {
    let mut out = ((body.len() + 8) as u32).to_be_bytes().to_vec();
    out.extend(kind);
    out.extend(body);
    out
}
fn heif(rotated: bool) -> Vec<u8> {
    let mut ispe = vec![0, 0, 0, 0];
    ispe.extend(1200u32.to_be_bytes());
    ispe.extend(800u32.to_be_bytes());
    let mut props = box_bytes(b"ispe", &ispe);
    props.extend(box_bytes(b"irot", &[u8::from(rotated)]));
    // A larger secondary thumbnail must not replace the primary item's extent.
    let mut secondary = vec![0, 0, 0, 0];
    secondary.extend(9000u32.to_be_bytes());
    secondary.extend(7000u32.to_be_bytes());
    props.extend(box_bytes(b"ispe", &secondary));
    let mut iprp = box_bytes(b"ipco", &props);
    iprp.extend(box_bytes(b"ipma", &[0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 2, 1, 2]));
    let mut meta = vec![0, 0, 0, 0];
    meta.extend(box_bytes(b"pitm", &[0, 0, 0, 0, 0, 1]));
    meta.extend(box_bytes(b"iprp", &iprp));
    let mut bytes = box_bytes(b"ftyp", b"heic\0\0\0\0heic");
    bytes.extend(box_bytes(b"meta", &meta));
    bytes
}
fn jpeg(orientation: u16) -> Vec<u8> {
    let mut tiff = b"II\x2a\x00\x08\x00\x00\x00\x01\x00\x12\x01\x03\x00\x01\x00\x00\x00".to_vec();
    tiff.extend(orientation.to_le_bytes());
    tiff.extend([0, 0, 0, 0, 0, 0]);
    let mut app = b"Exif\0\0".to_vec();
    app.extend(tiff);
    let mut bytes = vec![0xff, 0xd8, 0xff, 0xe1];
    bytes.extend(((app.len() + 2) as u16).to_be_bytes());
    bytes.extend(app);
    bytes.extend([
        0xff, 0xc0, 0, 11, 8, 1, 0xe0, 2, 0x80, 1, 1, 0x11, 0, 0xff, 0xd9,
    ]);
    bytes
}

#[test]
fn unconfigured_wire_fields_are_explicit_null() {
    let fixture = Fixture::new();
    let state = fixture.state();
    let reply = serde_json::to_value(state.0.lock().unwrap().status()).unwrap();
    assert_eq!(
        reply,
        serde_json::json!({"configured":false,"label":null,"isAvailable":false,"lastIndexedAt":null,"eventCount":0})
    );
    assert!(!fixture.paths.config.join(DECLARATION_FILE).exists());
}
#[test]
fn declaring_a_picked_folder_never_enumerates_it() {
    let fixture = Fixture::new();
    fixture.photo("one.jpg");
    let state = fixture.state();
    let mut inner = state.0.lock().unwrap();
    let reply = declare_raw_dump_root(&mut inner, &fixture.a).unwrap();
    assert_eq!(reply.item_count, 0);
    assert_eq!(inner.status().event_count, 0);
    assert!(!fixture.paths.config.join(INDEX_FILE).exists());
}

#[test]
fn picker_checks_catalogue_not_old_grants() {
    let fixture = Fixture::new();
    private_store::record_roots(&fixture.paths, std::slice::from_ref(&fixture.a)).unwrap();
    let state = fixture.state();
    state.0.lock().unwrap().replace_source(&fixture.a).unwrap();
    assert!(state.0.lock().unwrap().source.is_some());
}
#[test]
fn dump_picker_refuses_curated_root_before_persisting() {
    let fixture = Fixture::new();
    private_store::write_0600(
        &fixture.paths.config.join("catalogue.json"),
        fixture.catalogue(&[&fixture.a]).as_bytes(),
    )
    .unwrap();
    let state = fixture.state();
    assert!(state.0.lock().unwrap().replace_source(&fixture.a).is_err());
    assert!(!fixture.paths.config.join(DECLARATION_FILE).exists());
    assert!(!fixture.paths.roots_path().exists());
}

#[test]
fn selecting_or_clearing_dump_never_grants_a_gallery_root() {
    let fixture = Fixture::new();
    private_store::record_roots(&fixture.paths, std::slice::from_ref(&fixture.b)).unwrap();
    let gallery_roots = fs::read(fixture.paths.roots_path()).unwrap();
    let state = fixture.state();
    state.0.lock().unwrap().replace_source(&fixture.a).unwrap();
    assert_eq!(fs::read(fixture.paths.roots_path()).unwrap(), gallery_roots);
    let dump_roots = private_store::raw_dump_roots_at(&fixture.paths).unwrap();
    assert_eq!(dump_roots.len(), 1);
    assert!(crate::same_path(Path::new(&dump_roots[0]), &fixture.a));
    state.0.lock().unwrap().clear().unwrap();
    assert_eq!(fs::read(fixture.paths.roots_path()).unwrap(), gallery_roots);
    assert_eq!(
        private_store::roots_at(&fixture.paths).unwrap(),
        vec![fixture.b.to_str().unwrap()]
    );
}

#[test]
fn gallery_picker_and_catalogue_refuse_active_dump() {
    let fixture = Fixture::new();
    let state = fixture.picked();
    let inner = state.0.lock().unwrap();
    assert!(inner
        .guard_gallery_roots(std::slice::from_ref(&fixture.a))
        .is_err());
    assert!(inner
        .guard_catalogue(&fixture.catalogue(&[&fixture.b, &fixture.a]))
        .is_err());
    assert!(inner
        .guard_catalogue(&fixture.catalogue(&[&fixture.b]))
        .is_ok());
}
#[test]
fn rejected_drop_batch_does_not_commit_earlier_root() {
    let fixture = Fixture::new();
    private_store::record_roots(&fixture.paths, std::slice::from_ref(&fixture.b)).unwrap();
    let state = fixture.picked();
    let before = fs::read(fixture.paths.roots_path()).unwrap();
    let inner = state.0.lock().unwrap();
    let batch = vec![fixture.b.clone(), fixture.a.clone()];
    let outcome = inner
        .guard_gallery_roots(&batch)
        .and_then(|_| private_store::record_roots(&inner.paths, &batch));
    assert!(outcome.is_err());
    assert_eq!(fs::read(fixture.paths.roots_path()).unwrap(), before);
}
#[cfg(unix)]
#[test]
fn canonical_aliases_conflict_in_both_directions() {
    use std::os::unix::fs::symlink;
    let fixture = Fixture::new();
    let alias = fixture.b.join("alias");
    symlink(&fixture.a, &alias).unwrap();
    private_store::write_0600(
        &fixture.paths.config.join("catalogue.json"),
        fixture.catalogue(&[&alias]).as_bytes(),
    )
    .unwrap();
    let state = fixture.state();
    assert!(state.0.lock().unwrap().replace_source(&fixture.a).is_err());
    private_store::remove_private(&fixture.paths.config.join("catalogue.json")).unwrap();
    state.0.lock().unwrap().replace_source(&alias).unwrap();
    assert!(state
        .0
        .lock()
        .unwrap()
        .guard_gallery_roots(std::slice::from_ref(&fixture.a))
        .is_err());
    assert!(state
        .0
        .lock()
        .unwrap()
        .guard_catalogue(&fixture.catalogue(&[&alias]))
        .is_err());
}
#[test]
fn invalid_catalogue_fails_closed() {
    let fixture = Fixture::new();
    let state = fixture.state();
    for bad in ["{", "{}", "{\"galleries\":[{}]}", "{\"galleries\":null}"] {
        assert!(state.0.lock().unwrap().guard_catalogue(bad).is_err());
        private_store::write_0600(&fixture.paths.config.join("catalogue.json"), bad.as_bytes())
            .unwrap();
        assert!(state.0.lock().unwrap().replace_source(&fixture.a).is_err());
    }
}
#[test]
fn unprovenanced_native_declaration_never_restores() {
    let fixture = Fixture::new();
    let state = fixture.picked();
    drop(state);
    private_store::remove_private(&fixture.paths.raw_dump_roots_path()).unwrap();
    let restored = fixture.state();
    assert!(!restored.0.lock().unwrap().status().configured);
}
#[test]
fn nonexistent_source_stays_configured_but_unavailable() {
    let fixture = Fixture::new();
    let state = fixture.picked();
    fs::remove_dir(&fixture.a).unwrap();
    let restored = fixture.state();
    let status = restored.0.lock().unwrap().status();
    assert!(status.configured);
    assert!(!status.is_available);
    assert!(status.last_indexed_at.is_none());
    assert!(state.0.lock().unwrap().source.is_some());
}
#[test]
fn scans_recurse_cache_incrementally_and_prune_without_source_writes() {
    let fixture = Fixture::new();
    fixture.photo("one.png");
    fs::create_dir(fixture.a.join("nested")).unwrap();
    fixture.photo("nested/two.png");
    let original = fs::read(fixture.a.join("one.png")).unwrap();
    let state = fixture.picked();
    assert_eq!(fixture.scan(&state, false).metadata_read_count, 2);
    assert_eq!(fixture.scan(&state, false).metadata_read_count, 0);
    fs::File::options()
        .write(true)
        .open(fixture.a.join("one.png"))
        .unwrap()
        .set_times(
            std::fs::FileTimes::new().set_modified(UNIX_EPOCH + Duration::from_secs(1_800_000_000)),
        )
        .unwrap();
    assert_eq!(fixture.scan(&state, false).metadata_read_count, 1);
    fs::remove_file(fixture.a.join("nested/two.png")).unwrap();
    assert_eq!(fixture.scan(&state, false).metadata_read_count, 0);
    assert_eq!(
        state
            .0
            .lock()
            .unwrap()
            .index
            .as_ref()
            .unwrap()
            .item_cache
            .len(),
        1
    );
    assert_eq!(fs::read(fixture.a.join("one.png")).unwrap(), original);
    assert_eq!(fs::read_dir(&fixture.a).unwrap().count(), 2); // source and pre-existing subfolder only
}
#[test]
fn force_scan_bypasses_cache() {
    let fixture = Fixture::new();
    fixture.photo("one.png");
    let state = fixture.picked();
    fixture.scan(&state, false);
    assert_eq!(fixture.scan(&state, true).metadata_read_count, 1);
}
#[test]
fn wrong_fingerprint_and_unknown_schema_are_discarded_and_rebuilt() {
    for field in [
        "deviceId",
        "sourceId",
        "sourceKind",
        "label",
        "schemaVersion",
    ] {
        let fixture = Fixture::new();
        fixture.photo("one.png");
        let state = fixture.picked();
        fixture.scan(&state, false);
        drop(state);
        let path = fixture.paths.config.join(INDEX_FILE);
        let mut json: serde_json::Value =
            serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        if field == "schemaVersion" {
            json[field] = serde_json::json!(999);
        } else {
            json["source"][field] = serde_json::json!(uuid::Uuid::new_v4().to_string());
        }
        private_store::write_0600(&path, &serde_json::to_vec(&json).unwrap()).unwrap();
        let state = fixture.state();
        assert!(state.0.lock().unwrap().index.is_none());
        assert!(!path.exists());
        assert_eq!(fixture.scan(&state, false).metadata_read_count, 1);
    }
}
#[test]
fn restore_reuses_matching_index_and_stable_private_device_uuid() {
    let fixture = Fixture::new();
    fixture.photo("one.png");
    let state = fixture.picked();
    fixture.scan(&state, false);
    let id = state.0.lock().unwrap().device_id.clone();
    drop(state);
    let restored = fixture.state();
    assert_eq!(restored.0.lock().unwrap().device_id, id);
    assert_eq!(fixture.scan(&restored, false).metadata_read_count, 0);
    restored.0.lock().unwrap().clear().unwrap();
    drop(restored);
    let restored = fixture.picked();
    assert_eq!(restored.0.lock().unwrap().device_id, id);
    assert!(!fixture.paths.config.join("device.json").exists());
}
#[test]
fn calendar_change_requests_metadata_rebuild() {
    let fixture = Fixture::new();
    fixture.photo("one.png");
    let state = fixture.picked();
    fixture.scan(&state, false);
    let ticket = state
        .0
        .lock()
        .unwrap()
        .begin_scan(false, "Asia/Kolkata".into())
        .unwrap();
    assert!(ticket.cache.is_none());
    assert_eq!(ticket.run().unwrap().1, 1);
}
#[test]
fn actual_os_calendar_uses_iana_rules_and_keeps_dst() {
    let zone = iana_time_zone::get_timezone().unwrap();
    assert!(Calendar::iana(&zone).is_ok());
    let calendar = Calendar::iana("America/New_York").unwrap();
    // UTC 04:30 is yesterday in winter, but today after the DST change.
    assert_eq!(calendar.day_key(1_767_328_200.0).unwrap(), "2026-01-01");
    assert_eq!(calendar.day_key(1_782_880_200.0).unwrap(), "2026-07-01");
}
#[test]
fn wire_dates_are_ms_but_index_dates_are_seconds() {
    let fixture = Fixture::new();
    fixture.photo("one.jpg");
    let state = fixture.picked();
    let reply = fixture.scan(&state, false);
    let inner = state.0.lock().unwrap();
    let index = inner.index.as_ref().unwrap();
    assert_eq!(reply.last_indexed_at, index.source.last_indexed_at * 1000.0);
    assert_eq!(
        reply.clusters[0]["startDate"].as_f64().unwrap(),
        index.events[0].start_date * 1000.0
    );
    let stored: serde_json::Value =
        serde_json::from_slice(&fs::read(fixture.paths.config.join(INDEX_FILE)).unwrap()).unwrap();
    assert_eq!(
        stored["source"]["lastIndexedAt"].as_f64().unwrap(),
        index.source.last_indexed_at
    );
    assert_eq!(inner.index.as_ref().unwrap().source.source_kind, "folder");
}
#[test]
fn sub_day_wire_dates_are_also_ms() {
    let event = EventCluster {
        id: "evt_00000000000000000000".into(),
        start_date: 1.0,
        end_date: 2.0,
        is_multi_day: true,
        cover_item_id: "one.png".into(),
        item_ids: vec!["one.png".into()],
        sub_days: Some(vec![manorama_events::EventDayGroup {
            id: "2026-01-01".into(),
            date: 1.5,
            item_ids: vec!["one.png".into()],
        }]),
    };
    assert_eq!(wire_clusters(&[event])[0]["subDays"][0]["date"], 1500.0);
}
#[test]
fn status_is_memoized_without_reopening_headers() {
    let fixture = Fixture::new();
    fixture.photo("one.png");
    let state = fixture.picked();
    fixture.scan(&state, false);
    fs::write(fixture.a.join("one.png"), b"corrupt now").unwrap();
    let inner = &mut *state.0.lock().unwrap();
    let index = inner.index.clone().unwrap();
    for _ in 0..30 {
        assert_eq!(inner.status().event_count, index.events.len());
    }
    assert_eq!(inner.index.as_ref().unwrap(), &index);
}
#[test]
fn clear_wins_late_scan_and_does_not_recreate_index() {
    let fixture = Fixture::new();
    fixture.photo("one.png");
    let state = fixture.picked();
    fixture.scan(&state, false);
    let ticket = state
        .0
        .lock()
        .unwrap()
        .begin_scan(false, "America/New_York".into())
        .unwrap();
    let (index, reads) = ticket.run().unwrap();
    state.0.lock().unwrap().clear().unwrap();
    assert!(state
        .0
        .lock()
        .unwrap()
        .finish_scan(&ticket, index, reads)
        .is_err());
    assert!(!fixture.paths.config.join(INDEX_FILE).exists());
    assert!(!fixture.state().0.lock().unwrap().status().configured);
    assert!(fixture.paths.raw_dump_roots_path().exists());
    assert!(!fixture.paths.roots_path().exists());
    assert!(fixture.a.join("one.png").exists());
}
#[test]
fn changed_root_wins_late_scan() {
    let fixture = Fixture::new();
    fixture.photo("one.png");
    let state = fixture.picked();
    let ticket = state
        .0
        .lock()
        .unwrap()
        .begin_scan(false, "America/New_York".into())
        .unwrap();
    let (index, reads) = ticket.run().unwrap();
    state.0.lock().unwrap().replace_source(&fixture.b).unwrap();
    assert!(state
        .0
        .lock()
        .unwrap()
        .finish_scan(&ticket, index, reads)
        .is_err());
    assert!(!fixture.paths.config.join(INDEX_FILE).exists());
    assert!(crate::same_path(
        &state.0.lock().unwrap().source.as_ref().unwrap().root_path,
        &fixture.b
    ));
}
#[test]
fn newer_scan_wins_older_completion() {
    let fixture = Fixture::new();
    fixture.photo("one.png");
    let state = fixture.picked();
    let old = state
        .0
        .lock()
        .unwrap()
        .begin_scan(false, "America/New_York".into())
        .unwrap();
    let (index, reads) = old.run().unwrap();
    fixture.scan(&state, false);
    assert!(state
        .0
        .lock()
        .unwrap()
        .finish_scan(&old, index, reads)
        .is_err());
}
#[test]
fn private_state_and_index_are_0600() {
    let fixture = Fixture::new();
    fixture.photo("one.png");
    let state = fixture.picked();
    fixture.scan(&state, false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for path in [
            fixture.paths.config.join(INDEX_FILE),
            fixture.paths.config.join(DECLARATION_FILE),
            fixture.paths.raw_dump_roots_path(),
        ] {
            assert_eq!(
                fs::metadata(path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }
}
#[test]
fn asset_ids_batch_and_network_requests_are_validated() {
    for id in [
        "",
        "../one.png",
        "/one.png",
        "a//one.png",
        "a/./one.png",
        "a/../one.png",
        "C:/one.png",
        "a\\one.png",
        "one\0.png",
        "one\n.png",
        "one.txt",
        "file://a.png",
    ] {
        assert!(validate_batch(&[id.into()], None, None).is_err(), "{id:?}");
    }
    assert!(validate_batch(&vec!["one.png".into(); 65], None, None).is_err());
    let sixty_four: Vec<String> = (0..64).map(|index| format!("{index}.png")).collect();
    assert!(validate_batch(&sixty_four, Some(8192), Some(false)).is_ok());
    assert!(validate_batch(&["one.png".into(), "one.png".into()], None, None).is_err());
    assert!(validate_batch(&["one.png".into()], Some(0), None).is_err());
    assert!(validate_batch(&["one.png".into()], Some(8193), None).is_err());
    assert!(validate_batch(&["one.png".into()], None, Some(true)).is_err());
    assert!(validate_batch(&[], None, None).is_err());
}
#[test]
fn asset_returns_opaque_verified_lease_and_honest_pixel_extent() {
    let fixture = Fixture::new();
    fixture.photo("space #.png");
    let before = fs::read(fixture.a.join("space #.png")).unwrap();
    let state = fixture.picked();
    let mut inner = state.0.lock().unwrap();
    let source = inner.source.clone().unwrap();
    let root = open_source_root(&source).unwrap();
    let (mut item, member) = prepare_asset(&root, &fixture.a, "space #.png".to_string());
    let member = member.unwrap();
    item.url = Some(lease_asset(
        inner.generation,
        source.root_identity.unwrap(),
        member.clone(),
        &mut inner.assets,
    ));
    assert_eq!(item.state, "ready");
    assert_eq!((item.width, item.height), (640, 480));
    let url = item.url.as_ref().unwrap();
    assert!(request_token(url).is_some());
    assert!(!url.contains("%20") && !url.contains(' '));
    let request = Request::builder().uri(url).body(Vec::new()).unwrap();
    let response = asset_response(
        &VerifiedAsset {
            generation: inner.generation,
            root_identity: source.root_identity.unwrap(),
            member,
        },
        &request,
    );
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.body(), &before);
    assert_eq!(
        response.headers()[header::CACHE_CONTROL],
        "private, no-store"
    );
    assert_eq!(fs::read(fixture.a.join("space #.png")).unwrap(), before);
}

#[test]
fn asset_protocol_supports_head_and_bounded_ranges_without_rewriting_bytes() {
    let fixture = Fixture::new();
    fixture.photo("one.png");
    let before = fs::read(fixture.a.join("one.png")).unwrap();
    let state = fixture.picked();
    let mut inner = state.0.lock().unwrap();
    let source = inner.source.clone().unwrap();
    let root = open_source_root(&source).unwrap();
    let (_, member) = prepare_asset(&root, &fixture.a, "one.png".to_string());
    let asset = VerifiedAsset {
        generation: inner.generation,
        root_identity: source.root_identity.unwrap(),
        member: member.unwrap(),
    };
    let url = lease_asset(
        asset.generation,
        asset.root_identity,
        asset.member.clone(),
        &mut inner.assets,
    );
    let head = Request::builder()
        .method("HEAD")
        .uri(&url)
        .body(Vec::new())
        .unwrap();
    let response = asset_response(&asset, &head);
    assert_eq!(response.status(), StatusCode::OK);
    assert!(response.body().is_empty());
    assert_eq!(
        response.headers()[header::CONTENT_LENGTH],
        before.len().to_string()
    );
    let range = Request::builder()
        .uri(&url)
        .header(header::RANGE, "bytes=4-11")
        .body(Vec::new())
        .unwrap();
    let response = asset_response(&asset, &range);
    assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
    assert_eq!(response.body(), &before[4..12]);
    assert_eq!(
        response.headers()[header::CONTENT_RANGE],
        format!("bytes 4-11/{}", before.len())
    );
    let invalid = Request::builder()
        .uri(&url)
        .header(header::RANGE, "bytes=999999-")
        .body(Vec::new())
        .unwrap();
    assert_eq!(
        asset_response(&asset, &invalid).status(),
        StatusCode::RANGE_NOT_SATISFIABLE
    );
}

#[test]
fn whole_root_replacement_invalidates_status_scans_and_existing_leases() {
    let fixture = Fixture::new();
    fixture.photo("one.png");
    let state = fixture.picked();
    let source = state.0.lock().unwrap().source.clone().unwrap();
    let root = open_source_root(&source).unwrap();
    let (_, member) = prepare_asset(&root, &fixture.a, "one.png".to_string());
    #[allow(unused_mut)]
    let mut asset = VerifiedAsset {
        generation: state.0.lock().unwrap().generation,
        root_identity: source.root_identity.unwrap(),
        member: member.unwrap(),
    };
    #[cfg(windows)]
    {
        // Windows forbids renaming a pinned directory; retain the old lease
        // value so replacement still has to invalidate its identity.
        fs::create_dir_all(&fixture.paths.store).unwrap();
        asset.member.parent = Arc::new(open_root(&fixture.paths.store).unwrap());
        drop(member);
        drop(root);
        state.0.lock().unwrap().assets.clear();
    }
    fs::rename(&fixture.a, fixture.a.with_file_name("original-dump")).unwrap();
    fs::rename(&fixture.b, &fixture.a).unwrap();
    let mut inner = state.0.lock().unwrap();
    assert!(!inner.status().is_available);
    assert!(inner.begin_scan(true, "UTC".into()).is_err());
    assert!(!lease_is_current(&inner, &asset));
}

#[test]
fn legacy_declaration_without_original_root_identity_is_not_trusted() {
    let fixture = Fixture::new();
    let state = fixture.picked();
    drop(state);
    let path = fixture.paths.config.join(DECLARATION_FILE);
    let mut value: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    value["source"]
        .as_object_mut()
        .unwrap()
        .remove("rootIdentity");
    fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
    assert!(!fixture.state().0.lock().unwrap().status().configured);
}
#[test]
fn asset_lease_rejects_leaf_swap_after_pinned_read() {
    let fixture = Fixture::new();
    fixture.photo("one.png");
    let state = fixture.picked();
    let mut inner = state.0.lock().unwrap();
    let source = inner.source.clone().unwrap();
    let root = open_source_root(&source).unwrap();
    let (_, member) = prepare_asset(&root, &fixture.a, "one.png".to_string());
    let asset = VerifiedAsset {
        generation: inner.generation,
        root_identity: source.root_identity.unwrap(),
        member: member.unwrap(),
    };
    let url = lease_asset(
        asset.generation,
        asset.root_identity,
        asset.member.clone(),
        &mut inner.assets,
    );
    fs::rename(fixture.a.join("one.png"), fixture.a.join("validated.png")).unwrap();
    fs::write(fixture.a.join("one.png"), png(1, 1)).unwrap();
    let request = Request::builder().uri(url).body(Vec::new()).unwrap();
    assert_eq!(
        asset_response(&asset, &request).status(),
        StatusCode::NOT_FOUND
    );
}
#[cfg(unix)]
#[test]
fn asset_lease_rejects_ancestor_replacement() {
    use std::os::unix::fs::symlink;
    let fixture = Fixture::new();
    fs::create_dir(fixture.a.join("sub")).unwrap();
    fixture.photo("sub/one.png");
    fs::write(fixture.b.join("one.png"), b"foreign bytes").unwrap();
    let state = fixture.picked();
    let mut inner = state.0.lock().unwrap();
    let source = inner.source.clone().unwrap();
    let root = open_source_root(&source).unwrap();
    let (_, member) = prepare_asset(&root, &fixture.a, "sub/one.png".to_string());
    let asset = VerifiedAsset {
        generation: inner.generation,
        root_identity: source.root_identity.unwrap(),
        member: member.unwrap(),
    };
    let url = lease_asset(
        asset.generation,
        asset.root_identity,
        asset.member.clone(),
        &mut inner.assets,
    );
    fs::rename(fixture.a.join("sub"), fixture.a.join("old-sub")).unwrap();
    symlink(&fixture.b, fixture.a.join("sub")).unwrap();
    let request = Request::builder().uri(url).body(Vec::new()).unwrap();
    let response = asset_response(&asset, &request);
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    assert!(response.body().is_empty());
    assert!(!lease_is_current(&inner, &asset));
}
#[test]
fn clear_cannot_complete_before_an_asset_response_is_handed_off() {
    use std::sync::mpsc;
    let fixture = Fixture::new();
    fixture.photo("one.png");
    let state = fixture.picked();
    let shared = state.0.clone();
    let url = {
        let mut inner = shared.lock().unwrap();
        let source = inner.source.clone().unwrap();
        let root = open_source_root(&source).unwrap();
        let (_, member) = prepare_asset(&root, &fixture.a, "one.png".to_string());
        lease_asset(
            inner.generation,
            source.root_identity.unwrap(),
            member.unwrap(),
            &mut inner.assets,
        )
    };
    let request = Request::builder()
        .uri(url.clone())
        .body(Vec::new())
        .unwrap();
    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let responder = std::thread::spawn({
        let shared = shared.clone();
        move || {
            respond_event_asset(&shared, &request, |response| {
                entered_tx.send(response).unwrap();
                release_rx.recv().unwrap();
            });
        }
    });
    let response = entered_rx.recv().unwrap();
    let (cleared_tx, cleared_rx) = mpsc::channel();
    let clearer = std::thread::spawn({
        let shared = shared.clone();
        move || {
            shared.lock().unwrap().clear().unwrap();
            cleared_tx.send(()).unwrap();
        }
    });
    let cleared_early = cleared_rx.recv_timeout(Duration::from_millis(100)).is_ok();
    release_tx.send(()).unwrap();
    responder.join().unwrap();
    clearer.join().unwrap();
    assert!(
        !cleared_early,
        "clear completed while the response callback was still running"
    );
    assert_eq!(response.status(), StatusCode::OK);
    let request = Request::builder().uri(url).body(Vec::new()).unwrap();
    respond_event_asset(&shared, &request, |response| {
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    });
}

#[test]
fn reveal_revalidates_the_verified_member_at_the_opener_boundary() {
    let fixture = Fixture::new();
    fixture.photo("one.png");
    let state = fixture.picked();
    let inner = state.0.lock().unwrap();
    let source = inner.source.clone().unwrap();
    let root = open_source_root(&source).unwrap();
    let result = reveal_verified_member(&root, &source, "one.png", |target| {
        fs::rename(fixture.a.join("one.png"), fixture.a.join("validated.png")).unwrap();
        fs::write(fixture.a.join("one.png"), png(1, 1)).unwrap();
        target.path_at_handoff().map(|_| ())
    });
    assert!(result.is_err());
}

#[test]
fn missing_or_failed_assets_have_no_uri() {
    let fixture = Fixture::new();
    let root = open_root(&fixture.a).unwrap();
    let missing = asset_item(&root, &fixture.a, "absent.png");
    assert_eq!(missing.state, "missing");
    assert!(missing.url.is_none());
    fs::write(fixture.a.join("bad.png"), b"corrupt").unwrap();
    let failed = asset_item(&root, &fixture.a, "bad.png");
    assert_eq!(failed.state, "failed");
    assert!(failed.url.is_none());
}
#[cfg(unix)]
#[test]
fn sparse_cloud_placeholder_never_opens_pixels_or_returns_uri() {
    let fixture = Fixture::new();
    let root = open_root(&fixture.a).unwrap();
    fs::File::create(fixture.a.join("cloud.png"))
        .unwrap()
        .set_len(512 * 1024)
        .unwrap();
    let item = asset_item(&root, &fixture.a, "cloud.png");
    assert_eq!(item.state, "cloudOnly");
    assert!(item.url.is_none());
    assert_eq!((item.width, item.height), (0, 0));
}
#[test]
fn windows_cloud_flags_are_not_name_surrogate_exclusions() {
    for attr in [
        fs_scan::FILE_ATTRIBUTE_OFFLINE,
        fs_scan::FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS,
        fs_scan::FILE_ATTRIBUTE_OFFLINE | 0x400,
    ] {
        assert!(!fs_scan::windows_pixels_are_local(attr));
        assert!(fs_scan::windows_entry_is_visible(attr, false));
        assert!(!fs_scan::windows_entry_is_visible(attr, true));
    }
    assert!(fs_scan::windows_pixels_are_local(0x400));
}
#[cfg(unix)]
#[test]
fn capability_member_rejects_leaf_and_parent_symlink_escape() {
    use std::os::unix::fs::symlink;
    let fixture = Fixture::new();
    fs::write(fixture.b.join("outside.png"), png(1, 1)).unwrap();
    symlink(&fixture.b, fixture.a.join("alias")).unwrap();
    symlink(fixture.b.join("outside.png"), fixture.a.join("leaf.png")).unwrap();
    let root = open_root(&fixture.a).unwrap();
    for id in ["alias/outside.png", "leaf.png"] {
        let item = asset_item(&root, &fixture.a, id);
        assert!(item.url.is_none());
        assert_eq!(item.state, "missing");
    }
}
#[cfg(unix)]
#[test]
fn capability_parent_stays_pinned_during_ancestor_replacement() {
    use std::os::unix::fs::symlink;
    let fixture = Fixture::new();
    fs::create_dir(fixture.a.join("sub")).unwrap();
    fixture.photo("sub/one.png");
    fs::write(fixture.b.join("one.png"), b"foreign bytes").unwrap();
    let root = open_root(&fixture.a).unwrap();
    let (parent, name, _) = bound_member(&root, &fixture.a, "sub/one.png").unwrap();
    fs::rename(fixture.a.join("sub"), fixture.a.join("old-sub")).unwrap();
    symlink(&fixture.b, fixture.a.join("sub")).unwrap();
    let mut options = OpenOptions::new();
    options.read(true).follow(FollowSymlinks::No);
    let mut bytes = Vec::new();
    parent
        .open_with(name, &options)
        .unwrap()
        .read_to_end(&mut bytes)
        .unwrap();
    assert_eq!(header_dimensions(&bytes), Some((640, 480)));
    assert!(asset_item(&root, &fixture.a, "sub/one.png").url.is_none());
}
#[test]
fn jpeg_and_png_header_dimensions_respect_orientation() {
    assert_eq!(header_dimensions(&png(320, 240)), Some((320, 240)));
    for orientation in 1..=8 {
        assert_eq!(
            header_dimensions(&jpeg(orientation)),
            Some(if orientation >= 5 {
                (480, 640)
            } else {
                (640, 480)
            })
        );
    }
    assert!(header_dimensions(&png(0, 200)).is_none());
    assert!(header_dimensions(b"not an image").is_none());
}
#[test]
fn webp_all_three_headers_supply_dimensions() {
    let mut vp8x = vec![0; 10];
    vp8x[4] = 99;
    vp8x[7] = 49;
    let mut vp8 = vec![0; 10];
    vp8[3..6].copy_from_slice(b"\x9d\x01\x2a");
    vp8[6..8].copy_from_slice(&100u16.to_le_bytes());
    vp8[8..10].copy_from_slice(&50u16.to_le_bytes());
    let mut vp8l = vec![0x2f];
    vp8l.extend((99u32 | 49 << 14).to_le_bytes());
    for (kind, data) in [(b"VP8X", vp8x), (b"VP8 ", vp8), (b"VP8L", vp8l)] {
        let mut bytes = b"RIFF\0\0\0\0WEBP".to_vec();
        bytes.extend(kind);
        bytes.extend((data.len() as u32).to_le_bytes());
        bytes.extend(data);
        assert_eq!(header_dimensions(&bytes), Some((100, 50)));
    }
}
#[test]
fn heif_and_avif_use_primary_properties_and_rotation() {
    for rotate in [false, true] {
        let mut bytes = heif(rotate);
        let expected = if rotate { (800, 1200) } else { (1200, 800) };
        assert_eq!(header_dimensions(&bytes), Some(expected));
        bytes[8..12].copy_from_slice(b"avif");
        assert_eq!(header_dimensions(&bytes), Some(expected));
    }
}
#[test]
fn header_window_is_bounded_and_large_webp_payload_needs_no_pixels() {
    let mut bytes = png(640, 480);
    bytes.resize(HEADER_LIMIT as usize + 100, 0);
    let prefix = read_header_prefix(std::io::Cursor::new(&bytes)).unwrap();
    assert_eq!(prefix.len(), HEADER_LIMIT as usize);
    assert_eq!(header_dimensions(&prefix), Some((640, 480)));
    let mut webp = b"RIFF\0\0\0\0WEBPVP8 ".to_vec();
    webp.extend((HEADER_LIMIT as u32 + 100).to_le_bytes());
    webp.extend([0, 0, 0, 0x9d, 0x01, 0x2a, 100, 0, 50, 0]);
    assert_eq!(header_dimensions(&webp), Some((100, 50)));
}

#[cfg(windows)]
#[test]
fn windows_offline_asset_is_metadata_only_without_an_original_uri() {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::SetFileAttributesW;
    let fixture = Fixture::new();
    fixture.photo("offline.png");
    let path: Vec<u16> = fixture
        .a
        .join("offline.png")
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    assert_ne!(
        unsafe { SetFileAttributesW(path.as_ptr(), fs_scan::FILE_ATTRIBUTE_OFFLINE) },
        0
    );
    let root = open_root(&fixture.a).unwrap();
    let item = asset_item(&root, &fixture.a, "offline.png".into());
    assert_eq!(item.state, "cloudOnly");
    assert!(item.url.is_none());
    assert_eq!((item.width, item.height), (0, 0));
    let scan = fs_scan::scan(&fixture.a, None, &Calendar::fixed_offset(0).unwrap()).unwrap();
    assert_eq!(scan.metadata_read_count, 0);
}

#[test]
fn malformed_headers_never_panic_or_scan_arbitrary_ispe_bytes() {
    for bytes in [png(100, 50), jpeg(6), heif(true)] {
        for length in 0..bytes.len() {
            let _ = header_dimensions(&bytes[..length]);
        }
    }
    let mut bytes = box_bytes(b"ftyp", b"avif\0\0\0\0avif");
    bytes.extend(box_bytes(b"mdat", b"ispe\0\0\0\0\0\0\x10\0\0\0\x10\0"));
    assert!(header_dimensions(&bytes).is_none());
}
#[test]
fn watcher_payload_is_empty_and_stop_drops_late_activity() {
    let fixture = Fixture::new();
    let (tx, rx) = mpsc::channel();
    let watcher = start_watcher(&fixture.a, move || {
        let _ = tx.send(change_payload());
    })
    .unwrap();
    fs::write(fixture.a.join("one.png"), png(1, 1)).unwrap();
    assert_eq!(
        rx.recv_timeout(Duration::from_secs(8)).unwrap(),
        serde_json::json!({})
    );
    drop(watcher);
    fs::write(fixture.a.join("two.png"), png(2, 2)).unwrap();
    assert!(rx.recv_timeout(Duration::from_millis(900)).is_err());
}
#[test]
fn clear_and_root_change_stop_replace_watchers_without_mutex_deadlock() {
    let fixture = Fixture::new();
    let state = fixture.picked();
    let (tx, rx) = mpsc::channel();
    state.0.lock().unwrap().watcher = Some(
        start_watcher(&fixture.a, move || {
            let _ = tx.send(());
        })
        .unwrap(),
    );
    state.0.lock().unwrap().replace_source(&fixture.b).unwrap();
    assert!(state.0.lock().unwrap().watcher.is_none());
    fs::write(fixture.a.join("old.png"), png(1, 1)).unwrap();
    assert!(rx.recv_timeout(Duration::from_millis(900)).is_err());
    let (tx, rx) = mpsc::channel();
    state.0.lock().unwrap().watcher = Some(
        start_watcher(&fixture.b, move || {
            let _ = tx.send(());
        })
        .unwrap(),
    );
    state.0.lock().unwrap().clear().unwrap();
    assert!(state.0.lock().unwrap().watcher.is_none());
    fs::write(fixture.b.join("old.png"), png(1, 1)).unwrap();
    assert!(rx.recv_timeout(Duration::from_millis(900)).is_err());
}
