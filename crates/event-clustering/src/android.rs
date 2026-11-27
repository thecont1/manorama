//! JNI JSON boundary for in.thecontrarian.manorama.events.RustBridge.
//! No Android metadata, bitmap or permission code enters the shared library.
use crate::{cluster, CalendarSpec, ClusteringConfig, Error, EventIndex, MediaMetadataItem};
use jni::{
    objects::{JClass, JString},
    sys::jstring,
    JNIEnv,
};
use serde::{
    de::{self, DeserializeSeed, MapAccess, SeqAccess, Visitor},
    Deserialize, Serialize,
};
use std::{
    fmt,
    io::{self, Write},
};

// 50k metadata records fit comfortably; these are transport budgets, not an
// invitation to allocate until OOM. Paths/source/burst IDs share the wire's
// 4096-byte filesystem reach; member/day counts match packages/core.
pub const MAX_JSON_BYTES: usize = 32 * 1024 * 1024;
pub const MAX_JAVA_UNITS: usize = 16 * 1024 * 1024;
pub const MAX_CONFIG_BYTES: usize = 16 * 1024;
pub const MAX_IDENTIFIER_BYTES: usize = 4096;
pub const MAX_ITEMS: usize = 100_000;
const MAX_DAYS: usize = 366;
const MAX_COLLECTION_ENTRIES: usize = 2_000_000;

fn limit(ok: bool) -> Result<(), Error> {
    if ok {
        Ok(())
    } else {
        Err(Error::InvalidInput("JSON resource limit exceeded".into()))
    }
}
// A borrowed streaming preflight rejects huge collections/identifiers BEFORE
// building Vec<Item> or an index. The second pass uses the existing typed codec.
struct Budget {
    entries: usize,
}
impl<'de> DeserializeSeed<'de> for &mut Budget {
    type Value = ();
    fn deserialize<D: de::Deserializer<'de>>(self, d: D) -> Result<(), D::Error> {
        d.deserialize_any(self)
    }
}
impl<'de> Visitor<'de> for &mut Budget {
    type Value = ();
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("bounded JSON")
    }
    fn visit_bool<E: de::Error>(self, _: bool) -> Result<(), E> {
        Ok(())
    }
    fn visit_i64<E: de::Error>(self, _: i64) -> Result<(), E> {
        Ok(())
    }
    fn visit_u64<E: de::Error>(self, _: u64) -> Result<(), E> {
        Ok(())
    }
    fn visit_f64<E: de::Error>(self, _: f64) -> Result<(), E> {
        Ok(())
    }
    fn visit_unit<E: de::Error>(self) -> Result<(), E> {
        Ok(())
    }
    fn visit_str<E: de::Error>(self, s: &str) -> Result<(), E> {
        if s.len() > MAX_IDENTIFIER_BYTES {
            Err(E::custom("identifier limit exceeded"))
        } else {
            Ok(())
        }
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<(), A::Error> {
        let mut count = 0;
        while let Some(()) = seq.next_element_seed(&mut *self)? {
            count += 1;
            self.entries += 1;
            if count > MAX_ITEMS || self.entries > MAX_COLLECTION_ENTRIES {
                return Err(de::Error::custom("collection limit exceeded"));
            }
        }
        Ok(())
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<(), A::Error> {
        let mut count = 0;
        while let Some(()) = map.next_key_seed(&mut *self)? {
            count += 1;
            self.entries += 1;
            if count > MAX_ITEMS || self.entries > MAX_COLLECTION_ENTRIES {
                return Err(de::Error::custom("collection limit exceeded"));
            }
            map.next_value_seed(&mut *self)?;
        }
        Ok(())
    }
}
fn preflight(json: &str, max_bytes: usize) -> Result<(), Error> {
    limit(json.len() <= max_bytes)?;
    let mut decoder = serde_json::Deserializer::from_str(json);
    (&mut Budget { entries: 0 }).deserialize(&mut decoder)?;
    decoder.end()?;
    Ok(())
}
struct BoundedWriter {
    bytes: Vec<u8>,
}
impl Write for BoundedWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() > MAX_JSON_BYTES.saturating_sub(self.bytes.len()) {
            return Err(io::Error::other("output limit exceeded"));
        }
        self.bytes
            .try_reserve(bytes.len())
            .map_err(|_| io::Error::other("output allocation failed"))?;
        self.bytes.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
fn bounded_json(value: &impl Serialize) -> Result<String, Error> {
    let mut writer = BoundedWriter { bytes: Vec::new() };
    serde_json::to_writer(&mut writer, value)?;
    let text = String::from_utf8(writer.bytes)
        .map_err(|_| Error::InvalidInput("invalid UTF-8 output".into()))?;
    limit(text.encode_utf16().count() <= MAX_JAVA_UNITS)?;
    Ok(text)
}
fn validate_index_limits(index: &EventIndex) -> Result<(), Error> {
    limit(
        index.item_cache.len() <= MAX_ITEMS
            && index.events.len() <= MAX_ITEMS
            && index.screenshot_item_ids.len() <= MAX_ITEMS,
    )?;
    let mut members = index.screenshot_item_ids.len();
    let mut day_members = 0usize;
    for event in &index.events {
        members = members.saturating_add(event.item_ids.len());
        limit(members <= MAX_ITEMS)?;
        if let Some(days) = &event.sub_days {
            limit(days.len() <= MAX_DAYS)?;
            for day in days {
                day_members = day_members.saturating_add(day.item_ids.len());
                limit(day_members <= MAX_ITEMS)?;
            }
        }
    }
    Ok(())
}

/// configJson is {sourceId, calendar, config}; calendar uses the golden schema.
/// An explicit namespace and calendar avoid host/device-default disagreements.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClusterOptions {
    pub source_id: String,
    pub calendar: CalendarSpec,
    pub config: ClusteringConfig,
}
pub fn cluster_json(items_json: &str, config_json: &str) -> Result<String, Error> {
    preflight(items_json, MAX_JSON_BYTES)?;
    preflight(config_json, MAX_CONFIG_BYTES)?;
    let items: Vec<MediaMetadataItem> = serde_json::from_str(items_json)?;
    limit(items.len() <= MAX_ITEMS)?;
    let options: ClusterOptions = serde_json::from_str(config_json)?;
    let result = cluster(
        &items,
        &options.source_id,
        &options.config,
        &options.calendar.calendar()?,
    )?;
    bounded_json(&result)
}
pub fn decode_index_json(json: &str) -> Result<String, Error> {
    preflight(json, MAX_JSON_BYTES)?;
    let index = EventIndex::decode(json.as_bytes())?;
    validate_index_limits(&index)?;
    // Preserve the codec's sortedKeys form; the tree is already transport-bounded.
    // No complete output string is allocated before the writer enforces its cap.
    bounded_json(&serde_json::to_value(&index)?)
}
pub fn encode_index_json(json: &str) -> Result<String, Error> {
    // Both directions validate the schema. An unknown cache asks the shell to
    // rebuild, never to reinterpret it as a current index.
    decode_index_json(json)
}
fn error_payload(code: &str, message: &str) -> String {
    serde_json::json!({"code": code, "message": message}).to_string()
}
fn java_json(
    env: &mut JNIEnv<'_>,
    text: &JString<'_>,
    units: usize,
    bytes: usize,
) -> Result<String, String> {
    if text.is_null() {
        return Err("null JSON string".into());
    }
    // String.length() is safe JNI and does not copy the Java backing storage.
    // get_string must remain AFTER this gate, including the tiny config gate.
    let length = env
        .call_method(text, "length", "()I", &[])
        .and_then(|v| v.i())
        .map_err(|e| e.to_string())?;
    if length < 0 || length as usize > units {
        return Err("Java String resource limit exceeded before copy".into());
    }
    let json: String = env.get_string(text).map_err(|e| e.to_string())?.into();
    if json.len() > bytes {
        return Err("UTF-8 JSON resource limit exceeded".into());
    }
    Ok(json)
}
fn bridge(
    mut env: JNIEnv<'_>,
    operation: impl FnOnce(&mut JNIEnv<'_>) -> Result<String, String>,
) -> jstring {
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(
        || -> Result<String, String> {
            let text = operation(&mut env)?;
            if text.len() > MAX_JSON_BYTES || text.encode_utf16().count() > MAX_JAVA_UNITS {
                return Err("JNI output resource limit exceeded".into());
            }
            Ok(text)
        },
    ));
    match outcome {
        Ok(Ok(text)) => match env.new_string(text) {
            Ok(string) => string.into_raw(),
            Err(_) => {
                let _ = env.throw_new(
                    "java/lang/RuntimeException",
                    error_payload("JNI_ALLOCATION", "could not allocate result"),
                );
                std::ptr::null_mut()
            }
        },
        Ok(Err(message)) => {
            let _ = env.throw_new(
                "java/lang/IllegalArgumentException",
                error_payload("INVALID_INPUT", &message),
            );
            std::ptr::null_mut()
        }
        Err(_) => {
            let _ = env.throw_new(
                "java/lang/RuntimeException",
                error_payload("INTERNAL_ERROR", "event engine failed"),
            );
            std::ptr::null_mut()
        }
    }
}
#[no_mangle]
pub extern "system" fn Java_in_thecontrarian_manorama_events_RustBridge_cluster(
    env: JNIEnv<'_>,
    _class: JClass<'_>,
    items: JString<'_>,
    config: JString<'_>,
) -> jstring {
    bridge(env, |env| {
        let items = java_json(env, &items, MAX_JAVA_UNITS, MAX_JSON_BYTES)?;
        let config = java_json(env, &config, MAX_CONFIG_BYTES, MAX_CONFIG_BYTES)?;
        cluster_json(&items, &config).map_err(|e| e.to_string())
    })
}
#[no_mangle]
pub extern "system" fn Java_in_thecontrarian_manorama_events_RustBridge_decodeIndex(
    env: JNIEnv<'_>,
    _class: JClass<'_>,
    index: JString<'_>,
) -> jstring {
    bridge(env, |env| {
        let json = java_json(env, &index, MAX_JAVA_UNITS, MAX_JSON_BYTES)?;
        decode_index_json(&json).map_err(|e| e.to_string())
    })
}
#[no_mangle]
pub extern "system" fn Java_in_thecontrarian_manorama_events_RustBridge_encodeIndex(
    env: JNIEnv<'_>,
    _class: JClass<'_>,
    index: JString<'_>,
) -> jstring {
    bridge(env, |env| {
        let json = java_json(env, &index, MAX_JAVA_UNITS, MAX_JSON_BYTES)?;
        encode_index_json(&json).map_err(|e| e.to_string())
    })
}
