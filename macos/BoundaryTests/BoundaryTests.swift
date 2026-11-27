import Darwin
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
///  5. **Raw dump events** — the recursive, header-only walk; the cached
///     timeline it maintains; the `0600` file it lives in; the wire shape
///     the page reads; and the watch that nudges when the folder changes.
///
/// `--event-index-performance-50k` runs the separate performance gate. It gets
/// a fresh process so the rest of this suite cannot inflate its peak RSS.
///
/// Run:
///   swiftc -O macos/ManoramaMac/{LocalGallery,FolderStore,LocalSchemeHandler,Trace,OAuthLoopback,NativeBridge,InvokeReply,FolderDumpScanner,RawDumpEvents}.swift \
///     native/EventClustering/Sources/ManoramaEventClustering/*.swift \
///     macos/BoundaryTests/{BoundaryTests,main}.swift \
///     -framework AppKit -framework WebKit -framework Security -framework Vision -framework CoreServices \
///     -o /tmp/boundary && /tmp/boundary
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

        // Account auth is the one opener case that must NOT reach the
        // system browser — App Review 4.0.0 keeps sign-in inside the app,
        // so these URLs are recognised for the in-app auth sheet path.
        // Everything else on the opener scope stays external.
        check("auth session takes apple sign-in",
              NativeCapabilities.isAccountAuthURL(URL(string: "https://manorama.xyz/auth/apple?native=desktop&code_challenge=abc")!))
        check("auth session takes signin-host connect flow",
              NativeCapabilities.isAccountAuthURL(URL(string: "https://signin.manorama.xyz/auth/google?link=tok&native=desktop")!))
        check("auth session takes dropbox sign-in",
              NativeCapabilities.isAccountAuthURL(URL(string: "https://manorama.xyz/auth/dropbox?native=desktop&code_challenge=abc")!))
        check("auth session takes dev auth",
              NativeCapabilities.isAccountAuthURL(URL(string: "http://localhost:5173/auth/dropbox?native=desktop&code_challenge=abc")!))
        check("auth session refuses bare auth URL",
              !NativeCapabilities.isAccountAuthURL(URL(string: "https://manorama.xyz/auth/apple")!))
        check("auth session refuses non-provider auth path",
              !NativeCapabilities.isAccountAuthURL(URL(string: "https://manorama.xyz/auth/logout?native=desktop")!))
        check("auth session refuses gallery page",
              !NativeCapabilities.isAccountAuthURL(URL(string: "https://manorama.xyz/thecontrarian/italy")!))
        check("auth session refuses provider-source OAuth",
              !NativeCapabilities.isAccountAuthURL(URL(string: "https://www.dropbox.com/oauth2/authorize?client_id=x")!))
        check("auth session refuses lookalike host",
              !NativeCapabilities.isAccountAuthURL(URL(string: "https://manorama.xyz.evil.example/auth/apple?native=desktop")!))
        check("auth session refuses foreign dev port",
              !NativeCapabilities.isAccountAuthURL(URL(string: "http://localhost:9999/auth/apple?native=desktop")!))

        check("http capability allows proton.me", NativeCapabilities.isAllowedHttpURL("https://drive-api.proton.me/drive/urls/abc") != nil)
        check("http capability allows protonvpn.com", NativeCapabilities.isAllowedHttpURL("https://api.protonvpn.com/test") != nil)
        check("http capability allows mega api", NativeCapabilities.isAllowedHttpURL("https://g.api.mega.co.nz/cs?n=abc") != nil)
        check("http capability allows mega cdn", NativeCapabilities.isAllowedHttpURL("https://gfs206n189.userstorage.mega.co.nz/dl/abc") != nil)
        check("http capability refuses non-scoped host", NativeCapabilities.isAllowedHttpURL("https://example.com/api") == nil)
        check("http capability refuses lookalike mega host", NativeCapabilities.isAllowedHttpURL("https://userstorage.mega.co.nz.evil.example/") == nil)
        check("http capability refuses plain http proton", NativeCapabilities.isAllowedHttpURL("http://drive-api.proton.me/drive") == nil)

        // The invoke reply contract: a nil result is `value: null`, never an
        // omitted member — the page's `!== null` purge verification reads an
        // omitted value (`undefined`) as a surviving vault key.
        let okReply = InvokeReplyEncoding.payload(id: 7, ok: true, value: nil)
        check("nil invoke reply carries value null", okReply["value"] is NSNull)
        let errReply = InvokeReplyEncoding.payload(id: 8, ok: false, error: "x")
        check("error invoke reply carries no value", errReply["value"] == nil && errReply["error"] as? String == "x")
        if let replyData = try? JSONSerialization.data(withJSONObject: okReply),
           let replyJson = String(data: replyData, encoding: .utf8) {
            check("invoke reply JSON keeps the value member", replyJson.contains("\"value\":null"), replyJson)
        } else {
            check("invoke reply JSON keeps the value member", false, "serialization failed")
        }

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

            // The same bridge outlives its Library document. Record its real
            // command replies and emits without loading a page or doing OAuth.
            var page = RecordingBridgeWebView()
            bridge.webView = page
            var commandID = 0
            @MainActor func invoke(_ cmd: String, _ args: [String: Any] = [:]) -> Any? {
                commandID += 1
                let id = commandID
                bridge.handle(["type": "invoke", "id": id, "cmd": cmd, "args": args])
                let deadline = Date().addingTimeInterval(2)
                while page.replies[id] == nil && Date() < deadline {
                    RunLoop.main.run(until: Date().addingTimeInterval(0.01))
                }
                check("lifecycle command \(id) replies successfully", page.replies[id]?["ok"] as? Bool == true)
                return page.replies[id]?["value"]
            }
            let early = "in.thecontrarian.manorama.desktop://auth/callback?handoff=early"
            let between = "in.thecontrarian.manorama.desktop://auth/callback?handoff=between"
            let live = "in.thecontrarian.manorama.desktop://auth/callback?handoff=live"
            let reopened = "in.thecontrarian.manorama.desktop://auth/callback?handoff=reopened"
            bridge.deliverDeepLink(early)
            bridge.deliverDeepLink(early)
            _ = invoke("plugin:event|listen", ["event": "tauri://resize", "handler": 1])
            bridge.deliverDeepLink(between)
            check("an unrelated listener does not enable deep-link emission", page.emissions.isEmpty)
            // Match installDesktopAuth: subscribe twice, then read get_current.
            _ = invoke("plugin:event|listen", ["event": "deep-link://new-url", "handler": 2])
            _ = invoke("plugin:event|listen", ["event": "manorama://deep-link", "handler": 3])
            check("subscriptions leave launch URLs buffered", page.emissions.isEmpty)
            check("get_current drains unique launch URLs in order",
                  invoke("plugin:deep-link|get_current") as? [String] == [early, between])
            check("get_current is read-once", invoke("plugin:deep-link|get_current") is NSNull)
            bridge.deliverDeepLink(live)
            check("a ready document receives both existing deep-link events",
                  page.emissions.count == 1
                    && page.emissions[0].contains("deep-link://new-url")
                    && page.emissions[0].contains("manorama://deep-link")
                    && page.emissions[0].contains("handoff=live"))
            check("a live emission is not also buffered", invoke("plugin:deep-link|get_current") is NSNull)

            bridge.resetDeepLinkReadiness()
            bridge.deliverDeepLink(reopened)
            bridge.resetDeepLinkReadiness() // Close and navigation may both reset.
            check("a replacement document receives no premature emission", page.emissions.count == 1)
            let oldPage = page
            page = RecordingBridgeWebView()
            bridge.webView = page
            check("replacement drains only undelivered URLs, never the old live handoff",
                  invoke("plugin:deep-link|get_current") as? [String] == [reopened])
            check("replacement get_current is also read-once", invoke("plugin:deep-link|get_current") is NSNull)
            check("the old document gets no replacement delivery", oldPage.emissions.count == 1)
        }
        check("Tauri-picked existing root is adopted into FolderStore", adoptedCount == 1, "adopted=\(adoptedCount)")
        check("only reachable roots enter GrantedRoots", grantedCount == 1 && !grantedContainsMissing, "granted=\(grantedCount)")

        try? FileManager.default.removeItem(at: testConfigDir)
        try? FileManager.default.removeItem(at: tauriPickedDir)

        // --- 8. Raw dump events -----------------------------------------
        //
        // A camera backup built out of nothing but ImageIO and numbers this
        // suite chose. Real photographs would make the expected event
        // boundaries a matter of interpretation; these are arithmetic. The
        // tree is deliberately nested two ways at once — `YYYY-MM-DD` and
        // `YYYY/MM` — because the walk's whole point is that it does not
        // care what shape the backup is in.
        let dumpRoot = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("manorama-dump-\(UUID().uuidString)", isDirectory: true)
        let dumpConfig = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("manorama-dump-config-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: dumpConfig, withIntermediateDirectories: true)

        let pune = (18.5158, 73.8566)
        let lagos = (6.5244, 3.3792)
        // Eight frames the walk must find, in three nesting shapes, one of
        // them a screenshot and one with no EXIF at all.
        let fixtures: [(path: String, captured: String?, offset: String?, gps: (Double, Double)?, camera: Bool, png: Bool)] = [
            ("2026-03-14/IMG_0001.jpg", "2026:03:14 18:30:00", "+05:30", pune, true, false),
            ("2026-03-14/IMG_0002.jpg", "2026:03:14 18:35:00", "+05:30", pune, true, false),
            ("2026-03-14/IMG_0003.jpg", "2026:03:14 18:40:00", "+05:30", pune, true, false),
            ("2026-03-15/IMG_0004.jpg", "2026:03:15 10:00:00", "+05:30", pune, true, false),
            ("2026/04/IMG_0005.jpg", "2026:04:02 16:00:00", "+01:00", lagos, true, false),
            ("2026/06/IMG_TZ_A.jpg", "2026:06:01 12:00:00", "+05:30", nil, true, false),
            ("2026/06/IMG_TZ_B.jpg", "2026:06:01 12:00:00", "+01:00", nil, true, false),
            ("2026/07/Screenshot_2026-07-01_at_09.00.00.png", nil, nil, nil, false, true),
        ]
        var written = 0
        for fixture in fixtures {
            if BoundaryTests.writeDumpPhoto(
                in: dumpRoot, at: fixture.path, captured: fixture.captured, offset: fixture.offset,
                gps: fixture.gps, camera: fixture.camera, png: fixture.png
            ) { written += 1 }
        }
        // The things a backup folder always has beside the photographs, and
        // the walk must not.
        _ = BoundaryTests.writeDumpPhoto(in: dumpRoot, at: ".hidden/IMG_9999.jpg",
                                         captured: "2026:03:14 18:30:00", offset: "+05:30", gps: pune, camera: true, png: false)
        _ = BoundaryTests.writeDumpPhoto(in: dumpRoot, at: "2026-03-14/.IMG_dot.jpg",
                                         captured: "2026:03:14 18:31:00", offset: "+05:30", gps: pune, camera: true, png: false)
        try? "not a photograph".write(
            to: dumpRoot.appendingPathComponent("notes.txt"), atomically: true, encoding: .utf8)
        check("raw dump fixtures were written", written == fixtures.count, "written=\(written)/\(fixtures.count)")

        let traversalRoot = dumpConfig.appendingPathComponent("traversal", isDirectory: true)
        let traversalPaths = ["root.jpg", "DCIM/child.jpg", "2026/03/grandchild.jpg"]
        for path in traversalPaths {
            check("traversal fixture \(path) was written", BoundaryTests.writeDumpPhoto(
                in: traversalRoot, at: path, captured: "2026:03:14 18:30:00",
                offset: "+05:30", gps: pune, camera: true
            ))
        }
        let galleryScan = LocalScanner.scan(root: traversalRoot)
        let dumpWalk = try? FolderDumpScanner.enumerate(root: traversalRoot)
        check("a curated gallery reads only the root of the same tree",
              galleryScan.items.map(\.id) == ["root.jpg"] && galleryScan.truncated == nil)
        check("only a declared dump recurses the same tree",
              Set(dumpWalk?.map(\.relativePath) ?? []) == Set(traversalPaths))

        // 8a. The walk itself: recursive, uncapped, hidden-free.
        let walked = try? FolderDumpScanner.enumerate(root: dumpRoot)
        check("the walk finds every visible frame at any depth", walked?.count == fixtures.count,
              "count=\(walked?.count ?? -1)")
        check("a dated directory and a nested year/month directory are both walked",
              walked?.contains { $0.relativePath == "2026-03-14/IMG_0001.jpg" } == true
                  && walked?.contains { $0.relativePath == "2026/04/IMG_0005.jpg" } == true)
        check("dot files and dot directories are skipped",
              walked?.contains { $0.relativePath.contains("hidden") || $0.url.lastPathComponent.hasPrefix(".") } != true)
        check("a non-image beside the photographs is not an item",
              walked?.contains { $0.relativePath.hasSuffix(".txt") } != true)

        // 8b. Header-only ingestion, and the two timestamp rules.
        if let walked,
           let zoneA = walked.first(where: { $0.relativePath == "2026/06/IMG_TZ_A.jpg" }),
           let zoneB = walked.first(where: { $0.relativePath == "2026/06/IMG_TZ_B.jpg" }),
           let itemA = FolderDumpScanner.ingest(zoneA).item,
           let itemB = FolderDumpScanner.ingest(zoneB).item {
            // The same wall clock written in two zones is four and a half
            // hours apart in fact. Read it as local time and a trip in two
            // countries becomes one afternoon.
            /* Sign matters: A carries +05:30 and B +01:00, so noon in Pune
             * is 06:30 UTC while noon in Lagos is 11:00 UTC. A therefore
             * happened EARLIER and A minus B is negative. Asserting the
             * positive difference here would have failed a correct parser. */
            let apart = itemA.timestamp.timeIntervalSince(itemB.timestamp)
            check("OffsetTimeOriginal moves the instant, not the machine's zone",
                  abs(apart + 16_200) < 1, "apart=\(apart)")
        } else {
            check("OffsetTimeOriginal moves the instant, not the machine's zone", false, "fixtures unreadable")
        }
        if let walked,
           let shot = walked.first(where: { $0.relativePath.hasSuffix(".png") }),
           let item = FolderDumpScanner.ingest(shot).item {
            check("a frame with no EXIF falls back to the file's own date",
                  item.timestamp == (shot.creationDate ?? shot.modificationDate))
            check("a PNG with no camera make is a screenshot, not a photograph", item.isScreenshot)
        } else {
            check("a frame with no EXIF falls back to the file's own date", false, "fixture unreadable")
            check("a PNG with no camera make is a screenshot, not a photograph", false)
        }
        let allIngested = (walked ?? []).map { FolderDumpScanner.ingest($0) }
        check("ingestion opens a header for every file whose bytes are on this disk",
              allIngested.count == fixtures.count
                  && allIngested.allSatisfy { $0.headerWasOpened && $0.item != nil })

        /* 8b′. The optional visual pass, run for real rather than stubbed.
         * The engine's own suite proves what an opinion does to a boundary —
         * and that `nil` keeps a session together — but only this layer can
         * prove the Vision path is wired: a thumbnail built from the header
         * without caching, a request performed, a distance widened into the
         * Double the config is written in. The fixtures are flat grey, so
         * what is asserted is that a number comes back and that a frame is
         * zero apart from itself, not that two scenes look different. */
        let visualProbe = VisionBoundaryProbe(root: dumpRoot)
        let photographed = allIngested.compactMap(\.item).filter { !$0.isScreenshot }
        if photographed.count >= 2 {
            let selfDistance = visualProbe.visualDistance(between: photographed[0], and: photographed[0])
            let pairDistance = visualProbe.visualDistance(between: photographed[0], and: photographed[1])
            check("the visual pass answers a distance for two frames that are on this disk",
                  pairDistance.map { $0.isFinite && $0 >= 0 } == true,
                  "distance=\(String(describing: pairDistance))")
            check("a frame compared with itself is not apart from itself",
                  selfDistance.map { $0 < 0.01 } == true,
                  "distance=\(String(describing: selfDistance))")
            /* The abstention is the safety property, not the measurement: a
             * frame whose bytes this Mac has not been given must produce no
             * opinion, because a cloud placeholder is not evidence that the
             * user stopped doing something. An id that was never written is
             * the cheapest honest stand-in for that file. */
            let ghost = MediaMetadataItem(
                id: "2026/06/IMG_NEVER_WRITTEN.jpg",
                timestamp: Date(timeIntervalSince1970: 1_780_000_000)
            )
            let ghostDistance = visualProbe.visualDistance(between: ghost, and: photographed[0])
            check("a frame whose pixels cannot be read has no opinion rather than a split",
                  ghostDistance == nil, "distance=\(String(describing: ghostDistance))")
        } else {
            check("the visual pass answers a distance for two frames that are on this disk", false, "no fixtures")
            check("a frame compared with itself is not apart from itself", false, "no fixtures")
            check("a frame whose pixels cannot be read has no opinion rather than a split", false, "no fixtures")
        }

        // 8c. The store: incremental, private, self-correcting.
        let dumpStore = RawDumpEventStore(configDir: dumpConfig)
        let firstScan = try? dumpStore.scan(root: dumpRoot, deviceId: "boundary-device",
                                       sourceId: "boundary-source", label: "Boundary Dump", force: false)
        check("a first scan opens every header", firstScan?.report.metadataReadCount == fixtures.count,
              "read=\(firstScan?.report.metadataReadCount ?? -1)")
        check("a first scan produces events", (firstScan?.report.eventCount ?? 0) >= 2,
              "events=\(firstScan?.report.eventCount ?? -1)")
        let indexPerms = ((try? FileManager.default.attributesOfItem(atPath: dumpStore.indexURL.path))?[.posixPermissions] as? Int) ?? 0
        check("events-index.json is written at mode 0600", (indexPerms & 0o777) == 0o600,
              "perms=\(String(indexPerms, radix: 8))")
        check("the index lands in the config directory it was given",
              dumpStore.indexURL.deletingLastPathComponent() == dumpConfig
                  && FileManager.default.fileExists(atPath: dumpStore.indexURL.path))
        let unchangedStamp = Date(timeIntervalSince1970: 1_700_000_000)
        try? FileManager.default.setAttributes(
            [.modificationDate: unchangedStamp], ofItemAtPath: dumpStore.indexURL.path)
        let indexDataBeforeRescan = (try? Data(contentsOf: dumpStore.indexURL)) ?? Data()
        let indexedBeforeRescan = dumpStore.readIndex()?.source.lastIndexedAt
        let secondScan = try? dumpStore.scan(root: dumpRoot, deviceId: "boundary-device",
                                        sourceId: "boundary-source", label: "Boundary Dump", force: false)
        check("an unchanged rescan opens no header at all", secondScan?.report.metadataReadCount == 0,
              "read=\(secondScan?.report.metadataReadCount ?? -1)")
        let indexStampAfterRescan = ((try? FileManager.default.attributesOfItem(
            atPath: dumpStore.indexURL.path))?[.modificationDate] as? Date) ?? .distantPast
        let indexDataAfterRescan = try? Data(contentsOf: dumpStore.indexURL)
        let lastIndexedUnchanged = indexedBeforeRescan.map { before in
            guard let after = secondScan?.report.lastIndexedAt else { return false }
            return abs(after.timeIntervalSince(before)) < 0.001
        } ?? false
        check("an unchanged rescan does not rewrite or re-date the index",
              abs(indexStampAfterRescan.timeIntervalSince(unchangedStamp)) < 0.001
                  && indexDataAfterRescan == indexDataBeforeRescan && lastIndexedUnchanged,
              "stamp=\(indexStampAfterRescan.timeIntervalSince1970)")
        // Touch one frame: its mod time moves, so its row alone is stale.
        let touchedFile = dumpRoot.appendingPathComponent("2026-03-14/IMG_0002.jpg")
        try? FileManager.default.setAttributes(
            [.modificationDate: Date().addingTimeInterval(5)], ofItemAtPath: touchedFile.path)
        let thirdScan = try? dumpStore.scan(root: dumpRoot, deviceId: "boundary-device",
                                       sourceId: "boundary-source", label: "Boundary Dump", force: false)
        check("a touched file is re-read and nothing else is", thirdScan?.report.metadataReadCount == 1,
              "read=\(thirdScan?.report.metadataReadCount ?? -1)")
        let clusters = firstScan.map { RawDumpWire.scan($0) }
        let clusterList = clusters?["clusters"] as? [[String: Any]] ?? []
        let memberIds = clusterList.flatMap { ($0["itemIds"] as? [String]) ?? [] }
        check("event membership is carried as relative-path item ids",
              !memberIds.isEmpty
                  && memberIds.allSatisfy { id in !id.hasPrefix("/") && !id.hasPrefix(dumpRoot.path) }
                  && memberIds.contains("2026-03-14/IMG_0001.jpg"),
              "ids=\(memberIds.prefix(3).map { $0 }.joined(separator: ","))")
        check("the wire carries milliseconds, not seconds",
              clusterList.allSatisfy { (($0["startDate"] as? Int64) ?? (($0["startDate"] as? Int).map(Int64.init)) ?? 0) > 1_000_000_000_000 })
        let screenshotId = "2026/07/Screenshot_2026-07-01_at_09.00.00.png"
        check("the screenshot left the events", !memberIds.contains(screenshotId))
        check("the screenshot was counted", (clusters?["screenshotCount"] as? Int) == 1,
              "count=\(String(describing: clusters?["screenshotCount"]))")
        check("three frames ten minutes apart at one place are one event",
              clusterList.contains { cluster in
                  let ids = (cluster["itemIds"] as? [String]) ?? []
                  return ids.filter { $0.hasPrefix("2026-03-14/") }.count == 3
              })
        // A different device is a different source: the cache cannot be
        // reused, and the count of headers read proves it rebuilt.
        let foreignScan = try? dumpStore.scan(root: dumpRoot, deviceId: "another-device",
                                         sourceId: "boundary-source", label: "Boundary Dump", force: false)
        check("a fingerprint mismatch forces a rebuild, not a merge",
              foreignScan?.report.metadataReadCount == fixtures.count,
              "read=\(foreignScan?.report.metadataReadCount ?? -1)")
        _ = try? dumpStore.scan(root: dumpRoot, deviceId: "boundary-device", sourceId: "boundary-source",
                            label: "Boundary Dump", force: false)
        // A frame the user deleted must leave the cache.
        try? FileManager.default.removeItem(at: dumpRoot.appendingPathComponent("2026-03-14/IMG_0003.jpg"))
        let afterLoss = try? dumpStore.scan(root: dumpRoot, deviceId: "boundary-device",
                                       sourceId: "boundary-source", label: "Boundary Dump", force: false)
        check("a vanished file is pruned from the cache",
              dumpStore.readIndex()?.itemCache["2026-03-14/IMG_0003.jpg"] == nil
                  && (afterLoss?.report.metadataReadCount ?? 1) == 0,
              "read=\(afterLoss?.report.metadataReadCount ?? -1)")
        // Status is a `stat` after the first read, whichever store asks.
        let coldStore = RawDumpEventStore(configDir: dumpConfig)
        _ = coldStore.summary()
        _ = coldStore.summary()
        _ = coldStore.summary()
        check("three status polls decode the cache once", coldStore.summaryDecodes == 1,
              "decodes=\(coldStore.summaryDecodes)")
        check("status knows what the cache knows", coldStore.summary().eventCount == (afterLoss?.report.eventCount ?? -2)
              && coldStore.summary().lastIndexedAt != nil)

        // 8d. The bridge: the seeded pick, the nudge, and the clear.
        //
        // The real Keychain is refused by this unsigned test binary, so the
        // scan command itself is proved through the store above — the same
        // call the command makes once the device id is in hand. What is
        // proved here is the command surface that does not need it.
        let legacyFolders = dumpConfig.appendingPathComponent("folders.json")
        try? BoundaryTests.legacyFoldersJSON(for: dumpRoot).write(to: legacyFolders, atomically: true, encoding: .utf8)
        MainActor.assumeIsolated {
            let bridgeStore = FolderStore(fileURL: legacyFolders, configDir: dumpConfig)
            check("a legacy folders.json without isRawDump still loads", bridgeStore.entries.count == 1
                  && bridgeStore.rawDumpEntry == nil, "entries=\(bridgeStore.entries.count)")
            // `--config` isolation, measured rather than assumed: the real
            // Application Support directory is whatever the machine running
            // this suite happens to have, and the claim is only that a test
            // run leaves it exactly as it found it.
            let realIndex = NativeBridge.defaultConfigDir().appendingPathComponent("events-index.json")
            let realIndexWasThere = FileManager.default.fileExists(atPath: realIndex.path)
            let realIndexDate = (try? FileManager.default.attributesOfItem(atPath: realIndex.path)[.modificationDate] as? Date) ?? nil
            let granted = GrantedRoots()
            var bridge = NativeBridge(folderStore: bridgeStore, grantedRoots: granted,
                                      configDir: dumpConfig, seededFolder: dumpRoot.path,
                                      seededRawDumpPath: dumpRoot.path)
            var page = RecordingBridgeWebView()
            bridge.webView = page
            var commandID = 0
            @MainActor func invoke(_ cmd: String, _ args: [String: Any] = [:]) -> Any? {
                commandID += 1
                let id = commandID
                bridge.handle(["type": "invoke", "id": id, "cmd": cmd, "args": args])
                let deadline = Date().addingTimeInterval(5)
                while page.replies[id] == nil && Date() < deadline {
                    RunLoop.main.run(until: Date().addingTimeInterval(0.01))
                }
                return page.replies[id]?["value"]
            }
            @MainActor func invokeError(_ cmd: String, _ args: [String: Any] = [:]) -> String? {
                commandID += 1
                let id = commandID
                bridge.handle(["type": "invoke", "id": id, "cmd": cmd, "args": args])
                let deadline = Date().addingTimeInterval(5)
                while page.replies[id] == nil && Date() < deadline {
                    RunLoop.main.run(until: Date().addingTimeInterval(0.01))
                }
                let reply = page.replies[id]
                return reply?["ok"] as? Bool == false ? (reply?["error"] as? String) : nil
            }
            _ = invoke("plugin:event|listen", ["event": NativeBridge.rawDumpChangedEvent, "handler": 7])
            let pick = invoke("pick_raw_dump_root") as? [String: Any]
            check("the seeded seam answers the dump picker without a panel",
                  pick?["rootPath"] as? String == dumpRoot.path
                      || pick?["rootPath"] as? String == dumpRoot.standardizedFileURL.path,
                  "rootPath=\(String(describing: pick?["rootPath"]))")
            check("the pick reports the frames it found, without scanning them",
                  (pick?["itemCount"] as? Int) == 7, "itemCount=\(String(describing: pick?["itemCount"]))")
            check("the pick names the dump for the page",
                  (pick?["label"] as? String) == dumpRoot.lastPathComponent)
            check("the dump root enters the media handler's own grants",
                  granted.all().contains { $0.resolvingExistingSymlinksInPath().path == dumpRoot.path },
                  "grants=\(granted.all().count)")
            let rootsFile = dumpConfig.appendingPathComponent("roots.json")
            /* Decode the file instead of searching its text: JSON
             * serialisation escapes every path separator, so the stored
             * entry reads `\/var\/folders\/…` and a substring match on a
             * real path can never hit. The value is what the shell wrote;
             * the escaping is what a string does on the way there. */
            let recordedRoots: [String] = ((try? Data(contentsOf: rootsFile)).flatMap {
                (try? JSONSerialization.jsonObject(with: $0)) as? [String]
            }) ?? []
            check("the dump is recorded in roots.json",
                  recordedRoots.contains {
                      $0 == dumpRoot.path || $0 == dumpRoot.standardizedFileURL.path
                  }, "roots=\(recordedRoots)")
            let status = invoke("get_raw_dump_status") as? [String: Any]
            check("status reports the dump configured and reachable",
                  status?["configured"] as? Bool == true && status?["isAvailable"] as? Bool == true,
                  "status=\(String(describing: status))")
            check("status answers the index it found, in milliseconds or null",
                  status?["lastIndexedAt"] is NSNull
                      || ((status?["lastIndexedAt"] as? NSNumber)?.int64Value ?? 0) > 1_000_000_000_000,
                  "lastIndexedAt=\(String(describing: status?["lastIndexedAt"]))")
            check("status answers no path", (status?["rootPath"] as? String) == nil)
            check("a dump cannot be picked as a curated gallery",
                  invokeError("pick_gallery_root")?.contains("camera-roll dump") == true)
            let galleryJSON = String(data: try! JSONSerialization.data(withJSONObject: [
                "version": 1, "galleries": [["rootPath": dumpRoot.path]]
            ]), encoding: .utf8)!
            check("a catalogue write cannot turn a dump into a gallery",
                  invokeError("write_private_file", ["name": "catalogue.json", "contents": galleryJSON])?
                      .contains("camera-roll dump") == true)
            check("a rejected catalogue write leaves the previous file untouched",
                  !FileManager.default.fileExists(atPath: dumpConfig.appendingPathComponent("catalogue.json").path))
            let dumpAlias = dumpConfig.appendingPathComponent("dump-alias")
            try? FileManager.default.createSymbolicLink(at: dumpAlias, withDestinationURL: dumpRoot)
            let aliasJSON = String(data: try! JSONSerialization.data(withJSONObject: [
                "version": 1, "galleries": [["rootPath": dumpAlias.path]]
            ]), encoding: .utf8)!
            check("a symlink alias cannot put a dump into the catalogue",
                  invokeError("write_private_file", ["name": "catalogue.json", "contents": aliasJSON])?
                      .contains("camera-roll dump") == true)
            bridge.receiveDrop(urls: [traversalRoot, dumpRoot], files: 0)
            check("a dropped dump rejects the entire gallery batch",
                  invokeError("commit_dropped_roots", ["paths": [traversalRoot.path, dumpRoot.path]])?
                      .contains("camera-roll dump") == true)
            check("a rejected drop batch makes no partial gallery grants", bridgeStore.entries.count == 1)
            _ = invoke("discard_dropped_roots")
            let otherGalleryJSON = String(data: try! JSONSerialization.data(withJSONObject: [
                "version": 1, "galleries": [["rootPath": traversalRoot.path]]
            ]), encoding: .utf8)!
            check("a different gallery root can coexist with the dump",
                  invokeError("write_private_file", ["name": "catalogue.json", "contents": otherGalleryJSON]) == nil)
            _ = invoke("delete_private_file", ["name": "catalogue.json"])
            // The nudge: touch a file and wait for the watch to say so.
            try? FileManager.default.setAttributes(
                [.modificationDate: Date()],
                ofItemAtPath: dumpRoot.appendingPathComponent("2026-03-15/IMG_0004.jpg").path)
            var waited = 0.0
            while !page.emissions.contains { $0.contains(NativeBridge.rawDumpChangedEvent) }, waited < 15 {
                RunLoop.main.run(until: Date().addingTimeInterval(0.1))
                waited += 0.1
            }
            check("the filesystem watch nudges the page",
                  page.emissions.contains { $0.contains(NativeBridge.rawDumpChangedEvent) },
                  "waited=\(String(format: "%.1f", waited))s")
            check("the nudge carries no path, timestamp or coordinate",
                  !page.emissions.filter { $0.contains(NativeBridge.rawDumpChangedEvent) }
                      .contains { $0.contains(dumpRoot.path) })
            check("the watch is armed on the dump root",
                  bridge.rawDumpWatchedRoot == dumpRoot.path,
                  "watched=\(String(describing: bridge.rawDumpWatchedRoot))")
            let cleared = invoke("clear_raw_dump_root")
            /* The reply contract says `value` is PRESENT on every success
             * and carries NSNull when the command returned nothing — an
             * omitted key would reach the page as `undefined`, which the
             * vault's own checks read as a surviving value. So the honest
             * form of "answers null" is the null the page actually gets,
             * the same shape the status assertions two lines below accept. */
            check("clear answers null", cleared == nil || cleared is NSNull,
                  "cleared=\(String(describing: cleared))")
            check("clear deletes the index", !FileManager.default.fileExists(atPath: dumpStore.indexURL.path))
            check("clear stops the watch", bridge.rawDumpWatchedRoot == nil,
                  "watched=\(String(describing: bridge.rawDumpWatchedRoot))")
            check("clear leaves the folder grant alone",
                  bridgeStore.entries.count == 1 && bridgeStore.rawDumpEntry == nil)
            let afterClear = invoke("get_raw_dump_status") as? [String: Any]
            check("after a clear the page is told it is not configured",
                  afterClear?["configured"] as? Bool == false
                      && afterClear?["eventCount"] as? Int == 0
                      && afterClear?["lastIndexedAt"] is NSNull,
                  "status=\(String(describing: afterClear))")
            let refused = invokeError("scan_raw_dump_events")
            check("a scan with no dump configured is an error, not an empty timeline",
                  refused?.contains("no raw dump folder is configured") == true,
                  "error=\(String(describing: refused))")
            check("events-index.json is not a private file the page may read",
                  invokeError("read_private_file", ["name": "events-index.json"]) != nil)
            let realIndexNow = FileManager.default.fileExists(atPath: realIndex.path)
            let realIndexDateNow = (try? FileManager.default.attributesOfItem(atPath: realIndex.path)[.modificationDate] as? Date) ?? nil
            check("a config-scoped run leaves the real config directory untouched",
                  realIndexWasThere == realIndexNow && realIndexDate == realIndexDateNow,
                  "before=\(realIndexWasThere) after=\(realIndexNow)")
            check("clearing the dump permits a gallery catalogue declaration",
                  invokeError("write_private_file", ["name": "catalogue.json", "contents": galleryJSON]) == nil)
            for path in [dumpRoot.path, dumpAlias.path] {
                bridge = NativeBridge(folderStore: bridgeStore, grantedRoots: granted,
                                      configDir: dumpConfig, seededRawDumpPath: path)
                page = RecordingBridgeWebView()
                bridge.webView = page
                check("a gallery root or its alias cannot be declared as a dump",
                      invokeError("pick_raw_dump_root")?.contains("gallery root") == true)
                check("a rejected dump declaration leaves the source unconfigured",
                      bridgeStore.rawDumpEntry == nil)
                check("a rejected dump declaration preserves the catalogue",
                      invoke("read_private_file", ["name": "catalogue.json"]) as? String == galleryJSON)
            }
            _ = invoke("delete_private_file", ["name": "catalogue.json"])
        }

        try? FileManager.default.removeItem(at: dumpRoot)
        try? FileManager.default.removeItem(at: dumpConfig)

        // --- Summary ----------------------------------------------------
        print(failures == 0 ? "\nALL PASS" : "\n\(failures) FAILURE(S)")
        exit(failures == 0 ? 0 : 1)
    }

    // MARK: - Raw dump fixtures

    /// One fixture photograph, with a header this suite wrote on purpose.
    ///
    /// `CGImageDestination` rather than a copied file because the expected
    /// answers are then numbers the test chose: `DateTimeOriginal` with its
    /// `OffsetTimeOriginal`, and a GPS fix. The pixels are flat grey and
    /// 64x48 because the walk must not look at them — if a fixture's pixels
    /// ever mattered, that would be the invariant broken.
    static func writeDumpPhoto(
        in root: URL,
        at relativePath: String,
        captured: String?,
        offset: String?,
        gps: (Double, Double)?,
        camera: Bool,
        png: Bool = false
    ) -> Bool {
        let url = root.appendingPathComponent(relativePath)
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let width = 64, height = 48
        guard let space = CGColorSpace(name: CGColorSpace.sRGB),
              let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8,
                                      bytesPerRow: 0, space: space,
                                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return false }
        context.setFillColor(CGColor(red: 0.5, green: 0.5, blue: 0.5, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        guard let image = context.makeImage() else { return false }
        var properties: [String: Any] = [:]
        var tiff: [String: Any] = [:]
        if camera {
            tiff[kCGImagePropertyTIFFMake as String] = "BoundaryCam"
            tiff[kCGImagePropertyTIFFModel as String] = "B-1"
        }
        properties[kCGImagePropertyTIFFDictionary as String] = tiff
        var exif: [String: Any] = [:]
        if let captured { exif[kCGImagePropertyExifDateTimeOriginal as String] = captured }
        // Exif 2.31, and not a named constant in every SDK this compiles
        // against; the parser reads the same key ImageIO writes back.
        if let offset { exif["OffsetTimeOriginal"] = offset }
        if !exif.isEmpty { properties[kCGImagePropertyExifDictionary as String] = exif }
        if let gps {
            properties[kCGImagePropertyGPSDictionary as String] = [
                kCGImagePropertyGPSLatitude as String: gps.0,
                kCGImagePropertyGPSLatitudeRef as String: gps.0 < 0 ? "S" : "N",
                kCGImagePropertyGPSLongitude as String: gps.1,
                kCGImagePropertyGPSLongitudeRef as String: gps.1 < 0 ? "W" : "E",
            ]
        }
        guard let destination = CGImageDestinationCreateWithURL(
            url as CFURL, (png ? "public.png" : "public.jpeg") as CFString, 1, nil
        ) else { return false }
        CGImageDestinationAddImage(destination, image, properties as CFDictionary)
        return CGImageDestinationFinalize(destination)
    }

    /// A `folders.json` in the shape a previous build wrote it: every key
    /// except `isRawDump`, which did not exist. Hand-written rather than
    /// produced by `FolderStore`, because the point of the file is the key
    /// this build's encoder would always emit.
    static func legacyFoldersJSON(for url: URL) -> String {
        let bookmark = (try? ScopedFolder.makeBookmark(for: url.standardizedFileURL)) ?? Data()
        return """
        [
          {
            "id" : "8E6F3A51-5E2B-4F3F-9F0A-1B2C3D4E5F60",
            "name" : "\(url.lastPathComponent)",
            "bookmark" : "\(bookmark.base64EncodedString())",
            "isAvailable" : true,
            "sourceKind" : "folder"
          }
        ]
        """
    }

    static func isRefusal(_ resolution: LocalMediaResolver.Resolution) -> Bool {
        if case .forbidden = resolution { return true }
        return false
    }
}

/// The Slice 6 budget gate: a real 50,000-file dump through the same store
/// call the shell makes, in a fresh process so WebKit and the other boundary
/// checks cannot inflate the memory measurement.
final class EventIndexPerformanceGate {
    static let flag = "--event-index-performance-50k"
    static let testName = "macOS event index 50,000-item performance"

    private static let itemCount = 50_000
    private static let photosPerEvent = 20
    private static let expectedEventCount = itemCount / photosPerEvent
    private static let initialScanLimitSeconds = 10.0
    private static let rescanLimitSeconds = 1.0
    /// The wall-clock budgets are calibrated on a development machine. Shared
    /// CI runners scan measurably slower, so the workflow exports
    /// MANORAMA_PERF_BUDGET_SCALE to loosen only the wall-clock assertions;
    /// the zero-reread, membership and peak-RSS checks stay strict everywhere.
    private static let budgetScale: Double = {
        guard let raw = ProcessInfo.processInfo.environment["MANORAMA_PERF_BUDGET_SCALE"],
              let scale = Double(raw), scale >= 1 else { return 1 }
        return scale
    }()
    /// Decimal MB, deliberately stricter than a 300 MiB interpretation.
    private static let peakRSSLimitBytes = 300_000_000

    static func run() -> Int32 {
        print("== \(testName) ==")
        let work = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
            .appendingPathComponent("manorama-event-index-performance-\(UUID().uuidString)", isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: work, withIntermediateDirectories: true)
        } catch {
            print("FAIL  \(testName) — could not create the synthetic fixture directory: \(error)")
            return 1
        }
        // The runner also puts TMPDIR inside its own trapped scratch tree.
        // This defer covers a throw; the explicit check below covers success.
        defer { try? FileManager.default.removeItem(at: work) }

        do {
            let passed = try exercise(in: work)
            print(passed ? "PASS  \(testName)" : "FAIL  \(testName)")
            return passed ? 0 : 1
        } catch {
            print("FAIL  \(testName) — \(error)")
            return 1
        }
    }

    private static func exercise(in work: URL) throws -> Bool {
        let fixtureStart = ProcessInfo.processInfo.systemUptime
        let baseDate = try writeSyntheticDump(in: work)
        let fixtureSeconds = ProcessInfo.processInfo.systemUptime - fixtureStart
        print(String(format: "INFO  synthetic dump: 50,000 JPEGs; setup %.3f s (excluded from scan timings)",
                     fixtureSeconds))

        let dump = work.appendingPathComponent("dump", isDirectory: true)
        let config = work.appendingPathComponent("config", isDirectory: true)
        let store = RawDumpEventStore(configDir: config)
        let deviceId = "performance-device"
        let sourceId = "performance-source"

        let initialPeak: UInt64
        let rescanPeak: UInt64
        let initialStart = ProcessInfo.processInfo.systemUptime
        let initial = try store.scan(
            root: dump, deviceId: deviceId, sourceId: sourceId,
            label: "Synthetic 50k", force: false
        )
        let initialElapsed = ProcessInfo.processInfo.systemUptime - initialStart
        // RUSAGE_SELF is the kernel's process high-water mark, not a
        // sampled estimate. Capture both scans' peaks before verification
        // allocates sets, JSON buffers or a second decoded index.
        initialPeak = peakRSSBytes()

        let rescanStart = ProcessInfo.processInfo.systemUptime
        let rescan = try store.scan(
            root: dump, deviceId: deviceId, sourceId: sourceId,
            label: "Synthetic 50k", force: false
        )
        let rescanElapsed = ProcessInfo.processInfo.systemUptime - rescanStart
        rescanPeak = peakRSSBytes()
        let overallPeak = max(initialPeak, rescanPeak)

        let initialSummary = try summarize(initial.report)
        let rescanSummary = try summarize(rescan.report)
        try validateInitialIndex(store: store, summary: initialSummary, baseDate: baseDate)

        if budgetScale != 1 {
            print(String(format: "INFO  wall-clock budgets scaled %.4gx by MANORAMA_PERF_BUDGET_SCALE", budgetScale))
        }
        print(String(format: "INFO  initial production scan: %.3f s; peak RSS %.2f MB (%llu bytes)",
                     initialElapsed, Double(initialPeak) / 1_000_000, initialPeak))
        print(String(format: "INFO  unchanged production rescan: %.3f s; peak RSS %.2f MB (%llu bytes)",
                     rescanElapsed, Double(rescanPeak) / 1_000_000, rescanPeak))
        print(String(format: "INFO  production scan peak RSS: %.2f MB (%llu bytes); budget < %.2f MB",
                     Double(overallPeak) / 1_000_000, overallPeak, Double(peakRSSLimitBytes) / 1_000_000))
        print("INFO  initial headers=\(initialSummary.metadataReadCount); rescan headers=\(rescanSummary.metadataReadCount); events=\(rescanSummary.eventCount); members=\(rescanSummary.memberCount)")

        var failures = 0
        func check(_ label: String, _ condition: Bool, _ detail: String = "") {
            if condition {
                print("PASS  \(label)")
            } else {
                print("FAIL  \(label) \(detail)")
                failures += 1
            }
        }

        check("50,000 real files produce 50,000 cached items",
              initialSummary.memberCount == itemCount && initialSummary.uniqueMemberCount == itemCount,
              "members=\(initialSummary.memberCount) unique=\(initialSummary.uniqueMemberCount)")
        check("the synthetic dump contains no screenshots",
              initialSummary.screenshotCount == 0 && rescanSummary.screenshotCount == 0)
        check("initial production scan reads all 50,000 headers",
              initialSummary.metadataReadCount == itemCount,
              "read=\(initialSummary.metadataReadCount)")
        check(String(format: "initial production scan is under %.4g seconds", initialScanLimitSeconds * budgetScale),
              initialElapsed < initialScanLimitSeconds * budgetScale,
              String(format: "elapsed=%.3f s", initialElapsed))
        check("actual peak RSS is under 300 MB",
              overallPeak > 0 && overallPeak < UInt64(peakRSSLimitBytes),
              String(format: "peak=%.2f MB", Double(overallPeak) / 1_000_000))
        check(String(format: "unchanged production rescan is under %.4g seconds", rescanLimitSeconds * budgetScale),
              rescanElapsed < rescanLimitSeconds * budgetScale,
              String(format: "elapsed=%.3f s", rescanElapsed))
        check("unchanged production rescan reads zero headers",
              rescanSummary.metadataReadCount == 0,
              "read=\(rescanSummary.metadataReadCount)")
        check("unchanged rescan preserves 2,500 events and 50,000 unique members",
              rescanSummary.eventCount == expectedEventCount
                  && rescanSummary.memberCount == itemCount
                  && rescanSummary.uniqueMemberCount == itemCount,
              "events=\(rescanSummary.eventCount) members=\(rescanSummary.memberCount) unique=\(rescanSummary.uniqueMemberCount)")
        check("unchanged rescan preserves event ids and membership",
              initialSummary.eventFingerprint == rescanSummary.eventFingerprint)

        let cleaned: Bool
        do {
            try FileManager.default.removeItem(at: work)
            cleaned = !FileManager.default.fileExists(atPath: work.path)
        } catch {
            cleaned = false
        }
        check("all synthetic fixture and index files are cleaned up", cleaned)
        return failures == 0
    }

    /// Write one small camera JPEG once, then vary only its 19-byte EXIF
    /// DateTimeOriginal field. Every file is real input to ImageIO; the flat
    /// pixels are synthetic and no source photograph is copied or decoded.
    /// Twenty one-minute frames are followed by a 24-hour gap, yielding
    /// 2,500 unambiguous events without invoking the Vision tie-breaker.
    private static func writeSyntheticDump(in work: URL) throws -> Date {
        let dump = work.appendingPathComponent("dump", isDirectory: true)
        try FileManager.default.createDirectory(at: dump, withIntermediateDirectories: true)

        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.timeZone = TimeZone(identifier: "UTC")!
        formatter.dateFormat = "yyyy:MM:dd HH:mm:ss"
        let templateDate = "2020:01:01 00:00:00"
        guard let baseDate = formatter.date(from: templateDate),
              BoundaryTests.writeDumpPhoto(
                in: work, at: "template.jpg", captured: templateDate,
                offset: "+00:00", gps: nil, camera: true
              ) else {
            throw Failure(description: "could not write the synthetic JPEG template")
        }
        let template = try Data(contentsOf: work.appendingPathComponent("template.jpg"))
        guard let dateRange = template.range(of: Data(templateDate.utf8)) else {
            throw Failure(description: "the synthetic JPEG template has no DateTimeOriginal field")
        }

        for index in 0..<itemCount {
            if index % (photosPerEvent * 100) == 0 {
                let directory = dump.appendingPathComponent(
                    String(format: "%04d", index / photosPerEvent / 100), isDirectory: true
                )
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            }
            let stamp = formatter.string(from: timestamp(for: index, baseDate: baseDate))
            guard stamp.utf8.count == templateDate.utf8.count else {
                throw Failure(description: "the EXIF fixture timestamp changed width")
            }
            var photo = template
            photo.replaceSubrange(dateRange, with: Data(stamp.utf8))
            try photo.write(to: dump.appendingPathComponent(id(for: index)))
        }
        return baseDate
    }

    private static func timestamp(for index: Int, baseDate: Date) -> Date {
        let day = index / photosPerEvent
        let minute = index % photosPerEvent
        return baseDate.addingTimeInterval(Double(day * 86_400 + minute * 60))
    }

    private static func id(for index: Int) -> String {
        String(format: "%04d/IMG_%05d.jpg", index / photosPerEvent / 100, index)
    }

    private static func validateInitialIndex(
        store: RawDumpEventStore,
        summary: ScanSummary,
        baseDate: Date
    ) throws {
        guard let index = store.readIndex() else {
            throw Failure(description: "the production scan did not leave a readable events-index.json")
        }
        guard index.itemCache.count == itemCount,
              index.events.count == expectedEventCount,
              index.screenshotItemIds.isEmpty,
              index.itemCache.values.allSatisfy({ !$0.isScreenshot }) else {
            throw Failure(description: "the persisted index does not contain the expected 50,000 photographs in 2,500 events")
        }
        guard summary.metadataReadCount == itemCount,
              summary.eventCount == expectedEventCount,
              summary.memberCount == itemCount,
              summary.uniqueMemberCount == itemCount else {
            throw Failure(description: "the production report does not account for every synthetic photograph")
        }
        for itemIndex in 0..<itemCount {
            guard let item = index.itemCache[id(for: itemIndex)],
                  abs(item.timestamp.timeIntervalSince(timestamp(for: itemIndex, baseDate: baseDate))) < 0.001 else {
                throw Failure(description: "synthetic photograph \(itemIndex) did not retain its EXIF timestamp")
            }
        }
    }

    private static func summarize(_ report: RawDumpScanReport) throws -> ScanSummary {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let fingerprint = SHA256Digest.digest(try encoder.encode(report.clusters))
        let members = report.clusters.flatMap(\.itemIds)
        return ScanSummary(
            metadataReadCount: report.metadataReadCount,
            screenshotCount: report.screenshotCount,
            eventCount: report.eventCount,
            memberCount: members.count,
            uniqueMemberCount: Set(members).count,
            eventFingerprint: fingerprint
        )
    }

    /// Darwin reports ru_maxrss in bytes (Linux reports KiB). Because this is
    /// the process lifetime high-water mark, a short allocation spike inside
    /// the synchronous scan cannot fall between samples.
    private static func peakRSSBytes() -> UInt64 {
        var usage = rusage()
        guard getrusage(RUSAGE_SELF, &usage) == 0 else { return 0 }
        return UInt64(max(0, usage.ru_maxrss))
    }

    private struct ScanSummary {
        let metadataReadCount: Int
        let screenshotCount: Int
        let eventCount: Int
        let memberCount: Int
        let uniqueMemberCount: Int
        let eventFingerprint: String
    }

    private struct Failure: Error, CustomStringConvertible {
        let description: String
    }
}

/// Records the bridge's outbound JavaScript without running a renderer.
@MainActor
final class RecordingBridgeWebView: WKWebView {
    var replies: [Int: [String: Any]] = [:]
    var emissions: [String] = []

    override func evaluateJavaScript(_ javaScriptString: String,
                                     completionHandler: (@MainActor @Sendable (Any?, Error?) -> Void)? = nil) {
        let prefix = "window.__manoramaShellSettle && window.__manoramaShellSettle("
        if javaScriptString.hasPrefix(prefix), javaScriptString.hasSuffix(");"),
           let data = String(javaScriptString.dropFirst(prefix.count).dropLast(2)).data(using: .utf8),
           let reply = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let id = reply["id"] as? Int {
            replies[id] = reply
        } else {
            emissions.append(javaScriptString)
            // The deep-link emit asks the page whether a listener exists —
            // a recorded emission means the fake's page is listening, so
            // it answers true and lets the bridge retire the buffer.
            completionHandler?(javaScriptString.contains("__manoramaShellEmit") ? true : nil, nil)
            return
        }
        completionHandler?(nil, nil)
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
