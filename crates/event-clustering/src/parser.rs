//! Pure header parsing; accepts the same Exif/TIFF/GPS field names as ImageIO.
use crate::Calendar;
use chrono::{Duration, NaiveDate};
use serde_json::{Map, Value};

pub type HeaderFields = Map<String, Value>;
#[derive(Clone, Debug, Default)]
pub struct ImageHeaderProperties {
    pub exif: HeaderFields,
    pub tiff: HeaderFields,
    pub gps: HeaderFields,
}
impl ImageHeaderProperties {
    pub fn from_properties(properties: &HeaderFields) -> Self {
        let fields = |key| {
            properties
                .get(key)
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default()
        };
        Self {
            exif: fields("{Exif}"),
            tiff: fields("{TIFF}"),
            gps: fields("{GPS}"),
        }
    }
}
fn text<'a>(fields: &'a HeaderFields, key: &str) -> Option<&'a str> {
    fields.get(key)?.as_str()
}
fn whitespace_trim(text: &str) -> &str {
    text.trim_matches(|c: char| c.is_whitespace() && c != '\n' && c != '\r')
}
pub fn tz_offset_seconds(text: Option<&str>) -> Option<i32> {
    let raw = whitespace_trim(text?);
    if raw.is_empty() {
        return None;
    }
    if raw == "Z" || raw == "z" {
        return Some(0);
    }
    let (sign, body) = match raw.as_bytes()[0] {
        b'+' => (1, &raw[1..]),
        b'-' => (-1, &raw[1..]),
        _ => (1, raw),
    };
    let digits: Vec<_> = body.chars().filter(|c| *c != ':').collect();
    if digits.len() < 2 {
        return None;
    }
    let hours: i32 = digits[..2].iter().collect::<String>().parse().ok()?;
    let minutes: i32 = if digits.len() >= 4 {
        digits[2..4].iter().collect::<String>().parse().unwrap_or(0)
    } else {
        0
    };
    if !(0..24).contains(&hours) || !(0..60).contains(&minutes) {
        return None;
    }
    Some(sign * (hours * 3600 + minutes * 60))
}
pub fn capture_date(exif: &HeaderFields, local_calendar: &Calendar) -> Option<f64> {
    let raw = text(exif, "DateTimeOriginal").or_else(|| text(exif, "DateTimeDigitized"))?;
    let normalized = whitespace_trim(raw).replace('T', " ");
    let (date, time) = normalized.trim_start_matches(' ').split_once(' ')?;
    let date_parts: Vec<_> = date.split([':', '-']).filter(|p| !p.is_empty()).collect();
    let time_parts: Vec<_> = time
        .trim_start_matches(' ')
        .split(':')
        .filter(|p| !p.is_empty())
        .collect();
    if date_parts.len() != 3 || time_parts.len() < 2 {
        return None;
    }
    let year: i32 = date_parts[0].parse().ok()?;
    let month: i64 = date_parts[1].parse().ok()?;
    let day: i64 = date_parts[2].parse().ok()?;
    let hour: i64 = time_parts[0].parse().ok()?;
    let minute: i64 = time_parts[1].parse().ok()?;
    let second: i64 = time_parts
        .get(2)
        .and_then(|p| p.split('.').next())
        .unwrap_or("0")
        .parse()
        .unwrap_or(0);
    // Calendar.date(from:) normalizes overflowing components. Use checked math
    // so malicious header fields can only fail, never panic or wrap.
    let month_index = (year as i64)
        .checked_mul(12)?
        .checked_add(month)?
        .checked_sub(1)?;
    let normalized_year = i32::try_from(month_index.div_euclid(12)).ok()?;
    let normalized_month = (month_index.rem_euclid(12) + 1) as u32;
    let base =
        NaiveDate::from_ymd_opt(normalized_year, normalized_month, 1)?.and_hms_opt(0, 0, 0)?;
    let seconds = day
        .checked_sub(1)?
        .checked_mul(86400)?
        .checked_add(hour.checked_mul(3600)?)?
        .checked_add(minute.checked_mul(60)?)?
        .checked_add(second)?;
    let local = base.checked_add_signed(Duration::try_seconds(seconds)?)?;
    let offset =
        tz_offset_seconds(text(exif, "OffsetTimeOriginal").or_else(|| text(exif, "OffsetTime")));
    let zone = offset.and_then(|n| Calendar::fixed_offset(n).ok());
    zone.as_ref()
        .unwrap_or(local_calendar)
        .local_timestamp(local)
}
fn scalar(value: &Value) -> Option<f64> {
    value
        .as_f64()
        .or_else(|| value.as_str()?.parse().ok())
        .filter(|n| n.is_finite())
}
pub fn decimal(value: &Value) -> Option<f64> {
    if let Some(n) = scalar(value) {
        return Some(n);
    }
    let parts = value.as_array()?;
    if parts.len() != 3 {
        return None;
    }
    Some(scalar(&parts[0])? + scalar(&parts[1])? / 60.0 + scalar(&parts[2])? / 3600.0)
}
pub fn coordinate(gps: &HeaderFields) -> Option<(f64, f64)> {
    let lat = decimal(gps.get("Latitude")?)?
        * if text(gps, "LatitudeRef") == Some("S") {
            -1.0
        } else {
            1.0
        };
    let lon = decimal(gps.get("Longitude")?)?
        * if text(gps, "LongitudeRef") == Some("W") {
            -1.0
        } else {
            1.0
        };
    // Parser accepts an equator fix; the model's stricter BOTH guard still
    // excludes it from clustering. Preserve that current Swift distinction.
    (lat.abs() <= 90.0 && lon.abs() <= 180.0 && (lat.abs() > 0.0001 || lon.abs() > 0.0001))
        .then_some((lat, lon))
}
pub fn is_screenshot(tiff: &HeaderFields, path_extension: &str, file_name: &str) -> bool {
    if ["Make", "Model"]
        .into_iter()
        .any(|key| text(tiff, key).is_some_and(|s| !whitespace_trim(s).is_empty()))
    {
        return false;
    }
    let name = file_name.to_lowercase();
    name.starts_with("screenshot")
        || name.starts_with("screen shot")
        || name.contains("screenshot")
        || path_extension.eq_ignore_ascii_case("png")
}
