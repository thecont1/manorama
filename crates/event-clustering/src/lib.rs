//! On-device metadata grouping. All timestamps here and in the index are f64 epoch
//! seconds; conversion to a WebView's milliseconds belongs to the consuming shell.
#[cfg(feature = "android")]
pub mod android;
mod calendar;
mod cluster;
#[cfg(feature = "fs-scan")]
pub mod fs_scan;
mod geo;
mod index;
mod models;
pub mod parser;

pub use calendar::{Calendar, CalendarSpec};
pub use cluster::{cluster, event_id, EventClusterer};
pub use geo::{haversine_km, is_same_place_km, GeoCell};
pub use index::{EventIndex, SourceFingerprint, SCHEMA_VERSION};
pub use models::*;

#[derive(Debug)]
pub enum Error {
    Json(serde_json::Error),
    InvalidCalendar(String),
    InvalidInput(String),
    UnsupportedSchema(i64),
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Json(e) => write!(f, "invalid JSON: {e}"),
            Self::InvalidCalendar(s) => write!(f, "invalid calendar: {s}"),
            Self::InvalidInput(s) => write!(f, "invalid input: {s}"),
            Self::UnsupportedSchema(n) => {
                write!(f, "unsupported index schema {n}; rebuild required")
            }
        }
    }
}
impl std::error::Error for Error {}
impl From<serde_json::Error> for Error {
    fn from(value: serde_json::Error) -> Self {
        Self::Json(value)
    }
}
