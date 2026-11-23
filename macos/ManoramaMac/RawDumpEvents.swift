import CoreServices
import Foundation
import ImageIO
import Vision

/*
 * The macOS half of the event pipeline: what is remembered between
 * launches, what it costs to remember it, what the page is told, and the
 * one thing that notices when the folder changes underneath.
 *
 * The four pieces live together because they are one argument. The cache
 * exists so a scan is cheap; the cheap status exists so the page can ask
 * whether a cache is worth using without paying for it; the probe exists
 * so the cheap scan can still be right about the one boundary the
 * timestamps cannot settle; the watcher exists so a stale cache is never
 * discovered by the user.
 */

// MARK: - The index store

/// What `get_raw_dump_status` needs from the cache, and nothing else.
struct RawDumpIndexSummary {
    let lastIndexedAt: Date?
    let eventCount: Int
    let screenshotCount: Int
}

/// A scan's answer, plus what it was a scan of.
///
/// `RawDumpScanReport` is the core's type and the core does not know about
/// paths. The root travels beside it rather than inside it, so the shared
/// report stays the shared report.
struct RawDumpScanOutcome {
    let report: RawDumpScanReport
    let rootPath: String
    let label: String
}

/// The shell's memory of the raw dump: `events-index.json`.
///
/// One file in the app's private directory holding the header read of every
/// frame plus the events made from them, at mode 0600 like every other
/// private document here. It is deliberately *not* on the
/// `read_private_file` allowlist: the page asks for what it wants by name,
/// and never gets to read — let alone write — a cache it did not ask for.
///
/// A class with a lock rather than a struct, for one reason: the walk runs
/// on a background queue and the status poll may run there too, and the
/// thing they must not both do is decode a multi-megabyte file in order to
/// answer a number as small as `eventCount`.
final class RawDumpEventStore: @unchecked Sendable {
    let indexURL: URL

    /// How many times the index file has actually been decoded.
    ///
    /// "Status is cheap" is a claim about the *second* call, and a
    /// stopwatch in a test is a flake waiting to happen, so the store keeps
    /// the count the boundary suite asserts on.
    private(set) var summaryDecodes = 0

    private let stateLock = NSLock()
    private let scanLock = NSLock()
    private var memo: Memo?

    /// The memoised numbers, and the file they were read from.
    private struct Memo {
        struct Stamp: Equatable {
            let size: Int64
            let modified: TimeInterval
        }
        let stamp: Stamp?
        let summary: RawDumpIndexSummary
    }

    init(configDir: URL) {
        indexURL = configDir.appendingPathComponent("events-index.json")
    }

    // MARK: Status

    /// The cache's three numbers, memoised against the file's size and
    /// modification date.
    ///
    /// A repeated poll is one `stat`, not one decode: the page is allowed
    /// to ask whether anything has changed as often as it likes, and a
    /// 50,000-frame cache is several megabytes of JSON that has not moved.
    func summary() -> RawDumpIndexSummary {
        stateLock.lock()
        defer { stateLock.unlock() }
        let stamp = Self.stamp(of: indexURL)
        if let memo, memo.stamp == stamp {
            return memo.summary
        }
        let summary = Self.summary(of: readIndex())
        memo = Memo(stamp: stamp, summary: summary)
        // A missing file is not a decode; the cold answer for "no cache
        // yet" costs nothing.
        if stamp != nil { summaryDecodes += 1 }
        return summary
    }

    /// Adopt the numbers just written, so the first status after a scan is
    /// also free.
    private func remember(_ index: EventIndex) {
        stateLock.lock()
        defer { stateLock.unlock() }
        memo = Memo(stamp: Self.stamp(of: indexURL), summary: Self.summary(of: index))
    }

    private static func summary(of index: EventIndex?) -> RawDumpIndexSummary {
        RawDumpIndexSummary(
            lastIndexedAt: index?.source.lastIndexedAt,
            eventCount: index?.events.count ?? 0,
            screenshotCount: index?.screenshotItemIds.count ?? 0
        )
    }

    private static func stamp(of url: URL) -> Memo.Stamp? {
        guard let values = try? url.resourceValues(forKeys: [.fileSizeKey, .contentModificationDateKey]),
              let size = values.fileSize,
              let modified = values.contentModificationDate else { return nil }
        return Memo.Stamp(size: Int64(size), modified: modified.timeIntervalSince1970)
    }

    // MARK: Reading and writing

    /// The cache as it stands on disk, or nil — missing, unreadable, or
    /// written under a schema this build does not know. A cache that cannot
    /// be trusted is a cache that gets rebuilt, never one guessed from.
    func readIndex() -> EventIndex? {
        guard let data = try? Data(contentsOf: indexURL) else { return nil }
        return try? EventIndex.decode(data)
    }

    /// Write at mode 0600, atomically, through the shell's one writer —
    /// `events-index.json` holds every timestamp and coordinate the dump
    /// ever gave up, which is precisely the profile of a private file.
    private func write(_ index: EventIndex) throws {
        let data: Data
        do {
            data = try EventIndex.encode(index)
        } catch {
            throw BridgeError.failed("the event cache could not be encoded")
        }
        do {
            try NativeBridge.write0600(to: indexURL, data: data)
        } catch {
            throw BridgeError.failed("the event cache could not be saved")
        }
    }

    /// Forget the dump entirely. `clear_raw_dump_root` calls this: leaving
    /// a timeline of someone's old dump in the app's private directory
    /// because the user changed their mind is not a thing this app does.
    func deleteIndex() {
        if FileManager.default.fileExists(atPath: indexURL.path) {
            try? FileManager.default.removeItem(at: indexURL)
        }
        stateLock.lock()
        defer { stateLock.unlock() }
        memo = nil
    }

    // MARK: Scanning

    /// Walk the dump, read what has changed, cluster the whole timeline.
    ///
    /// Serialised: a page that refreshes twice — a watcher nudge and a
    /// click — must not decode the dump twice, and must not write the cache
    /// in whichever order the two walks happened to finish.
    ///
    /// - Throws: when the root cannot be opened, or the cache cannot be
    ///   saved. A walk failure is never swallowed into an empty timeline.
    func scan(
        root: URL,
        deviceId: String,
        sourceId: String,
        label: String,
        force: Bool,
        config: ClusteringConfig = ClusteringConfig()
    ) throws -> RawDumpScanOutcome {
        scanLock.lock()
        defer { scanLock.unlock() }
        let files = try FolderDumpScanner.enumerate(root: root)
        let indexedAt = Date()
        let existing = readIndex()
        // A fingerprint mismatch is a rebuild, not a merge. The frames in
        // such a cache were read for another device, another folder, or
        // under a schema that no longer means what it says, and mixing a
        // foreign timeline into this one would produce events about a
        // camera roll nobody has here.
        let reusable = !force && (existing?.matches(deviceId: deviceId, sourceId: sourceId) ?? false)
        var base = reusable ? existing! : EventIndex(
            source: EventIndex.SourceFingerprint(
                deviceId: deviceId,
                sourceId: sourceId,
                sourceKind: EventIndex.folderSourceKind,
                label: label,
                lastIndexedAt: indexedAt
            ),
            config: config
        )
        // The knobs are recorded as the ones that produced these events, so
        // the sentence beside a boundary stays true even if the defaults
        // move under a future build.
        base.config = config
        // The folder may have been renamed since the last scan.
        base.source.label = label
        let previous = reusable ? base.itemCache : [:]

        // A vanished file leaves the cache and the screenshot list, in the
        // core's own words; events are rebuilt below rather than edited by
        // hand.
        let present = Set(files.map(\.relativePath))
        var cache = base.pruning(absentIds: Set(previous.keys).subtracting(present)).itemCache
        if force {
            cache = [:]
        }
        var headersRead = 0
        for file in files {
            let modTime = file.modificationDate?.timeIntervalSince1970
            // The incremental rule, asked per file: an unchanged frame costs
            // a dictionary lookup, and only a new, touched or never-seen
            // file costs a header.
            if !force, !base.needsMetadataRead(id: file.relativePath, fileModTime: modTime),
               let cached = previous[file.relativePath] {
                cache[file.relativePath] = cached
                continue
            }
            let record = FolderDumpScanner.ingest(file)
            if record.headerWasOpened { headersRead += 1 }
            if let item = record.item {
                cache[file.relativePath] = item
            } else {
                // A frame with no time at all has no row: an event cannot
                // be built around a guess.
                cache.removeValue(forKey: file.relativePath)
            }
        }

        // Clustering always runs over the whole cached timeline. Half a
        // walk's frames cannot say whether a session ended, and the pass is
        // microseconds for tens of thousands of rows.
        let result = EventClusterer(
            sourceId: sourceId,
            config: config,
            probe: VisionBoundaryProbe(root: root)
        ).cluster(Array(cache.values))
        let next = base.applying(result, itemCache: cache, indexedAt: indexedAt)
        try write(next)
        remember(next)
        return RawDumpScanOutcome(
            report: RawDumpScanReport(
                clusters: next.events,
                screenshotCount: next.screenshotItemIds.count,
                metadataReadCount: headersRead,
                eventCount: next.events.count,
                lastIndexedAt: next.source.lastIndexedAt
            ),
            rootPath: root.path,
            label: label
        )
    }
}

// MARK: - The wire

/// The bridge's raw-dump replies, built in one place.
///
/// The index stores seconds — `EventIndex`'s own date strategy, shared with
/// iOS — and the contract carries milliseconds. That multiplication
/// happens here and nowhere else on this platform: a command that formats a
/// date by hand is a command that will quietly disagree with its own cache.
enum RawDumpWire {
    static func millis(_ date: Date) -> Int64 {
        Int64((date.timeIntervalSince1970 * 1000).rounded())
    }

    static func pick(label: String, itemCount: Int, rootPath: String) -> [String: Any] {
        ["label": label, "itemCount": itemCount, "rootPath": rootPath]
    }

    static func status(_ status: RawDumpStatus) -> [String: Any] {
        [
            "configured": status.configured,
            "label": status.label ?? NSNull(),
            "isAvailable": status.isAvailable,
            "lastIndexedAt": status.lastIndexedAt.map(millis) ?? NSNull(),
            "eventCount": status.eventCount,
        ]
    }

    static func scan(_ outcome: RawDumpScanOutcome) -> [String: Any] {
        [
            "clusters": outcome.report.clusters.map(cluster),
            "screenshotCount": outcome.report.screenshotCount,
            // Device-local and never sent anywhere: the viewer needs the
            // root to ask the shell's own media handler for an original,
            // and the handler re-checks every request against the grant.
            "rootPath": outcome.rootPath,
        ]
    }

    static func cluster(_ cluster: EventCluster) -> [String: Any] {
        [
            "id": cluster.id,
            "startDate": millis(cluster.startDate),
            "endDate": millis(cluster.endDate),
            "isMultiDay": cluster.isMultiDay,
            "coverItemId": cluster.coverItemId,
            "itemIds": cluster.itemIds,
            // Null rather than absent for a one-day event: the core makes
            // `subDays` present exactly when `isMultiDay`, and a page that
            // has to test for the key is a page that will forget to.
            "subDays": cluster.subDays.map { days in days.map(subDay) } ?? NSNull(),
        ]
    }

    private static func subDay(_ day: EventDayGroup) -> [String: Any] {
        ["id": day.id, "date": millis(day.date), "itemIds": day.itemIds]
    }
}

// MARK: - Pass 4's tie-breaker

/// What two photographs look like, asked of the OS's own feature print.
///
/// The clusterer calls this only inside the ambiguous band the plan defines
/// — a gap long enough to be a new errand, too close and too short to be
/// sure — so a scan pays for a handful of thumbnails rather than for the
/// dump. Every failure answers `nil`, meaning "no opinion", and no opinion
/// keeps a session together: a frame the cloud has not delivered is not
/// evidence that the user stopped doing something.
///
/// The 512-pixel image this builds exists for microseconds, inside this
/// type. It is never written, never kept and never drawn, so invariants 2
/// and 13 — do not re-encode a source, do not render a bitmap larger than
/// its own pixels — are not in play here: a model input is neither the
/// user's photograph nor a rendered one.
final class VisionBoundaryProbe: VisualBoundaryProbe, @unchecked Sendable {
    private let root: URL
    private let lock = NSLock()
    /// Per scan, keyed by item id, held by the instance the scan owns. The
    /// same boundary frame is asked about twice — it is the second half of
    /// one comparison and the first half of the next — and a print costs a
    /// real decode, so the answer is kept for the rest of the walk. A nil
    /// is cached too: a placeholder that refused once is not going to
    /// cooperate two comparisons later, and asking again is the bug.
    ///
    /// Locked, because the core promises nothing about which thread asks.
    /// A torn read here would split someone's afternoon into two events.
    private var prints: [String: VNFeaturePrintObservation?] = [:]

    init(root: URL) {
        self.root = root
    }

    func visualDistance(between first: MediaMetadataItem, and second: MediaMetadataItem) -> Double? {
        guard let left = featurePrint(for: first), let right = featurePrint(for: second) else { return nil }
        // This SDK declares the out-parameter as `Float`. Widening to the
        // Double the config's threshold is written in loses nothing a
        // perceptual band was ever precise about.
        var distance: Float = 0
        do {
            try left.computeDistance(&distance, to: right)
        } catch {
            return nil
        }
        guard distance.isFinite else { return nil }
        return Double(distance)
    }

    private func featurePrint(for item: MediaMetadataItem) -> VNFeaturePrintObservation? {
        lock.lock()
        defer { lock.unlock() }
        if let cached = prints[item.id] { return cached }
        let computed = compute(item)
        prints[item.id] = computed
        return computed
    }

    private func compute(_ item: MediaMetadataItem) -> VNFeaturePrintObservation? {
        let url = root.appendingPathComponent(item.id)
        guard FolderDumpScanner.pixelsAreLocal(at: url) else { return nil }
        guard let source = CGImageSourceCreateWithURL(url as CFURL, FolderDumpScanner.headerOnlyOptions) else { return nil }
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, Self.thumbnailOptions) else { return nil }
        let request = VNGenerateImageFeaturePrintRequest()
        let handler = VNImageRequestHandler(cgImage: image, options: [:])
        do {
            try handler.perform([request])
        } catch {
            return nil
        }
        guard let observation = request.results?.first as? VNFeaturePrintObservation,
              !observation.data.isEmpty else { return nil }
        return observation
    }

    /// Why each option is here.
    ///
    ///  - `CreateThumbnailFromImageAlways`: many camera JPEGs carry a
    ///    160-pixel EXIF thumbnail whose framing is not the photograph's,
    ///    and two embedded thumbnails from two different cameras are not a
    ///    comparison of two scenes.
    ///  - `CreateThumbnailWithTransform`: a portrait frame compared
    ///    sideways looks like a different scene, which is the opposite of
    ///    the caution this pass exists to add.
    ///  - `ShouldCache` false: nothing downstream wants the bitmap, and
    ///    asking ImageIO to keep one per frame is how a scan turns into a
    ///    memory problem.
    ///  - 512 pixels: the feature print normalises its input anyway, and a
    ///    larger thumbnail is decode time bought for nothing.
    private static let thumbnailOptions: CFDictionary = [
        kCGImageSourceShouldCache: false,
        kCGImageSourceCreateThumbnailFromImageAlways: true,
        kCGImageSourceCreateThumbnailWithTransform: true,
        kCGImageSourceThumbnailMaxPixelSize: 512,
    ] as CFDictionary
}

// MARK: - The nudge

/// FSEvents on the dump root, and nothing else.
///
/// The watcher never scans, never opens a file and never decides that an
/// event has changed. It says "the folder is not what the cache says", the
/// page decides whether to offer a re-scan, and the scan is the thing that
/// reads headers. A watcher that indexed on its own would turn a background
/// Drive sync into a background crawl of the user's disk at the exact
/// moment they least expect it.
///
/// All state is confined to one serial queue, which is why there is no
/// lock here: the C trampoline runs on it, and `start` and `stop` arrive
/// through it synchronously, so a callback that lands while the main thread
/// is inside `start` is simply ordered after it.
final class RawDumpWatcher: @unchecked Sendable {
    /// How long the OS may group changes into. Two seconds is long enough
    /// that a sync landing four hundred files is a handful of callbacks
    /// rather than four hundred, and short enough that the page hears about
    /// a copy while the user is still looking at it.
    private let coalescing: TimeInterval
    /// How quiet the folder has to stay before the nudge is passed on. The
    /// latency above batches at the OS's pace; this waits for the copying
    /// to actually stop, so one drag of a year of photographs is one event.
    private let quietPeriod: TimeInterval
    private let queue: DispatchQueue
    private var stream: FSEventStreamRef?
    /// The context the stream was created with — a +1 on this object, and
    /// the reason the trampoline's pointer is still valid when it fires.
    private var streamInfo: UnsafeMutableRawPointer?
    private var watchedPath: String?
    private var onChange: (@Sendable () -> Void)?
    private var nudge: DispatchWorkItem?

    init(coalescing: TimeInterval = 2.0, quietPeriod: TimeInterval = 1.5) {
        self.coalescing = coalescing
        self.quietPeriod = quietPeriod
        self.queue = DispatchQueue(label: "in.thecontrarian.manorama.raw-dump-watch")
    }

    /// The root under watch, or nil. Read through the queue so the boundary
    /// suite can see what the last `start` or `stop` actually did.
    var watchedRoot: String? {
        queue.sync { watchedPath }
    }

    /// Watch `root`, replacing any previous root. Asking twice about the
    /// same path leaves the stream alone and refreshes the callback, so a
    /// re-pick that lands on the same folder with a new page behind it
    /// still nudges the new page.
    func start(root: URL, onChange: @escaping @Sendable () -> Void) {
        let path = root.standardizedFileURL.path
        queue.sync {
            if watchedPath == path, stream != nil {
                self.onChange = onChange
                return
            }
            stopLocked()
            var context = FSEventStreamContext(version: 0, info: nil, retain: nil, release: nil, copyDescription: nil)
            // Retained here and released in `stopLocked`. A stream that
            // could outlive its watcher by one runloop turn would hand the
            // trampoline a dangling pointer, and that crash would arrive as
            // a filesystem notification — nowhere near the code that caused
            // it.
            let info = Unmanaged.passRetained(self).toOpaque()
            context.info = info
            guard let stream = FSEventStreamCreate(
                kCFAllocatorDefault,
                rawDumpStreamCallback,
                &context,
                [path] as CFArray,
                FSEventStreamEventId(kFSEventStreamEventIdSinceNow),
                coalescing,
                FSEventStreamCreateFlags(kFSEventStreamCreateFlagNone)
            ) else {
                Unmanaged<RawDumpWatcher>.fromOpaque(info).release()
                return
            }
            FSEventStreamSetDispatchQueue(stream, queue)
            guard FSEventStreamStart(stream) else {
                FSEventStreamInvalidate(stream)
                FSEventStreamRelease(stream)
                Unmanaged<RawDumpWatcher>.fromOpaque(info).release()
                return
            }
            self.stream = stream
            self.streamInfo = info
            self.watchedPath = path
            self.onChange = onChange
        }
    }

    func stop() {
        queue.sync { stopLocked() }
    }

    /// Queue-confined teardown, called from `stop` and from a re-`start`,
    /// and from nothing else. There is deliberately no `deinit` doing this:
    /// the stream holds the reference that keeps the object alive, so the
    /// last one is usually dropped by a block running on this queue, and a
    /// `queue.sync` from a deinit would be a deadlock dressed as cleanup.
    private func stopLocked() {
        nudge?.cancel()
        nudge = nil
        onChange = nil
        watchedPath = nil
        if let stream {
            FSEventStreamStop(stream)
            // Detaching the queue blocks until any callback in flight has
            // returned, which is what makes releasing the context below a
            // teardown rather than a race with the trampoline.
            FSEventStreamSetDispatchQueue(stream, nil)
            FSEventStreamInvalidate(stream)
            FSEventStreamRelease(stream)
            self.stream = nil
        }
        if let info = streamInfo {
            streamInfo = nil
            Unmanaged<RawDumpWatcher>.fromOpaque(info).release()
        }
    }

    /// The trampoline's destination: push the nudge back, so a burst of
    /// callbacks is one event for the page. Runs on the watch queue.
    fileprivate func noteActivity() {
        nudge?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            /* No queue hop here, on purpose: `asyncAfter(execute:)` runs
             * this block ON the watch queue, so a `queue.sync` from inside
             * it is a synchronous dispatch onto the queue that is already
             * running this very block. libdispatch traps that as a
             * deadlock rather than hanging, so the whole app dies with a
             * SIGTRAP — and it dies on a filesystem notification, several
             * seconds after anything anyone typed. The state being touched
             * is queue-confined already, which is exactly what makes
             * reading it here safe without the hop. */
            self.nudge = nil
            let handler = self.onChange
            // Async, not sync: a page in the middle of a navigation
            // must be able to stall its own UI, but it must not be able
            // to stall the watch queue.
            DispatchQueue.main.async { handler?() }
        }
        nudge = work
        queue.asyncAfter(deadline: .now() + quietPeriod, execute: work)
    }
}

/// The FSEvents trampoline. A `@convention(c)` function can capture
/// nothing, so the watcher reaches it through the stream's context.
private func rawDumpStreamCallback(
    streamRef: ConstFSEventStreamRef,
    clientCallBackInfo: UnsafeMutableRawPointer?,
    numEvents: Int,
    eventPaths: UnsafeMutableRawPointer,
    eventFlags: UnsafePointer<FSEventStreamEventFlags>,
    eventIds: UnsafePointer<FSEventStreamEventId>
) {
    guard let clientCallBackInfo else { return }
    Unmanaged<RawDumpWatcher>
        .fromOpaque(clientCallBackInfo)
        .takeUnretainedValue()
        .noteActivity()
}
