import Foundation

/*
 * Layer 3: the clustering itself.
 *
 * Deterministic by construction. Same items, same config, same calendar,
 * same source id — same events, byte for byte, on a Mac and on an iPhone.
 * That is the property the whole feature rests on: an event that
 * reshuffles between devices is a bug the user cannot be asked to reason
 * about, so nothing here reads a wall clock, a locale, or a random value.
 *
 * The passes, in order:
 *
 *   0  Hygiene      screenshots set aside; sub-second runs collapsed
 *   1  Home base     the busiest ~11 km cell, inferred from the dump alone
 *   2  Sessions      split on silence or on a jump, with a transit bypass
 *   3  Trips         merge travel sessions across short overnights
 *   4  Vision        optional tie-breaker inside the ambiguous gap band
 *
 * Pass 4 is the only one that can ask a second framework for help, and it
 * is expressed as an injected probe rather than a `Vision` import: the
 * core stays Foundation-only and testable without a GPU or a photograph.
 */

/// The tie-breaker of pass 4, supplied by the platform shell.
///
/// Returning nil means "no opinion" — an unreadable file, a cloud
/// placeholder that has not hydrated, a build without Vision — and the
/// clusterer keeps the session together. Absent evidence is not evidence
/// of a boundary.
public protocol VisualBoundaryProbe: Sendable {
    /// Perceptual distance between two frames, on the scale the config's
    /// `visualSplitFeaturePrintDistance` is calibrated against.
    func visualDistance(between first: MediaMetadataItem, and second: MediaMetadataItem) -> Double?
}

public struct EventClusterer: Sendable {
    /// Namespace for the deterministic event ids: the same timeline under
    /// two different sources is two different sets of events.
    private let sourceId: String
    private let config: ClusteringConfig
    /// The calendar days are cut in. Injectable so the tests are not at
    /// the mercy of the machine's timezone.
    private let calendar: Calendar
    private let probe: (any VisualBoundaryProbe)?

    public init(
        sourceId: String,
        config: ClusteringConfig = ClusteringConfig(),
        calendar: Calendar = .current,
        probe: (any VisualBoundaryProbe)? = nil
    ) {
        self.sourceId = sourceId
        self.config = config
        self.calendar = calendar
        self.probe = probe
    }

    // MARK: - Intermediate shapes

    /// A rapid-fire run collapsed to one representative.
    ///
    /// `members` keeps every frame — the collapse is a statement about
    /// density, never a deletion.
    struct Burst {
        let representative: MediaMetadataItem
        let members: [MediaMetadataItem]
        var ids: [String] { members.map(\.id) }
    }

    /// One outing: the unit pass 2 produces and pass 3 merges.
    struct Session {
        var bursts: [Burst]
        var start: Date { bursts.first?.members.first?.timestamp ?? .distantFuture }
        var end: Date { bursts.last?.members.last?.timestamp ?? .distantPast }
        var allIds: [String] { bursts.flatMap(\.ids) }
        var representatives: [MediaMetadataItem] { bursts.map(\.representative) }

        /// The mean of the geotagged frames. Mean rather than median: a
        /// session is a place the camera wandered around, and the point
        /// furthest from home is not what the session *was*.
        var centroid: (latitude: Double, longitude: Double)? {
            let points = representatives.compactMap(\.coordinate)
            guard !points.isEmpty else { return nil }
            let lat = points.reduce(0) { $0 + $1.latitude } / Double(points.count)
            let lon = points.reduce(0) { $0 + $1.longitude } / Double(points.count)
            return (lat, lon)
        }
    }

    // MARK: - Entry point

    public func cluster(_ items: [MediaMetadataItem]) -> EventClusteringResult {
        // One deterministic order everywhere downstream: time first, id as
        // the tie-break, so frames captured in the same second do not
        // swap places between runs.
        let ordered = items.sorted {
            $0.timestamp == $1.timestamp ? $0.id < $1.id : $0.timestamp < $1.timestamp
        }

        let screenshots = ordered.filter(\.isScreenshot)
        let real = ordered.filter { !$0.isScreenshot }
        guard !real.isEmpty else {
            return EventClusteringResult(events: [], screenshotItemIds: screenshots.map(\.id))
        }

        let bursts = collapseBursts(real)
        let home = inferredHomeBase(from: real)
        var sessions = sessionize(bursts)
        if probe != nil {
            sessions = sessions.flatMap { refine($0) }
        }

        let groups = mergeTrips(sessions, homeBase: home)
        let events = groups.map { event(from: $0) }

        return EventClusteringResult(
            events: events,
            screenshotItemIds: screenshots.map(\.id)
        )
    }

    // MARK: - Pass 0: burst collapse

    /// Group runs of frames taken within `burstThresholdSeconds` of each
    /// other at the same place (or with no place recorded at all).
    ///
    /// PhotoKit hands iPhone bursts a `burstIdentifier`; a Mac reading a
    /// Drive backup has nothing but timestamps, because the copying step
    /// stripped the metadata that would have said so. Grouping on the
    /// clock therefore has to be the rule and the identifier only ever a
    /// shortcut: two frames carrying different identifiers are never one
    /// burst even if they landed in the same second.
    func collapseBursts(_ items: [MediaMetadataItem]) -> [Burst] {
        guard !items.isEmpty else { return [] }
        var bursts: [Burst] = []
        var current: [MediaMetadataItem] = [items[0]]

        func samePlace(_ a: MediaMetadataItem, _ b: MediaMetadataItem) -> Bool {
            if let first = a.burstIdentifier, let second = b.burstIdentifier {
                return first == second
            }
            guard let ca = a.coordinate, let cb = b.coordinate else { return true }
            return GeoMath.haversineKm(ca.latitude, ca.longitude, cb.latitude, cb.longitude) < 0.2
        }

        for index in 1..<items.count {
            let previous = items[index - 1]
            let candidate = items[index]
            let delta = candidate.timestamp.timeIntervalSince(previous.timestamp)
            if delta <= config.burstThresholdSeconds, samePlace(previous, candidate) {
                current.append(candidate)
            } else {
                bursts.append(makeBurst(current))
                current = [candidate]
            }
        }
        bursts.append(makeBurst(current))
        return bursts
    }

    /// The middle frame leads a burst.
    ///
    /// First frames are the half-press, last frames are the pan off; the
    /// middle of a three-shot run is the one the photographer was looking
    /// at. An even run takes the frame after the midpoint, the one more
    /// likely to have settled.
    private func makeBurst(_ members: [MediaMetadataItem]) -> Burst {
        Burst(representative: members[members.count / 2], members: members)
    }

    // MARK: - Pass 1: home base

    /// The cell the camera keeps coming back to, or nil when the dump
    /// cannot support the claim.
    ///
    /// No reverse geocoding, no place database, no network: the question
    /// pass 3 asks is only "was this far from where the camera spends its
    /// life", and the dump already answers it.
    ///
    /// Ranked by how many separate days a cell appears on, not how many
    /// frames. A ten-day honeymoon photographs three thousand frames in one
    /// cell and outranks a hometown photographed dutifully across six
    /// hundred, which is exactly backwards: what makes a place home is that
    /// the camera returns to it, not that one week was busy. Frame count,
    /// then first appearance, then the cell's own coordinates break the
    /// ties, so the answer never depends on dictionary order.
    ///
    /// A cell must appear on at least two separate days to qualify. One
    /// day is a stop on the way, and a dump of a single weekend away has
    /// no hometown in it — better no travel classification than one
    /// invented from the trip itself.
    public func inferredHomeBase(from items: [MediaMetadataItem]) -> GeoCell? {
        struct Stat {
            var frames = 0
            var days = Set<String>()
            var earliest = Date.distantFuture
        }
        var stats: [GeoCell: Stat] = [:]
        for item in items {
            guard let cell = GeoCell(item: item) else { continue }
            var stat = stats[cell] ?? Stat()
            stat.frames += 1
            stat.days.insert(dayKey(for: item.timestamp))
            if item.timestamp < stat.earliest { stat.earliest = item.timestamp }
            stats[cell] = stat
        }
        let qualified = stats.filter { $0.value.days.count >= 2 }
        guard !qualified.isEmpty else { return nil }
        return qualified.min { lhs, rhs in
            let a = lhs.value, b = rhs.value
            if a.days.count != b.days.count { return a.days.count > b.days.count }
            if a.frames != b.frames { return a.frames > b.frames }
            if a.earliest != b.earliest { return a.earliest < b.earliest }
            if lhs.key.latitude != rhs.key.latitude { return lhs.key.latitude < rhs.key.latitude }
            return lhs.key.longitude < rhs.key.longitude
        }?.key
    }

    // MARK: - Pass 2: sessionization

    /// Split the burst timeline into outings.
    ///
    /// A break is silence, or a jump. The bypass matters: 30 km in 20
    /// minutes is a car on a highway, and calling that two events would
    /// split every road trip into its rest stops.
    func sessionize(_ bursts: [Burst]) -> [Session] {
        guard !bursts.isEmpty else { return [] }
        var sessions: [Session] = [Session(bursts: [bursts[0]])]

        for index in 1..<bursts.count {
            let previousBurst = bursts[index - 1]
            let currentBurst = bursts[index]
            let previous = previousBurst.representative
            let current = currentBurst.representative
            let gapHours = current.timestamp.timeIntervalSince(previous.timestamp) / 3600
            var split = gapHours > config.sessionGapHours

            if !split,
               let a = previous.coordinate, let b = current.coordinate,
               gapHours * 3600 > config.transitBypassMinutes * 60 {
                let km = GeoMath.haversineKm(a.latitude, a.longitude, b.latitude, b.longitude)
                if km > config.sessionDistanceKm { split = true }
            }

            if split {
                sessions.append(Session(bursts: [currentBurst]))
            } else {
                sessions[sessions.count - 1].bursts.append(currentBurst)
            }
        }
        return sessions
    }

    // MARK: - Pass 4: ambiguous-boundary tie-breaker

    /// Split a session inside the ambiguous gap band, on the probe's say-so.
    ///
    /// Only gaps the clock cannot decide are worth a model's opinion:
    /// under `visualSplitMinGapHours` it is one outing, over
    /// `sessionGapHours` it already is two. What is left — two to three
    /// and a half quiet hours at the same coordinate, afternoon family
    /// dinner into evening party — is where a visual distance genuinely
    /// separates two scenes from one long afternoon.
    private func refine(_ session: Session) -> [Session] {
        guard session.bursts.count > 1 else { return [session] }
        var chunks: [[Burst]] = [[session.bursts[0]]]

        for index in 1..<session.bursts.count {
            let previous = session.bursts[index - 1].representative
            let current = session.bursts[index].representative
            let gapHours = current.timestamp.timeIntervalSince(previous.timestamp) / 3600
            let inAmbiguousBand = gapHours > config.visualSplitMinGapHours
                && gapHours <= config.sessionGapHours
            if inAmbiguousBand,
               let a = previous.coordinate, let b = current.coordinate,
               GeoMath.isSamePlaceKm(
                   GeoMath.haversineKm(a.latitude, a.longitude, b.latitude, b.longitude),
                   tolerance: config.visualSplitMaxDistanceKm
               ),
               let distance = probe?.visualDistance(between: previous, and: current),
               distance > config.visualSplitFeaturePrintDistance {
                chunks.append([session.bursts[index]])
            } else {
                chunks[chunks.count - 1].append(session.bursts[index])
            }
        }
        return chunks.map { Session(bursts: $0) }
    }

    // MARK: - Pass 3: trip merging

    /// Merge consecutive travel sessions into one trip.
    ///
    /// "Travel" is distance from the inferred home base, and the merge is
    /// an overnight window: a 10-hour gap 300 km away is the same holiday
    /// sleeping, a 30-hour gap 300 km away is two holidays. Both sides of
    /// a pair must be away — a trip's last session is often the drive
    /// home, and merging the flight back into the holiday would drag the
    /// arrival evening at home with it.
    ///
    /// With no geotagged home base at all, nothing can be classified as
    /// away, so a camera roll with no GPS gets chronological events and no
    /// fabricated trips.
    func mergeTrips(_ sessions: [Session], homeBase: GeoCell?) -> [[Session]] {
        guard !sessions.isEmpty else { return [] }
        var groups: [[Session]] = [[sessions[0]]]
        var currentIsTravel = isTravel(sessions[0], homeBase: homeBase)

        for index in 1..<sessions.count {
            let previous = sessions[index - 1]
            let candidate = sessions[index]
            let overnightHours = candidate.start.timeIntervalSince(previous.end) / 3600
            let bothAway = currentIsTravel && isTravel(candidate, homeBase: homeBase)

            if bothAway && overnightHours < config.tripOvernightGapHours {
                groups[groups.count - 1].append(candidate)
            } else {
                groups.append([candidate])
            }
            currentIsTravel = isTravel(candidate, homeBase: homeBase)
        }
        return groups
    }

    private func isTravel(_ session: Session, homeBase: GeoCell?) -> Bool {
        guard let homeBase, let centroid = session.centroid else { return false }
        let km = GeoMath.haversineKm(homeBase.latitude, homeBase.longitude, centroid.latitude, centroid.longitude)
        return km > config.tripDistanceFromHomeKm
    }

    // MARK: - Event assembly

    /// Turn a group of sessions into the record the index and the page see.
    private func event(from group: [Session]) -> EventCluster {
        let members = group.flatMap(\.allIds)
        let representatives = group.flatMap(\.representatives)
        let start = group.map(\.start).min() ?? .distantPast
        let end = group.map(\.end).max() ?? .distantFuture

        // Multi-day needs more than the clock crossing midnight: one
        // session that runs 10 pm to 2 am is an evening, four sessions
        // across four dates is a trip.
        let days = calendarComponents(for: representatives)
        let spansDates = days.uniqueKeys.count > 1
        let isMultiDay = group.count > 1 && spansDates

        let subDays: [EventDayGroup]? = isMultiDay
            ? days.groups.map {
                EventDayGroup(
                    id: $0.key,
                    date: $0.value.map(\.timestamp).min() ?? $0.value.first!.timestamp,
                    itemIds: $0.value.map(\.id)
                )
            }
            : nil

        return EventCluster(
            id: Self.eventId(sourceId: sourceId, start: start),
            startDate: start,
            endDate: end,
            isMultiDay: isMultiDay,
            coverItemId: cover(of: representatives, start: start, end: end).id,
            itemIds: members,
            subDays: subDays
        )
    }

    /// The frame an event card shows: the burst representative nearest
    /// the middle of the event.
    ///
    /// The middle of a trip is its second or third day, which is a
    /// reasonable thumbnail for the whole thing; the first frame is often
    /// an airport floor, and the last a car park on the way home.
    private func cover(of representatives: [MediaMetadataItem], start: Date, end: Date) -> MediaMetadataItem {
        guard !representatives.isEmpty else { fatalError("an event always has a representative") }
        let midpoint = start.addingTimeInterval(end.timeIntervalSince(start) / 2)
        return representatives.min { lhs, rhs in
            abs(lhs.timestamp.timeIntervalSince(midpoint)) < abs(rhs.timestamp.timeIntervalSince(midpoint))
        } ?? representatives[0]
    }

    /// Bucket representatives by local calendar day, keeping first-seen
    /// order so a rescan cannot reorder the day list.
    private func calendarComponents(for items: [MediaMetadataItem]) -> (groups: [(key: String, value: [MediaMetadataItem])], uniqueKeys: [String]) {
        var groups: [(key: String, value: [MediaMetadataItem])] = []
        var indexByKey: [String: Int] = [:]
        for item in items {
            let key = dayKey(for: item.timestamp)
            if let at = indexByKey[key] {
                groups[at].value.append(item)
            } else {
                indexByKey[key] = groups.count
                groups.append((key, [item]))
            }
        }
        return (groups, groups.map(\.key))
    }

    /// `YYYY-MM-DD` in the clustering calendar.
    func dayKey(for date: Date) -> String {
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", parts.year ?? 1970, parts.month ?? 1, parts.day ?? 1)
    }

    /// Event identity: source plus first timestamp.
    ///
    /// Hashed rather than concatenated because the id crosses into JSON
    /// and into DOM keys, and a fixed-length hex string is the shape both
    /// want. Stable across rescans, which is what lets a viewer stay open
    /// on an event while the index underneath it is rewritten.
    public static func eventId(sourceId: String, start: Date) -> String {
        let seconds = Int64(start.timeIntervalSince1970.rounded(.down))
        let digest = SHA256Digest.hex("\(sourceId)|\(seconds)")
        return "evt_\(digest.prefix(20))"
    }
}
