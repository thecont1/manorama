import Foundation
import WebKit

/// A headless exercise of the boundary layers, so the persistence and
/// media guarantees are proved without a window in the way.
///
/// What it checks, in order:
///
///  1. **Bookmark round-trip** — a picked folder survives being written to
///     disk and read back in a *fresh* store. This is the persistent access
///     guarantee, and the only honest way to test it is across a
///     re-instantiation boundary.
///  2. **Scope semantics** — whether `startAccessingSecurityScopedResource`
///     reports true (sandboxed) or false (unsandboxed, access is implicit).
///     The answer changes what the shell must do for a missing folder.
///  3. **Media resolution** — the resolver serves a real JPEG, refuses a
///     path outside the granted root, and distinguishes "gone" from
///     "forbidden".
///  4. **Error recovery** — after the folder is deleted, the bookmark
///     stops resolving and the gallery is reported unavailable rather than
///     crashing.
///
/// Run:
///   swiftc -O macos/ManoramaMac/{LocalGallery,FolderStore,LocalSchemeHandler}.swift \
///     macos/BoundaryTests/{BoundaryTests,main}.swift \
///     -framework AppKit -framework WebKit -o /tmp/boundary && /tmp/boundary
final class BoundaryTests {
    /// The entry point — `main` has to be a top-level symbol for the
    /// linker, so the work lives in `run()`.
    static func main() {
        run()
    }

    static func run() {
        var failures = 0
        func check(_ label: String, _ condition: Bool, _ detail: String = "") {
            if condition {
                print("PASS  \(label)")
            } else {
                print("FAIL  \(label) \(detail)")
                failures += 1
            }
        }

        // A fixture folder with real images.
        let fixture = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("manorama-boundary-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: fixture, withIntermediateDirectories: true)

        let sources = [
            "/System/Library/CoreServices/DefaultDesktop.heic",
            "/System/Library/Desktop Pictures/.thumbnails/Valley Light.heic",
        ]
        var made = 0
        for (index, path) in sources.enumerated() {
            let target = fixture.appendingPathComponent("photo\(index).jpg")
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/usr/bin/sips")
            process.arguments = ["-s", "format", "jpeg", "-Z", "800", path, "--out", target.path]
            process.standardOutput = FileHandle.nullDevice
            process.standardError = FileHandle.nullDevice
            try? process.run()
            process.waitUntilExit()
            if FileManager.default.fileExists(atPath: target.path) { made += 1 }
        }
        check("fixture has real images", made >= 1, "made=\(made)")

        // --- 1. Bookmark round-trip -------------------------------------
        let bookmark: Data
        do {
            bookmark = try ScopedFolder.makeBookmark(for: fixture)
            check("bookmark created", bookmark.count > 0)
        } catch {
            print("FAIL  bookmark created — \(error)")
            exit(1)
        }
        check("bookmark resolves immediately",
              ScopedFolder.resolve(bookmark)?.url.standardizedFileURL.path == fixture.standardizedFileURL.path)

        // The store lives in Application Support in the real app — beside
        // the galleries, never inside one. The fixture mirrors that: the
        // store's file must survive the gallery folder being deleted.
        let storeFile = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("manorama-boundary-store-\(UUID().uuidString).json")
        let store = FolderStore(fileURL: storeFile)
        guard store.add(folder: fixture) != nil else {
            print("FAIL  folder added to store")
            exit(1)
        }
        check("folder recorded", store.entries.count == 1)

        // A second store instance reading the same file is the "relaunch"
        // case: nothing in memory carries over.
        let reopened = FolderStore(fileURL: storeFile)
        check("entry survives reload", reopened.entries.count == 1)
        let resolved = reopened.entries.first.flatMap { reopened.resolve($0) }
        check("bookmark resolves after reload", resolved != nil)
        check("resolved path is the same folder",
              resolved?.standardizedFileURL.path == fixture.standardizedFileURL.path,
              "got \(resolved?.path ?? "nil")")

        // --- 2. Scope semantics -----------------------------------------
        var scopeStarted = false
        if let live = reopened.entries.first, let url = reopened.startAccess(live) {
            check("scope yields a usable URL", url.standardizedFileURL.path == fixture.standardizedFileURL.path)
            let readable = FileManager.default.fileExists(atPath: url.appendingPathComponent("photo0.jpg").path)
            check("original is readable through the scope", readable)
            scopeStarted = url.startAccessingSecurityScopedResource()
        } else {
            check("scope yields a usable URL", false, "startAccess returned nil")
        }
        // An unsandboxed app gets no scoped resource to start — access is
        // implicit. A sandboxed one gets a real scope. The shell must work
        // in both cases, so this is reported, not asserted.
        print("INFO  startAccessingSecurityScopedResource → \(scopeStarted) (false = unsandboxed, access is implicit)")

        // --- 3. Media resolution ----------------------------------------
        let bundleRoot = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("manorama-bundle-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: bundleRoot, withIntermediateDirectories: true)
        try? "hello".write(to: bundleRoot.appendingPathComponent("index.html"), atomically: true, encoding: .utf8)

        let resolver = LocalMediaResolver(bundleRoot: bundleRoot)
        let token = "test-token"
        resolver.grant(token: token, url: fixture)

        let served = resolver.resolve(URL(string: "manorama://media/\(token)/photo0.jpg")!)
        if case .file(let fileURL, let mime) = served {
            check("media file resolves", fileURL.lastPathComponent == "photo0.jpg")
            check("media mime is an image", mime.hasPrefix("image/"), mime)
            check("media bytes are readable", ((try? Data(contentsOf: fileURL).count) ?? 0) > 0)
        } else {
            check("media file resolves", false, "got \(served)")
        }

        // Outside the granted root — the traversal guard.
        let escaped = resolver.resolve(URL(string: "manorama://media/\(token)/../../etc/passwd")!)
        check("traversal outside the root is refused", isRefusal(escaped), "got \(escaped)")

        // A legitimate name containing consecutive dots is not a traversal.
        let dotfile = fixture.appendingPathComponent("photo..5.jpg")
        try? Data([0xFF, 0xD8]).write(to: dotfile)
        let dotted = resolver.resolve(URL(string: "manorama://media/\(token)/photo..5.jpg")!)
        if case .file = dotted {
            check("a filename with consecutive dots resolves", true)
        } else {
            check("a filename with consecutive dots resolves", false, "got \(dotted)")
        }

        // A symlink inside the root pointing outside it must not serve —
        // the standardised path keeps the link, so only a resolved check
        // catches this.
        let outsideDir = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("manorama-outside-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: outsideDir, withIntermediateDirectories: true)
        try? Data([0x01]).write(to: outsideDir.appendingPathComponent("x.jpg"))
        let escapeLink = fixture.appendingPathComponent("escape")
        try? FileManager.default.createSymbolicLink(at: escapeLink, withDestinationURL: outsideDir)
        let symlinked = resolver.resolve(URL(string: "manorama://media/\(token)/escape/x.jpg")!)
        check("escaping symlink is refused", isRefusal(symlinked), "got \(symlinked)")

        // A sibling directory whose name shares the root's prefix must not
        // satisfy containment — the check is on resolved components, never
        // a raw string prefix.
        let sibling = fixture.deletingLastPathComponent()
            .appendingPathComponent("\(fixture.lastPathComponent)-sibling")
        try? FileManager.default.createDirectory(at: sibling, withIntermediateDirectories: true)
        try? Data([0x01]).write(to: sibling.appendingPathComponent("x.jpg"))
        let siblingLink = fixture.appendingPathComponent("sneak")
        try? FileManager.default.createSymbolicLink(at: siblingLink, withDestinationURL: sibling)
        let prefixed = resolver.resolve(URL(string: "manorama://media/\(token)/sneak/x.jpg")!)
        check("prefix-sharing sibling is refused", isRefusal(prefixed), "got \(prefixed)")

        // --- 3b. The absolute-path form the shell actually serves ---------
        // The app's own asset URLs address a file by its absolute path —
        // the catalogue knows where the photograph is. The shell answers
        // them only when the path really is inside a root the user
        // granted, and refuses everything else.
        resolver.grantedRoots = { [fixture] }
        let absoluteInside = resolver.resolve(
            URL(string: "manorama://media/local/\(fixture.appendingPathComponent("photo0.jpg").path.addingPercentEncoding(withAllowedCharacters: .alphanumerics)!)")!
        )
        if case .file(let fileURL, let mime) = absoluteInside {
            check("an absolute path inside a granted root resolves", fileURL.lastPathComponent == "photo0.jpg")
            check("an absolute path keeps its mime", mime.hasPrefix("image/"), mime)
        } else {
            check("an absolute path inside a granted root resolves", false, "got \(absoluteInside)")
        }

        let absoluteOutside = resolver.resolve(
            URL(string: "manorama://media/local/\(outsideDir.appendingPathComponent("x.jpg").path.addingPercentEncoding(withAllowedCharacters: .alphanumerics)!)")!
        )
        check("an absolute path outside every granted root is refused",
              isRefusal(absoluteOutside), "got \(absoluteOutside)")

        let absoluteTraversal = resolver.resolve(
            URL(string: "manorama://media/local/\(fixture.appendingPathComponent("../../etc/passwd").path.addingPercentEncoding(withAllowedCharacters: .alphanumerics)!)")!
        )
        check("an absolute path cannot traverse out of a granted root",
              isRefusal(absoluteTraversal), "got \(absoluteTraversal)")

        // A symlink inside the granted root that points out of it. The
        // absolute form resolves symlinks before it compares, so the link
        // is caught the same way the token form catches it.
        let absoluteSymlink = resolver.resolve(
            URL(string: "manorama://media/local/\(escapeLink.appendingPathComponent("x.jpg").path.addingPercentEncoding(withAllowedCharacters: .alphanumerics)!)")!
        )
        check("an absolute path through an escaping symlink is refused",
              isRefusal(absoluteSymlink), "got \(absoluteSymlink)")

        // A file inside the granted root that is not there: the URL is
        // well-formed and permitted, and the file is simply absent. The
        // read is what fails, and the shell says so.
        let absoluteMissing = resolver.resolve(
            URL(string: "manorama://media/local/\(fixture.appendingPathComponent("nope.jpg").path.addingPercentEncoding(withAllowedCharacters: .alphanumerics)!)")!
        )
        if case .file(let fileURL, _) = absoluteMissing {
            check("an absolute path to a missing file resolves to nothing",
                  !FileManager.default.fileExists(atPath: fileURL.path))
        } else {
            check("an absolute path to a missing file resolves", false, "got \(absoluteMissing)")
        }

        try? FileManager.default.removeItem(at: escapeLink)
        try? FileManager.default.removeItem(at: siblingLink)
        try? FileManager.default.removeItem(at: outsideDir)
        try? FileManager.default.removeItem(at: sibling)

        // A well-formed path to a file that is not there.
        let missing = resolver.resolve(URL(string: "manorama://media/\(token)/nope.jpg")!)
        if case .file(let fileURL, _) = missing {
            check("missing file resolves to a path that does not exist",
                  !FileManager.default.fileExists(atPath: fileURL.path))
        } else {
            check("missing file resolves to a path", false, "got \(missing)")
        }

        // An unknown token.
        let ungranted = resolver.resolve(URL(string: "manorama://media/other-token/photo0.jpg")!)
        check("ungranted token is refused", isRefusal(ungranted), "got \(ungranted)")

        // The bundle prefix.
        let page = resolver.resolve(URL(string: "manorama://localhost/index.html")!)
        if case .file(let fileURL, let mime) = page {
            check("bundle file resolves", fileURL.lastPathComponent == "index.html")
            check("bundle mime is html", mime.hasPrefix("text/html"), mime)
        } else {
            check("bundle file resolves", false, "got \(page)")
        }

        // A traversal out of the bundle root.
        let bundleEscape = resolver.resolve(URL(string: "manorama://localhost/../../../etc/passwd")!)
        check("traversal out of the bundle is refused", isRefusal(bundleEscape), "got \(bundleEscape)")

        // --- 4. Error recovery ------------------------------------------
        // The folder goes away underneath the app.
        let resolvedFixtureBeforeDelete = fixture.resolvingSymlinksInPath()
        resolver.grantedRoots = { [resolvedFixtureBeforeDelete] }
        try? FileManager.default.removeItem(at: fixture)
        let absoluteAfterFolderDelete = resolver.resolve(
            URL(string: "manorama://media/local/\(fixture.appendingPathComponent("photo0.jpg").path.addingPercentEncoding(withAllowedCharacters: .alphanumerics)!)")!
        )
        if case .file(let fileURL, _) = absoluteAfterFolderDelete {
            check("deleted /tmp folder still matches /private/tmp grant so read reports gone (404), not forbidden (403)",
                  !FileManager.default.fileExists(atPath: fileURL.path))
        } else {
            check("deleted /tmp folder still matches /private/tmp grant so read reports gone (404), not forbidden (403)",
                  false, "got \(absoluteAfterFolderDelete)")
        }
        let afterDelete = FolderStore(fileURL: storeFile)
        check("folder reported unavailable after deletion",
              afterDelete.entries.first?.isAvailable == false,
              "isAvailable=\(String(describing: afterDelete.entries.first?.isAvailable))")
        check("no gallery is built from a dead folder", afterDelete.availableFolders().isEmpty)

        // The token is revoked once the scope is released.
        resolver.revoke(token: token)
        let afterRelease = resolver.resolve(URL(string: "manorama://media/\(token)/photo0.jpg")!)
        check("released token stops resolving", isRefusal(afterRelease), "got \(afterRelease)")

        // --- 5. A stopped task is never answered -------------------------
        // The proxy answers on the main queue after a URLSession round
        // trip. WebKit delivers stop on that same queue, so a task the
        // page abandoned must be silent once its completion lands —
        // answering it throws and takes the app down. The control task
        // proves the completion pipeline ran in this window; without it
        // the stopped task's silence could be a slow network, not the
        // guard. No network reachability means the check is skipped
        // rather than failed: the guard cannot be exercised without the
        // round trip.
        let handler = LocalSchemeHandler(bundleRoot: bundleRoot)
        let webView = WKWebView()
        let apiRequest = URLRequest(url: URL(string: "manorama://localhost/api/galleries")!)

        let control = RecordingSchemeTask(request: apiRequest)
        handler.webView(webView, start: control)
        let deadline = Date().addingTimeInterval(15)
        while !control.answered, Date() < deadline {
            RunLoop.main.run(until: Date().addingTimeInterval(0.05))
        }
        if !control.answered {
            print("INFO  api proxy unreachable — stopped-task check skipped")
        } else {
            check("proxy answers a live task", control.finished || control.failed)

            let stopped = RecordingSchemeTask(request: apiRequest)
            handler.webView(webView, start: stopped)
            handler.webView(webView, stop: stopped)
            let quietDeadline = Date().addingTimeInterval(10)
            while Date() < quietDeadline {
                RunLoop.main.run(until: Date().addingTimeInterval(0.05))
            }
            check("stopped task is never answered", !stopped.answered,
                  "answered=\(stopped.answerSummary)")
        }

        // --- 6. Opener & HTTP capability scopes and OAuth loopback ------
        check("opener allows https URL", NativeCapabilities.isAllowedOpenerURL("https://manorama.xyz/privacy") != nil)
        check("opener allows localhost:5173 dev URL", NativeCapabilities.isAllowedOpenerURL("http://localhost:5173/.dev-seed/desktop-login") != nil)
        check("opener allows 127.0.0.1:5173 dev URL", NativeCapabilities.isAllowedOpenerURL("http://127.0.0.1:5173/.dev-seed/desktop-login") != nil)
        check("opener allows mailto URL", NativeCapabilities.isAllowedOpenerURL("mailto:mahesh@thecontrarian.in?subject=Manorama") != nil)
        check("opener refuses file URL", NativeCapabilities.isAllowedOpenerURL("file:///etc/passwd") == nil)
        check("opener refuses arbitrary http URL", NativeCapabilities.isAllowedOpenerURL("http://example.com/") == nil)

        check("http capability allows proton.me", NativeCapabilities.isAllowedHttpURL("https://drive-api.proton.me/drive/urls/abc") != nil)
        check("http capability allows protonvpn.com", NativeCapabilities.isAllowedHttpURL("https://api.protonvpn.com/test") != nil)
        check("http capability refuses non-proton host", NativeCapabilities.isAllowedHttpURL("https://example.com/api") == nil)
        check("http capability refuses plain http proton", NativeCapabilities.isAllowedHttpURL("http://drive-api.proton.me/drive") == nil)

        let loopback = OAuthLoopbackServer()
        if let port = try? loopback.begin() {
            check("loopback binds an ephemeral port", port > 0)
            var finishedTarget: String?
            var finishedError: Error?
            let finishDone = DispatchSemaphore(value: 0)
            Task {
                do {
                    finishedTarget = try await loopback.finish(timeout: 5)
                } catch {
                    finishedError = error
                }
                finishDone.signal()
            }

            // 1) A stray probe (e.g. /favicon.ico) must receive 400 and NOT consume the listener.
            if let badURL = URL(string: "http://127.0.0.1:\(port)/favicon.ico") {
                let badDone = DispatchSemaphore(value: 0)
                var badStatus = 0
                URLSession.shared.dataTask(with: badURL) { _, resp, _ in
                    badStatus = (resp as? HTTPURLResponse)?.statusCode ?? 0
                    badDone.signal()
                }.resume()
                _ = badDone.wait(timeout: .now() + 2)
                check("stray request on loopback gets 400", badStatus == 400, "status=\(badStatus)")
            }

            // 2) The real OAuth redirect gets 200 and resolves finish() with the target.
            if let goodURL = URL(string: "http://127.0.0.1:\(port)/?code=abc123&state=xyz789") {
                let goodDone = DispatchSemaphore(value: 0)
                var goodStatus = 0
                URLSession.shared.dataTask(with: goodURL) { _, resp, _ in
                    goodStatus = (resp as? HTTPURLResponse)?.statusCode ?? 0
                    goodDone.signal()
                }.resume()
                _ = goodDone.wait(timeout: .now() + 2)
                check("oauth redirect on loopback gets 200", goodStatus == 200, "status=\(goodStatus)")
            }

            _ = finishDone.wait(timeout: .now() + 3)
            check("loopback finish returns OAuth request target",
                  finishedTarget == "/?code=abc123&state=xyz789",
                  "got \(String(describing: finishedTarget)) err=\(String(describing: finishedError))")
        } else {
            check("loopback binds an ephemeral port", false, "begin() threw")
        }

        // 3) Cancelling an in-flight loopback listener releases finish().
        if (try? loopback.begin()) != nil {
            var cancelError: Error?
            let cancelDone = DispatchSemaphore(value: 0)
            Task {
                do {
                    _ = try await loopback.finish(timeout: 5)
                } catch {
                    cancelError = error
                }
                cancelDone.signal()
            }
            usleep(100_000)
            loopback.cancel()
            _ = cancelDone.wait(timeout: .now() + 2)
            check("cancelled loopback listener rejects finish()", cancelError != nil)
        }

        // --- 7. Unified provenance, 0600 permissions, and vault_log rotation ---
        let testConfigDir = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("manorama-config-\(UUID().uuidString)", isDirectory: true)
        let tauriPickedDir = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("manorama-tauri-picked-\(UUID().uuidString)", isDirectory: true)
        let missingPickedDir = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("manorama-missing-picked-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: testConfigDir, withIntermediateDirectories: true)
        try? FileManager.default.createDirectory(at: tauriPickedDir, withIntermediateDirectories: true)

        // Pre-seed roots.json with one real Tauri-picked directory and one vanished directory.
        let preseededRoots = [tauriPickedDir.path, missingPickedDir.path]
        if let rootsData = try? JSONSerialization.data(withJSONObject: preseededRoots) {
            try? NativeBridge.write0600(to: testConfigDir.appendingPathComponent("roots.json"), data: rootsData)
        }
        let rootsPerms = (try? FileManager.default.attributesOfItem(atPath: testConfigDir.appendingPathComponent("roots.json").path)[.posixPermissions] as? Int) ?? 0
        check("roots.json written at mode 0600", (rootsPerms & 0o777) == 0o600, "perms=\(String(rootsPerms, radix: 8))")

        let bridgeStore = FolderStore(fileURL: testConfigDir.appendingPathComponent("folders.json"), configDir: testConfigDir)
        let bridgeGranted = GrantedRoots()
        var adoptedCount = 0
        var grantedCount = 0
        var grantedContainsMissing = true
        MainActor.assumeIsolated {
            let bridge = NativeBridge(folderStore: bridgeStore, grantedRoots: bridgeGranted, configDir: testConfigDir)
            try? bridge.registerSavedGalleryRoots()
            adoptedCount = bridgeStore.entries.count
            let urls = bridgeGranted.all().map { $0.standardizedFileURL.path }
            grantedCount = urls.count
            grantedContainsMissing = urls.contains(missingPickedDir.standardizedFileURL.path)

            // Legacy vault-debug.log cleanup and 512 KB rotation
            let legacyLog = testConfigDir.appendingPathComponent("vault-debug.log")
            try? Data("legacy".utf8).write(to: legacyLog)
            let vaultLog = testConfigDir
                .appendingPathComponent("manorama-vault-v1", isDirectory: true)
                .appendingPathComponent("vault-debug.log")
            try? FileManager.default.createDirectory(at: vaultLog.deletingLastPathComponent(), withIntermediateDirectories: true)
            let oversizedData = Data(repeating: 0x61, count: NativeBridge.vaultLogMaxBytes + 1024)
            try? oversizedData.write(to: vaultLog)

            try? bridge.appendVaultLog("after-rotation")
            check("legacy vault-debug.log outside vault root is removed", !FileManager.default.fileExists(atPath: legacyLog.path))
            let newLogSize = (try? FileManager.default.attributesOfItem(atPath: vaultLog.path)[.size] as? Int) ?? 0
            check("oversized vault-debug.log is rotated below cap", newLogSize > 0 && newLogSize < 1024, "size=\(newLogSize)")
            let logPerms = (try? FileManager.default.attributesOfItem(atPath: vaultLog.path)[.posixPermissions] as? Int) ?? 0
            check("rotated vault-debug.log has mode 0600", (logPerms & 0o777) == 0o600, "perms=\(String(logPerms, radix: 8))")
            check("device_label resolves non-empty", !NativeBridge.resolveDeviceLabel().isEmpty)
        }
        check("Tauri-picked existing root is adopted into FolderStore", adoptedCount == 1, "adopted=\(adoptedCount)")
        check("only reachable roots enter GrantedRoots", grantedCount == 1 && !grantedContainsMissing, "granted=\(grantedCount)")

        try? FileManager.default.removeItem(at: testConfigDir)
        try? FileManager.default.removeItem(at: tauriPickedDir)

        // --- Summary ----------------------------------------------------
        print(failures == 0 ? "\nALL PASS" : "\n\(failures) FAILURE(S)")
        exit(failures == 0 ? 0 : 1)
    }

    static func isRefusal(_ resolution: LocalMediaResolver.Resolution) -> Bool {
        if case .forbidden = resolution { return true }
        return false
    }
}

/// A `WKURLSchemeTask` that records every answer instead of delivering one.
///
/// WebKit's real task object throws when a stopped task is answered — that
/// throw is the crash this suite's stopped-task check guards. The fake
/// cannot reproduce the throw itself, but it does prove the handler's own
/// ordering: a task recorded as stopped receives no response, no data, no
/// finish, and no failure once its completion lands.
final class RecordingSchemeTask: NSObject, WKURLSchemeTask {
    let request: URLRequest
    private(set) var receivedResponse = false
    private(set) var receivedData = 0
    private(set) var finished = false
    private(set) var failed = false

    init(request: URLRequest) {
        self.request = request
    }

    var answered: Bool { receivedResponse || receivedData > 0 || finished || failed }
    var answerSummary: String {
        "response=\(receivedResponse) data=\(receivedData) finished=\(finished) failed=\(failed)"
    }

    func didReceive(_ response: URLResponse) { receivedResponse = true }
    func didReceive(_ data: Data) { receivedData += data.count }
    func didFinish() { finished = true }
    func didFailWithError(_ error: Error) { failed = true }
}
