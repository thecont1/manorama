import Foundation

/*
 * Layer 1 of the event pipeline: the types every platform shares.
 *
 * Nothing here knows about PhotoKit, AppKit or the filesystem. An adapter
 * on each platform turns its own library into `MediaMetadataItem` values;
 * from that point the clustering, the persisted index and the bridge
 * payload are the same code everywhere, which is the only way event
 * boundaries stay predictable when the same camera roll is opened on an
 * iPhone and on a Mac.
 */

// MARK: - What an ingestion adapter produces

/// One photograph, reduced to the few fields event grouping needs.
///
/// The metadata a clusterer reads, and nothing else: no path beyond the
/// source-relative id that lets a viewer resolve the original, no bytes,
/// no thumbnails. A device with no EXIF and no GPS still produces a
/// perfectly usable item — timestamp alone is enough to group a dump.
public struct MediaMetadataItem: Identifiable, Codable, Hashable, Sendable {
    /// iOS: `PHAsset.localIdentifier`. macOS: the path relative to the
    /// raw-dump root, so the id survives the container moving and stays
    /// short enough to key a 50,000-entry cache with.
    public let id: String
    /// EXIF `DateTimeOriginal` when present, else the asset's or the
    /// file's creation date. Never nil: an item with no time cannot be
    /// placed on a timeline, so the adapter must answer something.
    public let timestamp: Date
    public let latitude: Double?
    public let longitude: Double?
    /// Screenshots are not events. They are artefacts of using the device,
    /// and they cluster tightly in time and place — one receipt, one
    /// meme, one error dialog would otherwise shred a real evening into
    /// fragments. They are bucketed separately and never counted.
    public let isScreenshot: Bool
    /// PhotoKit's burst identifier, when the platform has one. macOS has
    /// no equivalent token, so the clusterer groups sub-second runs
    /// itself and this stays nil there.
    public let burstIdentifier: String?
    /// The file's modification time, used to decide whether a rescan has
    /// to re-read the EXIF header at all. Nil on platforms where the
    /// asset store is authoritative (PhotoKit answers metadata in memory).
    public let fileModTime: TimeInterval?

    public init(
        id: String,
        timestamp: Date,
        latitude: Double? = nil,
        longitude: Double? = nil,
        isScreenshot: Bool = false,
        burstIdentifier: String? = nil,
        fileModTime: TimeInterval? = nil
    ) {
        self.id = id
        self.timestamp = timestamp
        self.latitude = latitude
        self.longitude = longitude
        self.isScreenshot = isScreenshot
        self.burstIdentifier = burstIdentifier
        self.fileModTime = fileModTime
    }

    /// The coordinate, when the item carries a usable pair.
    ///
    /// EXIF writes (0, 0) for a chip that has no fix, which is a real
    /// coordinate in the Atlantic off Africa; adapters should reject it
    /// rather than let a zero-guess pollute home-base inference.
    public var coordinate: (latitude: Double, longitude: Double)? {
        guard let latitude, let longitude,
              abs(latitude) > 0.0001, abs(longitude) > 0.0001 else { return nil }
        return (latitude, longitude)
    }
}

// MARK: - What the clusterer produces

/// One day inside a multi-day event.
public struct EventDayGroup: Identifiable, Codable, Hashable, Sendable {
    /// `YYYY-MM-DD` in the capture calendar — stable, readable, and
    /// already unique inside an event because a day cannot repeat there.
    public let id: String
    public let date: Date
    public let itemIds: [String]

    public init(id: String, date: Date, itemIds: [String]) {
        self.id = id
        self.date = date
        self.itemIds = itemIds
    }
}

/// A group of photographs the device believes were taken together.
///
/// Deliberately unnamed: the engine separates, it does not interpret. What
/// a group *is* — a dinner, a hike, a fortnight in Kerala — is the user's
/// business, so the record carries a date span, a count, and optional
/// sub-days and nothing else.
public struct EventCluster: Identifiable, Codable, Hashable, Sendable {
    /// Deterministic hash of `sourceId` + `startDate`, so the same event
    /// has the same identity across rescans, across launches, and across
    /// the two platforms. Not a UUID: an index that changes its event ids
    /// every scan cannot hold a viewer open on one.
    public let id: String
    public let startDate: Date
    public let endDate: Date
    public let isMultiDay: Bool
    /// The frame an event card opens with. Elected from the burst
    /// representatives rather than the raw head of the list, so a
    /// seven-shot burst does not contribute its first, half-pressed
    /// shutter to the cover.
    public let coverItemId: String
    /// Every member, in chronological order — burst frames included.
    /// Collapsing a burst is a decision about density and covers, not a
    /// licence to lose the user's photographs.
    public let itemIds: [String]
    /// Populated when `isMultiDay` is true; nil otherwise, so a single
    /// evening does not carry a one-element day list.
    public let subDays: [EventDayGroup]?

    public init(
        id: String,
        startDate: Date,
        endDate: Date,
        isMultiDay: Bool,
        coverItemId: String,
        itemIds: [String],
        subDays: [EventDayGroup]? = nil
    ) {
        self.id = id
        self.startDate = startDate
        self.endDate = endDate
        self.isMultiDay = isMultiDay
        self.coverItemId = coverItemId
        self.itemIds = itemIds
        self.subDays = subDays
    }
}

/// The clusterer's answer: events plus the screenshots it set aside.
public struct EventClusteringResult: Codable, Hashable, Sendable {
    public let events: [EventCluster]
    public let screenshotItemIds: [String]
    /// Frames the engine could not place because their timestamp was
    /// unrecorded and the adapter had no creation date either. Adapters
    /// guarantee this is empty in practice; it exists so the number is
    /// honest when it is not.
    public let unplacedItemIds: [String]

    public init(events: [EventCluster], screenshotItemIds: [String], unplacedItemIds: [String] = []) {
        self.events = events
        self.screenshotItemIds = screenshotItemIds
        self.unplacedItemIds = unplacedItemIds
    }
}

// MARK: - Tuning

/// The knobs of the spatiotemporal model.
///
/// Serialised into the index and returned to the page, so an event that
/// looks wrong can be explained by the numbers that made it. The defaults
/// are the plan's, and they are opinionated on purpose: 3.5 hours is long
/// enough to swallow dinner and the drinks after it, short enough that
/// breakfast tomorrow is not the same event as that dinner.
public struct ClusteringConfig: Codable, Hashable, Sendable {
    /// Silence longer than this ends a session.
    public var sessionGapHours: Double = 3.5
    /// Both frames geotagged and further apart than this ends a session.
    public var sessionDistanceKm: Double = 5.0
    /// …unless the jump happened inside this window, which reads as
    /// continuous transit along a route rather than two separate outings.
    public var transitBypassMinutes: Double = 45.0
    /// Further than this from the inferred home base, an outing is travel.
    public var tripDistanceFromHomeKm: Double = 50.0
    /// Two travel sessions with an overnight gap shorter than this are
    /// one trip.
    public var tripOvernightGapHours: Double = 18.0
    /// Frames closer together than this are one burst.
    public var burstThresholdSeconds: Double = 3.0

    /// Pass 4 tie-breaker: the window of ambiguity worth asking Vision
    /// about. A gap of 2 hours at a fixed location is a family afternoon
    /// becoming an evening party; a gap of 20 minutes is not a boundary,
    /// and a gap of 4 hours is already one.
    public var visualSplitMinGapHours: Double = 1.5
    /// …and only when the two frames are effectively in the same place.
    public var visualSplitMaxDistanceKm: Double = 0.5
    /// Vision feature-print distance above which the frames are judged
    /// different scenes. Roughly the middle of the range Apple's own
    /// samples report for "same scene" versus "different scene"; calibrate
    /// against a real dump before changing it.
    public var visualSplitFeaturePrintDistance: Double = 1.0

    public init() {}
}
