use manorama_events::*;
use serde::Deserialize;
use std::{fs, path::PathBuf};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct IndexCase {
    schema_version: i64,
    expected_reusable: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Fixture {
    schema_version: i64,
    source_id: String,
    calendar: CalendarSpec,
    config: ClusteringConfig,
    items: Vec<MediaMetadataItem>,
    expected: EventClusteringResult,
    home_base: Option<GeoCell>,
    index_cases: Option<Vec<IndexCase>>,
}
fn directory() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/event-clustering")
}
fn parity(name: &str) {
    let data = fs::read(directory().join(format!("{name}.json"))).unwrap();
    let f: Fixture = serde_json::from_slice(&data).unwrap();
    assert_eq!(f.schema_version, 1);
    let engine = EventClusterer::new(
        &f.source_id,
        f.config.clone(),
        f.calendar.calendar().unwrap(),
    )
    .unwrap();
    assert_eq!(engine.cluster(&f.items).unwrap(), f.expected, "{name}");
    let mut reversed = f.items.clone();
    reversed.reverse();
    assert_eq!(
        engine.cluster(&reversed).unwrap(),
        f.expected,
        "input order: {name}"
    );
    let real: Vec<_> = f
        .items
        .iter()
        .filter(|i| !i.is_screenshot)
        .cloned()
        .collect();
    assert_eq!(
        engine.inferred_home_base(&real).unwrap(),
        f.home_base,
        "home: {name}"
    );
    let source = SourceFingerprint {
        device_id: "synthetic-device".into(),
        source_id: f.source_id.clone(),
        source_kind: EventIndex::FOLDER_SOURCE_KIND.into(),
        label: "Synthetic metadata".into(),
        last_indexed_at: 0.0,
    };
    let mut index = EventIndex::new(source, f.config.clone());
    index.item_cache = f.items.iter().cloned().map(|i| (i.id.clone(), i)).collect();
    index.events = f.expected.events.clone();
    index.screenshot_item_ids = f.expected.screenshot_item_ids.clone();
    assert_eq!(EventIndex::decode(&index.encode().unwrap()).unwrap(), index);
    for case in f.index_cases.unwrap_or_default() {
        index.schema_version = case.schema_version;
        assert_eq!(
            index.matches("synthetic-device", &f.source_id),
            case.expected_reusable
        );
        let encoded = index.encode().unwrap();
        assert_eq!(
            EventIndex::reusable(&encoded, "synthetic-device", &f.source_id).is_some(),
            case.expected_reusable
        );
        assert!(!index.matches("other-device", &f.source_id));
        assert!(!index.matches("synthetic-device", "other-source"));
    }
    #[cfg(feature = "android")]
    {
        let options = serde_json::json!({"sourceId": f.source_id, "calendar": f.calendar, "config": f.config});
        let json = android::cluster_json(
            &serde_json::to_string(&f.items).unwrap(),
            &options.to_string(),
        )
        .unwrap();
        assert_eq!(
            serde_json::from_str::<EventClusteringResult>(&json).unwrap(),
            f.expected,
            "JNI JSON: {name}"
        );
    }
}
macro_rules! fixtures {
    ($($test:ident => $name:literal),+ $(,)?) => {
        const NAMES: &[&str] = &[$($name),+];
        $(#[test] fn $test() { parity($name); })+
    }
}
fixtures! {
    dinner_and_drinks => "01-dinner-and-drinks",
    hike_and_dinner => "02-hike-and-dinner",
    four_day_trip => "03-four-day-trip",
    screenshots_and_bursts => "04-screenshots-and-bursts-at-dinner",
    session_gap_equal => "05-session-gap-equal",
    session_gap_above => "06-session-gap-above",
    session_distance_below => "07-session-distance-below",
    session_distance_above => "08-session-distance-above",
    transit_equal => "09-transit-window-equal",
    transit_above => "10-transit-window-above",
    trip_gap_below => "11-trip-gap-below",
    trip_gap_equal => "12-trip-gap-equal",
    trip_distance_below => "13-trip-distance-below",
    trip_distance_above => "14-trip-distance-above",
    home_days => "15-home-days-beat-frame-count",
    home_frames => "16-home-frame-count-tie-break",
    home_earliest => "17-home-earliest-tie-break",
    home_latitude => "18-home-latitude-tie-break",
    home_longitude => "19-home-longitude-tie-break",
    one_day_not_home => "20-home-one-day-is-not-home",
    negative_rounding => "21-home-negative-half-rounding",
    burst_equal_chain_even => "22-burst-threshold-equal-chain-even",
    burst_above => "23-burst-threshold-above",
    burst_distinct_ids => "24-burst-distinct-identifiers",
    burst_same_id => "25-burst-same-identifier-overrides-place",
    burst_missing_coords => "26-burst-missing-and-zero-coordinates",
    burst_place => "27-burst-place-threshold",
    time_only => "28-time-only-no-trip-or-visual-split",
    equal_time_ids => "29-input-order-and-equal-time-ids",
    unicode_source => "30-source-identity-unicode",
    earlier_frame => "31-earlier-frame-changes-id",
    utc_subdays => "32-calendar-utc-trip-burst-subdays",
    iana_dst => "33-calendar-iana-dst-trip",
    fixed_offset => "34-calendar-fixed-offset-same-day",
    negative_epoch => "35-negative-fractional-epoch",
    empty_schema => "36-empty-and-index-schema-versions",
    screenshots_only => "37-screenshots-only-never-infer-home",
}
#[test]
fn fixture_inventory_is_complete() {
    let mut actual: Vec<_> = fs::read_dir(directory())
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().is_some_and(|e| e == "json"))
        .map(|p| p.file_stem().unwrap().to_str().unwrap().to_owned())
        .collect();
    actual.sort();
    let mut expected: Vec<_> = NAMES.iter().map(|s| s.to_string()).collect();
    expected.sort();
    assert_eq!(expected.len(), 37);
    assert_eq!(actual, expected, "missing or unconsumed fixture");
}
