import Foundation

/*
 * The durable half of the pipeline: what `events-index.json` holds.
 *
 * Same type on both platforms, because the file is the feature's memory
 * and a Mac and an iPhone must not remember a camera roll differently.
 * Timestamps are encoded as seconds since the epoch rather than ISO-8601:
 * the payload that crosses into the webview is epoch milliseconds, and
 * one time representation through the whole chain is one fewer place for
 * a timezone bug to live.
 */

/*
 * `Equatable` is not decoration: the only honest test of a persistence
 * format is that a value survives it unchanged, and comparing a decoded
 * index against the one that was written is how that is proved.
 */
public struct EventIndex: Codable, Equatable {
    public static let schemaVersion = 1

    /// Which source and which device this index belongs to.
    ///
    /// A fingerprint that stops matching forces a full rebuild rather than
    /// a merge: an index built against a folder that has been replaced is
    /// not stale, it is wrong, and the difference decides whether the
    /// viewer opens on photographs that no longer exist.
    public struct SourceFingerprint: Codable, Hashable, Sendable {
        /// The device's stable id — never a serial or a hardware UUID, the
        /// same rule every other synced row in this app obeys.
        public var deviceId: String
        /// macOS: the `FolderStore` entry id of the raw dump.
        /// iOS: `photokitSourceId`.
        public var sourceId: String
        /// `folder` or `photokit`, so a reader can tell what the ids mean.
        public var sourceKind: String
        /// A human label for the status command, and the only one that
        /// leaves this device — never a filesystem path.
        public var label: String
        public var lastIndexedAt: Date

        public init(deviceId: String, sourceId: String, sourceKind: String, label: String, lastIndexedAt: Date) {
            self.deviceId = deviceId
            self.sourceId = sourceId
            self.sourceKind = sourceKind
            self.label = label
            self.lastIndexedAt = lastIndexedAt
        }
    }

    /// The PhotoKit source id, fixed because the system library is one per
    /// device and has no other name.
    public static let photokitSourceId = "photokit-library"
    public static let folderSourceKind = "folder"
    public static let photokitSourceKind = "photokit"

    public var schemaVersion: Int
    public var source: SourceFingerprint
    /// The knobs that produced these events, kept beside them: an event
    /// boundary nobody can explain is a bug nobody can file.
    public var config: ClusteringConfig
    /// Metadata per item id, so a rescan compares modification times
    /// instead of re-reading EXIF headers. This is the entire reason
    /// adding twenty photographs to a 50,000-frame dump is instant.
    public var itemCache: [String: MediaMetadataItem]
    public var events: [EventCluster]
    public var screenshotItemIds: [String]

    public init(
        schemaVersion: Int = EventIndex.schemaVersion,
        source: SourceFingerprint,
        config: ClusteringConfig,
        itemCache: [String: MediaMetadataItem] = [:],
        events: [EventCluster] = [],
        screenshotItemIds: [String] = []
    ) {
        self.schemaVersion = schemaVersion
        self.source = source
        self.config = config
        self.itemCache = itemCache
        self.events = events
        self.screenshotItemIds = screenshotItemIds
    }

    // MARK: - Codec

    /// The one encoder and decoder for this file, so nothing downstream
    /// has to rediscover the date strategy.
    public static func encode(_ index: EventIndex) throws -> Data {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .secondsSince1970
        encoder.outputFormatting = [.sortedKeys]
        return try encoder.encode(index)
    }

    public static func decode(_ data: Data) throws -> EventIndex {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .secondsSince1970
        return try decoder.decode(EventIndex.self, from: data)
    }

    // MARK: - Incremental rescan

    /// Whether this index can be reused for the source being scanned now.
    public func matches(deviceId: String, sourceId: String) -> Bool {
        schemaVersion == Self.schemaVersion
            && source.deviceId == deviceId
            && source.sourceId == sourceId
    }

    /// Whether a file on disk has changed since its metadata was read.
    ///
    /// Unchanged is answered by the cached header read: a Drive backup
    /// folder whose files have not been touched costs nothing to rescan,
    /// which is what makes an observer-driven re-index affordable on a
    /// machine with tens of gigabytes of placeholders.
    public func needsMetadataRead(id: String, fileModTime: TimeInterval?) -> Bool {
        guard let cached = itemCache[id] else { return true }
        // A file whose mod time cannot be read is treated as changed —
        // the honest default is to look, not to trust.
        guard let fileModTime, let cachedTime = cached.fileModTime else { return true }
        // Second granularity is enough: a photograph's content is not
        // rewritten within the same second it was written.
        return abs(fileModTime - cachedTime) >= 1
    }

    /// Drop cached entries whose files are gone, and the screenshots that
    /// went with them.
    ///
    /// Events are not edited here: a member id that no longer resolves is
    /// skipped when the viewer asks, and the next clustering pass rebuilds
    /// the list anyway. Rewriting event membership by hand is how an index
    /// ends up claiming an event has nine photographs and showing seven.
    public func pruning(absentIds: Set<String>) -> EventIndex {
        var next = self
        next.itemCache = itemCache.filter { !absentIds.contains($0.key) }
        next.screenshotItemIds = screenshotItemIds.filter { !absentIds.contains($0) }
        return next
    }

    /// Fold a clustering pass into the index.
    public func applying(_ result: EventClusteringResult, itemCache: [String: MediaMetadataItem], indexedAt: Date) -> EventIndex {
        var next = self
        next.itemCache = itemCache
        next.events = result.events
        next.screenshotItemIds = result.screenshotItemIds
        next.source.lastIndexedAt = indexedAt
        return next
    }

    /// Total frames the events cover, for the status command's arithmetic.
    public var indexedItemCount: Int { itemCache.count }
}

/// The scan's report back to the page — the payload shape of
/// `scan_raw_dump_events`, defined once so macOS and iOS answer alike.
public struct RawDumpScanReport: Codable, Sendable {
    public let clusters: [EventCluster]
    public let screenshotCount: Int
    /// Frames read from their headers this run, against frames considered:
    /// the number that tells the user whether the scan was incremental.
    public let metadataReadCount: Int
    public let eventCount: Int
    public let lastIndexedAt: Date

    public init(
        clusters: [EventCluster],
        screenshotCount: Int,
        metadataReadCount: Int,
        eventCount: Int,
        lastIndexedAt: Date
    ) {
        self.clusters = clusters
        self.screenshotCount = screenshotCount
        self.metadataReadCount = metadataReadCount
        self.eventCount = eventCount
        self.lastIndexedAt = lastIndexedAt
    }
}

/// The status answer, with no path in it.
public struct RawDumpStatus: Codable, Sendable {
    public let configured: Bool
    public let label: String?
    /// Configured *and* reachable — a granted folder that has been unmounted
    /// is configured but not available, and the page must not offer a scan.
    public let isAvailable: Bool
    public let lastIndexedAt: Date?
    public let eventCount: Int

    public init(configured: Bool, label: String?, isAvailable: Bool, lastIndexedAt: Date?, eventCount: Int) {
        self.configured = configured
        self.label = label
        self.isAvailable = isAvailable
        self.lastIndexedAt = lastIndexedAt
        self.eventCount = eventCount
    }

    public static let notConfigured = RawDumpStatus(
        configured: false, label: nil, isAvailable: false, lastIndexedAt: nil, eventCount: 0
    )
}
