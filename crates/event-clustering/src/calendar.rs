use crate::Error;
use chrono::TimeZone;
use chrono::{DateTime, Datelike, FixedOffset, NaiveDateTime, Utc};
use chrono_tz::Tz;
use serde::{Deserialize, Serialize};

const REFERENCE_EPOCH: f64 = 978_307_200.0;
/// Foundation Date stores a Double relative to 2001, including its precision
/// loss on conversion from Unix seconds. Thresholds and fileModTime are Doubles,
/// not Dates, and must never pass through this conversion.
pub(crate) fn swift_date(seconds: f64) -> f64 {
    (seconds - REFERENCE_EPOCH) + REFERENCE_EPOCH
}
pub(crate) fn date_interval(later: f64, earlier: f64) -> f64 {
    (later - REFERENCE_EPOCH) - (earlier - REFERENCE_EPOCH)
}
pub(crate) fn date_midpoint_reference(start: f64, end: f64) -> f64 {
    // addingTimeInterval works in Date's reference epoch. Converting this
    // intermediate midpoint back to Unix seconds would lose extra precision.
    (start - REFERENCE_EPOCH) + date_interval(end, start) / 2.0
}
pub(crate) fn distance_from_reference(seconds: f64, reference: f64) -> f64 {
    ((seconds - REFERENCE_EPOCH) - reference).abs()
}
pub(crate) mod date_codec {
    use super::swift_date;
    use serde::{Deserialize, Deserializer, Serializer};
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<f64, D::Error> {
        f64::deserialize(d).map(swift_date)
    }
    pub fn serialize<S: Serializer>(value: &f64, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_f64(swift_date(*value))
    }
}

pub(crate) mod optional_date_codec {
    use super::swift_date;
    use serde::{Deserialize, Deserializer, Serialize, Serializer};
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Option<f64>, D::Error> {
        Option::<f64>::deserialize(d).map(|date| date.map(swift_date))
    }
    pub fn serialize<S: Serializer>(value: &Option<f64>, s: S) -> Result<S::Ok, S::Error> {
        value.map(swift_date).serialize(s)
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CalendarSpec {
    pub identifier: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub time_zone_identifier: Option<String>,
    #[serde(
        rename = "secondsFromGMT",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub seconds_from_gmt: Option<i32>,
}
impl Default for CalendarSpec {
    fn default() -> Self {
        Self {
            identifier: "gregorian".into(),
            time_zone_identifier: None,
            seconds_from_gmt: Some(0),
        }
    }
}
impl CalendarSpec {
    pub fn calendar(&self) -> Result<Calendar, Error> {
        if self.identifier != "gregorian" {
            return Err(Error::InvalidCalendar("only Gregorian is supported".into()));
        }
        match (&self.time_zone_identifier, self.seconds_from_gmt) {
            (Some(name), None) => Calendar::iana(name),
            (None, Some(seconds)) => Calendar::fixed_offset(seconds),
            _ => Err(Error::InvalidCalendar("supply exactly one timezone".into())),
        }
    }
}
#[derive(Clone, Debug)]
pub enum Calendar {
    Fixed(FixedOffset),
    Iana(Tz),
}
impl Default for Calendar {
    fn default() -> Self {
        Self::Fixed(FixedOffset::east_opt(0).expect("UTC has a valid offset"))
    }
}
use chrono::Offset;
impl Calendar {
    pub fn fixed_offset(seconds: i32) -> Result<Self, Error> {
        FixedOffset::east_opt(seconds)
            .map(Self::Fixed)
            .ok_or_else(|| Error::InvalidCalendar("offset must be less than 24 hours".into()))
    }
    pub fn iana(name: &str) -> Result<Self, Error> {
        if let Some(seconds) = gmt_offset_seconds(name) {
            return Self::fixed_offset(seconds);
        }
        name.parse::<Tz>()
            .map(Self::Iana)
            .map_err(|_| Error::InvalidCalendar("unknown IANA timezone".into()))
    }
    pub(crate) fn instant(seconds: f64) -> Result<DateTime<Utc>, Error> {
        if !seconds.is_finite() || seconds.abs() > 8_000_000_000_000.0 {
            return Err(Error::InvalidInput(
                "timestamp outside supported Gregorian range".into(),
            ));
        }
        let seconds = swift_date(seconds);
        let floor = seconds.floor();
        let nanos = ((seconds - floor) * 1e9).floor() as u32;
        DateTime::from_timestamp(floor as i64, nanos).ok_or_else(|| {
            Error::InvalidInput("timestamp outside supported Gregorian range".into())
        })
    }
    pub fn day_key(&self, seconds: f64) -> Result<String, Error> {
        let instant = Self::instant(seconds)?;
        let date = match self {
            Self::Fixed(zone) => instant.with_timezone(zone).date_naive(),
            Self::Iana(zone) => instant.with_timezone(zone).date_naive(),
        };
        Ok(format!(
            "{:04}-{:02}-{:02}",
            date.year(),
            date.month(),
            date.day()
        ))
    }

    pub(crate) fn local_timestamp(&self, date: NaiveDateTime) -> Option<f64> {
        // Foundation chooses the first occurrence of an ambiguous wall time,
        // and advances nonexistent times by the gap using the preceding offset.
        // A bounded search also covers IANA's historical skipped calendar days.
        let instant = match self {
            Self::Fixed(zone) => zone
                .from_local_datetime(&date)
                .earliest()?
                .with_timezone(&Utc),
            Self::Iana(zone) => {
                if let Some(instant) = zone.from_local_datetime(&date).earliest() {
                    instant.with_timezone(&Utc)
                } else {
                    let mut preceding = None;
                    for minutes in 1..=1440 {
                        let before = date.checked_sub_signed(chrono::Duration::minutes(minutes))?;
                        if let Some(instant) = zone.from_local_datetime(&before).earliest() {
                            preceding = Some(instant.offset().fix());
                            break;
                        }
                    }
                    preceding?
                        .from_local_datetime(&date)
                        .earliest()?
                        .with_timezone(&Utc)
                }
            }
        };
        Some(instant.timestamp() as f64)
    }
}

fn gmt_offset_seconds(name: &str) -> Option<i32> {
    let raw = name
        .strip_prefix("GMT")
        .or_else(|| name.strip_prefix("UTC"))?;
    if raw.is_empty() {
        return Some(0);
    }
    let (sign, body) = match raw.as_bytes()[0] {
        b'+' => (1, &raw[1..]),
        b'-' => (-1, &raw[1..]),
        _ => (1, raw),
    };
    if body.is_empty() {
        return None;
    }
    let parts: Vec<_> = body.split(':').collect();
    if parts.len() > 3
        || parts
            .first()
            .is_some_and(|part| part.is_empty() || part.len() > 2)
        || parts.iter().skip(1).any(|part| part.len() != 2)
        || parts
            .iter()
            .any(|part| !part.bytes().all(|byte| byte.is_ascii_digit()))
    {
        return None;
    }
    let hours = parts[0].parse::<i32>().ok()?;
    let minutes = parts
        .get(1)
        .and_then(|part| part.parse::<i32>().ok())
        .unwrap_or(0);
    let seconds = parts
        .get(2)
        .and_then(|part| part.parse::<i32>().ok())
        .unwrap_or(0);
    let offset = hours * 3600 + minutes * 60 + seconds;
    (offset < 86_400).then_some(sign * offset)
}
