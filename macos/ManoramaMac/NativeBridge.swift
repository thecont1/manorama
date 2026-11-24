import AppKit
import ApplicationServices
import Carbon.HIToolbox
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

    /// The shared access group profiled builds carry in their
    /// `keychain-access-groups` entitlement. Items in the data-protection
    /// keychain under this group are readable by any binary signed by team
    /// 373K7W3LKU with the entitlement — App Store today, a Developer ID
    /// build once a profile is embedded — with no per-item prompt. Direct
    /// builds carry no profile, cannot carry the restricted entitlement at
    /// all, and land in the legacy store instead. The name is deliberately
    /// not derived from the bundle id: the same entitlements file signs
    /// test bundles whose CFBundleIdentifier differs, and a bundle-id-
    /// derived group would lose them custody.
    private static let keychainAccessGroup = "373K7W3LKU.manorama.shared"

    /// The private documents the renderer may read and write.
    ///
    /// A fixed allowlist, never a caller-supplied path — the same list the
    /// Tauri build keeps.
    private static let privateFiles: Set<String> = ["session.json", "catalogue.json", "providers.json", "library-prefs.json", "device.json"]

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
    /// Whether this launch was seeded with `--seed-drop`.
    let hasSeededDrop: Bool
    /// The directories a `--seed-drop` run drops once the page is ready.
    private var seededDropPaths: [String]?

    /// A dropped directory held for the page's commit or discard. `url`
    /// is the path the page names — the lookup key; `scoped` is the URL
    /// the security scope was actually started on (the dragged URL for a
    /// real drop, a bookmark-resolved one for a seeded path).
    private struct PendingDrop {
        let url: URL
        let scoped: URL
        /// Whether THIS scope was started here — balanced on release.
        let started: Bool
    }
    /// Dropped directories awaiting commit — scoped for reading and
    /// thumbnails but never bookmarked, so an abandoned sheet cannot
    /// become a durable grant. Expires on its own after ten minutes.
    private var pendingDrops: [PendingDrop] = []
    private var pendingDropExpiry: DispatchWorkItem?
    /// The sequence that identifies the current drop — every drop bumps it
    /// and the event carries it, so the page echoes it back on commit and a
    /// commit for a replaced drop can be refused rather than allowed to
    /// spend the pending set its successor now owns.
    private var pendingDropSeq = 0
    private static let pendingDropTTL: TimeInterval = 10 * 60
    private static let maxPendingDrops = 50

    /// The cached picker-approved roots, and the lock that guards them.
    private var cachedRoots: [String]?
    private let rootsLock = NSLock()

    /// The folders the user has granted, shared with the media handler.
    private let grantedRoots: GrantedRoots

    /// Ephemeral loopback HTTP server for Google Drive installed-app OAuth.
    private let oauthLoopback = OAuthLoopbackServer()

    /// The account-auth sheet — App Review's macOS design rule keeps
    /// authentication inside the app. ASWebAuthenticationSession does not
    /// qualify on macOS: it hands the page to the default browser, the
    /// exact symptom guideline 4.0.0 names. The sheet is a WKWebView
    /// window whose navigation delegate intercepts the provider's
    /// redirect to this app's scheme and feeds it to deliverDeepLink —
    /// the same path an OS deep link takes.
    private var authSheet: AuthSheetController?

    /// Custom-scheme deep links (`in.thecontrarian.manorama.desktop://...`) received by the app.
    private var currentDeepLinks: [String] = []
    /// URLs buffered for get_current whose live emit has not yet confirmed —
    /// the read-once call must skip them so a racing read cannot deliver
    /// the same link the emit is about to land.
    private var inFlightDeepLinks: Set<String> = []
    /// Whether this document has installed its listeners and read the launch URLs.
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

        // `--seed-drop <a,b,c>` replays a folder drop once the page is
        // ready — the same pending/commit pipeline a real drag runs,
        // minus the AppKit callbacks. Initialised before the seed-folder
        // block below, which calls an instance method and so needs every
        // stored property settled first.
        if let seeded = Self.seededDrop {
            seededDropPaths = seeded
            hasSeededDrop = true
        } else {
            seededDropPaths = nil
            hasSeededDrop = false
        }

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

    /// The folders a test run asks to be dropped, comma-separated.
    static var seededDrop: [String]? {
        let arguments = CommandLine.arguments
        guard let index = arguments.firstIndex(of: "--seed-drop"), index + 1 < arguments.count else { return nil }
        let paths = arguments[index + 1].split(separator: ",").map(String.init).filter { !$0.isEmpty }
        return paths.isEmpty ? nil : paths
    }

    /// The app's private directory — the Tauri build's, so the two shells
    /// share one account, one catalogue and one vault.
    static func defaultConfigDir() -> URL {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSTemporaryDirectory())
        return support.appendingPathComponent("in.thecontrarian.manorama.desktop", isDirectory: true)
    }

    // MARK: - Deep links

    /// A closed or replaced document has lost its listeners. Keep undelivered
    /// URLs for the replacement's read-once get_current call.
    func resetDeepLinkReadiness() {
        pageReadyForDeepLinks = false
        // An emit into a dead document can never confirm — release the
        // in-flight marks so the replacement's get_current can read them.
        inFlightDeepLinks.removeAll()
    }

    /// Buffer until the document is listening; a live delivery is never replayed.
    func deliverDeepLink(_ urlString: String) {
        Trace.log("deliverDeepLink ready=\(pageReadyForDeepLinks) host=\(URL(string: urlString)?.host ?? urlString)")
        guard pageReadyForDeepLinks, let webView else {
            if !currentDeepLinks.contains(urlString) {
                currentDeepLinks.append(urlString)
            }
            return
        }
        guard let data = try? JSONSerialization.data(withJSONObject: [urlString]),
              let arrayJson = String(data: data, encoding: .utf8),
              // Top-level fragments need the flag — a bare String throws
              // without it, and a thrown single literal used to take the
              // array emit down with it.
              let singleData = try? JSONSerialization.data(withJSONObject: urlString, options: [.fragmentsAllowed]),
              let singleJson = String(data: singleData, encoding: .utf8) else { return }
        // The URL joins the read-once buffer before the emit so a document
        // replacement mid-flight still finds it — but marked in-flight, so
        // a get_current that races the emit does not hand the page the same
        // URL twice. __manoramaShellEmit && (...) reports undefined — not
        // an error — so the script answers a Bool, and the completion runs
        // on the main actor where assumeIsolated keeps the bookkeeping
        // synchronous.
        if !currentDeepLinks.contains(urlString) {
            currentDeepLinks.append(urlString)
        }
        inFlightDeepLinks.insert(urlString)
        let script = """
        window.__manoramaShellEmit ? (
          window.__manoramaShellEmit("deep-link://new-url", \(arrayJson)),
          window.__manoramaShellEmit("manorama://deep-link", \(singleJson)),
          true
        ) : false;
        """
        webView.evaluateJavaScript(script) { [weak self] result, error in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.inFlightDeepLinks.remove(urlString)
                if error == nil, result as? Bool == true {
                    self.currentDeepLinks.removeAll { $0 == urlString }
                } else {
                    Trace.log("deep-link delivery unconfirmed — buffered for get_current (\(error?.localizedDescription ?? "no listener"))")
                }
            }
        }
    }

    // MARK: - Account auth

    /// Runs an account-auth URL in the in-app sheet — the only
    /// presentation that keeps sign-in inside the app on macOS.
    ///
    /// The provider flow ends by redirecting to this app's registered
    /// scheme; the sheet's navigation delegate hands that URL to
    /// deliverDeepLink, the same path an OS deep link would have taken,
    /// so the page's exchange never learns which door the URL came
    /// through. Closing the sheet is the user's own cancel — the page's
    /// in-memory PKCE verifier simply goes unused.
    ///
    /// Returns false only when the Library window is not there to anchor
    /// the sheet — the caller then keeps the system-browser open rather
    /// than stranding sign-in.
    private func openAuthSheet(_ url: URL) -> Bool {
        guard let parent = webView?.window else { return false }
        if let sheet = authSheet, !sheet.isFinished {
            sheet.load(url)
            return true
        }
        authSheet = AuthSheetController(url: url, parent: parent, title: Self.authSheetTitle(for: url)) { [weak self] callback in
            guard let self else { return }
            self.authSheet = nil
            if let callback {
                self.deliverDeepLink(callback.absoluteString)
            }
        }
        Trace.log("auth sheet opened \(url.host ?? "")\(url.path)")
        return true
    }

    /// What the sheet's titlebar says — the provider when the path names
    /// one, and Connect rather than Sign in for the `?link=` flow.
    private static func authSheetTitle(for url: URL) -> String {
        let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        if query.contains(where: { $0.name == "link" }) { return "Connect account" }
        let parts = url.path.split(separator: "/")
        guard parts.count == 2 else { return "Sign in" }
        return "Sign in with \(String(parts[1]).capitalized)"
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
        /// Matches `src-tauri/src/lib.rs` `device_kind()`: the generic
        /// platform family only — never the model, the name or a serial.
        case "device_kind":
            return "mac"
        case "device_id":
            return try stableDeviceId()

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
        case "commit_dropped_roots":
            return try commitDroppedRoots(args)
        case "discard_dropped_roots":
            try discardDroppedRoots(args)
            return nil

        case "plugin:opener|open_url":
            guard let raw = args["url"] as? String,
                  let url = NativeCapabilities.isAllowedOpenerURL(raw) else {
                throw BridgeError.failed("URL is not allowed by opener capability")
            }
            // Account auth stays inside the app — App Review 4.0.0
            // rejects a sign-in that hands the user to the default
            // browser. The sheet intercepts the provider's redirect to
            // our scheme and returns it through deliverDeepLink, the same
            // path an OS-opened deep link takes.
            if NativeCapabilities.isAccountAuthURL(url), openAuthSheet(url) {
                return nil
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

        case "share_post":
            return try sharePost(args)

        case "plugin:deep-link|get_current":
            // installDesktopAuth awaits both deep-link subscriptions before
            // this call. Unrelated event listeners do not make a page ready.
            pageReadyForDeepLinks = true
            // Read-once: a handoff that failed (no in-memory verifier, an
            // expired token) must not replay its error on every launch.
            // In-flight URLs stay buffered — their live emit may still
            // land, and handing them out here would deliver the link twice.
            let buffered = currentDeepLinks.filter { !inFlightDeepLinks.contains($0) }
            currentDeepLinks.removeAll { !inFlightDeepLinks.contains($0) }
            return buffered.isEmpty ? NSNull() : buffered

        case "plugin:event|listen":
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
        case "read_file_range":
            return try await readFileRange(args)

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
        rebuildGrantedRoots()
        onRootsChanged?()
    }

    // MARK: - Drag-and-drop folder grants

    /// The granted set is the store's bookmarks plus any pending drop
    /// scopes — one formula, so a call site cannot refresh the committed
    /// half and silently drop the pending one.
    func rebuildGrantedRoots() {
        grantedRoots.replace(folderStore.grantedRoots() + pendingDrops.map(\.scoped))
    }

    /// A file drag is hovering the window — counts only, nothing scoped.
    func folderDragEnter(folders: Int, files: Int) {
        emitFolderEvent("manorama://folder-drag-enter", ["folders": folders, "files": files])
    }

    func folderDragLeave() {
        emitFolderEvent("manorama://folder-drag-leave", [:])
    }

    /// The drop itself: the previous uncommitted set goes first, then each
    /// directory is scoped pending — never bookmarked, so nothing here can
    /// become a durable grant by accident.
    func receiveDrop(urls: [URL], files: Int) {
        releaseAllPendingDrops()
        var kept: [PendingDrop] = []
        var seen = Set<String>()
        for url in urls {
            guard kept.count < Self.maxPendingDrops else { break }
            guard let pending = pendingDrop(for: url) else { continue }
            let key = pending.scoped.resolvingExistingSymlinksInPath().standardizedFileURL.path
            guard !seen.contains(key) else {
                release(pending)
                continue
            }
            seen.insert(key)
            kept.append(pending)
        }
        pendingDrops = kept
        pendingDropSeq += 1
        armPendingDropExpiry()
        rebuildGrantedRoots()
        emitFolderEvent("manorama://folders-dropped", [
            "paths": kept.map { $0.url.path },
            "files": files,
            "drop": pendingDropSeq,
        ])
    }

    /// `--seed-drop` replays the drop pipeline once the page is ready —
    /// every step except the AppKit drag callbacks is the real one.
    func receiveSeededDrop() {
        guard let paths = seededDropPaths, !paths.isEmpty else { return }
        seededDropPaths = nil
        receiveDrop(urls: paths.map { URL(fileURLWithPath: $0) }, files: 0)
    }

    /// Scope one dragged URL for pending access, or nil when it is not a
    /// usable directory. A real drag answers `resourceValues` inside the
    /// drag promise; a seeded path may need its ephemeral bookmark before
    /// the sandbox lets us even look.
    private func pendingDrop(for url: URL) -> PendingDrop? {
        let usable = Self.droppedDirectoryStatus(url)
        if usable == false { return nil }
        if usable == true, url.startAccessingSecurityScopedResource() {
            return PendingDrop(url: url, scoped: url, started: true)
        }
        // Either the sandbox hid the metadata (a seeded path — no drag
        // promise) or the dragged URL refused a direct scope. An ephemeral
        // bookmark is the remaining way in; it lives in memory only and is
        // never written to folders.json, so the pending set still cannot
        // outlive its commit or discard.
        var bookmarkStale = false
        guard let bookmark = try? url.bookmarkData(options: [.withSecurityScope], includingResourceValuesForKeys: nil, relativeTo: nil),
              let scoped = try? URL(resolvingBookmarkData: bookmark, options: [.withSecurityScope], relativeTo: nil, bookmarkDataIsStale: &bookmarkStale),
              scoped.startAccessingSecurityScopedResource() else {
            // A dragged directory whose scope simply would not start still
            // gets a pending row — reads fail honestly as 'unreadable'.
            return usable == true ? PendingDrop(url: url, scoped: url, started: false) : nil
        }
        guard Self.droppedDirectoryStatus(scoped) == true else {
            scoped.stopAccessingSecurityScopedResource()
            return nil
        }
        return PendingDrop(url: url, scoped: scoped, started: true)
    }

    /// Whether a dragged URL is a usable drop directory — a real directory,
    /// not a package. Nil when the sandbox will not even answer metadata
    /// (a path with no drag promise and no scope yet).
    private static func droppedDirectoryStatus(_ url: URL) -> Bool? {
        guard let values = try? url.resourceValues(forKeys: [.isDirectoryKey, .isPackageKey]),
              let isDirectory = values.isDirectory else { return nil }
        return isDirectory && values.isPackage != true
    }

    /// The page's Add: each named path that is still pending becomes a
    /// real grant — the same `folderStore.add` + `recordGalleryRoot` a
    /// picked folder takes — and leaves the pending set. Paths are lookup
    /// keys only; anything not pending grants nothing.
    private func commitDroppedRoots(_ args: [String: Any]) throws -> [String] {
        guard let raw = args["paths"] as? [String] else {
            throw BridgeError.badArguments("commit_dropped_roots needs paths")
        }
        // The page echoes the drop's sequence — a commit for a replaced
        // drop must not spend the pending set its successor now owns.
        if let seq = args["drop"] as? Int, seq != pendingDropSeq {
            throw BridgeError.failed("the drop was replaced")
        }
        let wanted = Set(raw.map { URL(fileURLWithPath: $0).standardizedFileURL.path })
        var committed: [String] = []
        var remaining: [PendingDrop] = []
        for pending in pendingDrops {
            guard wanted.contains(pending.url.standardizedFileURL.path) else {
                remaining.append(pending)
                continue
            }
            guard let entry = folderStore.add(folder: pending.url) else {
                // Could not be bookmarked — leave it pending so the page's
                // discard or the expiry collects the scope.
                remaining.append(pending)
                continue
            }
            _ = folderStore.startAccess(entry)
            if pending.started { pending.scoped.stopAccessingSecurityScopedResource() }
            // The grant is durable now — the same recordGalleryRoot a
            // picked folder writes, roots.json included.
            recordGalleryRoot(pending.url.path)
            committed.append(pending.url.path)
        }
        pendingDrops = remaining
        armPendingDropExpiry()
        rebuildGrantedRoots()
        return committed
    }

    /// Release pending scopes — the named ones, or all of them when the
    /// page sends no `paths`. Roots already committed in FolderStore are
    /// never touched: only the pending set lives here.
    private func discardDroppedRoots(_ args: [String: Any]) throws {
        if let raw = args["paths"] as? [String] {
            let wanted = Set(raw.map { URL(fileURLWithPath: $0).standardizedFileURL.path })
            for pending in pendingDrops where wanted.contains(pending.url.standardizedFileURL.path) {
                release(pending)
            }
            pendingDrops.removeAll { wanted.contains($0.url.standardizedFileURL.path) }
        } else {
            releaseAllPendingDrops()
        }
        armPendingDropExpiry()
        rebuildGrantedRoots()
    }

    private func release(_ pending: PendingDrop) {
        if pending.started { pending.scoped.stopAccessingSecurityScopedResource() }
    }

    /// Stop every pending scope and empty the set — the shell's own
    /// cleanup for a replaced drop, a discard-all, and expiry.
    private func releaseAllPendingDrops() {
        for pending in pendingDrops { release(pending) }
        pendingDrops.removeAll()
        pendingDropExpiry?.cancel()
        pendingDropExpiry = nil
    }

    /// An abandoned sheet must not hold security scopes forever — the
    /// pending set expires on its own after ten minutes.
    private func armPendingDropExpiry() {
        pendingDropExpiry?.cancel()
        guard !pendingDrops.isEmpty else { pendingDropExpiry = nil; return }
        let work = DispatchWorkItem { [weak self] in
            MainActor.assumeIsolated { self?.expirePendingDrops() }
        }
        pendingDropExpiry = work
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.pendingDropTTL, execute: work)
    }

    private func expirePendingDrops() {
        Trace.log("pending drop scopes expired")
        releaseAllPendingDrops()
        rebuildGrantedRoots()
    }

    /// Folder-drag events reach the page through the same shell emitter
    /// deep links use, with one addition: a seeded drop can land before
    /// the page's listener mounts, so delivery retries until the page arms
    /// `__manoramaFolderDropArmed` (set by the drop subscription) or the
    /// retries run out.
    private func emitFolderEvent(_ event: String, _ payload: [String: Any]) {
        guard let webView,
              let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8) else { return }
        let script = """
        (function(){
          var payload = \(json);
          var deliver = function(){
            if (window.__manoramaFolderDropArmed === true && window.__manoramaShellEmit) {
              window.__manoramaShellEmit("\(event)", payload);
              return true;
            }
            return false;
          };
          if (deliver()) return;
          var tries = 0;
          var timer = setInterval(function(){ tries += 1; if (deliver() || tries > 40) clearInterval(timer); }, 250);
        })();
        """
        webView.evaluateJavaScript(script, completionHandler: nil)
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

    /// "Post to X": stage the prepared photographs where the OS can reach
    /// them, then open the X composer.
    ///
    /// X on the Mac is a website, not a sharing service — there is no
    /// activity sheet to hand files to. The photographs go on the
    /// pasteboard as file URLs and the composer opens in the browser; a
    /// paste attaches them to the post. They are staged in the temporary
    /// directory, are never a saved copy, and the previous post's staging
    /// is swept on every call — what is on the clipboard is always the
    /// latest set.
    private func sharePost(_ args: [String: Any]) throws -> Any? {
        guard let files = args["files"] as? [[String: Any]], !files.isEmpty else {
            throw BridgeError.badArguments("share_post needs files")
        }
        let text = args["text"] as? String ?? ""

        let temporary = FileManager.default.temporaryDirectory
        let folder = temporary.appendingPathComponent(
            "manorama-post-\(UUID().uuidString)", isDirectory: true
        )
        // The previous post's staging is removed only after the new files
        // are on the clipboard — the pasteboard keeps pointing at files
        // that exist if this call fails halfway.
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)

            var urls: [URL] = []
            for file in files {
                guard let name = file["name"] as? String, !name.isEmpty, !name.contains("/"),
                      let data = file["data"] as? String,
                      let bytes = Data(base64Encoded: data) else {
                    throw BridgeError.badArguments("share_post files need name and data")
                }
                let url = folder.appendingPathComponent(name)
                try bytes.write(to: url)
                urls.append(url)
            }

            let pasteboard = NSPasteboard.general
            pasteboard.clearContents()
            guard pasteboard.writeObjects(urls as [NSURL]) else {
                throw BridgeError.failed("The photographs could not be put on the clipboard")
            }
        } catch {
            try? FileManager.default.removeItem(at: folder)
            throw error
        }
        if let stale = try? FileManager.default.contentsOfDirectory(
            at: temporary, includingPropertiesForKeys: nil
        ) {
            for url in stale where url.lastPathComponent.hasPrefix("manorama-post-") && url != folder {
                try? FileManager.default.removeItem(at: url)
            }
        }
        var parts = URLComponents(string: "https://x.com/intent/post")!
        parts.queryItems = [URLQueryItem(name: "text", value: text)]
        guard let intent = parts.url, NSWorkspace.shared.open(intent) else {
            throw BridgeError.failed("The X composer could not be opened")
        }
        attemptPostPaste(into: intent)
        return "The photographs are on your clipboard — paste them into the post."
    }

    /// One-time guard for the Accessibility prompt — asked once ever, so a
    /// denial is a silent fall back to the manual paste, not a nag.
    private static let postPastePromptedKey = "post-to-x-ax-prompted"

    /// Best-effort automatic paste: an Accessibility-trusted app may press
    /// ⌘V in the browser for the owner. Trust is asked for exactly once;
    /// without it, or when the browser cannot be resolved, this returns and
    /// the draft's own first line teaches the paste by hand.
    private func attemptPostPaste(into intent: URL) {
        guard AXIsProcessTrusted() else {
            guard !UserDefaults.standard.bool(forKey: Self.postPastePromptedKey) else { return }
            UserDefaults.standard.set(true, forKey: Self.postPastePromptedKey)
            _ = AXIsProcessTrustedWithOptions(
                ["AXTrustedCheckOptionPrompt": true] as CFDictionary
            )
            return
        }
        guard let browser = NSWorkspace.shared.urlForApplication(toOpen: intent),
              let bundleID = Bundle(url: browser)?.bundleIdentifier else { return }
        Task { [weak self] in
            await self?.pasteWhenComposerReady(bundleID)
        }
    }

    /// There is no way to watch the composer's text field take focus — the
    /// intent page focuses it as the page hydrates. Holding until the
    /// browser owns the front, then a breath for the page, is the honest
    /// approximation; posting into a browser that lost the front would be
    /// worse than not posting at all.
    private func pasteWhenComposerReady(_ bundleID: String) async {
        let deadline = Date().addingTimeInterval(6)
        while NSWorkspace.shared.frontmostApplication?.bundleIdentifier != bundleID,
              Date() < deadline {
            try? await Task.sleep(nanoseconds: 150_000_000)
        }
        guard NSWorkspace.shared.frontmostApplication?.bundleIdentifier == bundleID else { return }
        try? await Task.sleep(nanoseconds: 2_500_000_000)
        guard NSWorkspace.shared.frontmostApplication?.bundleIdentifier == bundleID else { return }
        let source = CGEventSource(stateID: .hidSystemState)
        guard let down = CGEvent(keyboardEventSource: source, virtualKey: CGKeyCode(kVK_ANSI_V), keyDown: true),
              let up = CGEvent(keyboardEventSource: source, virtualKey: CGKeyCode(kVK_ANSI_V), keyDown: false) else { return }
        down.flags = .maskCommand
        up.flags = .maskCommand
        down.post(tap: .cghidEventTap)
        up.post(tap: .cghidEventTap)
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
        rebuildGrantedRoots()
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

    /// A bounded window of a granted file — the embedded-metadata probe asks
    /// for a few hundred KB at a time and must never pull whole photographs
    /// into the webview. Reading past EOF answers with whatever is left,
    /// possibly nothing.
    private static let maxRangeBytes = 4 * 1024 * 1024

    private func readFileRange(_ args: [String: Any]) async throws -> [String: Any] {
        let url = try grantedPath(args)
        guard let start = args["start"] as? Int, let length = args["length"] as? Int else {
            throw BridgeError.badArguments("read_file_range needs start and length")
        }
        guard start >= 0, length > 0, length <= Self.maxRangeBytes else {
            throw BridgeError.badArguments("read_file_range bounds are start >= 0 and 0 < length <= 4 MiB")
        }
        let data = try await offMain { () throws -> Data in
            let handle = try FileHandle(forReadingFrom: url)
            defer { try? handle.close() }
            try handle.seek(toOffset: UInt64(start))
            // read(upToCount:) throws where the legacy readData(ofLength:)
            // raised an NSException — a mid-range I/O error must surface as
            // a thrown error, never as a crash. Nil is plain EOF: an empty
            // window, exactly what reading past the end answers.
            return try handle.read(upToCount: length) ?? Data()
        }
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

    /// The identity a synced row names. A random UUID minted once and kept
    /// in the shared Keychain — the same place vault keys live — so it
    /// survives the catalogue resets and reinstalls that were proven to
    /// orphan synced rows as mirrors that can never render. It is not a
    /// serial, MAC address or hardware UUID: the privacy rule `device_label`
    /// documents stays true.
    private static let deviceIdAccount = "device-id"

    private func stableDeviceId() throws -> String {
        if let existing = try keychainGet(Self.deviceIdAccount), !existing.isEmpty {
            return existing
        }
        let minted = UUID().uuidString.lowercased()
        try keychainSet(Self.deviceIdAccount, minted)
        return minted
    }

    /// The item identity every keychain operation against `name` shares.
    /// On its own it is also the *legacy* query — verbatim the shape
    /// pre-access-group builds ran against the file-based login keychain,
    /// where each item's ACL is bound to the creating binary's signature.
    /// Adding the data-protection + access-group keys turns it into the
    /// shared query (see `sharedQuery`).
    private func legacyQuery(_ name: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Self.keychainService,
            kSecAttrAccount as String: name,
        ]
    }

    /// The shared-custody form of `legacyQuery`: the data-protection
    /// keychain plus the team's shared access group, so every build
    /// signed by team 373K7W3LKU carrying the entitlement resolves the
    /// same item with no OS prompt.
    private func sharedQuery(_ name: String) -> [String: Any] {
        var query = legacyQuery(name)
        query[kSecUseDataProtectionKeychain as String] = true
        query[kSecAttrAccessGroup as String] = Self.keychainAccessGroup
        return query
    }

    /// A read against the shared store that preserves its OSStatus, so a
    /// refusal is distinguishable from a confirmed absence.
    private func keychainReadShared(_ name: String) -> (value: String?, status: OSStatus) {
        var query = sharedQuery(name)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        guard status == errSecSuccess, let data = item as? Data,
              let value = String(data: data, encoding: .utf8) else {
            return (nil, status)
        }
        return (value, status)
    }

    /// A read against the legacy file-based store only — verbatim the
    /// query the old builds ran, so items an older signature wrote are
    /// still found. Every failure answers nil, the dismissed ACL prompt
    /// included: a legacy miss is an ordinary miss and a denied read is
    /// never a reason to crash.
    private func keychainGetLegacy(_ name: String) -> String? {
        var query = legacyQuery(name)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    /// Read a vault key or the device id. The shared store is asked
    /// first; a *confirmed absence* — or a build that does not carry the
    /// access-group entitlement at all, where every shared query is
    /// refused — falls back to the legacy login keychain, where items
    /// written before the access group existed still live under an ACL
    /// bound to the old binary's signature. Any other refusal propagates:
    /// an operational failure is not a missing key, and answering from
    /// the wrong store would lie. A legacy hit is migrated on the spot —
    /// the one prompt that ACL forces on first read is the last the item
    /// ever shows, after which every team-signed build shares custody.
    private func keychainGet(_ name: String) throws -> String? {
        let (value, status) = keychainReadShared(name)
        if status == errSecSuccess { return value }
        guard status == errSecItemNotFound || status == errSecMissingEntitlement else {
            throw BridgeError.failed("the keychain refused the read")
        }
        guard let value = keychainGetLegacy(name) else { return nil }
        // Migrate custody: the shared copy is written before the legacy
        // item is touched, so a failed write can never strand the key —
        // a write that fails simply retries on the next read.
        do {
            try keychainSet(name, value)
        } catch {
            Trace.log("keychain migration of \(name) deferred — the write was refused")
        }
        return value
    }

    /// Write into `store` (a query dict already carrying the access-group
    /// keys or not) — update-then-insert. The raw status comes back so a
    /// missing entitlement is distinguishable from an operational refusal.
    private func keychainWrite(_ query: [String: Any], _ value: String) -> OSStatus {
        let attributes: [String: Any] = [
            kSecValueData as String: Data(value.utf8),
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock,
        ]
        let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var insert = query
            insert.merge(attributes) { current, _ in current }
            return SecItemAdd(insert as CFDictionary, nil)
        }
        return status
    }

    private func keychainSet(_ name: String, _ value: String) throws {
        let shared = keychainWrite(sharedQuery(name), value)
        if shared == errSecSuccess {
            // Keep the file-based copy in sync rather than sweeping it:
            // the Tauri shell's keyring store reads the legacy keychain
            // only, so a delete would strand its custody of the same key.
            // Best-effort — the shared store is already authoritative,
            // and a denied legacy write costs the Tauri leg nothing the
            // old world did not already cost it.
            _ = keychainWrite(legacyQuery(name), value)
            return
        }
        // Only a build without the access-group entitlement may fall back
        // to the file store. Any other refusal means the shared store
        // declined a query the entitlement says is valid — and reporting
        // success for a value the shared read on this same build will not
        // answer hides a real fault, so it propagates instead.
        guard shared == errSecMissingEntitlement else {
            throw BridgeError.failed("the shared keychain refused the write")
        }
        guard keychainWrite(legacyQuery(name), value) == errSecSuccess else {
            throw BridgeError.failed("the keychain refused the write")
        }
    }

    /// The legacy store's verbatim answer to a read probe — removal
    /// verification's status check, where a denied read must never
    /// collapse into "absent" the way `keychainGetLegacy` deliberately
    /// lets it for ordinary reads.
    private func keychainProbeLegacy(_ name: String) -> OSStatus {
        var query = legacyQuery(name)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        var item: CFTypeRef?
        return SecItemCopyMatching(query as CFDictionary, &item)
    }

    private func keychainRemove(_ name: String) throws {
        // Best-effort in the shared store — a missing-entitlement delete
        // answers the same miss an absent item would, and the throwing
        // probe below is what separates a refused read from a confirmed
        // absence.
        SecItemDelete(sharedQuery(name) as CFDictionary)
        // The legacy delete's status matters: its per-item ACL can refuse,
        // and a refusal leaves the item behind. Anything but success or a
        // clean miss fails here rather than guessing at the verify.
        let legacyDelete = SecItemDelete(legacyQuery(name) as CFDictionary)
        guard legacyDelete == errSecSuccess || legacyDelete == errSecItemNotFound else {
            throw BridgeError.failed("the keychain refused the delete")
        }
        // A resolved delete is not proof of deletion — and the item is
        // only gone when NEITHER store still holds it. keychainGet is
        // deliberately not used here: its migration path would copy a
        // surviving legacy item straight back into the shared store. The
        // probes are the status-checking kind — the nil-on-denial readers
        // would call a refused read a removal. A missing entitlement is
        // the one refusal that skips verification: a build without the
        // group can neither delete nor read the shared store, and the
        // legacy verdict below is the only one it can give.
        switch keychainReadShared(name).status {
        case errSecSuccess:
            throw BridgeError.failed("the key survived the delete")
        case errSecItemNotFound, errSecMissingEntitlement:
            break
        default:
            throw BridgeError.failed("the keychain refused the read")
        }
        switch keychainProbeLegacy(name) {
        case errSecSuccess:
            throw BridgeError.failed("the key survived the delete")
        case errSecItemNotFound:
            break
        default:
            throw BridgeError.failed("the keychain refused the read")
        }
    }

    // MARK: - Bytes

    /// The bytes a command's arguments carried, if any.
    private func decodeBytes(_ args: [String: Any]) -> Data? {
        guard let encoded = args["__bytes"] as? String else { return nil }
        return Data(base64Encoded: encoded)
    }
}

/// The in-app window account auth runs in.
///
/// App Review 4.0.0 (macOS) keeps sign-in inside the app, and
/// ASWebAuthenticationSession does not do that on macOS — it hands the
/// page to the default browser, the exact symptom the guideline names.
/// This sheet is a plain WKWebView window instead: the provider's web
/// flow renders inside it, and the final redirect to this app's
/// registered scheme is intercepted in decidePolicyFor and handed to the
/// bridge's deep-link path.
///
/// The class stays nonisolated like ViewerCoordinator — WebKit and
/// AppKit call its delegates on the main thread, and the completion is
/// typed @MainActor so the bridge hears it synchronously.
private final class AuthSheetController: NSObject, WKNavigationDelegate, WKUIDelegate, NSWindowDelegate {
    /// This app's own scheme — the destination every auth flow ends on.
    private static let callbackScheme = "in.thecontrarian.manorama.desktop"

    private let window: NSWindow
    private let webView: WKWebView
    private let backButton: NSButton
    private let forwardButton: NSButton
    private let reloadButton: NSButton
    /// Called once, with the callback URL — nil when the user closed the
    /// sheet first. @MainActor so the bridge can settle state directly.
    private var onFinish: (@MainActor (URL?) -> Void)?
    private var finished = false

    init(url: URL, parent: NSWindow, title: String, onFinish: @escaping @MainActor (URL?) -> Void) {
        self.onFinish = onFinish
        let size = NSSize(width: 980, height: 720)
        window = NSWindow(
            contentRect: NSRect(origin: .zero, size: size),
            styleMask: [.titled, .closable, .resizable, .miniaturizable],
            backing: .buffered,
            defer: false
        )
        window.title = title
        window.isReleasedWhenClosed = false
        window.contentMinSize = NSSize(width: 520, height: 420)

        // A slim header above the page: auth flows are linear, but error
        // pages offer "try again" links and a web view with no chrome
        // would strand the user on one.
        let header = NSView(frame: NSRect(x: 0, y: size.height - 34, width: size.width, height: 34))
        header.autoresizingMask = [.width, .minYMargin]
        backButton = Self.navButton("chevron.left", action: #selector(goBack))
        forwardButton = Self.navButton("chevron.right", action: #selector(goForward))
        reloadButton = Self.navButton("arrow.clockwise", action: #selector(reloadPage))
        backButton.frame = NSRect(x: 10, y: 7, width: 20, height: 20)
        forwardButton.frame = NSRect(x: 34, y: 7, width: 20, height: 20)
        reloadButton.frame = NSRect(x: 58, y: 7, width: 20, height: 20)
        header.addSubview(backButton)
        header.addSubview(forwardButton)
        header.addSubview(reloadButton)
        window.contentView?.addSubview(header)

        webView = WKWebView(frame: NSRect(x: 0, y: 0, width: size.width, height: size.height - 34),
                            configuration: WKWebViewConfiguration())
        webView.autoresizingMask = [.width, .height]
        window.contentView?.addSubview(webView)

        super.init()
        webView.navigationDelegate = self
        webView.uiDelegate = self
        backButton.target = self
        forwardButton.target = self
        reloadButton.target = self
        window.delegate = self

        parent.addChildWindow(window, ordered: .above)
        // Centre on the Library window rather than the screen.
        window.setFrameOrigin(NSPoint(
            x: parent.frame.midX - size.width / 2,
            y: parent.frame.midY - size.height / 2
        ))
        window.makeKeyAndOrderFront(nil)
        window.makeFirstResponder(webView)
        webView.load(URLRequest(url: url))
        updateNavButtons()
    }

    /// A second auth request while the sheet is up reuses it — the new
    /// provider's page simply replaces whatever was on screen.
    func load(_ url: URL) {
        guard !finished else { return }
        window.makeKeyAndOrderFront(nil)
        webView.load(URLRequest(url: url))
    }

    var isFinished: Bool { finished }

    private static func navButton(_ symbol: String, action: Selector) -> NSButton {
        let button = NSButton(
            image: NSImage(systemSymbolName: symbol, accessibilityDescription: nil)
                ?? NSImage(),
            target: nil,
            action: action
        )
        button.bezelStyle = .toolbar
        button.isBordered = false
        button.imageScaling = .scaleProportionallyDown
        button.contentTintColor = .secondaryLabelColor
        return button
    }

    @objc private func goBack() { webView.goBack() }
    @objc private func goForward() { webView.goForward() }
    @objc private func reloadPage() { webView.reload() }

    private func updateNavButtons() {
        backButton.isEnabled = webView.canGoBack
        forwardButton.isEnabled = webView.canGoForward
    }

    // MARK: WKNavigationDelegate

    func webView(_ webView: WKWebView,
                 decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.cancel)
            return
        }
        // The provider's redirect back to this app's scheme is the
        // callback — stop the load and hand the URL to the deep-link path.
        if url.scheme?.lowercased() == Self.callbackScheme {
            decisionHandler(.cancel)
            finish(with: url)
            return
        }
        // Outbound links on auth pages (help, legal, provider pickers)
        // belong to the user's browser — a page that navigates itself
        // somewhere it cannot return from would strand the flow, and the
        // opener scope still decides what may leave at all. Subframes are
        // left alone: consent and ad iframes navigate constantly and none
        // of them is the user's intent.
        let mainFrame = navigationAction.targetFrame?.isMainFrame ?? true
        if mainFrame {
            let scheme = url.scheme?.lowercased() ?? ""
            let inline = ["https", "http", "about", "blob", "data"].contains(scheme)
            if !inline {
                decisionHandler(.cancel)
                if NativeCapabilities.isAllowedOpenerURL(url.absoluteString) != nil {
                    NSWorkspace.shared.open(url)
                }
                return
            }
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        updateNavButtons()
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        updateNavButtons()
    }

    // MARK: WKUIDelegate — links that want a new window

    /// target=_blank and window.open stay inside the sheet — an auth page
    /// that pops a provider chooser must not lose the flow to Safari.
    func webView(_ webView: WKWebView,
                 createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction,
                 windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url,
           (navigationAction.request.httpMethod ?? "GET").uppercased() == "GET" {
            self.webView.load(URLRequest(url: url))
        }
        return nil
    }

    // MARK: NSWindowDelegate

    func windowWillClose(_ notification: Notification) {
        finish(with: nil)
    }

    // MARK: finish

    /// Close once and report — the callback URL on success, nil on cancel.
    /// Both delegate paths funnel here so a close during a navigation
    /// cannot report twice.
    private func finish(with url: URL?) {
        guard !finished else { return }
        finished = true
        let callback = onFinish
        onFinish = nil
        window.delegate = nil
        window.close()
        if let callback {
            MainActor.assumeIsolated { callback(url) }
        }
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
