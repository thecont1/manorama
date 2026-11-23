use crate::{Calendar, Error};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaMetadataItem {
    pub id: String,
    #[serde(with = "crate::calendar::date_codec")]
    pub timestamp: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub latitude: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub longitude: Option<f64>,
    pub is_screenshot: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub burst_identifier: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_mod_time: Option<f64>,
}
impl MediaMetadataItem {
    pub fn new(id: impl Into<String>, timestamp: f64) -> Self {
        Self {
            id: id.into(),
            timestamp: crate::calendar::swift_date(timestamp),
            latitude: None,
            longitude: None,
            is_screenshot: false,
            burst_identifier: None,
            file_mod_time: None,
        }
    }
    pub fn coordinate(&self) -> Option<(f64, f64)> {
        let (lat, lon) = (self.latitude?, self.longitude?);
        // Deliberately BOTH: this preserves Swift's equator/prime-meridian guard.
        (lat.abs() > 0.0001 && lon.abs() > 0.0001).then_some((lat, lon))
    }
    pub(crate) fn validate(&self) -> Result<(), Error> {
        Calendar::instant(self.timestamp)?;
        if [self.latitude, self.longitude, self.file_mod_time]
            .into_iter()
            .flatten()
            .any(|n| !n.is_finite())
        {
            return Err(Error::InvalidInput("non-finite metadata".into()));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventDayGroup {
    pub id: String,
    #[serde(with = "crate::calendar::date_codec")]
    pub date: f64,
    pub item_ids: Vec<String>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventCluster {
    pub id: String,
    #[serde(with = "crate::calendar::date_codec")]
    pub start_date: f64,
    #[serde(with = "crate::calendar::date_codec")]
    pub end_date: f64,
    pub is_multi_day: bool,
    pub cover_item_id: String,
    pub item_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sub_days: Option<Vec<EventDayGroup>>,
}
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventClusteringResult {
    pub events: Vec<EventCluster>,
    pub screenshot_item_ids: Vec<String>,
    pub unplaced_item_ids: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct ClusteringConfig {
    pub session_gap_hours: f64,
    pub session_distance_km: f64,
    pub transit_bypass_minutes: f64,
    pub trip_distance_from_home_km: f64,
    pub trip_overnight_gap_hours: f64,
    pub burst_threshold_seconds: f64,
    pub visual_split_min_gap_hours: f64,
    pub visual_split_max_distance_km: f64,
    pub visual_split_feature_print_distance: f64,
}
impl Default for ClusteringConfig {
    fn default() -> Self {
        Self {
            session_gap_hours: 3.5,
            session_distance_km: 5.0,
            transit_bypass_minutes: 45.0,
            trip_distance_from_home_km: 50.0,
            trip_overnight_gap_hours: 18.0,
            burst_threshold_seconds: 3.0,
            visual_split_min_gap_hours: 1.5,
            visual_split_max_distance_km: 0.5,
            visual_split_feature_print_distance: 1.0,
        }
    }
}
impl ClusteringConfig {
    pub fn validate(&self) -> Result<(), Error> {
        let values = [
            self.session_gap_hours,
            self.session_distance_km,
            self.transit_bypass_minutes,
            self.trip_distance_from_home_km,
            self.trip_overnight_gap_hours,
            self.burst_threshold_seconds,
            self.visual_split_min_gap_hours,
            self.visual_split_max_distance_km,
            self.visual_split_feature_print_distance,
        ];
        if values.into_iter().any(|v| !v.is_finite() || v < 0.0) {
            return Err(Error::InvalidInput(
                "config thresholds must be finite and nonnegative".into(),
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RawDumpScanReport {
    pub clusters: Vec<EventCluster>,
    pub screenshot_count: usize,
    pub metadata_read_count: usize,
    pub event_count: usize,
    #[serde(with = "crate::calendar::date_codec")]
    pub last_indexed_at: f64,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RawDumpStatus {
    pub configured: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    pub is_available: bool,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "crate::calendar::optional_date_codec"
    )]
    pub last_indexed_at: Option<f64>,
    pub event_count: usize,
}
