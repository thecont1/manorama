use crate::calendar::{
    date_interval, date_midpoint_reference, distance_from_reference, swift_date,
};
use crate::{
    haversine_km, Calendar, ClusteringConfig, Error, EventCluster, EventClusteringResult,
    EventDayGroup, GeoCell, MediaMetadataItem,
};
use sha2::{Digest, Sha256};
use std::{
    cmp::Ordering,
    collections::{BTreeMap, BTreeSet},
};
use unicode_normalization::UnicodeNormalization;

fn swift_string_cmp(a: &str, b: &str) -> Ordering {
    if a.is_ascii() && b.is_ascii() {
        a.as_bytes().cmp(b.as_bytes())
    } else {
        a.nfc().cmp(b.nfc())
    }
}

pub fn event_id(source_id: &str, start_seconds: f64) -> Result<String, Error> {
    Calendar::instant(start_seconds)?;
    let digest = Sha256::digest(
        format!("{source_id}|{}", swift_date(start_seconds).floor() as i64).as_bytes(),
    );
    let hex: String = digest[..10].iter().map(|b| format!("{b:02x}")).collect();
    Ok(format!("evt_{hex}"))
}

pub struct EventClusterer {
    source_id: String,
    config: ClusteringConfig,
    calendar: Calendar,
}
struct Burst<'a> {
    members: Vec<&'a MediaMetadataItem>,
}
impl<'a> Burst<'a> {
    fn representative(&self) -> &'a MediaMetadataItem {
        self.members[self.members.len() / 2]
    }
}
struct Session<'a> {
    bursts: Vec<Burst<'a>>,
}
impl Session<'_> {
    fn start(&self) -> f64 {
        self.bursts[0].members[0].timestamp
    }
    fn end(&self) -> f64 {
        self.bursts
            .last()
            .unwrap()
            .members
            .last()
            .unwrap()
            .timestamp
    }
    fn centroid(&self) -> Option<(f64, f64)> {
        let points: Vec<_> = self
            .bursts
            .iter()
            .filter_map(|b| b.representative().coordinate())
            .collect();
        if points.is_empty() {
            return None;
        }
        Some((
            points.iter().map(|p| p.0).sum::<f64>() / points.len() as f64,
            points.iter().map(|p| p.1).sum::<f64>() / points.len() as f64,
        ))
    }
}
impl EventClusterer {
    pub fn new(
        source_id: impl Into<String>,
        config: ClusteringConfig,
        calendar: Calendar,
    ) -> Result<Self, Error> {
        config.validate()?;
        Ok(Self {
            source_id: source_id.into(),
            config,
            calendar,
        })
    }
    pub fn inferred_home_base(
        &self,
        items: &[MediaMetadataItem],
    ) -> Result<Option<GeoCell>, Error> {
        struct Stat {
            cell: GeoCell,
            frames: usize,
            days: BTreeSet<String>,
            earliest: f64,
        }
        let mut stats: BTreeMap<(i64, i64), Stat> = BTreeMap::new();
        for item in items {
            item.validate()?;
            let Some(cell) = GeoCell::from_item(item) else {
                continue;
            };
            let stat = stats.entry(cell.key()).or_insert_with(|| Stat {
                cell,
                frames: 0,
                days: BTreeSet::new(),
                earliest: swift_date(item.timestamp),
            });
            stat.frames += 1;
            stat.days.insert(self.calendar.day_key(item.timestamp)?);
            stat.earliest = stat.earliest.min(swift_date(item.timestamp));
        }
        Ok(stats
            .values()
            .filter(|s| s.days.len() >= 2)
            .min_by(|a, b| {
                b.days
                    .len()
                    .cmp(&a.days.len())
                    .then(b.frames.cmp(&a.frames))
                    .then(a.earliest.total_cmp(&b.earliest))
                    .then(a.cell.latitude.total_cmp(&b.cell.latitude))
                    .then(a.cell.longitude.total_cmp(&b.cell.longitude))
            })
            .map(|s| s.cell))
    }
    pub fn cluster(&self, items: &[MediaMetadataItem]) -> Result<EventClusteringResult, Error> {
        for item in items {
            item.validate()?;
        }
        // Public fields may be assigned directly, bypassing the constructor or
        // codec; Date conversion belongs at this entrypoint too, before ordering.
        let normalized: Vec<_> = items
            .iter()
            .map(|item| {
                let mut item = item.clone();
                item.timestamp = swift_date(item.timestamp);
                item
            })
            .collect();
        let mut ordered: Vec<_> = normalized.iter().collect();
        ordered.sort_by(|a, b| {
            a.timestamp
                .partial_cmp(&b.timestamp)
                .unwrap()
                .then_with(|| swift_string_cmp(&a.id, &b.id))
        });
        let screenshots = ordered
            .iter()
            .filter(|i| i.is_screenshot)
            .map(|i| i.id.clone())
            .collect();
        let real: Vec<_> = ordered.into_iter().filter(|i| !i.is_screenshot).collect();
        let home_items: Vec<_> = real.iter().map(|i| (*i).clone()).collect();
        let home = self.inferred_home_base(&home_items)?;
        let mut bursts: Vec<Burst<'_>> = Vec::new();
        for item in real {
            let joins = bursts
                .last()
                .map(|b| {
                    let previous = b.members.last().unwrap();
                    let same_place = match (&previous.burst_identifier, &item.burst_identifier) {
                        (Some(a), Some(b)) => a == b,
                        _ => match (previous.coordinate(), item.coordinate()) {
                            (Some(a), Some(b)) => haversine_km(a.0, a.1, b.0, b.1) < 0.2,
                            _ => true,
                        },
                    };
                    date_interval(item.timestamp, previous.timestamp)
                        <= self.config.burst_threshold_seconds
                        && same_place
                })
                .unwrap_or(false);
            if joins {
                bursts.last_mut().unwrap().members.push(item);
            } else {
                bursts.push(Burst {
                    members: vec![item],
                });
            }
        }
        let mut sessions: Vec<Session<'_>> = Vec::new();
        for burst in bursts {
            let split = sessions
                .last()
                .map(|s| {
                    let previous = s.bursts.last().unwrap().representative();
                    let current = burst.representative();
                    let gap_hours = date_interval(current.timestamp, previous.timestamp) / 3600.0;
                    if gap_hours > self.config.session_gap_hours {
                        return true;
                    }
                    match (previous.coordinate(), current.coordinate()) {
                        (Some(a), Some(b))
                            if gap_hours * 3600.0 > self.config.transit_bypass_minutes * 60.0 =>
                        {
                            haversine_km(a.0, a.1, b.0, b.1) > self.config.session_distance_km
                        }
                        _ => false,
                    }
                })
                .unwrap_or(true);
            if split {
                sessions.push(Session {
                    bursts: vec![burst],
                });
            } else {
                sessions.last_mut().unwrap().bursts.push(burst);
            }
        }
        let mut groups: Vec<Vec<Session<'_>>> = Vec::new();
        let mut previous_away = false;
        for session in sessions {
            let away = match (home, session.centroid()) {
                (Some(h), Some(c)) => {
                    haversine_km(h.latitude, h.longitude, c.0, c.1)
                        > self.config.trip_distance_from_home_km
                }
                _ => false,
            };
            let joins = groups
                .last()
                .map(|g| {
                    previous_away
                        && away
                        && date_interval(session.start(), g.last().unwrap().end()) / 3600.0
                            < self.config.trip_overnight_gap_hours
                })
                .unwrap_or(false);
            if joins {
                groups.last_mut().unwrap().push(session);
            } else {
                groups.push(vec![session]);
            }
            previous_away = away;
        }
        let events = groups
            .iter()
            .map(|g| self.event(g))
            .collect::<Result<_, _>>()?;
        Ok(EventClusteringResult {
            events,
            screenshot_item_ids: screenshots,
            unplaced_item_ids: vec![],
        })
    }
    fn event(&self, group: &[Session<'_>]) -> Result<EventCluster, Error> {
        // Groups, sessions and bursts are created nonempty; no input-controlled indexing.
        let start = group[0].start();
        let end = group.last().unwrap().end();
        let reps: Vec<_> = group
            .iter()
            .flat_map(|s| s.bursts.iter().map(Burst::representative))
            .collect();
        let item_ids = group
            .iter()
            .flat_map(|s| {
                s.bursts
                    .iter()
                    .flat_map(|b| b.members.iter().map(|i| i.id.clone()))
            })
            .collect();
        let midpoint = date_midpoint_reference(start, end);
        let mut cover = reps[0];
        for rep in &reps[1..] {
            if distance_from_reference(rep.timestamp, midpoint)
                < distance_from_reference(cover.timestamp, midpoint)
            {
                cover = rep;
            }
        }
        let mut days: Vec<EventDayGroup> = Vec::new();
        for rep in reps {
            let key = self.calendar.day_key(rep.timestamp)?;
            if let Some(day) = days.iter_mut().find(|d| d.id == key) {
                day.item_ids.push(rep.id.clone());
                day.date = day.date.min(rep.timestamp);
            } else {
                days.push(EventDayGroup {
                    id: key,
                    date: rep.timestamp,
                    item_ids: vec![rep.id.clone()],
                });
            }
        }
        let is_multi_day = group.len() > 1 && days.len() > 1;
        Ok(EventCluster {
            id: event_id(&self.source_id, start)?,
            start_date: start,
            end_date: end,
            is_multi_day,
            cover_item_id: cover.id.clone(),
            item_ids,
            sub_days: is_multi_day.then_some(days),
        })
    }
}

pub fn cluster(
    items: &[MediaMetadataItem],
    source_id: &str,
    config: &ClusteringConfig,
    calendar: &Calendar,
) -> Result<EventClusteringResult, Error> {
    EventClusterer::new(source_id, config.clone(), calendar.clone())?.cluster(items)
}
