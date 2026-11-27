#![cfg(feature = "android")]
use manorama_events::{android::*, *};
use serde_json::json;
fn options() -> String {
    json!({"sourceId":"source", "calendar":{"identifier":"gregorian","secondsFromGMT":0}, "config":{}}).to_string()
}
#[test]
fn json_bridge_preserves_source_calendar_and_seconds() {
    let items = json!([{"id":"a", "timestamp":-0.5, "isScreenshot":false}]).to_string();
    let result: EventClusteringResult =
        serde_json::from_str(&cluster_json(&items, &options()).unwrap()).unwrap();
    assert_eq!(result.events[0].start_date, -0.5);
    assert_eq!(result.events[0].id, event_id("source", -0.5).unwrap());
    assert_eq!(result.events[0].item_ids, ["a"]);
}
#[test]
fn malformed_or_untrusted_json_never_succeeds_empty() {
    for items in [
        "null",
        "{}",
        "not-json",
        "[{}]",
        "[{\"id\":\"a\",\"timestamp\":1e100,\"isScreenshot\":false}]",
        "[{\"id\":\"a\",\"timestamp\":null,\"isScreenshot\":false}]",
    ] {
        assert!(cluster_json(items, &options()).is_err(), "{items}");
    }
    for config in ["null", "{}", "not-json", "{\"sourceId\":\"source\",\"calendar\":{},\"config\":{}}",
        "{\"sourceId\":\"source\",\"calendar\":{\"identifier\":\"gregorian\",\"secondsFromGMT\":0},\"config\":{\"sessionGapHours\":-1}}"] {
        assert!(cluster_json("[]", config).is_err(), "{config}");
    }
    let deep = format!("{}0{}", "[".repeat(1000), "]".repeat(1000));
    assert!(cluster_json(&deep, &options()).is_err());
}
#[test]
fn index_bridge_roundtrip_and_unknown_schema_rebuild() {
    let mut index = EventIndex::new(
        SourceFingerprint {
            device_id: "device".into(),
            source_id: "source".into(),
            source_kind: "mediastore".into(),
            label: "Camera".into(),
            last_indexed_at: -0.5,
        },
        ClusteringConfig::default(),
    );
    let json = String::from_utf8(index.encode().unwrap()).unwrap();
    assert_eq!(
        decode_index_json(&encode_index_json(&json).unwrap()).unwrap(),
        json
    );
    index.schema_version = 2;
    let unknown = String::from_utf8(index.encode().unwrap()).unwrap();
    assert!(decode_index_json(&unknown).is_err());
    assert!(encode_index_json(&unknown).is_err());
    assert!(decode_index_json("{}").is_err());
    assert!(encode_index_json("bad").is_err());
}
#[test]
fn helpers_bound_identifiers_counts_config_and_utf8_before_typed_parse() {
    for field in ["id", "burstIdentifier"] {
        let mut item = json!({"id":"a","timestamp":0,"isScreenshot":false});
        item[field] = json!("x".repeat(MAX_IDENTIFIER_BYTES + 1));
        assert!(cluster_json(&json!([item]).to_string(), &options()).is_err());
    }
    let large_id =
        json!([{"id":"x".repeat(1024 * 1024),"timestamp":0,"isScreenshot":false}]).to_string();
    assert!(cluster_json(&large_id, &options()).is_err());
    let source = options().replace(
        "\"source\"",
        &format!("\"{}\"", "x".repeat(MAX_IDENTIFIER_BYTES + 1)),
    );
    assert!(cluster_json("[]", &source).is_err());
    let padded = format!("{}{}", options(), " ".repeat(MAX_CONFIG_BYTES));
    assert!(cluster_json("[]", &padded).is_err());
    let count = format!("[{}0]", "0,".repeat(MAX_ITEMS));
    assert!(cluster_json(&count, &options()).is_err());
    let huge = " ".repeat(MAX_JSON_BYTES + 1);
    for f in [decode_index_json, encode_index_json] {
        assert!(f(&huge).is_err());
    }
    assert!(cluster_json(&huge, &options()).is_err());
}
#[test]
fn index_collection_and_day_budgets_apply_to_both_helpers() {
    let i = EventIndex::new(
        SourceFingerprint {
            device_id: "device".into(),
            source_id: "source".into(),
            source_kind: "mediastore".into(),
            label: "Camera".into(),
            last_indexed_at: 0.0,
        },
        ClusteringConfig::default(),
    );
    let mut value = serde_json::to_value(i).unwrap();
    value["screenshotItemIds"] = json!(vec!["a"; MAX_ITEMS + 1]);
    for f in [decode_index_json, encode_index_json] {
        assert!(f(&value.to_string()).is_err());
    }
    value["screenshotItemIds"] = json!([]);
    value["events"] = json!([{"id":"evt_00000000000000000000","startDate":0,"endDate":1,"isMultiDay":true,"coverItemId":"a","itemIds":["a"],"subDays":vec![json!({"id":"1970-01-01","date":0,"itemIds":["a"]}); 367]}]);
    for f in [decode_index_json, encode_index_json] {
        assert!(f(&value.to_string()).is_err());
    }
    value["events"] = json!([]);
    value["source"]["sourceId"] = json!("x".repeat(MAX_IDENTIFIER_BYTES + 1));
    for f in [decode_index_json, encode_index_json] {
        assert!(f(&value.to_string()).is_err());
    }
    value["source"]["sourceId"] = json!("source");
    value["itemCache"] = json!({"a":{"id":"a","timestamp":0,"isScreenshot":false,"burstIdentifier":"x".repeat(MAX_IDENTIFIER_BYTES + 1)}});
    for f in [decode_index_json, encode_index_json] {
        assert!(f(&value.to_string()).is_err());
    }
}
#[test]
fn fifty_thousand_realistic_records_remain_accepted() {
    let items: Vec<_> = (0..50_000)
        .map(|n| {
            MediaMetadataItem::new(format!("camera/IMG_{n:05}.jpg"), 1_760_000_000.0 + n as f64)
        })
        .collect();
    let input = serde_json::to_string(&items).unwrap();
    assert!(input.len() < MAX_JAVA_UNITS);
    let output = cluster_json(&input, &options()).unwrap();
    let result: EventClusteringResult = serde_json::from_str(&output).unwrap();
    assert_eq!(
        result
            .events
            .iter()
            .map(|e| e.item_ids.len())
            .sum::<usize>(),
        50_000
    );
}
#[test]
fn response_expansion_is_rejected_by_bounded_serialization() {
    let prefix = "x".repeat(3000);
    let items: Vec<_> = (0..5600)
        .map(|n| MediaMetadataItem::new(format!("{prefix}{n}"), n as f64 * 20_000.0))
        .collect();
    let input = serde_json::to_string(&items).unwrap();
    assert!(input.len() < MAX_JSON_BYTES);
    let error = cluster_json(&input, &options()).unwrap_err().to_string();
    assert!(error.contains("output limit"), "{error}");
}
