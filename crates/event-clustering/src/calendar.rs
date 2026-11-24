use crate::Error;
#[cfg(target_os = "android")]
use chrono::NaiveDate;
use chrono::TimeZone;
use chrono::{DateTime, Datelike, FixedOffset, NaiveDateTime, Utc};
#[cfg(not(target_os = "android"))]
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
    #[cfg(not(target_os = "android"))]
    Iana(Tz),
    #[cfg(target_os = "android")]
    System,
}
impl Default for Calendar {
    fn default() -> Self {
        Self::Fixed(FixedOffset::east_opt(0).expect("UTC has a valid offset"))
    }
}
#[cfg(not(target_os = "android"))]
use chrono::Offset;
impl Calendar {
    pub fn fixed_offset(seconds: i32) -> Result<Self, Error> {
        FixedOffset::east_opt(seconds)
            .map(Self::Fixed)
            .ok_or_else(|| Error::InvalidCalendar("offset must be less than 24 hours".into()))
    }
    #[cfg(not(target_os = "android"))]
    pub fn iana(name: &str) -> Result<Self, Error> {
        name.parse::<Tz>()
            .map(Self::Iana)
            .map_err(|_| Error::InvalidCalendar("unknown IANA timezone".into()))
    }
    #[cfg(target_os = "android")]
    pub fn iana(name: &str) -> Result<Self, Error> {
        if let Some(seconds) = gmt_offset_seconds(name) {
            return Self::fixed_offset(seconds);
        }
        if name.starts_with("GMT") || name.starts_with("UTC") {
            return Err(Error::InvalidCalendar("invalid GMT timezone".into()));
        }
        if name.is_empty()
            || name.len() > 128
            || !name
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'/' | b'_' | b'+' | b'-' | b'.'))
            || name.contains("..")
        {
            return Err(Error::InvalidCalendar("invalid IANA timezone".into()));
        }
        // bionic resolves the process timezone from the device's own tzdata.
        Ok(Self::System)
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
        #[cfg(target_os = "android")]
        {
            if let Self::Fixed(zone) = self {
                let date = instant.with_timezone(zone).date_naive();
                return Ok(format!(
                    "{:04}-{:02}-{:02}",
                    date.year(),
                    date.month(),
                    date.day()
                ));
            }
            let mut local: libc::tm = unsafe { std::mem::zeroed() };
            let result = unsafe { libc::localtime_r(&instant.timestamp(), &mut local) };
            if result.is_null() {
                return Err(Error::InvalidInput(
                    "timestamp outside device timezone".into(),
                ));
            }
            return Ok(format!(
                "{:04}-{:02}-{:02}",
                local.tm_year + 1900,
                local.tm_mon + 1,
                local.tm_mday
            ));
        }
        #[cfg(not(target_os = "android"))]
        {
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
    }
    pub(crate) fn local_timestamp(&self, date: NaiveDateTime) -> Option<f64> {
        #[cfg(target_os = "android")]
        {
            if let Self::Fixed(zone) = self {
                return zone
                    .from_local_datetime(&date)
                    .earliest()
                    .map(|instant| instant.timestamp() as f64);
            }
            system_local_timestamp(date)
        }
        #[cfg(not(target_os = "android"))]
        {
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
                            let before =
                                date.checked_sub_signed(chrono::Duration::minutes(minutes))?;
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
}

#[cfg(target_os = "android")]
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

#[cfg(target_os = "android")]
fn system_local_timestamp(date: NaiveDateTime) -> Option<f64> {
    use chrono::Timelike;
    use std::collections::BTreeSet;

    fn local(seconds: i64) -> Option<libc::tm> {
        let mut value: libc::tm = unsafe { std::mem::zeroed() };
        let result = unsafe { libc::localtime_r(&seconds, &mut value) };
        (!result.is_null()).then_some(value)
    }
    fn wall(value: &libc::tm) -> Option<NaiveDateTime> {
        NaiveDate::from_ymd_opt(
            value.tm_year + 1900,
            value.tm_mon as u32 + 1,
            value.tm_mday as u32,
        )?
        .and_hms_opt(
            value.tm_hour as u32,
            value.tm_min as u32,
            value.tm_sec as u32,
        )
    }

    let target = NaiveDate::from_ymd_opt(date.year(), date.month(), date.day())?.and_hms_opt(
        date.hour(),
        date.minute(),
        date.second(),
    )?;
    let naive = target.and_utc().timestamp();
    let offsets: BTreeSet<_> = [naive - 129_600, naive, naive + 129_600]
        .into_iter()
        .filter_map(local)
        .map(|value| value.tm_gmtoff as i64)
        .collect();
    let mut earliest = None;
    let mut after_gap = None;
    for offset in offsets {
        let candidate = naive.checked_sub(offset)?;
        let value = local(candidate)?;
        let wall = wall(&value)?;
        if wall == target {
            earliest = Some(earliest.unwrap_or(candidate).min(candidate));
        } else if wall > target {
            let delta = wall.signed_duration_since(target).num_seconds();
            after_gap = after_gap.map_or(Some((delta, candidate)), |current: (i64, i64)| {
                Some(if delta < current.0 {
                    (delta, candidate)
                } else {
                    current
                })
            });
        }
    }
    earliest
        .or_else(|| after_gap.map(|(_, candidate)| candidate))
        .map(|seconds| seconds as f64)
}

#[cfg(all(test, target_os = "android"))]
mod android_tests {
    use super::*;
    use chrono::NaiveDate;
    use std::ffi::CString;

    extern "C" {
        fn tzset();
    }

    #[test]
    fn gmt_offsets_and_system_dst_match_foundation() {
        let zone = CString::new("America/New_York").unwrap();
        let key = CString::new("TZ").unwrap();
        unsafe {
            assert_eq!(libc::setenv(key.as_ptr(), zone.as_ptr(), 1), 0);
            tzset();
        }

        let india = Calendar::iana("GMT+05:30").unwrap();
        let utc = Calendar::fixed_offset(0).unwrap();
        let boundary = NaiveDate::from_ymd_opt(2026, 1, 1)
            .unwrap()
            .and_hms_opt(18, 30, 0)
            .unwrap()
            .and_utc()
            .timestamp() as f64;
        assert_eq!(utc.day_key(boundary).unwrap(), "2026-01-01");
        assert_eq!(india.day_key(boundary).unwrap(), "2026-01-02");
        assert_eq!(
            india.local_timestamp(
                NaiveDate::from_ymd_opt(2026, 1, 2)
                    .unwrap()
                    .and_hms_opt(0, 0, 0)
                    .unwrap()
            ),
            Some(boundary)
        );
        assert!(Calendar::iana("GMT+24:00").is_err());

        let new_york = Calendar::iana("America/New_York").unwrap();
        assert_eq!(
            new_york.local_timestamp(
                NaiveDate::from_ymd_opt(2026, 3, 8)
                    .unwrap()
                    .and_hms_opt(2, 30, 0)
                    .unwrap()
            ),
            Some(1_772_955_000.0)
        );
        assert_eq!(
            new_york.local_timestamp(
                NaiveDate::from_ymd_opt(2026, 11, 1)
                    .unwrap()
                    .and_hms_opt(1, 30, 0)
                    .unwrap()
            ),
            Some(1_793_511_000.0)
        );
    }
}
