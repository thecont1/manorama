import AppKit
import Foundation
import ImageIO
import Security
import WebKit

/// The native shell's implementation of the desktop bundle's runtime API.
///
/// The Library is the desktop bundle, unchanged, and that bundle is written
/// against Tauri's runtime. Tauri's JavaScript surface is thin — every
/// machine-touching call goes through `invoke` — so the shell answers the
/// same commands here and the app's code stays exactly one implementation.
///
/// The rules the Tauri build already follows are kept:
///
/// - the renderer never supplies a path that is not inside a root the user
///   picked, and
/// - the private files are a fixed allowlist, not a general write primitive.
///
/// The vault's storage and its keys live here rather than in JavaScript:
/// ciphertext without the Keychain keys is dead bytes, which is what keeps a
/// saved gallery viewable only inside this app.
@MainActor
final class NativeBridge {
    /// The live webview, so an answer can be handed back to the page.
    weak var webView: WKWebView?

    /// The roots the user has granted, and the picker that asks for more.
    private let folderStore: FolderStore

    /// Where the app's private documents and the vault live.
    ///
    /// The same directory the Tauri build uses, deliberately: the session,
    /// the local catalogue and the vault are one app's state, and a user who
    /// signs in once and saves a gallery offline should find both in the
    /// other shell.
    private let configDir: URL

    /// The vault's ciphertext root.
    private let vaultRoot: URL

    /// The Keychain service the per-gallery keys live under.
    private static let keychainService = "in.thecontrarian.manorama.vault"

    /// The private documents the renderer may read and write.
    ///
    /// A fixed allowlist, never a caller-supplied path — the same list the
    /// Tauri build keeps.
    private static let privateFiles: Set<String> = ["session.json", "catalogue.json", "providers.json", "library-prefs.json"]

    /// The logical prefix the vault's own paths carry.
    nonisolated private static let vaultDirName = "manorama-vault-v1"

    /// Maximum size of `vault-debug.log` before rotation — matches `VAULT_LOG_MAX_BYTES` in `src-tauri/src/lib.rs`.
    nonisolated static let vaultLogMaxBytes = 512 * 1024

    /// The label this Mac reports to the account.
    private let deviceLabel: String
    /// The folder a test run hands back instead of asking for one.
    private var seededPickPath: String?
    /// Whether this launch was seeded with `--seed-folder`.
    let hasSeededFolder: Bool

    /// The cached picker-approved roots, and the lock that guards them.
    private var cachedRoots: [String]?
    private let rootsLock = NSLock()

    /// The folders the user has granted, shared with the media handler.
    private let grantedRoots: GrantedRoots

    /// Ephemeral loopback HTTP server for Google Drive installed-app OAuth.
    private let oauthLoopback = OAuthLoopbackServer()

    /// Custom-scheme deep links (`in.thecontrarian.manorama.desktop://...`) received by the app.
    private var currentDeepLinks: [String] = []
    /// Whether the page has registered a deep-link listener.
    private var pageReadyForDeepLinks = false

    /// State for `plugin:http|fetch*` (Proton Drive and MEGA native transports).
    private struct PendingHttpRequest {
        let request: URLRequest
        let allowRedirects: Bool
    }
    /// Answers `willPerformHTTPRedirection` with nil so a `maxRedirections: 0`
    /// request sees the 3xx itself — the page's hop validator inspects
    /// Location headers rather than trusting a followed chain.
    private final class RedirectRefuser: NSObject, URLSessionTaskDelegate {
        func urlSession(_ session: URLSession, task: URLSessionTask,
                        willPerformHTTPRedirection response: HTTPURLResponse,
                        newRequest request: URLRequest,
                        completionHandler: @escaping (URLRequest?) -> Void) {
            completionHandler(nil)
        }
    }
    private let redirectRefuser = RedirectRefuser()
    private struct StoredHttpResponse {
        let data: Data
        var offset: Int
    }
    private var nextHttpRid: Int = 1000
    private var pendingHttpRequests: [Int: PendingHttpRequest] = [:]
    private var inflightHttpTasks: [Int: Task<(Data, URLResponse), Error>] = [:]
    private var storedHttpResponses: [Int: StoredHttpResponse] = [:]
    private static let httpChunkBytes = 256 * 1024

    init(folderStore: FolderStore, grantedRoots: GrantedRoots, configDir: URL? = nil, seededFolder: String? = nil) {
        self.folderStore = folderStore
        self.grantedRoots = grantedRoots
        let resolved = configDir ?? Self.defaultConfigDir()
        self.configDir = resolved
        self.vaultRoot = resolved.appendingPathComponent(Self.vaultDirName, isDirectory: true)
        self.deviceLabel = Self.resolveDeviceLabel()

        // `--seed-folder <path>` both answers the picker and tells the app
        // to add that folder at launch. Bookmark it immediately in the
        // folder store so the grant is recorded on disk before the page
        // finishes its async session check.
        if let seeded = seededFolder ?? ({
            let arguments = CommandLine.arguments
            guard let index = arguments.firstIndex(of: "--seed-folder"), index + 1 < arguments.count else { return nil }
            return arguments[index + 1]
        }()) {
            seededPickPath = seeded
            hasSeededFolder = true
            let url = URL(fileURLWithPath: seeded)
            _ = folderStore.add(folder: url)
            recordGalleryRoot(url.path)
        } else {
            hasSeededFolder = false
        }
    }

    /// Matches `src-tauri/src/lib.rs` `device_label()`:
    /// `scutil --get ComputerName` → `hostname` (stripping `.local`) → `"This Mac"`.
    static func resolveDeviceLabel() -> String {
        func run(_ executable: String, _ args: [String]) -> String? {
            let process = Process()
            process.executableURL = URL(fileURLWithPath: executable)
            process.arguments = args
            let pipe = Pipe()
            process.standardOutput = pipe
            process.standardError = FileHandle.nullDevice
            do {
                try process.run()
                process.waitUntilExit()
                guard process.terminationStatus == 0 else { return nil }
                let data = pipe.fileHandleForReading.readDataToEndOfFile()
                guard let output = String(data: data, encoding: .utf8)?
                    .trimmingCharacters(in: .whitespacesAndNewlines),
                      !output.isEmpty else { return nil }
                return output
            } catch {
                return nil
            }
        }
        if let name = run("/usr/sbin/scutil", ["--get", "ComputerName"]) {
            return name
        }
        if let host = run("/bin/hostname", []) {
            let cleaned = host.hasSuffix(".local")
                ? String(host.dropLast(".local".count))
                : host
            if !cleaned.isEmpty {
                return cleaned
            }
        }
        return "This Mac"
    }

    /// The folder a test run asked to be added, if any.
    static var seededFolder: String? {
        let arguments = CommandLine.arguments
        guard let index = arguments.firstIndex(of: "--seed-folder"), index + 1 < arguments.count else { return nil }
        return arguments[index + 1]
    }

    /// The app's private directory — the Tauri build's, so the two shells
    /// share one account, one catalogue and one vault.
    static func defaultConfigDir() -> URL {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSTemporaryDirectory())
        return support.appendingPathComponent("in.thecontrarian.manorama.desktop", isDirectory: true)
    }

    // MARK: - Deep links

    /// Record and forward a custom-scheme URL opened on the application.
    func deliverDeepLink(_ urlString: String) {
        if !currentDeepLinks.contains(urlString) {
            currentDeepLinks.append(urlString)
        }
        guard pageReadyForDeepLinks,
              let data = try? JSONSerialization.data(withJSONObject: [urlString]),
              let arrayJson = String(data: data, encoding: .utf8),
              let singleData = try? JSONSerialization.data(withJSONObject: urlString),
              let singleJson = String(data: singleData, encoding: .utf8) else { return }
        let script = """
        window.__manoramaShellEmit && (
          window.__manoramaShellEmit("deep-link://new-url", \(arrayJson)),
          window.__manoramaShellEmit("manorama://deep-link", \(singleJson))
        );
        """
        webView?.evaluateJavaScript(script)
    }

    // MARK: - The channel

    /// Answer one command from the page.
    ///
    /// The command runs off the main actor where it touches the disk: a
    /// vault record is megabytes, and the window must not stall while one
    /// is written. The picker is the exception — a panel has to be on the
    /// main thread.
    func handle(_ body: [String: Any]) {
        guard let type = body["type"] as? String, type == "invoke" else { return }
        guard let id = body["id"] as? Int else { return }
        let cmd = body["cmd"] as? String ?? ""
        let args = body["args"] as? [String: Any] ?? [:]
        let headers = body["headers"] as? [String: String] ?? [:]

        Task { [weak self] in
            guard let self else { return }
            do {
                let value = try await self.run(cmd, args: args, headers: headers)
                Trace.log("invoke \(cmd) → ok")
                self.reply(id: id, ok: true, value: value)
            } catch {
                Trace.log("invoke \(cmd) → error \(error.localizedDescription)")
                self.reply(id: id, ok: false, error: error.localizedDescription)
            }
        }
    }

    /// Hand the answer back to the page.
    private func reply(id: Int, ok: Bool, value: Any? = nil, error: String? = nil) {
        let payload = InvokeReplyEncoding.payload(id: id, ok: ok, value: value, error: error)
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8) else { return }
        webView?.evaluateJavaScript("window.__manoramaShellSettle && window.__manoramaShellSettle(\(json));")
    }

    // MARK: - Commands

    /// Run one command. The names are Tauri's, so the bundle needs no fork.
    private func run(_ cmd: String, args: [String: Any], headers: [String: String]) async throws -> Any? {
        switch cmd {
        case "device_label":
            return deviceLabel

        case "read_private_file":
            let name = try privateName(args)
            return try readPrivateFile(name)
        case "write_private_file":
            let name = try privateName(args)
            guard let contents = args["contents"] as? String else {
                throw BridgeError.badArguments("write_private_file needs contents")
            }
            try writePrivateFile(name, contents: contents)
            return nil
        case "delete_private_file":
            let name = try privateName(args)
            try deletePrivateFile(name)
            return nil

        case "pick_gallery_root":
            return try pickGalleryRoot()
        case "register_saved_gallery_roots":
            try registerSavedGalleryRoots()
            return nil

        case "plugin:opener|open_url":
            guard let raw = args["url"] as? String,
                  let url = NativeCapabilities.isAllowedOpenerURL(raw) else {
                throw BridgeError.failed("URL is not allowed by opener capability")
            }
            guard NSWorkspace.shared.open(url) else {
                throw BridgeError.failed("The system browser could not open that URL")
            }
            return nil

        case "reveal_gallery_root":
            guard let raw = args["path"] as? String, !raw.isEmpty else {
                throw BridgeError.badArguments("reveal_gallery_root needs path")
            }
            try revealGalleryRoot(raw)
            return nil

        case "plugin:deep-link|get_current":
            pageReadyForDeepLinks = true
            return currentDeepLinks.isEmpty ? NSNull() : currentDeepLinks

        case "plugin:event|listen":
            pageReadyForDeepLinks = true
            return args["handler"] as? Int ?? 0
        case "plugin:event|unlisten":
            return nil
        case "plugin:event|emit", "plugin:event|emit_to":
            return nil

        case "plugin:window|start_dragging":
            if let window = webView?.window, let event = NSApp.currentEvent {
                window.performDrag(with: event)
            }
            return nil

        case "oauth_loopback_begin":
            return Int(try oauthLoopback.begin())
        case "oauth_loopback_cancel":
            oauthLoopback.cancel()
            return nil
        case "oauth_loopback_finish":
            return try await oauthLoopback.finish()

        case "plugin:http|fetch":
            return try httpFetchPrepare(args)
        case "plugin:http|fetch_send":
            return try await httpFetchSend(args)
        case "plugin:http|fetch_read_body":
            return try httpFetchReadBody(args)
        case "plugin:http|fetch_cancel":
            httpFetchCancel(args)
            return nil
        case "plugin:http|fetch_cancel_body":
            httpFetchCancelBody(args)
            return nil

        case "plugin:fs|exists":
            let path = try grantedPath(args)
            return FileManager.default.fileExists(atPath: path.path)
        case "plugin:fs|read_dir":
            return try await readDir(args)
        case "plugin:fs|read_file":
            return try await readFile(args)

        case "vault_read":
            let path = try vaultPath(args["path"] as? String ?? "")
            let data = try await offMain { try? Data(contentsOf: path) }
            guard let data else { return NSNull() }
            return ["__bytes": data.base64EncodedString()]
        case "vault_write":
            let path = try vaultPath(headers["x-vault-path"] ?? "")
            guard let bytes = decodeBytes(args) else {
                throw BridgeError.badArguments("vault_write needs bytes")
            }
            try await offMain { try self.writeVaultFile(path, bytes: bytes) }
            return nil
        case "vault_move":
            let from = try vaultPath(args["from"] as? String ?? "")
            let to = try vaultPath(args["to"] as? String ?? "")
            try await offMain {
                try FileManager.default.createDirectory(at: to.deletingLastPathComponent(), withIntermediateDirectories: true)
                if FileManager.default.fileExists(atPath: to.path) {
                    try FileManager.default.removeItem(at: to)
                }
                try FileManager.default.moveItem(at: from, to: to)
            }
            return nil
        case "vault_remove":
            let path = try vaultPath(args["path"] as? String ?? "")
            try await offMain {
                if FileManager.default.fileExists(atPath: path.path) {
                    try FileManager.default.removeItem(at: path)
                }
                // A resolved delete is not proof of deletion.
                if FileManager.default.fileExists(atPath: path.path) {
                    throw BridgeError.failed("the vault record survived the delete")
                }
            }
            return nil
        case "vault_list":
            return try await offMain { try self.listVault() }
        case "vault_log":
            let line = args["line"] as? String ?? ""
            try await offMain { try self.appendVaultLog(line) }
            return nil

        case "vault_key_get":
            return try keychainGet(args["name"] as? String ?? "")
        case "vault_key_set":
            guard let name = args["name"] as? String, let value = args["value"] as? String else {
                throw BridgeError.badArguments("vault_key_set needs a name and a value")
            }
            try keychainSet(name, value)
            return nil
        case "vault_key_remove":
            try keychainRemove(args["name"] as? String ?? "")
            return nil

        default:
            throw BridgeError.failed("the native shell does not implement \(cmd)")
        }
    }

    // MARK: - Native HTTP transport (`plugin:http|*`)

    private func httpFetchPrepare(_ args: [String: Any]) throws -> Int {
        guard let config = args["clientConfig"] as? [String: Any],
              let rawURL = config["url"] as? String,
              let url = NativeCapabilities.isAllowedHttpURL(rawURL) else {
            throw BridgeError.failed("URL is not allowed by http capability scope")
        }
        var request = URLRequest(url: url)
        request.httpMethod = (config["method"] as? String) ?? "GET"
        if let timeoutMs = config["connectTimeout"] as? Double, timeoutMs > 0 {
            request.timeoutInterval = timeoutMs / 1000.0
        }
        if let headers = config["headers"] as? [[Any]] {
            for pair in headers where pair.count >= 2 {
                if let name = pair[0] as? String, let value = pair[1] as? String {
                    request.setValue(value, forHTTPHeaderField: name)
                }
            }
        }
        if let bodyBytes = config["data"] as? [Int] {
            request.httpBody = Data(bodyBytes.map { UInt8(truncatingIfNeeded: $0) })
        } else if let bodyBytes = config["data"] as? [UInt8] {
            request.httpBody = Data(bodyBytes)
        } else if let encoded = (config["data"] as? [String: Any])?["__bytes"] as? String,
                  let decoded = Data(base64Encoded: encoded) {
            request.httpBody = decoded
        }
        let allowRedirects = (config["maxRedirections"] as? Int) != 0
        let rid = nextHttpRid
        nextHttpRid += 1
        pendingHttpRequests[rid] = PendingHttpRequest(request: request, allowRedirects: allowRedirects)
        return rid
    }

    private func httpFetchSend(_ args: [String: Any]) async throws -> [String: Any] {
        guard let rid = args["rid"] as? Int,
              let pending = pendingHttpRequests.removeValue(forKey: rid) else {
            throw BridgeError.badArguments("Invalid http request rid")
        }
        let refuser = pending.allowRedirects ? nil : redirectRefuser
        let task = Task<(Data, URLResponse), Error> {
            try await URLSession.shared.data(for: pending.request, delegate: refuser)
        }
        inflightHttpTasks[rid] = task
        defer { inflightHttpTasks.removeValue(forKey: rid) }

        let (data, response): (Data, URLResponse)
        do {
            (data, response) = try await task.value
        } catch {
            Trace.log("plugin:http|fetch_send \(pending.request.url?.host ?? "?") — \(error.localizedDescription)")
            throw error
        }
        guard let http = response as? HTTPURLResponse else {
            throw BridgeError.failed("Invalid HTTP response")
        }
        var headerPairs: [[String]] = []
        for (key, value) in http.allHeaderFields {
            if let k = key as? String, let v = value as? String {
                headerPairs.append([k, v])
            }
        }
        let responseRid = nextHttpRid
        nextHttpRid += 1
        storedHttpResponses[responseRid] = StoredHttpResponse(data: data, offset: 0)
        return [
            "status": http.statusCode,
            "statusText": HTTPURLResponse.localizedString(forStatusCode: http.statusCode),
            "url": (http.url ?? pending.request.url!).absoluteString,
            "headers": headerPairs,
            "rid": responseRid,
        ]
    }

    private func httpFetchReadBody(_ args: [String: Any]) throws -> [String: Any] {
        guard let rid = args["rid"] as? Int,
              var stored = storedHttpResponses[rid] else {
            // Already closed or empty: return EOF marker [1].
            return ["__bytes": Data([1]).base64EncodedString()]
        }
        if stored.offset >= stored.data.count {
            storedHttpResponses.removeValue(forKey: rid)
            return ["__bytes": Data([1]).base64EncodedString()]
        }
        let end = min(stored.offset + Self.httpChunkBytes, stored.data.count)
        var chunk = Data(stored.data[stored.offset..<end])
        chunk.append(0) // Trailing 0 indicates a data chunk in @tauri-apps/plugin-http
        stored.offset = end
        storedHttpResponses[rid] = stored
        return ["__bytes": chunk.base64EncodedString()]
    }

    private func httpFetchCancel(_ args: [String: Any]) {
        guard let rid = args["rid"] as? Int else { return }
        pendingHttpRequests.removeValue(forKey: rid)
        inflightHttpTasks.removeValue(forKey: rid)?.cancel()
    }

    private func httpFetchCancelBody(_ args: [String: Any]) {
        guard let rid = args["rid"] as? Int else { return }
        storedHttpResponses.removeValue(forKey: rid)
    }

    // MARK: - Private documents & atomic 0600 writer

    /// Atomic write at mode 0600 — shared by private files and `roots.json`,
    /// matching `write_0600` in `src-tauri/src/private_store.rs`.
    nonisolated static func write0600(to url: URL, data: Data) throws {
        let dir = url.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let tmp = dir.appendingPathComponent(".\(url.lastPathComponent).tmp")
        try data.write(to: tmp, options: [.atomic])
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: tmp.path)
        if FileManager.default.fileExists(atPath: url.path) {
            _ = try FileManager.default.replaceItemAt(url, withItemAt: tmp)
        } else {
            try FileManager.default.moveItem(at: tmp, to: url)
        }
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }

    private func privateName(_ args: [String: Any]) throws -> String {
        guard let name = args["name"] as? String, Self.privateFiles.contains(name) else {
            throw BridgeError.failed("unknown private file")
        }
        return name
    }

    private func readPrivateFile(_ name: String) throws -> String? {
        let url = configDir.appendingPathComponent(name)
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        return try String(contentsOf: url, encoding: .utf8)
    }

    private func writePrivateFile(_ name: String, contents: String) throws {
        let url = configDir.appendingPathComponent(name)
        try Self.write0600(to: url, data: Data(contents.utf8))
    }

    private func deletePrivateFile(_ name: String) throws {
        let url = configDir.appendingPathComponent(name)
        if FileManager.default.fileExists(atPath: url.path) {
            try FileManager.default.removeItem(at: url)
        }
    }

    // MARK: - Folder grants

    /// Ask the user for a folder and remember the grant.
    @MainActor
    private func pickGalleryRoot() throws -> String? {
        // A test hook: `--seed-folder <path>` answers the picker with that
        // path instead of showing a panel, so the app's own add flow can be
        // exercised end to end without a human at the file dialog. The grant
        // is still made the same way — the path is recorded and bookmarked
        // exactly as a picked folder is.
        if let seeded = seededPickPath {
            seededPickPath = nil
            let url = URL(fileURLWithPath: seeded)
            guard folderStore.add(folder: url) != nil else {
                throw BridgeError.failed("that folder could not be remembered for access")
            }
            recordGalleryRoot(url.path)
            return url.path
        }
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.prompt = "Add"
        panel.message = "Choose a folder of photographs to view in place."

        guard panel.runModal() == .OK, let url = panel.url else { return nil }
        guard folderStore.add(folder: url) != nil else {
            throw BridgeError.failed("that folder could not be remembered for access")
        }
        // The path is the catalogue's record of what the user chose; the
        // grant itself is the bookmark, which only this binary can resolve.
        recordGalleryRoot(url.path)
        return url.path
    }

    /// Re-open the scopes for the roots the user has already chosen.
    ///
    /// Security scopes are runtime state and reset when the app restarts, so
    /// every launch has to take them again. The renderer cannot forge an
    /// entry here: the list comes from the picker-approved roots, never from
    /// the page. If a root in `roots.json` was picked in the Tauri shell and
    /// does not yet have a bookmark in `FolderStore`, backfill one while the
    /// directory is reachable on disk.
    func registerSavedGalleryRoots() throws {
        let roots = savedGalleryRoots()
        for root in roots {
            if folderStore.grantIfKnown(root) == nil {
                var isDir: ObjCBool = false
                if FileManager.default.fileExists(atPath: root, isDirectory: &isDir), isDir.boolValue {
                    if let entry = folderStore.add(folder: URL(fileURLWithPath: root)) {
                        _ = folderStore.startAccess(entry)
                    }
                }
            }
        }
        // Only live, bookmark-resolved roots enter `grantedRoots` — a vanished
        // or unmounted directory in `roots.json` does not grant access.
        grantedRoots.replace(folderStore.grantedRoots())
        onRootsChanged?()
    }

    /// Open a granted root in Finder ("Open folder" on a gallery card).
    ///
    /// The path must be a picker-granted root or inside one — the same
    /// boundary the media handler enforces — so the renderer can only ever
    /// reveal folders the user already granted. Finder does the display;
    /// the app reads nothing, so no security scope needs taking here.
    private func revealGalleryRoot(_ raw: String) throws {
        let wanted = URL(fileURLWithPath: raw).standardizedFileURL
        let inside = grantedRoots.all().contains { root in
            let base = root.standardizedFileURL.path
            let prefix = base.hasSuffix("/") ? base : base + "/"
            return wanted.path == base || wanted.path.hasPrefix(prefix)
        }
        guard inside else { throw BridgeError.failed("That folder is not a granted gallery root") }
        guard NSWorkspace.shared.selectFile(nil, inFileViewerRootedAtPath: wanted.path) else {
            throw BridgeError.failed("Finder could not open that folder")
        }
    }

    /// The picker-approved roots, as paths.
    ///
    /// Cached: the fs plugin asks about the roots for every path it is
    /// handed, and re-reading `roots.json` for each one is a cost the app
    /// does not need to pay. The cache is dropped when a root is recorded.
    func savedGalleryRoots() -> [String] {
        rootsLock.lock()
        defer { rootsLock.unlock() }
        if let cached = cachedRoots { return cached }
        let url = configDir.appendingPathComponent("roots.json")
        guard let data = try? Data(contentsOf: url),
              let roots = try? JSONSerialization.jsonObject(with: data) as? [String] else {
            cachedRoots = []
            return []
        }
        cachedRoots = roots
        return roots
    }

    /// Told when the granted roots change, so the shell can refresh what
    /// the media handler answers for.
    var onRootsChanged: (() -> Void)?

    /// Record a picker-approved root at mode 0600.
    func recordGalleryRoot(_ root: String) {
        var roots = savedGalleryRoots()
        if !roots.contains(root) {
            roots.append(root)
            if let data = try? JSONSerialization.data(withJSONObject: roots) {
                let url = configDir.appendingPathComponent("roots.json")
                try? Self.write0600(to: url, data: data)
            }
            rootsLock.lock()
            cachedRoots = roots
            rootsLock.unlock()
        }
        // The page scans the folder it has just picked, so the grant has to
        // be in place now — not when the shell's refresh lands.
        grantedRoots.replace(folderStore.grantedRoots())
        onRootsChanged?()
    }

    /// A path the renderer asked for, checked against the granted roots.
    ///
    /// The renderer may name a path, but never a path outside a root the
    /// user picked — the same rule the Tauri build's fs scopes enforce.
    private func grantedPath(_ args: [String: Any]) throws -> URL {
        guard let raw = args["path"] as? String else {
            throw BridgeError.badArguments("a path is required")
        }
        let url = URL(fileURLWithPath: raw).resolvingExistingSymlinksInPath()
        for root in grantedRoots.all() {
            let resolved = root.resolvingExistingSymlinksInPath()
            let rootParts = resolved.pathComponents
            let parts = url.pathComponents
            if parts.count >= rootParts.count, parts.starts(with: rootParts) { return url }
        }
        throw BridgeError.failed("that path is outside every folder you have granted")
    }

    private func readDir(_ args: [String: Any]) async throws -> [[String: Any]] {
        let url = try grantedPath(args)
        // Directory enumeration plus a header probe per image is real I/O
        // — a large folder must not stall the window while it lists.
        return try await offMain {
            let entries = try FileManager.default.contentsOfDirectory(
                at: url,
                includingPropertiesForKeys: [.isDirectoryKey, .isRegularFileKey, .isSymbolicLinkKey],
                options: [.skipsHiddenFiles]
            )
            return entries.map { entry in
                let values = try? entry.resourceValues(forKeys: [.isDirectoryKey, .isRegularFileKey, .isSymbolicLinkKey])
                var record: [String: Any] = [
                    "name": entry.lastPathComponent,
                    "isDirectory": values?.isDirectory ?? false,
                    "isFile": values?.isRegularFile ?? false,
                    "isSymlink": values?.isSymbolicLink ?? false,
                ]
                if values?.isRegularFile == true, let dims = Self.imageDimensions(entry) {
                    record["width"] = dims.width
                    record["height"] = dims.height
                }
                return record
            }
        }
    }

    /// The extensions the renderer's scanner picks up — probing anything
    /// else is wasted ImageIO work on a directory listing.
    private static let imageExtensions: Set<String> = ["jpg", "jpeg", "png", "webp", "avif", "heic", "heif"]

    /// Displayed pixel dims read from the file's header — ImageIO answers
    /// without decoding the image, so a directory listing stays cheap.
    /// Orientations 5–8 swap the pair, the same rule the web bundle's
    /// `displayedImageDimensions` applies, so the box a frame reserves
    /// matches what the browser draws.
    private static func imageDimensions(_ url: URL) -> (width: Int, height: Int)? {
        guard imageExtensions.contains(url.pathExtension.lowercased()),
              let source = CGImageSourceCreateWithURL(url as CFURL, nil),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [String: Any],
              let width = (properties[kCGImagePropertyPixelWidth as String] as? NSNumber)?.intValue,
              let height = (properties[kCGImagePropertyPixelHeight as String] as? NSNumber)?.intValue,
              width > 0, height > 0
        else { return nil }
        let orientation = (properties[kCGImagePropertyOrientation as String] as? NSNumber)?.intValue ?? 1
        return orientation >= 5 ? (height, width) : (width, height)
    }

    private func readFile(_ args: [String: Any]) async throws -> [String: Any] {
        let url = try grantedPath(args)
        let data = try await offMain { try Data(contentsOf: url, options: [.mappedIfSafe]) }
        return ["__bytes": data.base64EncodedString()]
    }

    // MARK: - The vault

    /// A vault path, checked against the vault root.
    ///
    /// The path arrives from the page, so it is never trusted: it must carry
    /// the vault's own prefix and must not climb out of the root.
    nonisolated private func vaultPath(_ logical: String) throws -> URL {
        let prefix = "\(Self.vaultDirName)/"
        guard logical.hasPrefix(prefix) else {
            throw BridgeError.failed("that is not a vault path")
        }
        let relative = String(logical.dropFirst(prefix.count))
        guard !relative.isEmpty, !relative.contains("\\") else {
            throw BridgeError.failed("that vault path escapes the vault")
        }
        let components = relative.split(separator: "/", omittingEmptySubsequences: false)
        guard !components.isEmpty,
              !components.contains(where: { $0.isEmpty || $0 == "." || $0 == ".." }) else {
            throw BridgeError.failed("that vault path escapes the vault")
        }
        let root = vaultRoot.standardizedFileURL.resolvingSymlinksInPath()
        let candidate = vaultRoot.appendingPathComponent(relative)
            .standardizedFileURL.resolvingSymlinksInPath()
        let rootParts = root.pathComponents
        let parts = candidate.pathComponents
        guard parts.count >= rootParts.count, parts.starts(with: rootParts) else {
            throw BridgeError.failed("that vault path escapes the vault")
        }
        return candidate
    }

    nonisolated private func writeVaultFile(_ url: URL, bytes: Data) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try bytes.write(to: url, options: [.atomic])
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }

    /// Every file under the vault root, with its logical path and size.
    ///
    /// A missing root is an empty walk, not an error — a fresh vault reports
    /// zero files.
    nonisolated private func listVault() throws -> [[String: Any]] {
        var files: [[String: Any]] = []
        let root = vaultRoot
        guard FileManager.default.fileExists(atPath: root.path) else { return files }
        guard let enumerator = FileManager.default.enumerator(
            at: root,
            includingPropertiesForKeys: [.fileSizeKey, .isRegularFileKey],
            options: [.skipsHiddenFiles]
        ) else { return files }
        for case let url as URL in enumerator {
            let values = try? url.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey])
            guard values?.isRegularFile == true else { continue }
            let relative = url.path.replacingOccurrences(of: root.path + "/", with: "")
            files.append([
                "path": "\(Self.vaultDirName)/\(relative)",
                "bytes": values?.fileSize ?? 0,
            ])
        }
        return files
    }

    /// Matches `vault_log` in `src-tauri/src/lib.rs`: removes any legacy
    /// `vault-debug.log` outside the vault root, rotates past 512 KB, and
    /// keeps mode `0600`.
    nonisolated func appendVaultLog(_ line: String) throws {
        let legacy = configDir.appendingPathComponent("vault-debug.log")
        if FileManager.default.fileExists(atPath: legacy.path) {
            try? FileManager.default.removeItem(at: legacy)
        }
        let target = vaultRoot.appendingPathComponent("vault-debug.log")
        try FileManager.default.createDirectory(at: vaultRoot, withIntermediateDirectories: true)
        let size = (try? FileManager.default.attributesOfItem(atPath: target.path)[.size] as? Int) ?? 0
        let oversized = size > Self.vaultLogMaxBytes
        let millis = Int64(Date().timeIntervalSince1970 * 1000)
        var text = ""
        if oversized {
            text += "\(millis) vault-debug.log rotated past \(Self.vaultLogMaxBytes) bytes\n"
        }
        text += "\(millis) \(line)\n"
        if !oversized, let handle = try? FileHandle(forWritingTo: target) {
            handle.seekToEndOfFile()
            handle.write(Data(text.utf8))
            try? handle.close()
            try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: target.path)
        } else {
            try Self.write0600(to: target, data: Data(text.utf8))
        }
    }

    // MARK: - The Keychain

    private func keychainGet(_ name: String) throws -> String? {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Self.keychainService,
            kSecAttrAccount as String: name,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = item as? Data else {
            throw BridgeError.failed("the keychain refused the read")
        }
        return String(data: data, encoding: .utf8)
    }

    private func keychainSet(_ name: String, _ value: String) throws {
        let data = Data(value.utf8)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Self.keychainService,
            kSecAttrAccount as String: name,
        ]
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock,
        ]
        let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var insert = query
            insert.merge(attributes) { current, _ in current }
            let addStatus = SecItemAdd(insert as CFDictionary, nil)
            guard addStatus == errSecSuccess else {
                throw BridgeError.failed("the keychain refused the write")
            }
            return
        }
        guard status == errSecSuccess else {
            throw BridgeError.failed("the keychain refused the write")
        }
    }

    private func keychainRemove(_ name: String) throws {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Self.keychainService,
            kSecAttrAccount as String: name,
        ]
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw BridgeError.failed("the keychain refused the delete")
        }
        // A resolved delete is not proof of deletion.
        if (try? keychainGet(name)) != nil {
            throw BridgeError.failed("the key survived the delete")
        }
    }

    // MARK: - Bytes

    /// The bytes a command's arguments carried, if any.
    private func decodeBytes(_ args: [String: Any]) -> Data? {
        guard let encoded = args["__bytes"] as? String else { return nil }
        return Data(base64Encoded: encoded)
    }
}

/// Run a blocking piece of work off the main actor.
///
/// The window must never stall while a vault record — megabytes of
/// ciphertext — is read or written.
private func offMain<T>(_ work: @escaping () throws -> T) async throws -> T {
    try await withCheckedThrowingContinuation { continuation in
        DispatchQueue.global(qos: .userInitiated).async {
            do { continuation.resume(returning: try work()) }
            catch { continuation.resume(throwing: error) }
        }
    }
}

/// A command the shell could not carry out.
enum BridgeError: LocalizedError {
    case badArguments(String)
    case failed(String)

    var errorDescription: String? {
        switch self {
        case .badArguments(let why): return why
        case .failed(let why): return why
        }
    }
}
