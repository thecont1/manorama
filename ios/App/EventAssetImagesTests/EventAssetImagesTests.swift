import XCTest
import Photos
import UIKit
import Capacitor
import CryptoKit
@testable import App

final class EventAssetImagesTests: XCTestCase {
    final class Backend: EventPhotoBackend {
        var assets: [String: EventPhotoAsset] = [:]
        var image: UIImage?
        var cloud = false
        var thumbnailNetwork: [Bool] = []
        var targets: [CGSize] = []
        var originalNetwork: [Bool] = []
        var cancelled: [PHImageRequestID] = []
        var originalProgress: ((Double) -> Void)?
        var originalData: ((Data) -> Void)?
        var originalCompletion: ((Error?) -> Void)?
        var cancelledData: [PHAssetResourceDataRequestID] = []
        var nextDataId: PHAssetResourceDataRequestID = 73
        var synchronousChunks: [Data]?
        var synchronousError: Error?
        var onRequestData: (() -> Void)?
        var onCancelData: (() -> Void)?
        func asset(_ id: String) -> EventPhotoAsset? { assets[id] }
        func thumbnail(_ asset: EventPhotoAsset, target: CGSize, allowNetwork: Bool, completion: @escaping (UIImage?, Bool, Bool) -> Void) -> PHImageRequestID {
            thumbnailNetwork.append(allowNetwork); targets.append(target)
            completion(image, cloud, false)
            return 1
        }
        func cancelThumbnail(_ id: PHImageRequestID) { cancelled.append(id) }
        func requestData(_ asset: EventPhotoAsset, allowNetwork: Bool,
                         progress: @escaping (Double) -> Void, dataReceived: @escaping (Data) -> Void,
                         completion: @escaping (Error?) -> Void) -> PHAssetResourceDataRequestID {
            originalNetwork.append(allowNetwork)
            originalProgress = progress; originalData = dataReceived; originalCompletion = completion
            let id = nextDataId; nextDataId += 1
            onRequestData?()
            if let chunks = synchronousChunks {
                chunks.forEach(dataReceived)
                completion(synchronousError)
            }
            return id
        }
        func cancelDataRequest(_ id: PHAssetResourceDataRequestID) {
            cancelledData.append(id)
            onCancelData?()
        }
    }
    let queue = DispatchQueue(label: "event-image-tests")
    var root: URL!
    var backend: Backend!
    var service: EventAssetImages!
    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        backend = Backend()
        backend.assets["synthetic/L0/001"] = EventPhotoAsset(id: "synthetic/L0/001", width: 1200, height: 800, modified: Date(timeIntervalSince1970: 42), fileExtension: "jpg")
        service = EventAssetImages(queue: queue, backend: backend,
            thumbs: root.appendingPathComponent("Caches/event-thumbs"), originals: root.appendingPathComponent("event-originals"))
    }
    override func tearDownWithError() throws { queue.sync { service.clear() }; try? FileManager.default.removeItem(at: root) }
    func image(_ width: Int, _ height: Int) -> UIImage {
        let format = UIGraphicsImageRendererFormat(); format.scale = 1
        return UIGraphicsImageRenderer(size: CGSize(width: width, height: height), format: format).image { context in
            UIColor.magenta.setFill(); context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        }
    }
    func originalURL() -> URL {
        let lease = try! FileManager.default.contentsOfDirectory(at: service.originals, includingPropertiesForKeys: nil).first!
        return try! FileManager.default.contentsOfDirectory(at: lease, includingPropertiesForKeys: nil).first!
    }
    func assertPrivate(_ url: URL, directory: Bool = false, file: StaticString = #filePath, line: UInt = #line) {
        let attrs = try! FileManager.default.attributesOfItem(atPath: url.path)
        XCTAssertEqual((attrs[.posixPermissions] as? NSNumber)?.intValue, directory ? 0o700 : 0o600, file: file, line: line)
        XCTAssertEqual(try! url.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup, true, file: file, line: line)
        // Simulator checks do not prove hardware encryption or lock behavior.
        #if !targetEnvironment(simulator)
        XCTAssertEqual(attrs[.protectionKey] as? FileProtectionType, .complete, file: file, line: line)
        #endif
    }
    func testTargetCapAndNoUpscale() {
        let asset = backend.assets.values.first!
        XCTAssertEqual(EventAssetImages.target(asset, maxPixelSize: 2048), CGSize(width: 512, height: 342))
        let tiny = EventPhotoAsset(id: "tiny", width: 20, height: 10, modified: nil, fileExtension: "jpg")
        XCTAssertEqual(EventAssetImages.target(tiny, maxPixelSize: 512), CGSize(width: 20, height: 10))
    }
    func testOpaqueIdsRefuseTraversalAndControls() {
        XCTAssertTrue(EventAssetImages.validId("synthetic/L0/001"))
        for id in ["", "../id", "id/../x", "/id", "id//x", "id\\x", "file:id", "id\u{7f}", String(repeating: "x", count: 4097)] {
            XCTAssertFalse(EventAssetImages.validId(id), id)
        }
    }
    func testCacheKeyIncludesModificationAndSize() {
        let asset = backend.assets.values.first!
        let target = EventAssetImages.target(asset, maxPixelSize: 512)
        let changed = EventPhotoAsset(id: asset.id, width: asset.width, height: asset.height, modified: Date(timeIntervalSince1970: 43), fileExtension: "jpg")
        XCTAssertEqual(EventAssetImages.cacheKey(asset, target: target).count, 64)
        XCTAssertNotEqual(EventAssetImages.cacheKey(asset, target: target), EventAssetImages.cacheKey(changed, target: target))
        XCTAssertNotEqual(EventAssetImages.cacheKey(asset, target: target), EventAssetImages.cacheKey(asset, target: CGSize(width: 200, height: 100)))
    }
    func testThumbnailNeverNetworksAndHasProtectedHonestDimensions() {
        backend.image = image(120, 80)
        let done = expectation(description: "thumbnail")
        queue.async {
            self.service.request(ids: ["synthetic/L0/001"], purpose: "thumbnail", maxPixelSize: 512, allowNetwork: true) { replies in
                let reply = replies[0]
                XCTAssertEqual(reply.state, "ready"); XCTAssertEqual(reply.width, 120); XCTAssertEqual(reply.height, 80)
                self.assertPrivate(self.service.thumbs, directory: true)
                self.assertPrivate(reply.url!)
                XCTAssertEqual(self.backend.thumbnailNetwork, [false])
                XCTAssertEqual(self.backend.cancelled, [1])
                done.fulfill()
            }
        }
        wait(for: [done], timeout: 5)
    }
    func testPhotoKitOversizedRenditionIsDownscaledWithinSourceAndTargetBounds() {
        backend.assets["synthetic/three-by-two"] = EventPhotoAsset(id: "synthetic/three-by-two", width: 2048, height: 1365, modified: Date(timeIntervalSince1970: 43), fileExtension: "jpg")
        backend.image = image(540, 360)
        let done = expectation(description: "bounded PhotoKit rendition")
        queue.async {
            self.service.request(ids: ["synthetic/three-by-two"], purpose: "thumbnail", maxPixelSize: 512, allowNetwork: false) { replies in
                let reply = replies[0]
                XCTAssertEqual(reply.state, "ready")
                XCTAssertLessThanOrEqual(reply.width, 512); XCTAssertLessThanOrEqual(reply.height, 342)
                XCTAssertLessThanOrEqual(reply.width, 2048); XCTAssertLessThanOrEqual(reply.height, 1365)
                XCTAssertEqual(reply.width, 512); XCTAssertEqual(reply.height, 341)
                XCTAssertLessThan(abs(Double(reply.width) / Double(reply.height) - 2048.0 / 1365.0), 0.002)
                XCTAssertEqual(self.backend.targets, [CGSize(width: 512, height: 342)])
                XCTAssertEqual(self.backend.thumbnailNetwork, [false])
                self.assertPrivate(reply.url!)
                done.fulfill()
            }
        }
        wait(for: [done], timeout: 5)
    }
    func testThumbnailNeverUpscalesBeyondSourceDimensions() {
        backend.assets["synthetic/tiny"] = EventPhotoAsset(id: "synthetic/tiny", width: 20, height: 10, modified: nil, fileExtension: "jpg")
        backend.image = image(100, 50)
        let done = expectation(description: "no source upscale")
        queue.async {
            self.service.request(ids: ["synthetic/tiny"], purpose: "thumbnail", maxPixelSize: 512, allowNetwork: false) { replies in
                XCTAssertEqual(replies[0].state, "ready")
                XCTAssertEqual(replies[0].width, 20); XCTAssertEqual(replies[0].height, 10)
                done.fulfill()
            }
        }
        wait(for: [done], timeout: 5)
    }
    func testCloudOnlyThumbnailAndUnknownKeepTheirPositions() {
        backend.cloud = true
        let done = expectation(description: "ordered states")
        queue.async {
            self.service.request(ids: ["synthetic/L0/001", "unknown"], purpose: "thumbnail", maxPixelSize: 512, allowNetwork: false) { replies in
                XCTAssertEqual(replies.map(\.id), ["synthetic/L0/001", "unknown"])
                XCTAssertEqual(replies.map(\.state), ["cloudOnly", "missing"])
                XCTAssertTrue(replies.allSatisfy { $0.url == nil }); done.fulfill()
            }
        }
        wait(for: [done], timeout: 5)
    }
    func testOriginalResourceDisallowsNetworkByDefault() {
        let done = expectation(description: "cloud refusal")
        queue.async {
            self.service.request(ids: ["synthetic/L0/001"], purpose: "viewer", maxPixelSize: 512, allowNetwork: false) { replies in
                XCTAssertEqual(replies[0].state, "cloudOnly"); XCTAssertNil(replies[0].url); done.fulfill()
            }
            XCTAssertEqual(self.backend.originalNetwork, [false])
            self.backend.originalCompletion?(NSError(domain: PHPhotosErrorDomain, code: PHPhotosError.Code.networkAccessRequired.rawValue))
        }
        wait(for: [done], timeout: 5)
    }
    func testOriginalBytesVerbatimReleaseAndLaunchSweep() {
        let bytes = Data("original ICC C2PA synthetic resource".utf8)
        let done = expectation(description: "original")
        queue.async {
            self.service.request(ids: ["synthetic/L0/001"], purpose: "viewer", maxPixelSize: 512, allowNetwork: false) { replies in
                XCTAssertEqual(replies[0].state, "ready")
                let url = replies[0].url!
                XCTAssertEqual(try! Data(contentsOf: url), bytes)
                self.service.release(urls: [url])
                XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
                self.service.sweepLaunch()
                XCTAssertFalse(FileManager.default.fileExists(atPath: self.service.originals.path)); done.fulfill()
            }
            self.backend.originalData?(bytes.prefix(9))
            self.backend.originalData?(bytes.dropFirst(9))
            self.backend.originalCompletion?(nil)
        }
        wait(for: [done], timeout: 5)
    }
    func testCancelAndClearSuppressLateProgressAndLateTemp() {
        let done = expectation(description: "cancel")
        let late = expectation(description: "late completion drained")
        queue.async {
            var progressCount = 0
            self.service.progress = { _, _ in progressCount += 1 }
            self.service.request(ids: ["synthetic/L0/001"], purpose: "viewer", maxPixelSize: 512, allowNetwork: true) { replies in
                XCTAssertEqual(replies[0].state, "failed"); done.fulfill()
            }
            let url = self.originalURL()
            self.backend.originalData?(Data("queued before cancellation".utf8))
            self.service.cancel(ids: ["synthetic/L0/001"])
            XCTAssertEqual(self.backend.cancelledData, [73])
            XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
            self.service.clear()
            self.backend.originalProgress?(0.9)
            self.backend.originalData?(Data("late original".utf8))
            self.backend.originalCompletion?(nil)
            self.backend.originalCompletion?(CocoaError(.userCancelled))
            self.queue.async {
                XCTAssertEqual(progressCount, 0)
                XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
                XCTAssertFalse(FileManager.default.fileExists(atPath: self.service.thumbs.path)); late.fulfill()
            }
        }
        wait(for: [done, late], timeout: 5)
    }
    func testLRUEvictionBoundAndClear() throws {
        try FileManager.default.createDirectory(at: service.thumbs, withIntermediateDirectories: true)
        for index in 0..<3 {
            let url = service.thumbs.appendingPathComponent("\(index).jpg")
            try Data(repeating: 0, count: 100).write(to: url)
            try FileManager.default.setAttributes([.modificationDate: Date(timeIntervalSince1970: Double(index))], ofItemAtPath: url.path)
        }
        let bounded = EventAssetImages(queue: queue, backend: backend, thumbs: service.thumbs, originals: service.originals, budget: 150)
        queue.sync { bounded.evict() }
        let files = try FileManager.default.contentsOfDirectory(atPath: service.thumbs.path)
        XCTAssertEqual(files, ["2.jpg"])
        queue.sync { bounded.clear() }
        XCTAssertFalse(FileManager.default.fileExists(atPath: service.thumbs.path))
    }
    func testLegacyEventStorageRetiredWithoutTouchingOtherPreferences() throws {
        let suite = "event-state-tests-" + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        defaults.set(true, forKey: EventSourceStateStore.legacyKeys[0])
        defaults.set(["lastIndexedAt": 42, "eventCount": 7, "privateId": "legacy"], forKey: EventSourceStateStore.legacyKeys[1])
        defaults.set(true, forKey: EventSourceStateStore.legacyKeys[2])
        defaults.set(17, forKey: EventSourceStateStore.legacyKeys[3])
        defaults.set(["theme": "dark"], forKey: "non-event-preferences")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let legacy = root.appendingPathComponent("events-index.json")
        try Data("{\"schemaVersion\":999,\"privateId\":\"legacy\"}".utf8).write(to: legacy)
        let state = EventSourceStateStore(support: root, defaults: defaults)
        let migrated = try state.read()
        XCTAssertTrue(migrated.enabled); XCTAssertTrue(migrated.downloadCloudOnOpen)
        XCTAssertEqual(migrated.selectedPhotoCount, 17)
        XCTAssertNil(migrated.header) // Discarded index must not vouch for a header.
        XCTAssertFalse(FileManager.default.fileExists(atPath: legacy.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: state.indexURL.path))
        for key in EventSourceStateStore.legacyKeys { XCTAssertNil(defaults.object(forKey: key)) }
        XCTAssertEqual(defaults.dictionary(forKey: "non-event-preferences") as? [String: String], ["theme": "dark"])
        assertPrivate(state.directory, directory: true); assertPrivate(state.stateURL)
        XCTAssertFalse(String(data: try Data(contentsOf: state.stateURL), encoding: .utf8)!.contains("legacy"))
    }
    func testProtectedStateCachesStatusAndPersistsSeconds() throws {
        let suite = "event-state-tests-" + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let state = EventSourceStateStore(support: root, defaults: defaults)
        XCTAssertEqual(try state.read(), EventSourceStateStore.State())
        try EventPrivateFiles.write(Data("index fixture".utf8), to: state.indexURL)
        try state.update {
            $0.enabled = true; $0.downloadCloudOnOpen = true; $0.selectedPhotoCount = 3
            $0.header = .init(lastIndexedAt: Date(timeIntervalSince1970: 1764000000), eventCount: 2)
        }
        assertPrivate(state.directory, directory: true); assertPrivate(state.stateURL); assertPrivate(state.indexURL)
        let persisted = try Data(contentsOf: state.stateURL)
        let json = try JSONSerialization.jsonObject(with: persisted) as! [String: Any]
        XCTAssertEqual((json["header"] as? [String: Any])?["lastIndexedAt"] as? Double, 1764000000)
        let reopened = EventSourceStateStore(support: root, defaults: defaults)
        XCTAssertEqual(try reopened.read(), try state.read())
        // A warm status read must not re-open even its tiny state file.
        try FileManager.default.removeItem(at: state.stateURL)
        XCTAssertTrue(try state.read().enabled)
        XCTAssertEqual(try state.read().header?.eventCount, 2)
    }
    func testAtomicWriterRepairsPrivateDirectoryAndReplacesProtectedFile() throws {
        let directory = root.appendingPathComponent("EventClustering")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o755])
        let file = directory.appendingPathComponent("fixture.json")
        try EventPrivateFiles.write(Data("first".utf8), to: file)
        assertPrivate(directory, directory: true); assertPrivate(file)
        try EventPrivateFiles.write(Data("second".utf8), to: file)
        assertPrivate(directory, directory: true); assertPrivate(file)
        XCTAssertEqual(try Data(contentsOf: file), Data("second".utf8))
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: directory.path), ["fixture.json"])
    }
    func testUnknownIndexSchemaIsDiscardedNotMigrated() throws {
        let url = root.appendingPathComponent("EventClustering/events-index.json")
        let index = EventIndex(schemaVersion: 999,
            source: .init(deviceId: "device", sourceId: EventIndex.photokitSourceId, sourceKind: EventIndex.photokitSourceKind,
                          label: "Camera Roll", lastIndexedAt: Date(timeIntervalSince1970: 42)), config: ClusteringConfig())
        try EventPrivateFiles.write(EventIndex.encode(index), to: url)
        let store = RawDumpStore(url: url)
        queue.sync { store.open(deviceId: "device") }
        XCTAssertEqual(store.itemCount, 0)
        XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
    }
    func testOriginalFileProtectedBeforePhotoKitStartsAndStreamsUnchanged() {
        let bytes = Data("source ICC C2PA payload".utf8)
        backend.onRequestData = {
            let url = self.originalURL()
            self.assertPrivate(self.service.originals, directory: true)
            self.assertPrivate(url.deletingLastPathComponent(), directory: true)
            self.assertPrivate(url)
            XCTAssertEqual(try! Data(contentsOf: url).count, 0)
        }
        backend.synchronousChunks = [bytes.prefix(3), bytes.dropFirst(3)]
        let done = expectation(description: "synchronous chunks finish")
        queue.async {
            self.service.request(ids: ["synthetic/L0/001"], purpose: "viewer", maxPixelSize: 512, allowNetwork: false) { replies in
                let url = replies[0].url!
                let actual = try! Data(contentsOf: url)
                XCTAssertEqual(actual.count, bytes.count)
                XCTAssertEqual(SHA256.hash(data: actual), SHA256.hash(data: bytes))
                self.assertPrivate(url)
                XCTAssertEqual(self.backend.cancelledData, [])
                done.fulfill()
            }
        }
        wait(for: [done], timeout: 5)
    }
    func testSynchronousCompletionThenCancelUsesReturnedRequestIDOnce() {
        backend.synchronousChunks = [Data("queued success".utf8)]
        let done = expectation(description: "cancel once")
        let drained = expectation(description: "queued success cannot resurrect")
        queue.async {
            var completions = 0
            self.service.request(ids: ["synthetic/L0/001"], purpose: "viewer", maxPixelSize: 512, allowNetwork: true) { replies in
                completions += 1
                XCTAssertEqual(replies[0].state, "failed"); done.fulfill()
            }
            let url = self.originalURL()
            self.service.cancel(ids: ["synthetic/L0/001"])
            XCTAssertEqual(self.backend.cancelledData, [73])
            self.backend.originalData?(Data("late".utf8)); self.backend.originalProgress?(1)
            self.backend.originalCompletion?(nil)
            self.queue.async {
                XCTAssertEqual(completions, 1)
                XCTAssertFalse(FileManager.default.fileExists(atPath: url.path)); drained.fulfill()
            }
        }
        wait(for: [done, drained], timeout: 5)
    }
    func testClearCancelsPhotoKitDataRequestAndDeletesPartialImmediately() {
        let done = expectation(description: "clear")
        queue.async {
            self.service.request(ids: ["synthetic/L0/001"], purpose: "viewer", maxPixelSize: 512, allowNetwork: true) { replies in
                XCTAssertEqual(replies[0].state, "failed"); done.fulfill()
            }
            let url = self.originalURL()
            self.backend.onCancelData = { XCTAssertFalse(FileManager.default.fileExists(atPath: url.path)) }
            self.service.clear()
            XCTAssertEqual(self.backend.cancelledData, [73])
            XCTAssertFalse(FileManager.default.fileExists(atPath: self.service.originals.path))
        }
        wait(for: [done], timeout: 5)
    }
    func testResourceErrorRemovesPartialAndCompletesOnce() {
        let done = expectation(description: "resource error")
        let drained = expectation(description: "late events drained")
        queue.async {
            var completions = 0, progress = 0
            self.service.progress = { _, _ in progress += 1 }
            self.service.request(ids: ["synthetic/L0/001"], purpose: "viewer", maxPixelSize: 512, allowNetwork: true) { replies in
                completions += 1
                XCTAssertEqual(replies[0].state, "failed"); XCTAssertNil(replies[0].url); done.fulfill()
            }
            let url = self.originalURL()
            self.backend.originalData?(Data("partial".utf8))
            self.backend.originalCompletion?(CocoaError(.fileReadUnknown))
            self.backend.originalData?(Data("late".utf8)); self.backend.originalProgress?(1)
            self.backend.originalCompletion?(nil)
            self.queue.async {
                XCTAssertEqual(completions, 1); XCTAssertEqual(progress, 0)
                XCTAssertFalse(FileManager.default.fileExists(atPath: url.path)); drained.fulfill()
            }
        }
        wait(for: [done, drained], timeout: 5)
    }
    func testRemovedPartialOriginalCannotPublishMissingURL() {
        let done = expectation(description: "missing original file")
        queue.async {
            self.service.request(ids: ["synthetic/L0/001"], purpose: "viewer", maxPixelSize: 512, allowNetwork: false) { replies in
                XCTAssertEqual(replies[0].state, "failed"); XCTAssertNil(replies[0].url); done.fulfill()
            }
            let url = self.originalURL()
            try! FileManager.default.removeItem(at: url)
            self.backend.originalData?(Data("unlinked bytes".utf8))
            self.backend.originalCompletion?(nil)
        }
        wait(for: [done], timeout: 5)
    }
    func testCancelAlsoRemovesCompletedCopyWithoutTouchingUnissuedURL() {
        backend.synchronousChunks = [Data("complete resource".utf8)]
        let done = expectation(description: "cancel completed")
        queue.async {
            self.service.request(ids: ["synthetic/L0/001"], purpose: "viewer", maxPixelSize: 512, allowNetwork: false) { replies in
                let url = replies[0].url!
                let unrelated = self.root.appendingPathComponent("unrelated.json")
                try! Data("unrelated".utf8).write(to: unrelated)
                self.service.release(urls: [unrelated])
                XCTAssertTrue(FileManager.default.fileExists(atPath: unrelated.path))
                self.service.cancel(ids: ["synthetic/L0/001"])
                XCTAssertFalse(FileManager.default.fileExists(atPath: url.path)); done.fulfill()
            }
        }
        wait(for: [done], timeout: 5)
    }
    func testCacheHitStillRequiresPhotoKitAssetAuthorization() {
        backend.image = image(120, 80)
        let done = expectation(description: "revoked id")
        queue.async {
            self.service.request(ids: ["synthetic/L0/001"], purpose: "thumbnail", maxPixelSize: 512, allowNetwork: false) { replies in
                XCTAssertEqual(replies[0].state, "ready")
                self.backend.assets.removeAll() // A restricted/removed identifier no longer fetches.
                self.service.request(ids: ["synthetic/L0/001"], purpose: "thumbnail", maxPixelSize: 512, allowNetwork: false) { replies in
                    XCTAssertEqual(replies[0].state, "missing"); XCTAssertNil(replies[0].url); done.fulfill()
                }
            }
        }
        wait(for: [done], timeout: 5)
    }
    func testClosingServiceCancelsRequestOnOwnerQueue() {
        let done = expectation(description: "close resolves pending promise")
        let drained = expectation(description: "close cleanup")
        queue.async {
            var closing: EventAssetImages? = EventAssetImages(queue: self.queue, backend: self.backend,
                thumbs: self.service.thumbs, originals: self.service.originals)
            closing!.request(ids: ["synthetic/L0/001"], purpose: "viewer", maxPixelSize: 512, allowNetwork: true) { replies in
                XCTAssertEqual(replies[0].state, "failed"); done.fulfill()
            }
            let url = self.originalURL()
            closing = nil
            XCTAssertEqual(self.backend.cancelledData, [73])
            XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
            self.queue.async {
                XCTAssertEqual(self.backend.cancelledData, [73])
                XCTAssertFalse(FileManager.default.fileExists(atPath: url.path)); drained.fulfill()
            }
        }
        wait(for: [done, drained], timeout: 5)
    }
    func invoke(_ method: String, options: [String: Any] = [:], _ run: (CAPPluginCall) -> Void) -> [String: Any]? {
        let done = expectation(description: method)
        var result: [String: Any]?
        let call = CAPPluginCall(callbackId: UUID().uuidString, methodName: method, options: options, success: { reply, _ in
            result = reply?.data; done.fulfill()
        }, error: { error in
            XCTFail("\(method) rejected: \(error)"); done.fulfill()
        })!
        run(call)
        wait(for: [done], timeout: 20)
        return result
    }
    func testSeededPluginDeclarationScanPixelsAndClear() throws {
        let plugin = EventClusteringPlugin()
        _ = invoke("clearRawDumpRoot", plugin.clearRawDumpRoot)
        let before = invoke("getRawDumpStatus", plugin.getRawDumpStatus)
        XCTAssertEqual(before?["configured"] as? Bool, false)
        let picked = invoke("pickRawDumpRoot", plugin.pickRawDumpRoot)
        XCTAssertGreaterThan(picked?["itemCount"] as? Int ?? 0, 0)
        let scan = invoke("scanRawDumpEvents", plugin.scanRawDumpEvents)
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let privateDirectory = support.appendingPathComponent("EventClustering")
        let indexURL = privateDirectory.appendingPathComponent("events-index.json")
        assertPrivate(privateDirectory, directory: true); assertPrivate(indexURL)
        assertPrivate(privateDirectory.appendingPathComponent("source-state.json"))
        let disk = try EventIndex.decode(Data(contentsOf: indexURL))
        let status = invoke("getRawDumpStatus", plugin.getRawDumpStatus)
        XCTAssertEqual(status?["lastIndexedAt"] as? Int64, Int64(disk.source.lastIndexedAt.timeIntervalSince1970 * 1000))
        let clusters = try XCTUnwrap(scan?["clusters"] as? [[String: Any]])
        let id = try XCTUnwrap(clusters.first?["coverItemId"] as? String)
        let pixels = invoke("getEventAssetImage", options: ["ids": [id], "purpose": "viewer", "allowNetwork": false], plugin.getEventAssetImage)
        let items = try XCTUnwrap(pixels?["items"] as? [[String: Any]])
        XCTAssertEqual(items.first?["state"] as? String, "ready")
        let url = try XCTUnwrap((items.first?["url"] as? String).flatMap(URL.init(string:)))
        XCTAssertTrue(url.isFileURL)
        _ = invoke("clearRawDumpRoot", plugin.clearRawDumpRoot)
        let after = invoke("getRawDumpStatus", plugin.getRawDumpStatus)
        XCTAssertEqual(after?["configured"] as? Bool, false)
        XCTAssertEqual(after?["eventCount"] as? Int, 0)
        XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
        let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        XCTAssertFalse(FileManager.default.fileExists(atPath: indexURL.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: support.appendingPathComponent("events-index.json").path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: caches.appendingPathComponent("event-thumbs").path))
    }
    func testNativePixelSizeRejectsCoercion() {
        XCTAssertTrue(EventClusteringPlugin.validPixelSize(nil))
        XCTAssertTrue(EventClusteringPlugin.validPixelSize(NSNumber(value: 512)))
        for value: Any in [NSNumber(value: 0), NSNumber(value: 8193), NSNumber(value: 1.5), NSNumber(value: true), "512"] {
            XCTAssertFalse(EventClusteringPlugin.validPixelSize(value))
        }
    }
    func testSeededPhotoKitEventsGroupByCaptureDate() throws {
        XCTAssertEqual(PHPhotoLibrary.authorizationStatus(for: .readWrite), .authorized,
                       "Grant simulator Photos permission before running this suite")
        let all = PHAsset.fetchAssets(with: .image, options: nil)
        let marker = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("event-fixture-prefix.txt")
        let prefix = try XCTUnwrap((try? String(contentsOf: marker, encoding: .utf8))
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .flatMap { $0.isEmpty ? nil : $0 }
            ?? ProcessInfo.processInfo.environment["EVENT_FIXTURE_PREFIX"],
            "Neither event-fixture-prefix.txt nor EVENT_FIXTURE_PREFIX names this run's batch; the retired event-demo fallback could match stale assets from an earlier run")
        var seeded: [PHAsset] = []
        all.enumerateObjects { asset, _, _ in
            if PHAssetResource.assetResources(for: asset).contains(where: {
                let name = $0.originalFilename
                return name.hasPrefix(prefix) && name.hasSuffix(".jpg")
            }) {
                seeded.append(asset)
            }
        }
        XCTAssertEqual(seeded.count, 7, "Seed the seven event-demo JPEGs with simctl addmedia")
        let expectedIds = Set(seeded.map(\.localIdentifier))
        let plugin = EventClusteringPlugin()
        defer { _ = invoke("clearRawDumpRoot", plugin.clearRawDumpRoot) }
        _ = invoke("clearRawDumpRoot", plugin.clearRawDumpRoot)
        let picked = invoke("pickRawDumpRoot", plugin.pickRawDumpRoot)
        XCTAssertEqual(picked?["rootPath"] as? String, nil)
        let scan = invoke("scanRawDumpEvents", plugin.scanRawDumpEvents)
        let clusters = try XCTUnwrap(scan?["clusters"] as? [[String: Any]])
        // Reusing a simulator adds earlier fixture batches on the same dates;
        // those assets legitimately share events with the current batch.
        let fixtureClusters = clusters.filter { cluster in
            let ids = (cluster["itemIds"] as? [String]) ?? []
            return ids.contains(where: expectedIds.contains)
        }
        // Membership, not just sizes: two clusters exchanging one fixture id
        // would still count [2, 2, 3]. The fixture is three time-separated
        // sessions — [01, 02, 03], [04, 05], [06, 07] in the seed script's
        // numbering — not a capture-day partition: the morning and evening of
        // 15 March sit ten hours apart, well past the 3.5-hour session gap, so
        // they are distinct events by design in every timezone. The numeric
        // suffix in each seeded filename is the session contract, so the
        // expected partition comes from the assets themselves rather than a
        // hard-coded identifier list.
        var bySession: [Int: Set<String>] = [:]
        for asset in seeded {
            let name = PHAssetResource.assetResources(for: asset)
                .map(\.originalFilename)
                .first { $0.hasPrefix(prefix) && $0.hasSuffix(".jpg") } ?? ""
            let digits = name.dropFirst(prefix.count).dropLast(4)
            guard let number = Int(digits), (1...7).contains(number) else {
                XCTFail("seeded asset \(asset.localIdentifier) carries unexpected filename \(name)")
                continue
            }
            let session = number <= 3 ? 0 : (number <= 5 ? 1 : 2)
            bySession[session, default: []].insert(asset.localIdentifier)
        }
        let expectedGroups = bySession.values.sorted { $0.sorted().lexicographicallyPrecedes($1.sorted()) }
        let actualGroups = fixtureClusters.map { cluster in
            Set((cluster["itemIds"] as? [String]) ?? []).intersection(expectedIds)
        }.filter { !$0.isEmpty }
        XCTAssertEqual(
            actualGroups.map { $0.sorted() }.sorted { $0.lexicographicallyPrecedes($1) },
            expectedGroups.map { $0.sorted() }.sorted { $0.lexicographicallyPrecedes($1) },
            "each cluster's fixture membership must match the seed script's three-session partition"
        )
        let actualIds = Set(fixtureClusters.flatMap { ($0["itemIds"] as? [String]) ?? [] })
            .intersection(expectedIds)
        XCTAssertEqual(actualIds, expectedIds)
        XCTAssertEqual(actualIds.count, expectedIds.count)
    }
    func testSeededPhotoKitPixelsAndOriginalBytes() throws {
        // CI/local runners install the app, grant Photos, then simctl addmedia
        // a synthetic PNG. No personal library or iCloud account is used.
        XCTAssertEqual(PHPhotoLibrary.authorizationStatus(for: .readWrite), .authorized,
                       "Grant simulator Photos permission before running this suite")
        let all = PHAsset.fetchAssets(with: .image, options: nil)
        var seeded: PHAsset?
        all.enumerateObjects { asset, _, stop in
            if PHAssetResource.assetResources(for: asset).contains(where: { $0.originalFilename == "event-synthetic.png" }) {
                seeded = asset; stop.pointee = true
            }
        }
        let asset = try XCTUnwrap(seeded, "Seed event-synthetic.png with simctl addmedia")
        let resource = try XCTUnwrap(PHAssetResource.assetResources(for: asset).first { $0.type == .photo })
        let read = expectation(description: "untouched PhotoKit resource")
        let options = PHAssetResourceRequestOptions(); options.isNetworkAccessAllowed = false
        var expected = Data()
        PHAssetResourceManager.default().requestData(for: resource, options: options, dataReceivedHandler: { expected.append($0) }) { error in
            XCTAssertNil(error); read.fulfill()
        }
        wait(for: [read], timeout: 15)
        XCTAssertFalse(expected.isEmpty)
        let real = EventAssetImages(queue: queue, thumbs: service.thumbs, originals: service.originals)
        let thumbnail = expectation(description: "real PhotoKit thumbnail")
        let original = expectation(description: "real PhotoKit original")
        queue.async {
            real.request(ids: [asset.localIdentifier], purpose: "thumbnail", maxPixelSize: 512, allowNetwork: false) { replies in
                let reply = replies[0]
                XCTAssertEqual(reply.state, "ready")
                XCTAssertLessThanOrEqual(reply.width, min(512, asset.pixelWidth))
                XCTAssertLessThanOrEqual(reply.height, min(512, asset.pixelHeight))
                thumbnail.fulfill()
            }
            real.request(ids: [asset.localIdentifier], purpose: "viewer", maxPixelSize: 512, allowNetwork: false) { replies in
                let reply = replies[0]
                XCTAssertEqual(reply.state, "ready")
                if let url = reply.url {
                    let actual = try! Data(contentsOf: url)
                    XCTAssertEqual(actual, expected)
                    XCTAssertEqual(actual.count, expected.count)
                    XCTAssertEqual(SHA256.hash(data: actual), SHA256.hash(data: expected))
                    self.assertPrivate(url); self.assertPrivate(real.originals, directory: true)
                    XCTAssertEqual(reply.width, asset.pixelWidth); XCTAssertEqual(reply.height, asset.pixelHeight)
                    real.release(urls: [url])
                    XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
                } else { XCTFail("Original resource did not produce a private URL") }
                original.fulfill()
            }
        }
        wait(for: [thumbnail, original], timeout: 20)
        queue.sync { real.clear() }
        XCTAssertFalse(FileManager.default.fileExists(atPath: real.thumbs.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: real.originals.path))
    }
    func testPluginRegistersPixelAndLifecycleMethods() {
        let names = Set(EventClusteringPlugin().pluginMethods.map(\.name))
        for name in ["getEventAssetImage", "cancelEventAssetImage", "releaseEventAssetImages", "presentLimitedLibraryPicker", "getRawDumpStatus"] {
            XCTAssertTrue(names.contains(name), name)
        }
    }
}
