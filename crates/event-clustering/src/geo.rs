use crate::MediaMetadataItem;
use serde::{Deserialize, Serialize};

pub fn haversine_km(a_lat: f64, a_lon: f64, b_lat: f64, b_lon: f64) -> f64 {
    let d_lat = (b_lat - a_lat) * std::f64::consts::PI / 180.0;
    let d_lon = (b_lon - a_lon) * std::f64::consts::PI / 180.0;
    let phi1 = a_lat * std::f64::consts::PI / 180.0;
    let phi2 = b_lat * std::f64::consts::PI / 180.0;
    let h = (d_lat / 2.0).sin() * (d_lat / 2.0).sin()
        + phi1.cos() * phi2.cos() * (d_lon / 2.0).sin() * (d_lon / 2.0).sin();
    2.0 * 6371.0088 * h.min(1.0).sqrt().atan2((1.0 - h.min(1.0)).max(0.0).sqrt())
}
pub fn is_same_place_km(km: f64, tolerance: f64) -> bool {
    km <= tolerance
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct GeoCell {
    pub latitude: f64,
    pub longitude: f64,
}
impl GeoCell {
    pub fn new(latitude: f64, longitude: f64) -> Self {
        // Rust round(), like Swift rounded(), takes half ties away from zero.
        Self {
            latitude: (latitude * 10.0).round() / 10.0,
            longitude: (longitude * 10.0).round() / 10.0,
        }
    }
    pub fn from_item(item: &MediaMetadataItem) -> Option<Self> {
        item.coordinate().map(|(lat, lon)| Self::new(lat, lon))
    }
    pub(crate) fn key(self) -> (i64, i64) {
        (
            (self.latitude * 10.0).round() as i64,
            (self.longitude * 10.0).round() as i64,
        )
    }
}
