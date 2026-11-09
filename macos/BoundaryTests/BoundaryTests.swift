import Foundation

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
        let page = resolver.resolve(URL(string: "manorama://app/index.html")!)
        if case .file(let fileURL, let mime) = page {
            check("bundle file resolves", fileURL.lastPathComponent == "index.html")
            check("bundle mime is html", mime.hasPrefix("text/html"), mime)
        } else {
            check("bundle file resolves", false, "got \(page)")
        }

        // A traversal out of the bundle root.
        let bundleEscape = resolver.resolve(URL(string: "manorama://app/../../../etc/passwd")!)
        check("traversal out of the bundle is refused", isRefusal(bundleEscape), "got \(bundleEscape)")

        // --- 4. Error recovery ------------------------------------------
        // The folder goes away underneath the app.
        try? FileManager.default.removeItem(at: fixture)
        let afterDelete = FolderStore(fileURL: storeFile)
        check("folder reported unavailable after deletion",
              afterDelete.entries.first?.isAvailable == false,
              "isAvailable=\(String(describing: afterDelete.entries.first?.isAvailable))")
        check("no gallery is built from a dead folder", afterDelete.availableFolders().isEmpty)

        // The token is revoked once the scope is released.
        resolver.revoke(token: token)
        let afterRelease = resolver.resolve(URL(string: "manorama://media/\(token)/photo0.jpg")!)
        check("released token stops resolving", isRefusal(afterRelease), "got \(afterRelease)")

        // --- Summary ----------------------------------------------------
        print(failures == 0 ? "\nALL PASS" : "\n\(failures) FAILURE(S)")
        exit(failures == 0 ? 0 : 1)
    }

    static func isRefusal(_ resolution: LocalMediaResolver.Resolution) -> Bool {
        if case .forbidden = resolution { return true }
        return false
    }
}
