import Capacitor
import Foundation
import Photos
import Security

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

/// The declaration's memory: the warm metadata cache and the persisted
/// index, kept apart from the plugin so the queue discipline has one owner.
///
/// Every method runs on the plugin's serial queue and touches nothing
/// outside it — which is also why there is no lock anywhere in this file.
private final class RawDumpStore {
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
              decoded.matches(deviceId: deviceId, sourceId: EventIndex.photokitSourceId) else { return }
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
    /// A POSIX mode would buy nothing: every file in the container already
    /// belongs to this app alone. The data-protection class is what means
    /// something here, and `completeFileProtection` is the strongest one —
    /// the index is unreadable while the phone is locked, which is the
    /// honest price for a file holding where the user was every evening.
    /// `.atomic` swaps a temp copy into place, so the class travels with
    /// the content rather than being applied to a half-written name.
    private static func write(data: Data, to url: URL) throws {
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(), withIntermediateDirectories: true
        )
        try data.write(to: url, options: [.atomic, .completeFileProtection])
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
    ]

    /// The declaration lives in `UserDefaults`, not in
    /// `library-prefs.json` as the plan's macOS sketch suggests: the web
    /// bundle owns that file, reads it whole and writes it whole, so a
    /// second writer in Swift would lose either its own flag on the page's
    /// next save or the page's settings on ours. One key, one owner. The
    /// app's privacy manifest already declares this storage under the
    /// `CA92.1` reason.
    private static let enabledDefaultsKey = "manorama.cameraRollDumpEnabled"
    /// A mirror of the index header — `lastIndexedAt` and `eventCount` —
    /// written beside the file, so the status command can answer without
    /// decoding a fifty-thousand-entry cache to read two numbers off its
    /// top. It is a mirror and nothing more: every number in it came from
    /// an index write.
    private static let headerDefaultsKey = "manorama.cameraRollIndexHeader"

    /// The one lane. Scans, status reads, index writes and PhotoKit's own
    /// change callbacks all queue up here, which is what lets a library
    /// change and a scan order themselves against each other instead of
    /// racing, and what keeps the scan off the main queue.
    private let queue = DispatchQueue(label: "in.thecontrarian.manorama.event-clustering", qos: .userInitiated)
    private lazy var scanner = PhotoKitDumpScanner(queue: queue)
    private lazy var store = RawDumpStore(url: Self.indexURL)

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
        queue.async {
            guard UserDefaults.standard.bool(forKey: Self.enabledDefaultsKey) else { return }
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
                UserDefaults.standard.set(true, forKey: Self.enabledDefaultsKey)
                self.observeLibrary()
                let count = self.scanner.itemCount()
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

    // MARK: - getRawDumpStatus

    /// The cheap command: one flag, one authorization answer, two numbers
    /// mirrored from the last index write. It never fetches an asset and
    /// never opens the index file, so a page may call it on every mount.
    @objc func getRawDumpStatus(_ call: CAPPluginCall) {
        queue.async {
            let configured = UserDefaults.standard.bool(forKey: Self.enabledDefaultsKey)
            let header = configured ? self.storedHeader() : nil
            let payload: [String: Any] = [
                "configured": configured,
                "label": configured ? RawDumpStore.cameraRollLabel : NSNull(),
                "isAvailable": configured && Self.isLibraryReachable(),
                "lastIndexedAt": Self.millisecondsOrNull(header?.lastIndexedAt),
                "eventCount": header?.eventCount ?? 0,
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
            guard UserDefaults.standard.bool(forKey: Self.enabledDefaultsKey) else {
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
                self.rememberHeader(lastIndexedAt: indexedAt, eventCount: result.events.count)
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
            UserDefaults.standard.set(false, forKey: Self.enabledDefaultsKey)
            UserDefaults.standard.removeObject(forKey: Self.headerDefaultsKey)
            self.scanner.stopObserving()
            self.cacheDescribesLibrary = false
            self.store.forget()
            DispatchQueue.main.async { call.resolve() }
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

    /// Application Support — the container location the contract names for
    /// iOS. Same file name and same `EventIndex` schema as macOS, because
    /// two devices must not remember a camera roll differently.
    private static var indexURL: URL {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return support.appendingPathComponent("events-index.json")
    }

    private struct IndexHeader {
        let lastIndexedAt: Date?
        let eventCount: Int
    }

    /// The mirrored header, answered as nothing when the file behind it has
    /// gone: a deleted cache is a never-indexed device, not an indexed one
    /// whose events merely stopped being readable.
    private func storedHeader() -> IndexHeader? {
        guard let stored = UserDefaults.standard.dictionary(forKey: Self.headerDefaultsKey),
              FileManager.default.fileExists(atPath: Self.indexURL.path) else { return nil }
        let seconds = (stored["lastIndexedAt"] as? Double)
            ?? Double(stored["lastIndexedAt"] as? Int ?? 0)
        return IndexHeader(
            lastIndexedAt: seconds > 0 ? Date(timeIntervalSince1970: seconds) : nil,
            eventCount: stored["eventCount"] as? Int ?? 0
        )
    }

    private func rememberHeader(lastIndexedAt: Date, eventCount: Int) {
        UserDefaults.standard.set(
            ["lastIndexedAt": lastIndexedAt.timeIntervalSince1970, "eventCount": eventCount],
            forKey: Self.headerDefaultsKey
        )
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
