use crate::{
    Calendar, ClusteringConfig, Error, EventCluster, EventClusteringResult, MediaMetadataItem,
};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

pub const SCHEMA_VERSION: i64 = 1;
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceFingerprint {
    pub device_id: String,
    pub source_id: String,
    pub source_kind: String,
    pub label: String,
    #[serde(with = "crate::calendar::date_codec")]
    pub last_indexed_at: f64,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventIndex {
    pub schema_version: i64,
    pub source: SourceFingerprint,
    pub config: ClusteringConfig,
    pub item_cache: BTreeMap<String, MediaMetadataItem>,
    pub events: Vec<EventCluster>,
    pub screenshot_item_ids: Vec<String>,
}
impl EventIndex {
    pub const PHOTOKIT_SOURCE_ID: &'static str = "photokit-library";
    pub const FOLDER_SOURCE_KIND: &'static str = "folder";
    pub const PHOTOKIT_SOURCE_KIND: &'static str = "photokit";
    pub fn new(mut source: SourceFingerprint, config: ClusteringConfig) -> Self {
        source.last_indexed_at = crate::calendar::swift_date(source.last_indexed_at);
        Self {
            schema_version: SCHEMA_VERSION,
            source,
            config,
            item_cache: BTreeMap::new(),
            events: vec![],
            screenshot_item_ids: vec![],
        }
    }
    pub fn encode(&self) -> Result<Vec<u8>, Error> {
        self.validate()?;
        // serde_json's default map is a BTreeMap: sorted keys at every level,
        // including metadata dictionaries, just like Swift's sortedKeys encoder.
        Ok(serde_json::to_vec(&serde_json::to_value(self)?)?)
    }
    pub fn decode(data: &[u8]) -> Result<Self, Error> {
        let index: Self = serde_json::from_slice(data)?;
        if index.schema_version != SCHEMA_VERSION {
            return Err(Error::UnsupportedSchema(index.schema_version));
        }
        index.validate()?;
        Ok(index)
    }
    /// Corrupt, wrong-source and unknown-version caches all request a rebuild.
    pub fn reusable(data: &[u8], device_id: &str, source_id: &str) -> Option<Self> {
        Self::decode(data)
            .ok()
            .filter(|i| i.matches(device_id, source_id))
    }
    pub fn matches(&self, device_id: &str, source_id: &str) -> bool {
        self.schema_version == SCHEMA_VERSION
            && self.source.device_id == device_id
            && self.source.source_id == source_id
    }
    pub fn needs_metadata_read(&self, id: &str, file_mod_time: Option<f64>) -> bool {
        match (
            self.item_cache.get(id).and_then(|i| i.file_mod_time),
            file_mod_time,
        ) {
            (Some(cached), Some(current)) if cached.is_finite() && current.is_finite() => {
                (current - cached).abs() >= 1.0
            }
            _ => true,
        }
    }
    pub fn pruning(&self, absent_ids: &BTreeSet<String>) -> Self {
        let mut next = self.clone();
        next.item_cache.retain(|id, _| !absent_ids.contains(id));
        next.screenshot_item_ids
            .retain(|id| !absent_ids.contains(id));
        next
    }
    pub fn applying(
        &self,
        result: &EventClusteringResult,
        item_cache: BTreeMap<String, MediaMetadataItem>,
        indexed_at: f64,
    ) -> Result<Self, Error> {
        let mut next = self.clone();
        next.item_cache = item_cache;
        next.events = result.events.clone();
        next.screenshot_item_ids = result.screenshot_item_ids.clone();
        next.source.last_indexed_at = crate::calendar::swift_date(indexed_at);
        next.validate()?;
        Ok(next)
    }
    pub fn indexed_item_count(&self) -> usize {
        self.item_cache.len()
    }
    fn validate(&self) -> Result<(), Error> {
        self.config.validate()?;
        Calendar::instant(self.source.last_indexed_at)?;
        for (key, item) in &self.item_cache {
            item.validate()?;
            if key != &item.id {
                return Err(Error::InvalidInput("cache key differs from item id".into()));
            }
        }
        for event in &self.events {
            Calendar::instant(event.start_date)?;
            Calendar::instant(event.end_date)?;
            if let Some(days) = &event.sub_days {
                for day in days {
                    Calendar::instant(day.date)?;
                }
            }
        }
        Ok(())
    }
}
