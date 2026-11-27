use manorama_events::parser::*;
use manorama_events::*;
use serde_json::json;
use std::collections::BTreeSet;
fn fields(value: serde_json::Value) -> HeaderFields {
    value.as_object().unwrap().clone()
}
fn index() -> EventIndex {
    EventIndex::new(
        SourceFingerprint {
            device_id: "device".into(),
            source_id: "source".into(),
            source_kind: "folder".into(),
            label: "Camera backup".into(),
            last_indexed_at: 1760000000.0,
        },
        ClusteringConfig::default(),
    )
}
#[test]
fn all_nine_defaults_round_trip() {
    let c = ClusteringConfig::default();
    assert_eq!(
        (
            c.session_gap_hours,
            c.session_distance_km,
            c.transit_bypass_minutes
        ),
        (3.5, 5.0, 45.0)
    );
    assert_eq!(
        (
            c.trip_distance_from_home_km,
            c.trip_overnight_gap_hours,
            c.burst_threshold_seconds
        ),
        (50.0, 18.0, 3.0)
    );
    assert_eq!(
        (
            c.visual_split_min_gap_hours,
            c.visual_split_max_distance_km,
            c.visual_split_feature_print_distance
        ),
        (1.5, 0.5, 1.0)
    );
    let encoded = serde_json::to_value(&c).unwrap();
    assert_eq!(encoded.as_object().unwrap().len(), 9);
    assert_eq!(
        serde_json::from_value::<ClusteringConfig>(encoded).unwrap(),
        c
    );
    assert_eq!(serde_json::from_str::<ClusteringConfig>("{}").unwrap(), c);
}
#[test]
fn invalid_inputs_return_errors_not_panics() {
    for time in [f64::NAN, f64::INFINITY, -f64::INFINITY, 1e50] {
        assert!(cluster(
            &[MediaMetadataItem::new("bad", time)],
            "source",
            &ClusteringConfig::default(),
            &Calendar::default()
        )
        .is_err());
        assert!(event_id("source", time).is_err());
    }
    let config = ClusteringConfig {
        session_gap_hours: -1.0,
        ..ClusteringConfig::default()
    };
    assert!(EventClusterer::new("source", config, Calendar::default()).is_err());
    let config = ClusteringConfig {
        burst_threshold_seconds: f64::NAN,
        ..ClusteringConfig::default()
    };
    assert!(config.validate().is_err());
}
#[test]
fn geography_and_guard_match_swift() {
    assert!((haversine_km(0.0, 0.0, 1.0, 0.0) - 111.2).abs() < 0.5);
    assert!(haversine_km(0.0, 0.0, 0.0, 180.0) < 20100.0);
    assert_eq!(haversine_km(18.5, 73.8, 18.5, 73.8), 0.0);
    assert!(is_same_place_km(0.5, 0.5));
    assert_eq!(
        GeoCell::new(-18.55, -73.85),
        GeoCell {
            latitude: -18.6,
            longitude: -73.9
        }
    );
    let mut item = MediaMetadataItem::new("equator", 0.0);
    item.latitude = Some(0.0);
    item.longitude = Some(70.0);
    assert!(item.coordinate().is_none());
    assert_eq!(
        coordinate(&fields(json!({"Latitude": 0, "Longitude": 70}))),
        Some((0.0, 70.0))
    );
}
#[test]
fn calendar_is_explicit_and_dst_aware() {
    assert!(CalendarSpec {
        identifier: "buddhist".into(),
        ..CalendarSpec::default()
    }
    .calendar()
    .is_err());
    assert!(CalendarSpec {
        time_zone_identifier: Some("UTC".into()),
        ..CalendarSpec::default()
    }
    .calendar()
    .is_err());
    assert!(CalendarSpec {
        seconds_from_gmt: None,
        ..CalendarSpec::default()
    }
    .calendar()
    .is_err());
    assert!(Calendar::iana("not/a/zone").is_err());
    assert!(Calendar::fixed_offset(86400).is_err());
    assert_eq!(Calendar::default().day_key(-0.5).unwrap(), "1969-12-31");
    let ny = Calendar::iana("America/New_York").unwrap();
    let before = capture_date(
        &fields(json!({"DateTimeOriginal": "2026:03:08 01:30:00"})),
        &ny,
    )
    .unwrap();
    let after = capture_date(
        &fields(json!({"DateTimeOriginal": "2026:03:08 03:30:00"})),
        &ny,
    )
    .unwrap();
    assert_eq!(after - before, 3600.0);
    // Verified against Foundation Calendar.date(from:) on the slice base.
    assert_eq!(
        capture_date(
            &fields(json!({"DateTimeOriginal":"2026:03:08 02:30:00"})),
            &ny
        ),
        Some(1772955000.0)
    );
    assert_eq!(
        capture_date(
            &fields(json!({"DateTimeOriginal":"2026:11:01 01:30:00"})),
            &ny
        ),
        Some(1793511000.0)
    );
}
#[test]
fn dates_offsets_iso_and_digitized() {
    let utc = Calendar::default();
    let original = capture_date(
        &fields(json!({"DateTimeOriginal": "2026:03:14 08:45:12", "OffsetTimeOriginal": "+09:00"})),
        &utc,
    );
    let expected = capture_date(
        &fields(json!({"DateTimeOriginal": "2026:03:13 23:45:12", "OffsetTimeOriginal": "Z"})),
        &utc,
    );
    assert_eq!(original, expected);
    assert!(original.is_some());
    assert_eq!(tz_offset_seconds(Some("-0800")), Some(-28800));
    assert_eq!(tz_offset_seconds(Some("+05:30")), Some(19800));
    assert_eq!(tz_offset_seconds(Some("z")), Some(0));
    assert_eq!(tz_offset_seconds(Some("+24:00")), None);
    assert_eq!(tz_offset_seconds(Some("😀💥")), None);
    let iso = capture_date(
        &fields(
            json!({"DateTimeOriginal": "2026-06-01T14:00:45.500000", "OffsetTimeOriginal": "+02:00"}),
        ),
        &utc,
    );
    let digitized = capture_date(
        &fields(json!({"DateTimeDigitized": "2026:06:01 12:00:45", "OffsetTime": "Z"})),
        &utc,
    );
    assert_eq!(iso, digitized);
    assert!(iso.is_some());
    let local = Calendar::fixed_offset(19800).unwrap();
    let a = capture_date(
        &fields(json!({"DateTimeOriginal": "2026:06:01 14:00:00"})),
        &local,
    )
    .unwrap();
    let b = capture_date(
        &fields(json!({"DateTimeOriginal": "2026:06:01 14:00:00", "OffsetTimeOriginal": "+05:30"})),
        &utc,
    )
    .unwrap();
    assert_eq!(a, b);
}
#[test]
fn garbage_headers_do_not_invent_time() {
    for text in [
        "",
        "not a date",
        "2026:06",
        "😀 T 🤷",
        "999999999999999:1:1 0:0",
        "2026:1:1 9223372036854775807:0",
    ] {
        assert!(
            capture_date(
                &fields(json!({"DateTimeOriginal": text})),
                &Calendar::default()
            )
            .is_none(),
            "{text}"
        );
    }
    assert!(capture_date(&HeaderFields::new(), &Calendar::default()).is_none());
}
#[test]
fn gps_decimal_dms_and_ranges() {
    assert_eq!(
        coordinate(&fields(
            json!({"Latitude": "33.87", "LatitudeRef": "S", "Longitude": 151.2, "LongitudeRef": "W"})
        )),
        Some((-33.87, -151.2))
    );
    let (lat, lon) = coordinate(&fields(
        json!({"Latitude": [18, "31", 30], "Longitude": [73, 51, "22"]}),
    ))
    .unwrap();
    assert!((lat - (18.0 + 31.0 / 60.0 + 30.0 / 3600.0)).abs() < 1e-8);
    assert!((lon - (73.0 + 51.0 / 60.0 + 22.0 / 3600.0)).abs() < 1e-8);
    for gps in [
        json!({"Latitude":0,"Longitude":0}),
        json!({"Latitude":95,"Longitude":10}),
        json!({"Latitude":10,"Longitude":190}),
        json!({"Latitude":"NaN","Longitude":10}),
        json!({"Latitude":[1,2],"Longitude":10}),
    ] {
        assert!(coordinate(&fields(gps)).is_none());
    }
}
#[test]
fn screenshot_and_imageio_dictionary_rules() {
    let empty = HeaderFields::new();
    assert!(is_screenshot(&empty, "PNG", "Shot-0001.png"));
    assert!(is_screenshot(&empty, "jpg", "Screen Shot at noon.jpg"));
    assert!(is_screenshot(&empty, "jpg", "old-Screenshot-backup.jpg"));
    assert!(!is_screenshot(&empty, "jpg", "IMG_2048.jpg"));
    assert!(!is_screenshot(
        &fields(json!({"Make":" Canon "})),
        "png",
        "Screenshot.png"
    ));
    assert!(is_screenshot(
        &fields(json!({"Model":"  "})),
        "png",
        "IMG.png"
    ));
    let header = ImageHeaderProperties::from_properties(&fields(
        json!({"{Exif}":{"DateTimeOriginal":"2026:03:14 20:40:00"},
        "{TIFF}":{"Make":"Apple"},"{GPS}":{"Latitude":18.51,"Longitude":73.85}}),
    ));
    assert!(capture_date(&header.exif, &Calendar::default()).is_some());
    assert_eq!(coordinate(&header.gps), Some((18.51, 73.85)));
    assert!(!is_screenshot(&header.tiff, "heic", "IMG_0042.heic"));
}
#[test]
fn index_roundtrip_seconds_sorted_keys_and_fingerprint() {
    let mut i = index();
    let mut item = MediaMetadataItem::new("a.jpg", -0.5);
    item.file_mod_time = Some(1000.0);
    i.item_cache.insert(item.id.clone(), item);
    let data = i.encode().unwrap();
    assert_eq!(EventIndex::decode(&data).unwrap(), i);
    let text = String::from_utf8(data.clone()).unwrap();
    assert!(text.contains("\"lastIndexedAt\":1760000000.0"));
    assert!(text.contains("\"timestamp\":-0.5"));
    assert!(text.starts_with("{\"config\":"));
    assert!(EventIndex::reusable(&data, "device", "source").is_some());
    assert!(EventIndex::reusable(&data, "other", "source").is_none());
    assert!(EventIndex::reusable(&data, "device", "other").is_none());
}
#[test]
fn cache_invalid_or_unknown_schema_requests_rebuild() {
    for schema in [0, 2, -1, 999] {
        let mut i = index();
        i.schema_version = schema;
        let data = i.encode().unwrap();
        assert!(!i.matches("device", "source"));
        assert!(matches!(
            EventIndex::decode(&data),
            Err(Error::UnsupportedSchema(_))
        ));
        assert!(EventIndex::reusable(&data, "device", "source").is_none());
    }
    for data in [b"{}".as_slice(), b"not-json", b"{\"schemaVersion\":1}"] {
        assert!(EventIndex::reusable(data, "device", "source").is_none());
    }
}
#[test]
fn modification_delta_absolute_one_second_boundary() {
    let mut i = index();
    let mut item = MediaMetadataItem::new("a", 0.0);
    item.file_mod_time = Some(1000.0);
    i.item_cache.insert("a".into(), item);
    for time in [1000.0, 1000.4, 999.1] {
        assert!(!i.needs_metadata_read("a", Some(time)));
    }
    for time in [1001.0, 999.0, 1500.0] {
        assert!(i.needs_metadata_read("a", Some(time)));
    }
    assert!(i.needs_metadata_read("a", None));
    assert!(i.needs_metadata_read("new", Some(1000.0)));
}
#[test]
fn pruning_preserves_events_until_applying_recluster() {
    let mut i = index();
    let items = vec![
        MediaMetadataItem::new("a", 1.0),
        MediaMetadataItem::new("gone", 2.0),
    ];
    let result = cluster(&items, "source", &i.config, &Calendar::default()).unwrap();
    i = i
        .applying(
            &result,
            items.into_iter().map(|i| (i.id.clone(), i)).collect(),
            5.0,
        )
        .unwrap();
    i.screenshot_item_ids = vec!["gone.png".into(), "s1.png".into()];
    let pruned = i.pruning(&BTreeSet::from(["gone".into(), "gone.png".into()]));
    assert_eq!(pruned.events, i.events);
    assert_eq!(pruned.item_cache.len(), 1);
    assert_eq!(pruned.screenshot_item_ids, vec!["s1.png"]);
    let next_result = cluster(
        &pruned.item_cache.values().cloned().collect::<Vec<_>>(),
        "source",
        &i.config,
        &Calendar::default(),
    )
    .unwrap();
    let next = pruned
        .applying(&next_result, pruned.item_cache.clone(), 10.0)
        .unwrap();
    assert_eq!(next.events[0].item_ids, vec!["a"]);
    assert_eq!(next.source.last_indexed_at, 10.0);
    assert_eq!(next.indexed_item_count(), 1);
}
#[test]
fn canonical_id_sort_and_first_midpoint_tie() {
    let config = ClusteringConfig {
        burst_threshold_seconds: 0.0,
        ..ClusteringConfig::default()
    };
    let items = vec![
        MediaMetadataItem::new("z", 10.0),
        MediaMetadataItem::new("a", 0.0),
    ];
    let r = cluster(&items, "source", &config, &Calendar::default()).unwrap();
    assert_eq!(r.events[0].cover_item_id, "a");
    assert_eq!(r.events[0].item_ids, ["a", "z"]);
    let items = vec![
        MediaMetadataItem::new("é", 0.0),
        MediaMetadataItem::new("Z", 0.0),
    ];
    let r = cluster(&items, "source", &config, &Calendar::default()).unwrap();
    assert_eq!(r.events[0].item_ids, ["Z", "é"]);
}
#[test]
fn locked_core_graph_has_no_bitmap_ml_network_or_shell_engines() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let lock = std::fs::read_to_string(root.join("Cargo.lock")).unwrap();
    let names: Vec<_> = lock
        .lines()
        .filter_map(|line| {
            line.strip_prefix("name = \"")
                .and_then(|s| s.strip_suffix('"'))
        })
        .collect();
    for forbidden in [
        "image",
        "png",
        "jpeg-decoder",
        "tiff",
        "rav1e",
        "libheif-rs",
        "ffmpeg-next",
        "opencv",
        "ort",
        "tract-onnx",
        "reqwest",
        "hyper",
        "tauri",
    ] {
        assert!(
            !names.contains(&forbidden),
            "forbidden core dependency: {forbidden}"
        );
    }
}
#[test]
fn metadata_and_results_have_no_pixels_or_absolute_paths() {
    let item = MediaMetadataItem::new("2026/03/a.jpg", 1.0);
    let encoded = serde_json::to_value(&item).unwrap();
    let keys: Vec<_> = encoded
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    assert_eq!(keys, ["id", "isScreenshot", "timestamp"]);
    let r = cluster(
        &[item],
        "source",
        &ClusteringConfig::default(),
        &Calendar::default(),
    )
    .unwrap();
    let text = serde_json::to_string(&r).unwrap();
    for forbidden in [
        "thumbnail",
        "base64",
        "bytes",
        "latitude",
        "longitude",
        "/Users/",
    ] {
        assert!(!text.contains(forbidden));
    }
}

fn parity_cases() -> Vec<(Vec<MediaMetadataItem>, ClusteringConfig)> {
    let defaults = ClusteringConfig::default();
    let mut cases = vec![];
    for ids in [
        vec!["e\u{301}.jpg", "z.jpg"],
        vec!["é.jpg", "z.jpg"],
        vec!["é.jpg", "e\u{301}.jpg", "z.jpg"],
        vec!["東京", "🙂", "a"],
        vec!["z", "A", "a"],
    ] {
        cases.push((
            ids.into_iter()
                .map(|id| MediaMetadataItem::new(id, 0.0))
                .collect(),
            defaults.clone(),
        ));
    }
    let mut z = MediaMetadataItem::new("z", 0.0);
    z.timestamp = -1e-8; // exercise assignments bypassing the constructor
    let mut a = MediaMetadataItem::new("a", 0.0);
    a.timestamp = 1e-8;
    cases.push((
        vec![z, a],
        ClusteringConfig {
            burst_threshold_seconds: 0.0,
            ..defaults.clone()
        },
    ));
    for threshold in [0.10000001, 0.10000003] {
        cases.push((
            vec![
                MediaMetadataItem::new("a", 0.0),
                MediaMetadataItem::new("b", 0.10000002),
            ],
            ClusteringConfig {
                burst_threshold_seconds: threshold,
                ..defaults.clone()
            },
        ));
        cases.push((
            vec![
                MediaMetadataItem::new("a", 0.0),
                MediaMetadataItem::new("b", 0.10000002),
            ],
            ClusteringConfig {
                burst_threshold_seconds: 0.0,
                session_gap_hours: threshold / 3600.0,
                ..defaults.clone()
            },
        ));
    }
    for start in [
        -1.00000001,
        -0.99999999,
        -1e-8,
        1e-8,
        0.99999999,
        1.00000001,
        978307199.9999999,
        978307200.0,
        978307200.0000001,
        -0.5,
    ] {
        cases.push((
            vec![
                MediaMetadataItem::new("a", start),
                MediaMetadataItem::new("b", start + 0.10000002),
            ],
            ClusteringConfig {
                burst_threshold_seconds: 0.10000001,
                ..defaults.clone()
            },
        ));
    }
    cases
}
#[test]
fn canonical_accents_and_ascii_preserve_opaque_ids_and_source_bytes() {
    for (input, config) in parity_cases().into_iter().take(5) {
        let r = cluster(&input, "source", &config, &Calendar::default()).unwrap();
        assert_eq!(r.events[0].item_ids.len(), input.len());
    }
    for accented in ["e\u{301}.jpg", "é.jpg"] {
        let input = vec![
            MediaMetadataItem::new(accented, 0.0),
            MediaMetadataItem::new("z.jpg", 0.0),
        ];
        let r = cluster(
            &input,
            "source",
            &ClusteringConfig::default(),
            &Calendar::default(),
        )
        .unwrap();
        // Swift core oracle independently elects the accented frame, not z.
        assert_eq!(r.events[0].item_ids, ["z.jpg", accented]);
        assert_eq!(r.events[0].cover_item_id, accented);
    }
    assert_ne!(
        event_id("é", 0.0).unwrap(),
        event_id("e\u{301}", 0.0).unwrap()
    );
}
#[test]
fn explicit_named_shoots_rejoin_across_days_without_crossing_folders() {
    let items = vec![
        MediaMetadataItem::new("shoots/MS202603-Trip0001-Enhanced-NR.jpg", 0.0),
        MediaMetadataItem::new("shoots/ms202603-trip0002.JPG", 4.0 * 3_600.0),
        MediaMetadataItem::new("shoots/MS202603-Trip0003.jpg", 48.0 * 3_600.0),
    ];
    let result = cluster(
        &items,
        "source",
        &ClusteringConfig::default(),
        &Calendar::default(),
    )
    .unwrap();
    assert_eq!(result.events.len(), 1);
    assert_eq!(
        result.events[0].item_ids,
        items.iter().map(|i| i.id.as_str()).collect::<Vec<_>>()
    );
    assert_eq!(result.events[0].cover_item_id, items[1].id);
    assert!(result.events[0].is_multi_day);
    assert_eq!(result.events[0].sub_days.as_ref().unwrap().len(), 2);

    let crossed = vec![
        MediaMetadataItem::new("one/MS202603-Trip0001.jpg", 0.0),
        MediaMetadataItem::new("two/MS202603-Trip0002.jpg", 4.0 * 3_600.0),
    ];
    assert_eq!(
        cluster(
            &crossed,
            "source",
            &ClusteringConfig::default(),
            &Calendar::default()
        )
        .unwrap()
        .events
        .len(),
        2
    );
}

#[test]
fn named_shoot_merge_has_a_fourteen_day_ceiling() {
    for (hours, expected) in [(14.0 * 24.0, 1), (14.0 * 24.0 + 1.0 / 3_600.0, 2)] {
        let items = vec![
            MediaMetadataItem::new("shoots/MS202603-Trip0001.jpg", 0.0),
            MediaMetadataItem::new("shoots/MS202603-Trip0002.jpg", hours * 3_600.0),
        ];
        assert_eq!(
            cluster(
                &items,
                "source",
                &ClusteringConfig::default(),
                &Calendar::default()
            )
            .unwrap()
            .events
            .len(),
            expected
        );
    }
}

#[test]
fn filename_span_uses_the_final_session_of_a_travel_group() {
    let home = (18.5167, 73.8562);
    let away = (20.2954, 73.9846);
    let located = |id: &str, timestamp: f64, coordinate: (f64, f64)| {
        let mut item = MediaMetadataItem::new(id, timestamp);
        item.latitude = Some(coordinate.0);
        item.longitude = Some(coordinate.1);
        item
    };
    let day = 86_400.0;
    let start = 8.0 * 3_600.0;
    let home_items = (0..20)
        .map(|index| located(&format!("home{index}"), (index as f64 - 20.0) * day, home))
        .collect::<Vec<_>>();

    let mut named = home_items.clone();
    named.push(located("shoots/MS202603-Trip0001.jpg", start, away));
    let named_candidate_ids = (2..=14)
        .map(|number| format!("shoots/MS202603-Trip{number:04}.jpg"))
        .collect::<Vec<_>>();
    for (index, id) in named_candidate_ids.iter().enumerate() {
        named.push(located(
            id,
            9.0 * day + 18.0 * 3_600.0 + index as f64 * 10.0 * 3_600.0,
            away,
        ));
    }
    let result = cluster(
        &named,
        "source",
        &ClusteringConfig::default(),
        &Calendar::default(),
    )
    .unwrap();
    let named_events = result
        .events
        .iter()
        .filter(|event| event.item_ids.iter().any(|id| id.starts_with("shoots/")))
        .collect::<Vec<_>>();
    assert_eq!(named_events.len(), 2);
    assert_eq!(named_events[0].item_ids, ["shoots/MS202603-Trip0001.jpg"]);
    assert_eq!(named_events[1].item_ids, named_candidate_ids);

    let mut sequence = home_items;
    sequence.push(located("sequence/DSCF0100.jpg", start, away));
    let sequence_candidate_ids = (101..=105)
        .map(|number| format!("sequence/DSCF{number:04}.jpg"))
        .collect::<Vec<_>>();
    for (index, id) in sequence_candidate_ids.iter().enumerate() {
        sequence.push(located(
            id,
            2.0 * day + 18.0 * 3_600.0 + index as f64 * 10.0 * 3_600.0,
            away,
        ));
    }
    let result = cluster(
        &sequence,
        "source",
        &ClusteringConfig::default(),
        &Calendar::default(),
    )
    .unwrap();
    let sequence_events = result
        .events
        .iter()
        .filter(|event| event.item_ids.iter().any(|id| id.starts_with("sequence/")))
        .collect::<Vec<_>>();
    assert_eq!(sequence_events.len(), 2);
    assert_eq!(sequence_events[0].item_ids, ["sequence/DSCF0100.jpg"]);
    assert_eq!(sequence_events[1].item_ids, sequence_candidate_ids);
}

#[test]
fn overflowing_filename_numbers_and_non_ascii_case_folds_create_no_signal() {
    for ids in [
        [
            "shoots/MS202603-Trip99999999999999999999.jpg".to_owned(),
            "shoots/MS202603-Trip99999999999999999998.jpg".to_owned(),
        ],
        [
            "sequence/DSCF99999999999999999999.jpg".to_owned(),
            "sequence/DSCF99999999999999999998.jpg".to_owned(),
        ],
        [
            "shoots/MS202603-Trip0001\renhanced-nr.jpg".to_owned(),
            "shoots/MS202603-Trip0002\renhanced-nr.jpg".to_owned(),
        ],
    ] {
        let items = vec![
            MediaMetadataItem::new(ids[0].clone(), 0.0),
            MediaMetadataItem::new(ids[1].clone(), 6.0 * 3_600.0),
        ];
        assert_eq!(
            cluster(
                &items,
                "source",
                &ClusteringConfig::default(),
                &Calendar::default()
            )
            .unwrap()
            .events
            .len(),
            2,
            "{}",
            ids[0]
        );
    }
}

#[test]
fn filename_sequences_require_close_numbers_and_capture_times() {
    let items = vec![
        MediaMetadataItem::new("sequence/DSCF0100.jpg", 0.0),
        MediaMetadataItem::new("sequence/DSCF0105.jpg", 6.0 * 3_600.0),
        MediaMetadataItem::new("sequence/DSCF0117.jpg", 30.0 * 3_600.0),
        MediaMetadataItem::new("sequence/DSCF0118.jpg", 36.0 * 3_600.0),
    ];
    let result = cluster(
        &items,
        "source",
        &ClusteringConfig::default(),
        &Calendar::default(),
    )
    .unwrap();
    assert_eq!(result.events.len(), 2);
    assert_eq!(
        result.events[0].item_ids,
        [items[0].id.clone(), items[1].id.clone()]
    );
    assert_eq!(
        result.events[1].item_ids,
        [items[2].id.clone(), items[3].id.clone()]
    );

    for (number, expected) in [(112, 1), (113, 2)] {
        let pair = vec![
            MediaMetadataItem::new("sequence/DSCF0100.jpg", 0.0),
            MediaMetadataItem::new(format!("sequence/DSCF{number:04}.jpg"), 4.0 * 3_600.0),
        ];
        assert_eq!(
            cluster(
                &pair,
                "source",
                &ClusteringConfig::default(),
                &Calendar::default()
            )
            .unwrap()
            .events
            .len(),
            expected
        );
    }
}

#[test]
fn filename_sequences_are_bounded_and_timestamp_names_are_not_sequences() {
    let chained = (0..7)
        .map(|index| {
            MediaMetadataItem::new(
                format!("sequence/DSCF{index:04}.jpg"),
                if index < 6 {
                    index as f64 * 12.0 * 3_600.0
                } else {
                    73.0 * 3_600.0
                },
            )
        })
        .collect::<Vec<_>>();
    let result = cluster(
        &chained,
        "source",
        &ClusteringConfig::default(),
        &Calendar::default(),
    )
    .unwrap();
    assert_eq!(result.events.len(), 2);
    assert_eq!(result.events[0].item_ids.len(), 6);
    assert_eq!(result.events[1].item_ids, [chained[6].id.clone()]);

    let timestamped = vec![
        MediaMetadataItem::new("sequence/IMG_20260301_090000.jpg", 0.0),
        MediaMetadataItem::new("sequence/IMG_20260301_130000.jpg", 4.0 * 3_600.0),
    ];
    assert_eq!(
        cluster(
            &timestamped,
            "source",
            &ClusteringConfig::default(),
            &Calendar::default()
        )
        .unwrap()
        .events
        .len(),
        2
    );
    let ordinary = vec![
        MediaMetadataItem::new("sequence/IMG_0001.jpg", 0.0),
        MediaMetadataItem::new("sequence/IMG_0002.jpg", 4.0 * 3_600.0),
    ];
    assert_eq!(
        cluster(
            &ordinary,
            "source",
            &ClusteringConfig::default(),
            &Calendar::default()
        )
        .unwrap()
        .events
        .len(),
        1
    );
}

#[test]
fn date_precision_is_not_second_rounding_and_doubles_stay_unquantized() {
    // Date(timeIntervalSince1970:) values from the independent Swift probe.
    for (input, expected) in [
        (-1e-8, 0.0),
        (1e-8, 0.0),
        (-1.00000001, -1.0),
        (-0.99999999, -1.0),
        (0.99999999, 1.0),
        (1.00000001, 1.0),
        (-0.5, -0.5),
        (0.10000002, 0.10000002384185791),
    ] {
        let item = MediaMetadataItem::new("a", input);
        assert_eq!(item.timestamp, expected);
        assert_eq!(
            event_id("source", input).unwrap(),
            event_id("source", expected).unwrap()
        );
        let mut value =
            json!({"id":"a", "timestamp":input,"isScreenshot":false,"fileModTime":input});
        let decoded: MediaMetadataItem = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(decoded.timestamp, expected);
        assert_eq!(decoded.file_mod_time, Some(input));
        value["timestamp"] = json!(expected);
        assert_eq!(serde_json::to_value(decoded).unwrap(), value);
    }
    assert_eq!(Calendar::default().day_key(-1e-8).unwrap(), "1970-01-01");
    let cases = parity_cases();
    let r = cluster(&cases[5].0, "source", &cases[5].1, &Calendar::default()).unwrap();
    assert_eq!(r.events[0].item_ids, ["a", "z"]);
    assert_eq!(r.events[0].cover_item_id, "z");
    assert_eq!(r.events[0].start_date, 0.0);
    for (case, covers, events) in [(6, "a", 1), (7, "a", 2), (8, "b", 1), (9, "a", 1)] {
        let r = cluster(
            &cases[case].0,
            "source",
            &cases[case].1,
            &Calendar::default(),
        )
        .unwrap();
        assert_eq!(r.events.len(), events);
        assert_eq!(r.events[0].cover_item_id, covers);
    }
    let mut i = index();
    i.source.last_indexed_at = -1e-8;
    let item = MediaMetadataItem {
        timestamp: -1e-8,
        file_mod_time: Some(-1e-8),
        ..MediaMetadataItem::new("a", 0.0)
    };
    i.item_cache.insert("a".into(), item);
    let decoded = EventIndex::decode(&i.encode().unwrap()).unwrap();
    assert_eq!(decoded.source.last_indexed_at, 0.0);
    assert_eq!(decoded.item_cache["a"].timestamp, 0.0);
    assert_eq!(decoded.item_cache["a"].file_mod_time, Some(-1e-8));
    let status: RawDumpStatus = serde_json::from_value(
        json!({"configured":true,"isAvailable":true,"eventCount":1,"lastIndexedAt":-1e-8}),
    )
    .unwrap();
    assert_eq!(status.last_indexed_at, Some(0.0));
    let absent: RawDumpStatus =
        serde_json::from_value(json!({"configured":false,"isAvailable":false,"eventCount":0}))
            .unwrap();
    assert_eq!(absent.last_indexed_at, None);
}
#[cfg(target_os = "macos")]
#[test]
fn live_unmodified_swift_source_oracle_matches_unicode_and_date_regressions() {
    use std::{
        io::Write,
        process::{Command, Stdio},
    };
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let binary = std::path::PathBuf::from(
        std::env::var_os("CARGO_TARGET_DIR").unwrap_or_else(|| std::env::temp_dir().into()),
    )
    .join(format!("swift-parity-{}", std::process::id()));
    let sources = root.join("native/EventClustering/Sources/ManoramaEventClustering");
    let status = Command::new("swiftc")
        .args(["-o"])
        .arg(&binary)
        .args(
            [
                "Models.swift",
                "GeoMath.swift",
                "SHA256Digest.swift",
                "EventClusterer.swift",
            ]
            .map(|s| sources.join(s)),
        )
        .arg(root.join("crates/event-clustering/tests/SwiftParity.swift"))
        .status()
        .unwrap();
    assert!(status.success());
    let cases = parity_cases();
    let timestamps = vec![
        -1e-8,
        1e-8,
        -1.00000001,
        -0.99999999,
        0.99999999,
        1.00000001,
        0.10000002,
        -0.5,
        978307199.9999999,
        978307200.0,
        978307200.0000001,
    ];
    // Use raw assigned timestamps on input: serializing Item itself would
    // quantize before Swift and could conceal a Date-entrypoint defect.
    let inputs: Vec<_> = cases.iter().map(|(items, config)| json!({"items":items.iter().map(|i| json!({"id":i.id,"timestamp":i.timestamp,"isScreenshot":false})).collect::<Vec<_>>(),"config":config,"sourceId":"source"})).collect();
    let mut child = Command::new(&binary)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(
            json!({"cases":inputs,"timestamps":timestamps})
                .to_string()
                .as_bytes(),
        )
        .unwrap();
    let output = child.wait_with_output().unwrap();
    std::fs::remove_file(binary).unwrap();
    assert!(output.status.success());
    let swift: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    for (n, (items, config)) in cases.iter().enumerate() {
        let rust = cluster(items, "source", config, &Calendar::default()).unwrap();
        let expected: EventClusteringResult =
            serde_json::from_value(swift["results"][n].clone()).unwrap();
        assert_eq!(rust, expected, "Swift case {n}");
    }
    let rust_dates: Vec<_> = timestamps
        .iter()
        .map(|t| MediaMetadataItem::new("x", *t).timestamp)
        .collect();
    let swift_dates: Vec<f64> = serde_json::from_value(swift["timestamps"].clone()).unwrap();
    assert_eq!(rust_dates, swift_dates);
    println!(
        "Swift oracle: {} cases; Date(-1e-8)={}, Date(0.10000002)={}",
        cases.len(),
        swift_dates[0],
        swift_dates[6]
    );
}
