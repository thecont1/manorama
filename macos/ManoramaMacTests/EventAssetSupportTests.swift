import CoreGraphics
import Darwin
import Foundation
import ImageIO
import WebKit

private final class EventProtocolProbe: NSObject, WKNavigationDelegate {
    private let lock = NSLock()
    private var completed = false
    private var dimensions: String?

    func snapshot() -> (completed: Bool, dimensions: String?) {
        lock.lock()
        defer { lock.unlock() }
        return (completed, dimensions)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        webView.evaluateJavaScript(
            "document.images.length ? document.images[0].naturalWidth + 'x' + document.images[0].naturalHeight : ''"
        ) { [weak self] result, error in
            guard let self else { return }
            lock.lock()
            if !completed {
                completed = true
                dimensions = error == nil ? result as? String : nil
            }
            lock.unlock()
        }
    }

    func webView(_ webView: WKWebView,
                 didFailProvisionalNavigation navigation: WKNavigation!,
                 withError error: Error) {
        finishFailure()
    }

    func webView(_ webView: WKWebView,
                 didFail navigation: WKNavigation!,
                 withError error: Error) {
        finishFailure()
    }

    private func finishFailure() {
        lock.lock()
        completed = true
        dimensions = nil
        lock.unlock()
    }
}

/// Headless checks for the Camera Roll asset boundary. Compile with the same
/// explicit shell sources as test-macos-boundary.sh, replacing BoundaryTests
/// and its main with EventAssetSupportTests.swift and main.swift.
final class EventAssetSupportTests {
    private static var imageExtensions: Set<String> { FolderDumpScanner.imageExtensions }

    static func run() throws {
        var failures = 0
        func check(_ label: String, _ condition: Bool, _ detail: String = "") {
            if condition {
                print("PASS  \(label)")
            } else {
                print("FAIL  \(label) \(detail)")
                failures += 1
            }
        }

        let temporary = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("manorama-event-assets-\(UUID().uuidString)", isDirectory: true)
        let root = temporary.appendingPathComponent("dump", isDirectory: true)
        let outside = temporary.appendingPathComponent("dump-evil", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: outside, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: temporary) }
        guard let rootIdentity = NativeFileIdentity(directoryAt: root) else {
            throw NSError(domain: "EventAssetSupportTests", code: 2, userInfo: [NSLocalizedDescriptionKey: "missing root identity"])
        }
        let verifiedRoot = try EventAssetSupport.openRoot(root, expected: rootIdentity)
        let registry = EventAssetRegistry()
        let sourceID = UUID()

        func requestArgs(_ ids: [String] = ["one.jpg"]) -> [String: Any] {
            ["ids": ids, "purpose": "viewer"]
        }

        func expectBadRequest(_ label: String, _ args: [String: Any]) {
            do {
                _ = try EventAssetSupport.Request.parse(args, imageExtensions: imageExtensions)
                check(label, false, "accepted")
            } catch EventAssetSupportError.badArguments {
                check(label, true)
            } catch {
                check(label, false, "wrong error: \(error)")
            }
        }

        func expectRevealFailure(_ label: String, id: String) {
            do {
                _ = try EventAssetSupport.reveal(
                    root: verifiedRoot, id: id, imageExtensions: imageExtensions
                )
                check(label, false, "revealed \(id)")
            } catch {
                check(label, true)
            }
        }

        func expectReselection(_ label: String, _ body: () throws -> Void) {
            do {
                try body()
                check(label, false, "accepted replaced root")
            } catch EventAssetSupportError.reselectionRequired {
                check(label, true)
            } catch {
                check(label, false, "wrong error: \(error)")
            }
        }

        // --- Request validation ------------------------------------------
        expectBadRequest("empty asset batch is rejected", requestArgs([]))
        do {
            let sixtyFour = (0..<64).map { "\($0).jpg" }
            _ = try EventAssetSupport.Request.parse(requestArgs(sixtyFour), imageExtensions: imageExtensions)
            check("64 distinct asset ids are valid", true)
        } catch {
            check("64 distinct asset ids are valid", false, "\(error)")
        }
        expectBadRequest("65 asset ids are rejected", requestArgs((0..<65).map { "\($0).jpg" }))
        expectBadRequest("duplicate asset ids are rejected", requestArgs(["one.jpg", "one.jpg"]))

        for id in [
            "", "../one.jpg", "/one.jpg", "a//one.jpg", "a/./one.jpg", "a/../one.jpg",
            "C:/one.jpg", "a\\one.jpg", "one\0.jpg", "one\n.jpg", "one.txt", "file://one.jpg",
            String(repeating: "a", count: 4093) + ".jpg",
        ] {
            expectBadRequest("malformed asset id is rejected: \(id.debugDescription)", requestArgs([id]))
        }
        do {
            _ = try EventAssetSupport.Request.parse(
                requestArgs(["nested/space # % é.jpg"]), imageExtensions: imageExtensions
            )
            check("relative names with spaces, percent, hash and Unicode are valid", true)
        } catch {
            check("relative names with spaces, percent, hash and Unicode are valid", false, "\(error)")
        }

        var args = requestArgs()
        args["purpose"] = "original"
        expectBadRequest("invalid asset purpose is rejected", args)
        args = requestArgs()
        args.removeValue(forKey: "purpose")
        expectBadRequest("missing asset purpose is rejected", args)
        args = requestArgs()
        args["purpose"] = "thumbnail"
        args["maxPixelSize"] = NSNumber(value: 8192)
        args["allowNetwork"] = false
        do {
            _ = try EventAssetSupport.Request.parse(args, imageExtensions: imageExtensions)
            check("maximum 8192 size and allowNetwork false are valid", true)
        } catch {
            check("maximum 8192 size and allowNetwork false are valid", false, "\(error)")
        }
        for size: Any in [0, -1, 1.5, 8193, NSNumber(value: UInt64(UInt32.max) + 1), true, "128"] {
            args = requestArgs()
            args["maxPixelSize"] = size
            expectBadRequest("invalid maxPixelSize is rejected: \(size)", args)
        }
        args = requestArgs()
        args["allowNetwork"] = true
        expectBadRequest("allowNetwork true is rejected", args)
        for value: Any in [NSNumber(value: 1), "false"] {
            args = requestArgs()
            args["allowNetwork"] = value
            expectBadRequest("non-boolean allowNetwork is rejected: \(value)", args)
        }
        args = requestArgs()
        args["maxPixelSize"] = NSNull()
        expectBadRequest("null optional size is rejected", args)
        args = requestArgs()
        args["allowNetwork"] = NSNull()
        expectBadRequest("null optional network argument is rejected", args)

        // --- Ordered replies, honest dimensions and original URIs --------
        let rotatedURL = root.appendingPathComponent("nested/rotated.jpg")
        let specialURL = root.appendingPathComponent("space # % é.jpg")
        let rotatedBytes = try writeJPEG(to: rotatedURL, width: 640, height: 480, orientation: 6)
        let specialBytes = try writeJPEG(to: specialURL, width: 320, height: 240, orientation: 1)
        args = requestArgs(["space # % é.jpg", "nested/rotated.jpg", "absent.jpg"])
        args["purpose"] = "thumbnail"
        args["maxPixelSize"] = 32
        let request = try EventAssetSupport.Request.parse(args, imageExtensions: imageExtensions)
        let filesBefore = Set((try? FileManager.default.contentsOfDirectory(atPath: root.path)) ?? [])
        let ordered = try EventAssetSupport.items(
            root: verifiedRoot, request: request, pixelsAreLocal: { _ in true },
            registry: registry, sourceID: sourceID
        )
        check("asset reply preserves input order and count",
              ordered.map(\.id) == ["space # % é.jpg", "nested/rotated.jpg", "absent.jpg"])
        check("ready assets have positive intrinsic dimensions",
              ordered[0].state == .ready && (ordered[0].width, ordered[0].height) == (320, 240)
                  && ordered[1].state == .ready && (ordered[1].width, ordered[1].height) == (480, 640))
        func isOpaqueEventURL(_ value: String?) -> Bool {
            guard let value, let url = URL(string: value),
                  let token = EventAssetRegistry.token(from: url) else { return false }
            return value == "manorama-event://localhost/\(token)"
                && !value.contains("space") && !value.contains("rotated")
                && !value.contains(root.path)
        }
        check("ready URLs are opaque native event capabilities",
              isOpaqueEventURL(ordered[0].url) && isOpaqueEventURL(ordered[1].url)
                  && ordered[0].url != ordered[1].url)
        check("missing scan member has no URL or dimensions",
              ordered[2].state == .missing && ordered[2].url == nil
                  && ordered[2].width == 0 && ordered[2].height == 0)
        check("non-ready wire URL is explicit null",
              ordered[2].wireValue["url"] is NSNull
                  && Set(ordered[2].wireValue.keys) == ["id", "url", "width", "height", "state"])
        check("purpose and maxPixelSize hints do not alter source bytes",
              (try? Data(contentsOf: specialURL)) == specialBytes
                  && (try? Data(contentsOf: rotatedURL)) == rotatedBytes)
        let filesAfter = Set((try? FileManager.default.contentsOfDirectory(atPath: root.path)) ?? [])
        check("asset reply creates no thumbnail or other persisted file", filesAfter == filesBefore)
        check("wire reply is JSON serializable",
              JSONSerialization.isValidJSONObject(["items": ordered.map(\.wireValue)]))

        // --- Cloud, missing and malformed members ------------------------
        let cloudURL = root.appendingPathComponent("cloud.jpg")
        FileManager.default.createFile(atPath: cloudURL.path, contents: nil)
        do {
            let handle = try FileHandle(forWritingTo: cloudURL)
            try handle.truncate(atOffset: 512 * 1024)
            try handle.close()
        } catch {
            check("sparse cloud fixture was written", false, "\(error)")
        }
        let malformedURL = root.appendingPathComponent("malformed.jpg")
        try Data("not an image".utf8).write(to: malformedURL)
        let emptyURL = root.appendingPathComponent("empty.jpg")
        try Data().write(to: emptyURL)
        args = requestArgs(["cloud.jpg", "absent.jpg", "malformed.jpg", "empty.jpg"])
        let mixedRequest = try EventAssetSupport.Request.parse(args, imageExtensions: imageExtensions)
        var probed: [String] = []
        let mixed = try EventAssetSupport.items(
            root: verifiedRoot, request: mixedRequest,
            pixelsAreLocal: { url in
                probed.append(url.lastPathComponent)
                return url.lastPathComponent != "cloud.jpg"
            },
            registry: registry, sourceID: sourceID
        )
        check("cloud placeholder is detected before metadata probing or header parsing",
              mixed[0].state == .cloudOnly && !probed.contains("cloud.jpg"))
        let scannerMixed = try EventAssetSupport.items(
            root: verifiedRoot, request: mixedRequest,
            pixelsAreLocal: FolderDumpScanner.pixelsAreLocal(at:),
            registry: registry, sourceID: sourceID
        )
        check("scanner metadata identifies the sparse placeholder without a read",
              scannerMixed[0].state == .cloudOnly && scannerMixed[0].url == nil)
        check("missing and malformed assets have distinct no-URL states",
              mixed[1].state == .missing && mixed[2].state == .failed && mixed[3].state == .failed
                  && mixed.allSatisfy { $0.url == nil && $0.width == 0 && $0.height == 0 })

        // --- Traversal and symlink containment ---------------------------
        let outsidePhoto = outside.appendingPathComponent("outside.jpg")
        _ = try writeJPEG(to: outsidePhoto, width: 100, height: 80, orientation: 1)
        try FileManager.default.createSymbolicLink(
            atPath: root.appendingPathComponent("alias").path, withDestinationPath: outside.path
        )
        try FileManager.default.createSymbolicLink(
            atPath: root.appendingPathComponent("leaf.jpg").path, withDestinationPath: outsidePhoto.path
        )
        let insideTarget = root.appendingPathComponent("inside-target.jpg")
        _ = try writeJPEG(to: insideTarget, width: 90, height: 60, orientation: 1)
        try FileManager.default.createSymbolicLink(
            atPath: root.appendingPathComponent("inside-link.jpg").path, withDestinationPath: insideTarget.path
        )
        args = requestArgs(["alias/outside.jpg", "leaf.jpg", "inside-link.jpg"])
        let symlinkRequest = try EventAssetSupport.Request.parse(args, imageExtensions: imageExtensions)
        var symlinkProbes: [URL] = []
        let symlinkItems = try EventAssetSupport.items(
            root: verifiedRoot, request: symlinkRequest,
            pixelsAreLocal: { url in
                symlinkProbes.append(url)
                return true
            },
            registry: registry, sourceID: sourceID
        )
        check("parent and leaf symlinks never produce asset URLs",
              symlinkItems.allSatisfy { $0.state == .missing && $0.url == nil })
        check("even an in-root symlink is not treated as a declared member",
              symlinkItems[2].state == .missing && symlinkItems[2].url == nil)
        check("symlink members are rejected before metadata probing", symlinkProbes.isEmpty)
        for id in ["alias/outside.jpg", "leaf.jpg", "inside-link.jpg"] {
            expectRevealFailure("reveal refuses symlink member: \(id)", id: id)
        }
        expectBadRequest("reveal-style traversal id is rejected", requestArgs(["../dump-evil/outside.jpg"]))
        expectBadRequest("absolute renderer path is rejected", requestArgs([outsidePhoto.path]))

        // --- Reveal authorization ----------------------------------------
        let revealedLocal = try EventAssetSupport.reveal(
            root: verifiedRoot, id: "space # % é.jpg", imageExtensions: imageExtensions
        )
        check("reveal retains only the validated declared member",
              revealedLocal.path == specialURL.resolvingSymlinksInPath().standardizedFileURL.path)
        var revealSelections: [(String, String)] = []
        try EventAssetSupport.reveal(
            revealedLocal,
            confirmSource: { guard verifiedRoot.isStillCurrent() else { throw EventAssetSupportError.reselectionRequired } },
            select: { revealSelections.append(($0, $1)); return true }
        )
        check("reveal hands the retained member to the selector only after revalidation",
              revealSelections.count == 1 && revealSelections[0].0 == revealedLocal.path)
        let cloudSizeBefore = (try? FileManager.default.attributesOfItem(atPath: cloudURL.path)[.size] as? NSNumber)?.intValue
        let revealedCloud = try EventAssetSupport.reveal(
            root: verifiedRoot, id: "cloud.jpg", imageExtensions: imageExtensions
        )
        let cloudSizeAfter = (try? FileManager.default.attributesOfItem(atPath: cloudURL.path)[.size] as? NSNumber)?.intValue
        check("reveal permits a cloud placeholder without changing or reading its bytes",
              revealedCloud.path == cloudURL.resolvingSymlinksInPath().standardizedFileURL.path
                  && cloudSizeBefore == cloudSizeAfter && cloudSizeBefore == 512 * 1024)
        expectRevealFailure("reveal refuses a missing declared member", id: "absent.jpg")
        expectBadRequest("reveal rejects malformed id arguments", ["id": "../outside.jpg"])
        expectBadRequest("reveal rejects absolute id arguments", ["id": outsidePhoto.path])

        // --- Persisted root identity and legacy declarations ---------------
        let remembered = FolderStore.Entry(
            id: UUID(), name: "dump", bookmark: "", isRawDump: true,
            rawDumpRootIdentity: rootIdentity
        )
        let rememberedData = try JSONEncoder().encode(remembered)
        let rememberedAgain = try JSONDecoder().decode(FolderStore.Entry.self, from: rememberedData)
        check("raw-dump identity survives persistence",
              rememberedAgain.rawDumpRootIdentity == rootIdentity && rememberedAgain.isRawDump)
        let legacyJSON = Data("""
        [{"id":"\(UUID().uuidString)","name":"Legacy dump","bookmark":"","isRawDump":true}]
        """.utf8)
        let legacyStoreURL = temporary.appendingPathComponent("legacy-folders.json")
        try legacyJSON.write(to: legacyStoreURL)
        let legacyStore = FolderStore(fileURL: legacyStoreURL, configDir: temporary)
        check("legacy raw-dump declaration decodes but is not trusted",
              legacyStore.entries.count == 1 && legacyStore.entries[0].isRawDump
                  && legacyStore.entries[0].rawDumpRootIdentity == nil
                  && legacyStore.rawDumpEntry == nil)
        if let legacyEntry = legacyStore.entries.first {
            check("legacy declaration requires a fresh identity-bearing mark",
                  legacyStore.markRawDump(legacyEntry.id, identity: rootIdentity)
                      && legacyStore.rawDumpEntry?.rawDumpRootIdentity == rootIdentity)
            let reloaded = FolderStore(fileURL: legacyStoreURL, configDir: temporary)
            check("a reselected legacy root reloads as trusted",
                  reloaded.rawDumpEntry?.id == legacyEntry.id
                      && reloaded.rawDumpEntry?.rawDumpRootIdentity == rootIdentity)
        } else {
            check("legacy fixture decoded", false)
        }
        check("an unknown folder cannot be marked as the dump",
              !legacyStore.markRawDump(UUID(), identity: rootIdentity))

        // --- Whole selected-root replacement ------------------------------
        let replacedRoot = temporary.appendingPathComponent("replaced-root", isDirectory: true)
        try FileManager.default.createDirectory(at: replacedRoot, withIntermediateDirectories: true)
        guard let replacedIdentity = NativeFileIdentity(directoryAt: replacedRoot) else {
            throw NSError(domain: "EventAssetSupportTests", code: 3, userInfo: [NSLocalizedDescriptionKey: "missing replacement identity"])
        }
        let pinnedReplacedRoot = try EventAssetSupport.openRoot(replacedRoot, expected: replacedIdentity)
        let replacedPhoto = replacedRoot.appendingPathComponent("one.jpg")
        _ = try writeJPEG(to: replacedPhoto, width: 120, height: 90, orientation: 1)
        let replacedItem = try EventAssetSupport.item(
            root: pinnedReplacedRoot, id: "one.jpg", imageExtensions: imageExtensions,
            pixelsAreLocal: { _ in true }, registry: registry, sourceID: sourceID
        )
        guard let replacedCapability = replacedItem.url.flatMap(URL.init(string:)) else {
            throw NSError(domain: "EventAssetSupportTests", code: 4, userInfo: [NSLocalizedDescriptionKey: "missing root capability"])
        }
        let movedReplacedRoot = temporary.appendingPathComponent("replaced-root-old", isDirectory: true)
        try FileManager.default.moveItem(at: replacedRoot, to: movedReplacedRoot)
        try FileManager.default.createDirectory(at: replacedRoot, withIntermediateDirectories: true)
        _ = try writeJPEG(to: replacedPhoto, width: 121, height: 91, orientation: 1)
        check("whole-root replacement invalidates the pinned root", !pinnedReplacedRoot.isStillCurrent())
        expectReselection("whole-root replacement is rejected at open") {
            _ = try EventAssetSupport.openRoot(replacedRoot, expected: replacedIdentity)
        }
        expectReselection("whole-root replacement is rejected at scan") {
            _ = try FolderDumpScanner.enumerate(root: pinnedReplacedRoot)
        }
        expectReselection("whole-root replacement cannot write an event index") {
            _ = try RawDumpEventStore(configDir: temporary.appendingPathComponent("replaced-cache"))
                .scan(root: pinnedReplacedRoot, deviceId: "device", sourceId: "source", label: "dump", force: true)
        }
        check("whole-root replacement revokes descriptor delivery",
              registry.response(for: replacedCapability, method: "GET", range: nil).statusCode == 404)
        let declarationURL = temporary.appendingPathComponent("replaced-declaration.json")
        let declarationStore = FolderStore(fileURL: declarationURL, configDir: temporary)
        guard let declared = declarationStore.add(folder: replacedRoot) else {
            throw NSError(domain: "EventAssetSupportTests", code: 11, userInfo: [NSLocalizedDescriptionKey: "missing declaration fixture"])
        }
        check("declaration stores the originally pinned identity, not a later pathname",
              declarationStore.markRawDump(declared.id, identity: replacedIdentity))
        let declarationReloaded = FolderStore(fileURL: declarationURL, configDir: temporary)
        check("replacement does not rewrite the persisted selected identity",
              declarationReloaded.rawDumpEntry?.rawDumpRootIdentity == replacedIdentity)
        expectReselection("a replacement at the declared path cannot become the trusted root") {
            _ = try EventAssetSupport.openRoot(replacedRoot, expected: replacedIdentity)
        }
        let sameObjectAlias = temporary.appendingPathComponent("same-object-alias", isDirectory: true)
        try FileManager.default.createSymbolicLink(
            atPath: sameObjectAlias.path, withDestinationPath: movedReplacedRoot.path
        )
        check("a root symlink has no selectable directory identity",
              NativeFileIdentity(directoryAt: sameObjectAlias) == nil)
        do {
            _ = try EventAssetSupport.openRoot(sameObjectAlias, expected: replacedIdentity)
            check("a root alias cannot reauthorize the original object by pathname", false, "alias accepted")
        } catch {
            check("a root alias cannot reauthorize the original object by pathname", true)
        }

        // --- Leaf and ancestor replacement after authorization -------------
        let leafRoot = temporary.appendingPathComponent("leaf-root", isDirectory: true)
        try FileManager.default.createDirectory(at: leafRoot, withIntermediateDirectories: true)
        guard let leafRootIdentity = NativeFileIdentity(directoryAt: leafRoot) else {
            throw NSError(domain: "EventAssetSupportTests", code: 5, userInfo: [NSLocalizedDescriptionKey: "missing leaf root identity"])
        }
        let pinnedLeafRoot = try EventAssetSupport.openRoot(leafRoot, expected: leafRootIdentity)
        let leafPhoto = leafRoot.appendingPathComponent("one.jpg")
        _ = try writeJPEG(to: leafPhoto, width: 100, height: 80, orientation: 1)
        let leafItem = try EventAssetSupport.item(
            root: pinnedLeafRoot, id: "one.jpg", imageExtensions: imageExtensions,
            pixelsAreLocal: { _ in true }, registry: registry, sourceID: sourceID
        )
        guard let leafCapability = leafItem.url.flatMap(URL.init(string:)) else {
            throw NSError(domain: "EventAssetSupportTests", code: 6, userInfo: [NSLocalizedDescriptionKey: "missing leaf capability"])
        }
        let retainedLeaf = try EventAssetSupport.reveal(
            root: pinnedLeafRoot, id: "one.jpg", imageExtensions: imageExtensions
        )
        let leafReplacement = temporary.appendingPathComponent("leaf-replacement.jpg")
        try Data("replacement leaf".utf8).write(to: leafReplacement)
        check("leaf replacement fixture was installed", Darwin.rename(leafReplacement.path, leafPhoto.path) == 0)
        check("leaf replacement invalidates a retained member", !retainedLeaf.isStillCurrent())
        check("leaf replacement revokes descriptor delivery",
              registry.response(for: leafCapability, method: "GET", range: nil).statusCode == 404)
        var swappedLeafRevealCalled = false
        do {
            try EventAssetSupport.reveal(
                retainedLeaf,
                confirmSource: { guard pinnedLeafRoot.isStillCurrent() else { throw EventAssetSupportError.reselectionRequired } },
                select: { _, _ in swappedLeafRevealCalled = true; return true }
            )
            check("reveal rejects a post-authorization leaf swap", false, "selector accepted")
        } catch {
            check("reveal rejects a post-authorization leaf swap", !swappedLeafRevealCalled)
        }

        let ancestorRoot = temporary.appendingPathComponent("ancestor-root", isDirectory: true)
        let ancestorDirectory = ancestorRoot.appendingPathComponent("nested", isDirectory: true)
        try FileManager.default.createDirectory(at: ancestorDirectory, withIntermediateDirectories: true)
        guard let ancestorIdentity = NativeFileIdentity(directoryAt: ancestorRoot) else {
            throw NSError(domain: "EventAssetSupportTests", code: 7, userInfo: [NSLocalizedDescriptionKey: "missing ancestor root identity"])
        }
        let pinnedAncestorRoot = try EventAssetSupport.openRoot(ancestorRoot, expected: ancestorIdentity)
        let ancestorPhoto = ancestorDirectory.appendingPathComponent("one.jpg")
        _ = try writeJPEG(to: ancestorPhoto, width: 100, height: 80, orientation: 1)
        let ancestorItem = try EventAssetSupport.item(
            root: pinnedAncestorRoot, id: "nested/one.jpg", imageExtensions: imageExtensions,
            pixelsAreLocal: { _ in true }, registry: registry, sourceID: sourceID
        )
        guard let ancestorCapability = ancestorItem.url.flatMap(URL.init(string:)) else {
            throw NSError(domain: "EventAssetSupportTests", code: 8, userInfo: [NSLocalizedDescriptionKey: "missing ancestor capability"])
        }
        let retainedAncestor = try EventAssetSupport.reveal(
            root: pinnedAncestorRoot, id: "nested/one.jpg", imageExtensions: imageExtensions
        )
        let movedAncestor = ancestorRoot.appendingPathComponent("nested-old", isDirectory: true)
        try FileManager.default.moveItem(at: ancestorDirectory, to: movedAncestor)
        try FileManager.default.createDirectory(at: ancestorDirectory, withIntermediateDirectories: true)
        _ = try writeJPEG(to: ancestorPhoto, width: 101, height: 81, orientation: 1)
        check("ancestor replacement invalidates a retained member", !retainedAncestor.isStillCurrent())
        check("ancestor replacement revokes descriptor delivery",
              registry.response(for: ancestorCapability, method: "GET", range: nil).statusCode == 404)
        var swappedAncestorRevealCalled = false
        do {
            try EventAssetSupport.reveal(
                retainedAncestor,
                confirmSource: {},
                select: { _, _ in swappedAncestorRevealCalled = true; return true }
            )
            check("reveal rejects a post-authorization ancestor swap", false, "selector accepted")
        } catch {
            check("reveal rejects a post-authorization ancestor swap", !swappedAncestorRevealCalled)
        }

        let handoffRoot = temporary.appendingPathComponent("handoff-root", isDirectory: true)
        try FileManager.default.createDirectory(at: handoffRoot, withIntermediateDirectories: true)
        guard let handoffIdentity = NativeFileIdentity(directoryAt: handoffRoot) else {
            throw NSError(domain: "EventAssetSupportTests", code: 9, userInfo: [NSLocalizedDescriptionKey: "missing handoff root identity"])
        }
        let pinnedHandoffRoot = try EventAssetSupport.openRoot(handoffRoot, expected: handoffIdentity)
        let handoffPhoto = handoffRoot.appendingPathComponent("one.jpg")
        _ = try writeJPEG(to: handoffPhoto, width: 100, height: 80, orientation: 1)
        let handoffMember = try EventAssetSupport.reveal(
            root: pinnedHandoffRoot, id: "one.jpg", imageExtensions: imageExtensions
        )
        let handoffReplacement = temporary.appendingPathComponent("handoff-replacement.jpg")
        try Data("replacement at handoff".utf8).write(to: handoffReplacement)
        var handoffRevealCalled = false
        do {
            try EventAssetSupport.reveal(
                handoffMember,
                confirmSource: {
                    check("handoff replacement fixture was installed",
                          Darwin.rename(handoffReplacement.path, handoffPhoto.path) == 0)
                },
                select: { _, _ in handoffRevealCalled = true; return true }
            )
            check("reveal revalidates immediately before the selector", false, "selector accepted")
        } catch {
            check("reveal revalidates immediately before the selector", !handoffRevealCalled)
        }

        // --- Opaque URL validation -----------------------------------------
        guard let originalCapability = ordered[0].url.flatMap(URL.init(string:)),
              let originalToken = EventAssetRegistry.token(from: originalCapability) else {
            throw NSError(domain: "EventAssetSupportTests", code: 10, userInfo: [NSLocalizedDescriptionKey: "missing original capability"])
        }
        check("capability token is a 128-bit hexadecimal lease",
              originalToken.utf8.count == 32
                  && originalToken.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) })
        let malformedEventURLs = [
            "manorama-event://evil/\(originalToken)",
            "manorama-event://localhost/\(originalToken)/extra",
            "manorama-event://localhost//\(originalToken)",
            "manorama-event://localhost/\(originalToken)?download=1",
            "manorama-event://localhost/\(originalToken)?",
            "manorama-event://localhost/\(originalToken)#fragment",
            "manorama-event://localhost:443/\(originalToken)",
            "manorama-event://user@localhost/\(originalToken)",
            "manorama-event://localhost/%2e%2e",
            "manorama-event://localhost/\(String(originalToken.dropLast()))%2e",
            "manorama-event://localhost/\(String(repeating: "A", count: 31))",
            "manorama-event://localhost/\(String(repeating: "g", count: 32))",
            "manorama-event://localhost/\(originalToken)/",
            "file://localhost/\(originalToken)",
            "manorama://localhost/\(originalToken)",
            "https://localhost/\(originalToken)",
        ]
        check("opaque URL validation rejects authority, path, query and fragment variants",
              malformedEventURLs.allSatisfy { value in
                  guard let url = URL(string: value) else { return true }
                  return EventAssetRegistry.token(from: url) == nil
                      && registry.response(for: url, method: "GET", range: nil).statusCode == 404
              })

        // --- GET, HEAD, Range and cache policy -----------------------------
        let full = registry.response(for: originalCapability, method: "GET", range: nil)
        check("GET serves the exact original bytes", full.statusCode == 200 && full.body == specialBytes)
        check("event responses are private and never stored",
              full.headers["Cache-Control"] == "private, no-store"
                  && full.headers["X-Content-Type-Options"] == "nosniff"
                  && full.headers["Content-Type"] == "image/jpeg",
              full.headers.description)
        let head = registry.response(for: originalCapability, method: "HEAD", range: nil)
        check("HEAD returns full metadata without a body",
              head.statusCode == 200 && head.body.isEmpty
                  && head.headers["Content-Length"] == "\(specialBytes.count)"
                  && head.headers["Cache-Control"] == "private, no-store")
        let bounded = registry.response(for: originalCapability, method: "GET", range: "bytes=3-8")
        check("bounded Range returns the requested original slice",
              bounded.statusCode == 206 && bounded.body == specialBytes.subdata(in: 3..<9)
                  && bounded.headers["Content-Range"] == "bytes 3-8/\(specialBytes.count)"
                  && bounded.headers["Content-Length"] == "6")
        let suffix = registry.response(for: originalCapability, method: "GET", range: "bytes=-11")
        check("suffix Range returns the tail", suffix.statusCode == 206
              && suffix.body == specialBytes.suffix(11)
                  && suffix.headers["Content-Range"] == "bytes \(specialBytes.count - 11)-\(specialBytes.count - 1)/\(specialBytes.count)")
        let openEnded = registry.response(for: originalCapability, method: "GET", range: "bytes=\(specialBytes.count - 5)-")
        check("open-ended Range returns the tail", openEnded.statusCode == 206
              && openEnded.body == specialBytes.suffix(5))
        let headRange = registry.response(for: originalCapability, method: "HEAD", range: "bytes=0-0")
        check("HEAD honours Range without a body", headRange.statusCode == 206 && headRange.body.isEmpty
              && headRange.headers["Content-Range"] == "bytes 0-0/\(specialBytes.count)")
        for invalidRange in ["items=0-1", "bytes=8-3", "bytes=0-1,3-4", "bytes=abc", "bytes=-0"] {
            let invalid = registry.response(for: originalCapability, method: "GET", range: invalidRange)
            check("malformed Range is rejected: \(invalidRange)",
                  invalid.statusCode == 416 && invalid.body.isEmpty
                      && invalid.headers["Content-Range"] == "bytes */\(specialBytes.count)"
                      && invalid.headers["Cache-Control"] == "private, no-store")
        }
        let unsatisfiable = registry.response(
            for: originalCapability, method: "GET", range: "bytes=\(specialBytes.count)-"
        )
        check("unsatisfiable Range reports the original size",
              unsatisfiable.statusCode == 416 && unsatisfiable.body.isEmpty
                  && unsatisfiable.headers["Content-Range"] == "bytes */\(specialBytes.count)")
        let unsupported = registry.response(for: originalCapability, method: "POST", range: nil)
        check("only GET and HEAD are allowed", unsupported.statusCode == 405
              && unsupported.headers["Allow"] == "GET, HEAD" && unsupported.body.isEmpty)
        let unknown = registry.response(
            for: URL(string: "manorama-event://localhost/\(String(repeating: "b", count: 32))")!,
            method: "GET", range: nil
        )
        check("unknown capabilities fail closed", unknown.statusCode == 404 && unknown.body.isEmpty)
        let handler = LocalSchemeHandler(bundleRoot: temporary, eventAssets: registry)
        var headRequest = URLRequest(url: originalCapability)
        headRequest.httpMethod = "HEAD"
        let handlerHead = handler.eventAssetResponse(for: headRequest)
        check("scheme handler exposes HEAD without a body",
              handlerHead.statusCode == 200 && handlerHead.body.isEmpty
                  && handlerHead.headers["Cache-Control"] == "private, no-store")
        var rangeRequest = URLRequest(url: originalCapability)
        rangeRequest.setValue("bytes=0-1", forHTTPHeaderField: "Range")
        let handlerRange = handler.eventAssetResponse(for: rangeRequest)
        check("scheme handler forwards bounded Range semantics",
              handlerRange.statusCode == 206 && handlerRange.body == specialBytes.prefix(2))

        let configuration = ViewerWebView.makeConfiguration(
            schemeHandler: handler,
            coordinator: ViewerCoordinator()
        )
        let protocolWebView = WKWebView(frame: .zero, configuration: configuration)
        check("production WKWebView configuration registers the event scheme",
              protocolWebView.configuration.urlSchemeHandler(forURLScheme: "manorama-event") === handler
                  && protocolWebView.configuration.urlSchemeHandler(forURLScheme: "manorama") === handler)
        let probe = EventProtocolProbe()
        protocolWebView.navigationDelegate = probe
        protocolWebView.load(URLRequest(url: originalCapability))
        let deadline = Date().addingTimeInterval(15)
        var protocolResult = probe.snapshot()
        while !protocolResult.completed && Date() < deadline {
            RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.05))
            protocolResult = probe.snapshot()
        }
        protocolWebView.stopLoading()
        check("real WKWebView serves the unchanged original through the event scheme",
              protocolResult.completed && protocolResult.dimensions == "320x240",
              String(describing: protocolResult))

        // --- Registry bounds and revocation --------------------------------
        _ = revealedLocal.readHeaderPrefix()
        let boundedRegistry = EventAssetRegistry(capacity: 2)
        let first = try boundedRegistry.issue(revealedLocal, sourceID: sourceID)
        _ = try boundedRegistry.issue(revealedLocal, sourceID: sourceID)
        let third = try boundedRegistry.issue(revealedLocal, sourceID: sourceID)
        check("registry evicts its oldest capability at capacity",
              boundedRegistry.count == 2
                  && boundedRegistry.response(for: first, method: "GET", range: nil).statusCode == 404
                  && boundedRegistry.response(for: third, method: "GET", range: nil).statusCode == 200)
        boundedRegistry.revokeSource(UUID())
        check("revoking another source leaves capabilities intact",
              boundedRegistry.response(for: third, method: "GET", range: nil).statusCode == 200)
        boundedRegistry.revokeSource(sourceID)
        boundedRegistry.revokeAll()
        check("source revocation and teardown remove every capability",
              boundedRegistry.count == 0
                  && boundedRegistry.response(for: third, method: "GET", range: nil).statusCode == 404)

        // --- Bounded headers and EXIF orientation ------------------------
        for orientation in 1...8 {
            let url = root.appendingPathComponent("orientation-\(orientation).jpg")
            _ = try writeJPEG(to: url, width: 640, height: 480, orientation: orientation)
            let bytes = try Data(contentsOf: url)
            let dimensions = EventAssetSupport.headerDimensions(bytes)
            let expected = (5...8).contains(orientation) ? (480, 640) : (640, 480)
            check("header dimensions respect EXIF orientation \(orientation)",
                  dimensions?.width == expected.0 && dimensions?.height == expected.1,
                  "got \(String(describing: dimensions))")
        }
        check("malformed header fails closed", EventAssetSupport.headerDimensions(Data("not an image".utf8)) == nil)
        var zeroPNG = Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0x0D, 0x49, 0x48, 0x44, 0x52])
        zeroPNG.append(contentsOf: [UInt8](repeating: 0, count: 13))
        check("zero-sized image header fails closed", EventAssetSupport.headerDimensions(zeroPNG) == nil)

        let largeURL = temporary.appendingPathComponent("large-prefix.bin")
        try Data(repeating: 0x5A, count: EventAssetSupport.headerByteLimit + 123).write(to: largeURL)
        let fileFD = open(largeURL.path, O_RDONLY)
        if fileFD >= 0 {
            let prefix = EventAssetSupport.readHeaderPrefix(fileFD: fileFD)
            _ = close(fileFD)
            check("header read is capped at 4 MiB", prefix?.count == EventAssetSupport.headerByteLimit,
                  "got \(prefix?.count ?? -1)")
        } else {
            check("header read is capped at 4 MiB", false, "open failed")
        }

        print(failures == 0 ? "\nALL PASS" : "\n\(failures) FAILURE(S)")
        exit(failures == 0 ? 0 : 1)
    }

    private static func writeJPEG(to url: URL, width: Int, height: Int, orientation: Int) throws -> Data {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        guard let space = CGColorSpace(name: CGColorSpace.sRGB),
              let context = CGContext(
                data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
              ) else {
            throw NSError(domain: "EventAssetSupportTests", code: 1, userInfo: [NSLocalizedDescriptionKey: "fixture context failed"])
        }
        context.setFillColor(CGColor(red: 0.5, green: 0.5, blue: 0.5, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        guard let image = context.makeImage() else {
            throw NSError(domain: "EventAssetSupportTests", code: 1, userInfo: [NSLocalizedDescriptionKey: "fixture image failed"])
        }
        guard let destination = CGImageDestinationCreateWithURL(
            url as CFURL, "public.jpeg" as CFString, 1, nil
        ) else {
            throw NSError(domain: "EventAssetSupportTests", code: 2, userInfo: [NSLocalizedDescriptionKey: "fixture destination failed"])
        }
        CGImageDestinationAddImage(
            destination, image, [kCGImagePropertyOrientation as String: orientation] as CFDictionary
        )
        guard CGImageDestinationFinalize(destination) else {
            throw NSError(domain: "EventAssetSupportTests", code: 3, userInfo: [NSLocalizedDescriptionKey: "fixture finalize failed"])
        }
        return try Data(contentsOf: url)
    }
}
