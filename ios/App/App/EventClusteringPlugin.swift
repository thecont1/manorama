import Capacitor
import Foundation
import Photos
import PhotosUI
import Security
import UIKit
import Network

/*
 * The iOS and iPadOS half of `docs/event-clustering-bridge-contract.md`.
 *
 * Four commands, the same answers the macOS shell gives, so one page
 * drives both and never forks per platform. What differs is only where
 * the frames come from — the system library instead of a granted folder —
 * and how this shell remembers it was asked to use it.
 *
 * Nothing here sends anything anywhere. The index it writes holds capture
 * dates, coordinates and `PHAsset` identifiers; it goes into the app
 * container under complete file protection, the `/api` surface gains no
 * route for it and D1 gains no column. There is no private-file allowlist
 * in this shell to add it to: the page's way in is the scan command's
 * answer, never the file.
 */

/// Native-owned declaration, preferences and mirrored header. All access
/// runs on the plugin's serial queue, apart from isolated storage tests.
final class EventSourceStateStore {
    struct Header: Codable, Equatable {
        var lastIndexedAt: Date
        var eventCount: Int
    }
    struct State: Codable, Equatable {
        var enabled = false
        var downloadCloudOnOpen = false
        var selectedPhotoCount: Int?
        var header: Header?
    }
    static let legacyKeys = ["manorama.cameraRollDumpEnabled", "manorama.cameraRollIndexHeader",
                             "manorama.eventCloudDownload", "manorama.eventSelectedPhotoCount"]
    let directory: URL
    let indexURL: URL
    let stateURL: URL
    private let legacyIndexURL: URL
    private let defaults: UserDefaults
    private var cached: State?

    init(support: URL, defaults: UserDefaults = .standard) {
        directory = support.appendingPathComponent("EventClustering", isDirectory: true)
        indexURL = directory.appendingPathComponent("events-index.json")
        stateURL = directory.appendingPathComponent("source-state.json")
        legacyIndexURL = support.appendingPathComponent("events-index.json")
        self.defaults = defaults
    }

    /// First access retires only this feature's legacy storage. Never import
    /// the old metadata index: rebuild it, regardless of its schema version.
    /// Subsequent status reads use this tiny cached state, not PhotoKit.
    func read() throws -> State {
        if let cached { return cached }
        var next = State()
        defer {
            for key in Self.legacyKeys { defaults.removeObject(forKey: key) }
            try? removeIfPresent(legacyIndexURL)
        }
        if FileManager.default.fileExists(atPath: stateURL.path) {
            let data = try Data(contentsOf: stateURL)
            let decoder = JSONDecoder(); decoder.dateDecodingStrategy = .secondsSince1970
            if let decoded = try? decoder.decode(State.self, from: data) { next = decoded }
            else { try removeIfPresent(indexURL) }
        } else {
            next.enabled = defaults.bool(forKey: Self.legacyKeys[0])
            next.downloadCloudOnOpen = defaults.bool(forKey: Self.legacyKeys[2])
            next.selectedPhotoCount = defaults.object(forKey: Self.legacyKeys[3]) as? Int
        }
        try removeIfPresent(legacyIndexURL)
        try EventPrivateFiles.directory(directory)
        if !FileManager.default.fileExists(atPath: indexURL.path) { next.header = nil }
        try save(next)
        return next
    }
    func update(_ change: (inout State) -> Void) throws {
        var next = try read()
        change(&next)
        try save(next)
    }
    private func save(_ next: State) throws {
        let encoder = JSONEncoder(); encoder.dateEncodingStrategy = .secondsSince1970
        encoder.outputFormatting = [.sortedKeys]
        try EventPrivateFiles.write(encoder.encode(next), to: stateURL)
        cached = next
    }
    private func removeIfPresent(_ url: URL) throws {
        if FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
    }
}

/// The warm metadata cache and persisted index share the plugin's owner queue.
final class RawDumpStore {
    /// The one label this source ever answers with; it is a name, not a
    /// path, and it is the only wording about the source the page sees.
    static let cameraRollLabel = "Camera Roll"

    private let url: URL
    private var index: EventIndex?

    init(url: URL) {
        self.url = url
    }

    var itemCount: Int { index?.itemCache.count ?? 0 }

    /// Every cached frame, in no particular order — the clusterer sorts
    /// deterministically before its first pass, so handing it dictionary
    /// values rather than a second sorted copy avoids sorting twice.
    func items() -> [MediaMetadataItem] { index.map { Array($0.itemCache.values) } ?? [] }

    /// The knobs recorded with the last write, so a rescan keeps using the
    /// config that produced the events on disk rather than whatever this
    /// build's defaults happen to be. An event boundary somebody cannot
    /// explain is a bug nobody can file.
    var config: ClusteringConfig { index?.config ?? ClusteringConfig() }

    /// Read the persisted index, if it belongs to this device and to this
    /// source.
    ///
    /// Anything that fails to decode, or whose fingerprint does not match,
    /// is answered by having no index at all: a cache built against a
    /// library this phone has never seen is not stale, it is somebody
    /// else's, and merging it would show the user photographs they do not
    /// have.
    func open(deviceId: String) {
        guard index == nil else { return }
        guard let data = try? Data(contentsOf: url),
              let decoded = try? EventIndex.decode(data),
              decoded.matches(deviceId: deviceId, sourceId: EventIndex.photokitSourceId) else {
            try? FileManager.default.removeItem(at: url)
            return
        }
        index = decoded
    }

    /// Adopt a freshly enumerated library as the cache.
    func rebuild(deviceId: String, items: [MediaMetadataItem], indexedAt: Date) {
        let cache = Dictionary(items.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        index = EventIndex(
            source: EventIndex.SourceFingerprint(
                deviceId: deviceId,
                sourceId: EventIndex.photokitSourceId,
                sourceKind: EventIndex.photokitSourceKind,
                label: Self.cameraRollLabel,
                lastIndexedAt: indexedAt
            ),
            config: config,
            itemCache: cache
        )
    }

    /// Fold one PhotoKit change into the cache.
    ///
    /// This is the reason the observer exists: twenty new photographs cost
    /// twenty property reads and a prune, not a walk over fifty thousand
    /// assets. Events are not recomputed here — the next scan re-clusters,
    /// and that is milliseconds of in-memory arithmetic over records that
    /// are already open.
    func apply(_ delta: PhotoKitDumpDelta) {
        guard var current = index else { return }
        guard !delta.needsFullRescan else {
            // PhotoKit could not describe the change object by object.
            // Whatever is cached may be wrong, so it is worth nothing.
            index = nil
            return
        }
        // Prune before writing: a frame the library reports as both
        // removed and re-inserted in one batch should end up present, and
        // the deleted frame's screenshot entry has to leave with it.
        current = current.pruning(absentIds: delta.removedIds)
        for item in delta.added + delta.updated { current.itemCache[item.id] = item }
        index = current
    }

    /// Record a clustering pass and write it. Throwing rather than
    /// swallowing, so a command can report an index it never saved instead
    /// of showing events that will not be there after a relaunch.
    func commit(_ result: EventClusteringResult, indexedAt: Date) throws {
        // A scan always fills the cache first; committing against nothing
        // would write an index that claims to describe an empty library.
        guard var next = index else {
            throw CocoaError(.fileWriteUnknown, userInfo: [NSLocalizedDescriptionKey: "No metadata cache to commit"])
        }
        next = next.applying(result, itemCache: next.itemCache, indexedAt: indexedAt)
        next.config = config
        next.source.label = Self.cameraRollLabel
        index = next
        try Self.write(data: EventIndex.encode(next), to: url)
    }

    /// Forget everything, including the file.
    func forget() {
        index = nil
        try? FileManager.default.removeItem(at: url)
    }

    /// Atomic, fully protected write — this platform's counterpart of the
    /// macOS shell's `0600` writer.
    ///
    /// Owner-only mode matches the cross-shell contract. On a device the
    /// data-protection class also matters: `completeFileProtection` is the
    /// strongest one —
    /// the index is unreadable while the phone is locked, which is the
    /// honest price for a file holding where the user was every evening.
    /// Atomic rename swaps an already-protected inode into place, so its
    /// protection, 0600 mode and backup exclusion travel with the content.
    private static func write(data: Data, to url: URL) throws {
        try EventPrivateFiles.write(data, to: url)
    }
}

@objc(EventClusteringPlugin)
public class EventClusteringPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "EventClusteringPlugin"
    public let jsName = "EventClustering"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "pickRawDumpRoot", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getRawDumpStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "scanRawDumpEvents", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearRawDumpRoot", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getEventAssetImage", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancelEventAssetImage", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "releaseEventAssetImages", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setEventCloudDownload", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "presentLimitedLibraryPicker", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openEventPhotosSettings", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openEventAssetInPhotos", returnType: CAPPluginReturnPromise),
    ]

    /// Swift owns both the index and this tiny state file. They never enter
    /// renderer-owned preferences, ordinary defaults, or device backups.
    private lazy var sourceState = EventSourceStateStore(support: Self.supportURL)

    /// The one lane. Scans, status reads, index writes and PhotoKit's own
    /// change callbacks all queue up here, which is what lets a library
    /// change and a scan order themselves against each other instead of
    /// racing, and what keeps the scan off the main queue.
    private let queue = DispatchQueue(label: "in.thecontrarian.manorama.event-clustering", qos: .userInitiated)
    private lazy var scanner = PhotoKitDumpScanner(queue: queue)
    private lazy var store = RawDumpStore(url: sourceState.indexURL)
    private let pathMonitor = NWPathMonitor()
    private var pathNeedsConfirmation = true // Unknown path is not consent to spend data.
    private var declarationGeneration = 0
    private var downloadGenerations: [String: Int] = [:]
    private var lastAuthorization = PHPhotoLibrary.authorizationStatus(for: .readWrite)
    private var foregroundObserver: NSObjectProtocol?
    // Presentation state is main-thread-only; generations remain on queue.
    private var downloadConfirmation: (id: String, alert: UIAlertController, resolve: (Bool) -> Void)?
    private lazy var assetImages: EventAssetImages = {
        let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        let service = EventAssetImages(queue: queue,
            thumbs: caches.appendingPathComponent("event-thumbs"),
            originals: FileManager.default.temporaryDirectory.appendingPathComponent("event-originals"))
        service.progress = { [weak self] id, fraction in
            DispatchQueue.main.async { self?.notifyListeners("eventAssetProgress", data: ["id": id, "fraction": fraction]) }
        }
        return service
    }()

    /// Whether the cached metadata describes the library as it stands.
    ///
    /// True only after a walk taken while the observer was listening: a
    /// cache read off disk cannot be trusted across a relaunch, because
    /// nothing told this process what the user deleted while it was away.
    /// That is why the first scan of a launch always looks at the library —
    /// on PhotoKit that means reading in-memory records, not bytes, so the
    /// correctness is nearly free and the observer's saving is real where
    /// it matters: between scans, inside one run.
    private var cacheDescribesLibrary = false

    // MARK: - Lifecycle

    /// A dump declared in an earlier launch starts listening immediately.
    ///
    /// Not to answer status — that reads the mirrored header — but so the
    /// deltas begin accumulating before the first scan, and the walk that
    /// launch takes is the last one that has to guess.
    public override func load() {
        super.load()
        pathMonitor.pathUpdateHandler = { [weak self] path in
            self?.queue.async { self?.pathNeedsConfirmation = path.isExpensive || path.isConstrained || path.status != .satisfied }
        }
        pathMonitor.start(queue: queue)
        foregroundObserver = NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            self?.queue.async {
                guard let self else { return }
                let authorization = PHPhotoLibrary.authorizationStatus(for: .readWrite)
                guard authorization != self.lastAuthorization else { return }
                self.lastAuthorization = authorization
                self.declarationGeneration += 1
                self.cacheDescribesLibrary = false
                self.assetImages.clear()
                if Self.isReachable(authorization), ((try? self.sourceState.read())?.enabled ?? false) {
                    self.observeLibrary()
                } else {
                    self.scanner.stopObserving()
                    try? self.sourceState.update { $0.selectedPhotoCount = nil }
                }
                DispatchQueue.main.async {
                    self.dismissDownloadConfirmation()
                    self.notifyListeners("eventLibraryChanged", data: [:])
                }
            }
        }
        queue.async {
            self.assetImages.sweepLaunch()
            guard ((try? self.sourceState.read())?.enabled ?? false) else { return }
            guard Self.isLibraryReachable() else { return }
            self.observeLibrary()
        }
    }

    // MARK: - pickRawDumpRoot

    /// Declares the Camera Roll as this device's raw dump.
    ///
    /// There is no panel to answer on iOS: the declaration *is* the
    /// permission grant, so a denial is a native failure rather than the
    /// cancellation the contract keeps `null` for. Re-declaring costs
    /// nothing and changes nothing but the flag, because there is only one
    /// library to declare — the "replaces any previous raw dump" rule the
    /// macOS shell implements by clearing other entries' flags has no
    /// counterpart here.
    @objc func pickRawDumpRoot(_ call: CAPPluginCall) {
        queue.async {
        let generation = self.declarationGeneration
        PHPhotoLibrary.requestAuthorization(for: .readWrite) { [weak self] status in
            guard let self else { return }
            guard Self.isReachable(status) else {
                DispatchQueue.main.async {
                    call.reject(
                        status == .denied || status == .restricted
                            ? "Camera Roll access is not granted for this app"
                            : "Photo library access was not decided"
                    )
                }
                return
            }
            self.queue.async {
                guard generation == self.declarationGeneration else {
                    DispatchQueue.main.async { call.resolve() }; return
                }
                let count = self.scanner.itemCount()
                do {
                    try self.sourceState.update { $0.enabled = true; $0.selectedPhotoCount = count }
                } catch {
                    DispatchQueue.main.async { call.reject("The private event state could not be written") }; return
                }
                self.lastAuthorization = status
                self.observeLibrary()
                DispatchQueue.main.async {
                    call.resolve([
                        "label": RawDumpStore.cameraRollLabel,
                        "itemCount": count,
                        // Null, not a path: `rootPath` exists so the viewer
                        // can join a folder-relative item id, and a
                        // `PHAsset.localIdentifier` is already whole. The
                        // existing asset-protocol route resolves it.
                        "rootPath": NSNull(),
                    ])
                }
            }
        }
    }

        }

    // MARK: - getRawDumpStatus

    /// The cheap command: one flag, one authorization answer, two numbers
    /// mirrored from the last index write. It never fetches an asset and
    /// never opens the index file, so a page may call it on every mount.
    @objc func getRawDumpStatus(_ call: CAPPluginCall) {
        queue.async {
            let state = try? self.sourceState.read()
            let configured = state?.enabled ?? false
            let header = configured ? self.storedHeader() : nil
            let payload: [String: Any] = [
                "configured": configured,
                "label": configured ? RawDumpStore.cameraRollLabel : NSNull(),
                "isAvailable": configured && Self.isLibraryReachable(),
                "lastIndexedAt": Self.millisecondsOrNull(header?.lastIndexedAt),
                "eventCount": header?.eventCount ?? 0,
                "authorization": Self.authorizationName(),
                "selectedPhotoCount": configured ? (state?.selectedPhotoCount as Any? ?? NSNull()) : NSNull(),
                "downloadCloudOnOpen": state?.downloadCloudOnOpen ?? false,
            ]
            DispatchQueue.main.async { call.resolve(payload) }
        }
    }

    // MARK: - scanRawDumpEvents

    /// Metadata, clustering and the index write — none of it on the main
    /// queue, none of it asking for a pixel.
    ///
    /// Incremental in the only sense PhotoKit allows: the frames already
    /// in the cache are not read twice, and the observer's deltas have
    /// been folded in as they arrived. `force` distrusts the cache and
    /// walks the library again, which is the answer when the user says
    /// "look properly". Clustering always covers the whole timeline, per
    /// the contract — it is arithmetic over records already in memory.
    @objc func scanRawDumpEvents(_ call: CAPPluginCall) {
        let force = call.getBool("force") ?? false
        queue.async {
            guard ((try? self.sourceState.read())?.enabled ?? false) else {
                DispatchQueue.main.async { call.reject("No raw dump is declared on this device") }
                return
            }
            guard Self.isLibraryReachable() else {
                DispatchQueue.main.async { call.reject("The Camera Roll is not reachable right now") }
                return
            }
            let deviceId = Self.stableDeviceId()
            do {
                self.observeLibrary()
                self.store.open(deviceId: deviceId)
                if force { self.cacheDescribesLibrary = false }
                if !self.cacheDescribesLibrary || self.store.itemCount == 0 {
                    self.store.rebuild(
                        deviceId: deviceId,
                        items: self.scanner.snapshot(),
                        indexedAt: Date()
                    )
                    self.cacheDescribesLibrary = true
                }
                let config = self.store.config
                let result = EventClusterer(sourceId: EventIndex.photokitSourceId, config: config)
                    .cluster(self.store.items())
                let indexedAt = Date()
                try self.store.commit(result, indexedAt: indexedAt)
                try self.sourceState.update {
                    $0.header = EventSourceStateStore.Header(lastIndexedAt: indexedAt, eventCount: result.events.count)
                    $0.selectedPhotoCount = self.store.itemCount
                }
                DispatchQueue.main.async {
                    call.resolve([
                        "clusters": Self.wireClusters(result.events),
                        "screenshotCount": result.screenshotItemIds.count,
                        "rootPath": NSNull(),
                    ])
                }
            } catch {
                DispatchQueue.main.async {
                    call.reject("The event index could not be written: \(error.localizedDescription)")
                }
            }
        }
    }

    // MARK: - clearRawDumpRoot

    /// Un-declares the source and drops the index it produced.
    ///
    /// The photo grant stays: it belongs to the user and to the Settings
    /// app, and taking it back here would be a decision about their
    /// library that nobody asked this shell to make — the same reason the
    /// macOS command leaves a folder's gallery grant alone.
    @objc func clearRawDumpRoot(_ call: CAPPluginCall) {
        queue.async {
            self.declarationGeneration += 1
            self.downloadGenerations.removeAll()
            self.assetImages.clear()
            self.scanner.stopObserving()
            self.cacheDescribesLibrary = false
            self.store.forget()
            do {
                try self.sourceState.update { $0.enabled = false; $0.selectedPhotoCount = nil; $0.header = nil }
                DispatchQueue.main.async {
                    self.dismissDownloadConfirmation()
                    call.resolve()
                }
            } catch {
                DispatchQueue.main.async {
                    self.dismissDownloadConfirmation()
                    call.reject("The private event state could not be cleared")
                }
            }
        }
    }

    // MARK: - Event pixels and lifecycle

    private static func authorizationName() -> String {
        switch PHPhotoLibrary.authorizationStatus(for: .readWrite) {
        case .notDetermined: return "notDetermined"
        case .restricted: return "restricted"
        case .denied: return "denied"
        case .limited: return "limited"
        case .authorized: return "authorized"
        @unknown default: return "restricted"
        }
    }

    deinit {
        pathMonitor.cancel()
        if let foregroundObserver { NotificationCenter.default.removeObserver(foregroundObserver) }
    }

    private func dismissDownloadConfirmation(ids: Set<String>? = nil) {
        guard let confirmation = downloadConfirmation, ids == nil || ids!.contains(confirmation.id) else { return }
        downloadConfirmation = nil
        confirmation.alert.dismiss(animated: false)
        confirmation.resolve(false)
    }

    static func validPixelSize(_ value: Any?) -> Bool {
        guard let value else { return true }
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return false }
        let size = number.doubleValue
        return size.isFinite && size.rounded() == size && size >= 1 && size <= 8192
    }

    @objc func getEventAssetImage(_ call: CAPPluginCall) {
        guard let ids = call.getArray("ids", String.self), !ids.isEmpty, ids.count <= 64,
              Set(ids).count == ids.count, ids.allSatisfy(EventAssetImages.validId),
              let purpose = call.getString("purpose"), purpose == "thumbnail" || purpose == "viewer",
              call.getValue("allowNetwork") == nil || call.getBool("allowNetwork") != nil,
              Self.validPixelSize(call.getValue("maxPixelSize")) else {
            call.reject("Invalid event photograph request"); return
        }
        let network = call.getBool("allowNetwork") ?? false
        let size = call.getInt("maxPixelSize") ?? 512
        guard size > 0, size <= 8192, !network || (purpose == "viewer" && ids.count == 1) else {
            call.reject("Only an explicitly opened photograph may download"); return
        }
        queue.async {
            guard ((try? self.sourceState.read())?.enabled ?? false), Self.isLibraryReachable() else {
                DispatchQueue.main.async { call.reject("No reachable Camera Roll is declared") }; return
            }
            let declaration = self.declarationGeneration
            let download = (self.downloadGenerations[ids[0]] ?? 0) + 1
            if network { self.downloadGenerations[ids[0]] = download }
            let start: (Bool) -> Void = { accepted in
                self.queue.async {
                    guard declaration == self.declarationGeneration,
                          !network || self.downloadGenerations[ids[0]] == download,
                          Self.isLibraryReachable() else {
                        DispatchQueue.main.async { call.reject("Event photograph request cancelled") }; return
                    }
                    guard accepted else {
                        let items = ids.map { EventAssetImages.Reply(id: $0, url: nil, width: 0, height: 0, state: "cloudOnly").wire }
                        DispatchQueue.main.async { call.resolve(["items": items]) }; return
                    }
                    self.assetImages.request(ids: ids, purpose: purpose, maxPixelSize: size, allowNetwork: network) { replies in
                        DispatchQueue.main.async { call.resolve(["items": replies.map(\.wire)]) }
                    }
                }
            }
            if network && (self.pathNeedsConfirmation || ProcessInfo.processInfo.isLowPowerModeEnabled) {
                DispatchQueue.main.async {
                    guard let presenter = self.bridge?.viewController, presenter.presentedViewController == nil else {
                        start(false); return
                    }
                    let alert = UIAlertController(title: "Download this photo?",
                        message: "Photos will download from your iCloud account. This connection may use metered data or Low Data Mode.", preferredStyle: .alert)
                    let answer: (Bool) -> Void = { accepted in
                        self.downloadConfirmation = nil
                        start(accepted)
                    }
                    self.downloadConfirmation = (ids[0], alert, answer)
                    alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in answer(false) })
                    alert.addAction(UIAlertAction(title: "Download", style: .default) { _ in answer(true) })
                    presenter.present(alert, animated: true)
                }
            } else { start(true) }
        }
    }

    @objc func cancelEventAssetImage(_ call: CAPPluginCall) {
        guard let ids = call.getArray("ids", String.self), !ids.isEmpty, ids.count <= 64,
              Set(ids).count == ids.count, ids.allSatisfy(EventAssetImages.validId) else {
            call.reject("Invalid event photograph identifiers"); return
        }
        queue.async {
            for id in ids { self.downloadGenerations[id] = (self.downloadGenerations[id] ?? 0) + 1 }
            self.assetImages.cancel(ids: ids)
            DispatchQueue.main.async {
                self.dismissDownloadConfirmation(ids: Set(ids))
                call.resolve()
            }
        }
    }

    @objc func releaseEventAssetImages(_ call: CAPPluginCall) {
        guard let strings = call.getArray("urls", String.self), strings.count <= 64,
              strings.allSatisfy({ $0.count <= 8192 && URL(string: $0)?.isFileURL == true }) else {
            call.reject("Invalid event photograph URLs"); return
        }
        queue.async {
            self.assetImages.release(urls: strings.compactMap(URL.init(string:)))
            DispatchQueue.main.async { call.resolve() }
        }
    }

    @objc func setEventCloudDownload(_ call: CAPPluginCall) {
        guard let enabled = call.getBool("enabled") else { call.reject("Invalid download setting"); return }
        queue.async {
            do {
                try self.sourceState.update { $0.downloadCloudOnOpen = enabled }
                DispatchQueue.main.async { call.resolve() }
            } catch {
                DispatchQueue.main.async { call.reject("The private download preference could not be written") }
            }
        }
    }

    @objc func presentLimitedLibraryPicker(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard PHPhotoLibrary.authorizationStatus(for: .readWrite) == .limited,
                  let presenter = self.bridge?.viewController else {
                call.reject("Selected photo access is not active"); return
            }
            PHPhotoLibrary.shared().presentLimitedLibraryPicker(from: presenter) { _ in
                self.queue.async {
                    self.cacheDescribesLibrary = false
                    self.assetImages.clear()
                    DispatchQueue.main.async {
                        self.notifyListeners("eventLibraryChanged", data: [:])
                        call.resolve()
                    }
                }
            }
        }
    }

    @objc func openEventPhotosSettings(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let url = URL(string: UIApplication.openSettingsURLString) else { call.reject("Settings unavailable"); return }
            UIApplication.shared.open(url) { opened in opened ? call.resolve() : call.reject("Settings unavailable") }
        }
    }

    @objc func openEventAssetInPhotos(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), EventAssetImages.validId(id) else { call.reject("Invalid photograph identifier"); return }
        DispatchQueue.main.async {
            // Photos exposes no public deep link to a localIdentifier.
            UIApplication.shared.open(URL(string: "photos-redirect://")!) { opened in
                opened ? call.resolve() : call.reject("Photos unavailable")
            }
        }
    }

    // MARK: - Observer

    /// Registers the change observer while a dump is active, and folds what
    /// it reports into the cache.
    ///
    /// A delta that lands while a scan is in flight is simply ordered after
    /// it on the same lane, and the next scan sees it. Registration is
    /// idempotent in the scanner, so pick-then-scan-then-pick cannot
    /// unbalance PhotoKit's observer list.
    private func observeLibrary() {
        scanner.startObserving { [weak self] delta in
            guard let self else { return }
            if delta.needsFullRescan { self.cacheDescribesLibrary = false }
            self.store.apply(delta)
            self.assetImages.clear() // Changed/deleted originals must not retain a stale lease.
            DispatchQueue.main.async { self.notifyListeners("eventLibraryChanged", data: [:]) }
        }
    }

    // MARK: - Wire shape

    /// Events as the contract wants them, encoded from the core's own
    /// `Codable` conformance.
    ///
    /// Going through `EventCluster`'s encoding rather than hand-copying
    /// fields means a rename in `Models.swift` cannot leave this payload
    /// quietly holding the old name. `subDays` is emitted only when the
    /// core filled it, which is the contract's "present exactly when
    /// isMultiDay" — and seconds become milliseconds here, once, because
    /// the index file keeps seconds and the wire does not.
    private static func wireClusters(_ events: [EventCluster]) -> [[String: Any]] {
        events.map { event in
            var payload: [String: Any] = [
                "id": event.id,
                "startDate": milliseconds(event.startDate),
                "endDate": milliseconds(event.endDate),
                "isMultiDay": event.isMultiDay,
                "coverItemId": event.coverItemId,
                "itemIds": event.itemIds,
            ]
            if let days = event.subDays {
                payload["subDays"] = days.map { day in
                    ["id": day.id, "date": milliseconds(day.date), "itemIds": day.itemIds]
                }
            }
            return payload
        }
    }

    /// Epoch milliseconds — the wire's only time unit (contract §2).
    private static func milliseconds(_ date: Date) -> Int64 {
        Int64(date.timeIntervalSince1970 * 1000)
    }

    /// The same conversion for a field the contract allows to be null, so
    /// "never indexed" reaches the page as `null` rather than as 1970.
    private static func millisecondsOrNull(_ date: Date?) -> Any {
        guard let date else { return NSNull() }
        return NSNumber(value: milliseconds(date))
    }

    // MARK: - Shared answers

    /// `.limited` counts as reachable: the app sees the frames the user
    /// chose and the item count says so. Treating a partial grant as no
    /// grant would hide the events of the photographs they did share.
    private static func isReachable(_ status: PHAuthorizationStatus) -> Bool {
        status == .authorized || status == .limited
    }

    private static func isLibraryReachable() -> Bool {
        isReachable(PHPhotoLibrary.authorizationStatus(for: .readWrite))
    }

    private static var supportURL: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    }

    /// The mirrored header is cached native state, not a metadata-index read.
    /// A missing index is never reported as an indexed source.
    private func storedHeader() -> EventSourceStateStore.Header? {
        guard FileManager.default.fileExists(atPath: sourceState.indexURL.path) else { return nil }
        return (try? sourceState.read())?.header
    }

    // MARK: - Device identity

    /// The identity half of the index fingerprint: one random UUID, minted
    /// on first use and kept in the Keychain.
    ///
    /// Never a serial, a hardware UUID or an advertising identifier — the
    /// rule every other device row in this app obeys — and it never leaves
    /// the phone: its only job is to notice an index that arrived from
    /// somewhere else. `ThisDeviceOnly` is what makes that job work, since
    /// an id that rode an encrypted backup onto a second phone would vouch
    /// for an index that phone has no right to merge.
    ///
    /// Deliberately not the account's device id: the web bundle keeps that
    /// one inside a third-party keychain wrapper, and reaching into another
    /// layer's storage to read an identity would tie this shell's cache to
    /// a detail nobody promised to keep stable.
    private static func stableDeviceId() -> String {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: deviceIdService,
            kSecAttrAccount as String: deviceIdAccount,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var found: CFTypeRef?
        if SecItemCopyMatching(query as CFDictionary, &found) == errSecSuccess,
           let data = found as? Data,
           let existing = String(data: data, encoding: .utf8),
           !existing.isEmpty {
            return existing
        }
        let minted = UUID().uuidString.lowercased()
        let attributes: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: deviceIdService,
            kSecAttrAccount as String: deviceIdAccount,
            kSecValueData as String: Data(minted.utf8),
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        // A failed mint is not fatal: the id differs next launch and the
        // index rebuilds. Rebuilt-but-right beats remembered-but-wrong.
        SecItemAdd(attributes as CFDictionary, nil)
        return minted
    }

    private static let deviceIdService = "in.thecontrarian.manorama.event-clustering"
    private static let deviceIdAccount = "device-id"
}
