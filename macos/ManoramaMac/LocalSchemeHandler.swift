import Foundation
import WebKit

/// The pure half of the local media handler: it maps a `manorama://` URL to
/// bytes, with no WebKit types involved.
///
/// Splitting it out is not decoration. It means the security-critical part
/// — which paths are reachable, what a traversal answers, what a deleted
/// file answers — is testable without a web view, and it keeps the
/// `WKURLSchemeHandler` conformance down to plumbing.
///
/// Two prefixes, each backed by a root the shell controls:
///
///   manorama://app/<path>     → the viewer bundle (inside the app)
///   manorama://media/<token>/<path>  → a picked folder, only while a scope
///                                       is open
///
/// The media prefix is only reachable for folders the user granted, and
/// only while their security scope is held. A path outside a granted root
/// answers 403, and a file that has vanished answers 404 — so the page can
/// tell "this photograph is gone" from "this photograph failed to decode".
final class LocalMediaResolver {
    /// What the handler should answer.
    enum Resolution {
        /// Serve these bytes.
        case file(url: URL, mimeType: String)
        /// The path was refused — outside a granted root, or a traversal.
        case forbidden
        /// The path was well-formed but the file is not there.
        case notFound
        /// The API, reached through the shell rather than read off disk.
        case api(String)
        /// The URL could not be understood.
        case badURL
    }

    /// The viewer bundle's root on disk.
    var bundleRoot: URL
    /// The folders currently granted, keyed by the token the page uses.
    private var mediaRoots: [String: URL] = [:]
    /// The folders the user has granted outright — the roots a picked
    /// folder lives under. The app addresses a file inside one of them by
    /// absolute path, and the answer is 403 unless it really is inside a
    /// granted root.
    var grantedRoots: () -> [URL] = { [] }

    init(bundleRoot: URL) {
        self.bundleRoot = bundleRoot
    }

    /// Register a granted folder and return the token the page uses for it.
    func grant(token: String, url: URL) {
        mediaRoots[token] = url
    }

    /// Revoke a folder's grant. The token stops resolving immediately.
    func revoke(token: String) {
        mediaRoots[token] = nil
    }

    /// Revoke every grant.
    func revokeAll() {
        mediaRoots.removeAll()
    }

    /// Resolve a request URL to a file.
    func resolve(_ url: URL) -> Resolution {
        guard let scheme = url.scheme?.lowercased(), scheme == "manorama" else {
            return .badURL
        }
        switch url.host ?? "" {
        case "localhost":
            // The app's own bundle. The host is `localhost` so the page's
            // origin is `manorama://localhost` — a real origin, which is
            // what lets the page's API calls stay same-origin.
            let relative = url.path.hasPrefix("/") ? String(url.path.dropFirst()) : url.path
            guard !relative.isEmpty else { return .badURL }
            // `/api/…` is not a file: it is the API, reached through the
            // shell so the call is same-origin and needs nothing deployed.
            if relative.hasPrefix("api/") { return .api(relative) }
            guard let target = containedPath(root: bundleRoot, relative: relative) else {
                return .forbidden
            }
            return .file(url: target, mimeType: Self.mimeType(for: target.pathExtension))

        case "media":
            let components = url.path.split(separator: "/", omittingEmptySubsequences: false)
            guard components.count >= 2 else { return .badURL }
            // `local` addresses a file by absolute path — the form the app's
            // own asset URLs take. It is answered only for a path inside a
            // root the user actually granted.
            if components[1] == "local" {
                guard components.count >= 3 else { return .badURL }
                // `url.path` arrives already decoded — joining it and
                // removingPercentEncoding again decodes twice, corrupting a
                // filename that legitimately contains "%". Decode once,
                // from the raw percent-encoded path.
                guard let encodedPath = URLComponents(url: url, resolvingAgainstBaseURL: false)?.percentEncodedPath,
                      encodedPath.hasPrefix("/local/") else { return .badURL }
                guard let decoded = String(encodedPath.dropFirst("/local/".count)).removingPercentEncoding else { return .badURL }
                let candidate = URL(fileURLWithPath: decoded)
                    .resolvingExistingSymlinksInPath()
                for root in grantedRoots() {
                    let resolved = root.resolvingExistingSymlinksInPath()
                    let rootParts = resolved.pathComponents
                    let parts = candidate.pathComponents
                    if parts.count >= rootParts.count, parts.starts(with: rootParts) {
                        return .file(url: candidate, mimeType: Self.mimeType(for: candidate.pathExtension))
                    }
                }
                return .forbidden
            }
            let token = String(components[1])
            guard let root = mediaRoots[token] else {
                // The folder was released or never granted.
                return .forbidden
            }
            let relative = components.dropFirst(2).joined(separator: "/")
            guard !relative.isEmpty else { return .badURL }
            guard let target = containedPath(root: root, relative: relative) else {
                return .forbidden
            }
            return .file(url: target, mimeType: Self.mimeType(for: target.pathExtension))

        default:
            return .badURL
        }
    }

    /// Join a relative path under a root, refusing anything that escapes it.
    ///
    /// The guard is component-wise, not substring-wise: a whole `..`
    /// component is a traversal and is refused, while a legitimate filename
    /// like `photo..2.jpg` stays servable. Containment is proven on resolved
    /// path components — never a raw prefix match, which a sibling like
    /// `/root-evil` would satisfy — and symlinks are resolved so a link
    /// inside the root pointing outside it answers forbidden too.
    private func containedPath(root: URL, relative: String) -> URL? {
        let components = relative.split(separator: "/", omittingEmptySubsequences: false)
        guard !components.contains("..") else { return nil }
        let resolvedRoot = root.resolvingExistingSymlinksInPath()
        let candidate = root.appendingPathComponent(relative)
            .resolvingExistingSymlinksInPath()
        let rootParts = resolvedRoot.pathComponents
        let candidateParts = candidate.pathComponents
        guard candidateParts.count > rootParts.count,
              candidateParts.starts(with: rootParts) else { return nil }
        return candidate
    }

    static func mimeType(for ext: String) -> String {
        switch ext.lowercased() {
        case "html": return "text/html; charset=utf-8"
        case "js", "mjs": return "text/javascript; charset=utf-8"
        case "css": return "text/css; charset=utf-8"
        case "json": return "application/json"
        case "map": return "application/json"
        case "svg": return "image/svg+xml"
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "webp": return "image/webp"
        case "avif": return "image/avif"
        case "gif": return "image/gif"
        case "heic", "heif": return "image/heic"
        case "woff2": return "font/woff2"
        case "woff": return "font/woff"
        case "ttf": return "font/ttf"
        default: return "application/octet-stream"
        }
    }
}

/// The WebKit adapter — thin plumbing over `LocalMediaResolver`.
///
/// The scope lifetime lives here rather than in the resolver, because
/// starting and stopping a security scope is the shell's business: a
/// scope held open for the lifetime of the open gallery is what lets the
/// page fetch originals lazily.
final class LocalSchemeHandler: NSObject, WKURLSchemeHandler {
    let resolver: LocalMediaResolver

    /// Why a photograph could not be served.
    ///
    /// The two are different facts, and the user must not be told the same
    /// thing about both. A file that is no longer on disk is the folder's
    /// business — it was moved, renamed or deleted. A file that is sitting
    /// on disk and still could not be opened is the *app's* business, and
    /// blaming the user's storage for it is a lie.
    enum MediaFailure {
        /// The file is not on disk any more.
        case gone
        /// The file is on disk, but the read failed.
        case unreadable(String)
    }

    /// A photograph that could not be served.
    ///
    /// The page cannot say much about this: it asked for a file and got a
    /// 404, which it treats as a frame that failed to load. The shell is
    /// the one that knows why the read failed, so it is the one that has to
    /// tell the user.
    ///
    /// Only media paths report it — a missing asset inside the viewer
    /// bundle is the app's own bug, not the user's missing photograph.
    var onMediaMissing: ((String, MediaFailure) -> Void)?

    /// The roots the user has granted.
    ///
    /// An absolute path in a media URL is answered only when it really is
    /// inside one of these.
    var grantedRoots: () -> [URL] {
        get { resolver.grantedRoots }
        set { resolver.grantedRoots = newValue }
    }

    /// The live security scopes, keyed by token.
    private struct ScopedAccess {
        let url: URL
        let started: Bool
    }
    private var heldScopes: [String: ScopedAccess] = [:]

    /// Tasks whose file read is still in flight — only these may be
    /// recorded as stopped. A stop arriving after a task finished (or for
    /// a path that answered synchronously) is ignored, so the stopped set
    /// never collects stale identifiers a recycled ObjectIdentifier could
    /// later collide with.
    private var inflightTasks: Set<ObjectIdentifier> = []
    /// Tasks whose file read was stopped before it completed — the
    /// background completion checks this set so a stopped task never
    /// answers the webview late.
    private var stoppedTasks: Set<ObjectIdentifier> = []
    /// Serial queue guarding `stoppedTasks` — WebKit calls start/stop on
    /// its own queue and the reads complete on a global one.
    private let stoppedTasksLock = NSLock()
    /// Where original bytes are read — never the caller's queue, which is
    /// WebKit's and would stall on a multi-hundred-megabyte file.
    private let readQueue = DispatchQueue(label: "in.thecontrarian.manorama.media-reads", qos: .userInitiated)

    init(bundleRoot: URL) {
        self.resolver = LocalMediaResolver(bundleRoot: bundleRoot)
    }

    /// Register a granted folder, starting its security scope.
    func grant(token: String, url: URL) {
        let started = url.startAccessingSecurityScopedResource()
        resolver.grant(token: token, url: url)
        heldScopes[token] = ScopedAccess(url: url, started: started)
    }

    /// Release a folder's scope. The token stops resolving immediately.
    func release(token: String) {
        if let scope = heldScopes[token], scope.started {
            scope.url.stopAccessingSecurityScopedResource()
        }
        heldScopes[token] = nil
        resolver.revoke(token: token)
    }

    /// Release every scope — called on teardown so no scope leaks.
    func releaseAll() {
        for (_, scope) in heldScopes where scope.started {
            scope.url.stopAccessingSecurityScopedResource()
        }
        heldScopes.removeAll()
        resolver.revokeAll()
    }

    /// The site the shell proxies the API to.
    private static let apiOrigin = URL(string: "https://manorama.xyz")!

    /// One ephemeral session for every proxied API call — creating a
    /// URLSession per request discards its connection pool and pays the
    /// setup cost on each photograph-adjacent API round-trip.
    private static let apiSession = URLSession(configuration: .ephemeral)

    /// When launched with `--config <dir>` (an isolated test run), never
    /// forward non-GET `/api/device-galleries` mutations to the live server so
    /// throwaway test `deviceId`s do not pollute the owner's remote feed.
    private static let isIsolatedTestConfig = CommandLine.arguments.contains("--config")

    /// Answer an API call from the shell.
    ///
    /// The page's origin is the shell's own scheme, so the API is reached
    /// through the shell rather than straight out to the site: the call
    /// stays same-origin, which needs no CORS allowlist entry and no
    /// deployment. The bearer token travels with the request exactly as the
    /// browser sent it — the shell adds no authority of its own.
    private func proxyAPI(relative: String, request: URLRequest, task: WKURLSchemeTask, taskID: ObjectIdentifier) {
        if Self.isIsolatedTestConfig,
           relative.hasPrefix("api/device-galleries"),
           (request.httpMethod ?? "GET").uppercased() != "GET" {
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                if self.wasStopped(taskID) {
                    self.clearStopped(taskID)
                    return
                }
                defer { self.clearStopped(taskID) }
                let body = Data("{\"ok\":true}".utf8)
                if let url = request.url,
                   let response = HTTPURLResponse(
                       url: url, statusCode: 200, httpVersion: "HTTP/1.1",
                       headerFields: ["Content-Type": "application/json", "Content-Length": "\(body.count)"]
                   ) {
                    task.didReceive(response)
                    task.didReceive(body)
                    task.didFinish()
                }
            }
            return
        }
        // The upstream keeps the request's raw percent-encoded path and its
        // query — `relative` is the decoded path, which the isolated-test
        // guard above evaluates, but a decoded re-encoding would not be the
        // URL the page actually asked for.
        let requestPath = request.url.flatMap {
            URLComponents(url: $0, resolvingAgainstBaseURL: false)?.percentEncodedPath
        }.map { $0.hasPrefix("/") ? String($0.dropFirst()) : $0 } ?? relative
        var target = requestPath
        if let query = request.url.flatMap({ URLComponents(url: $0, resolvingAgainstBaseURL: false)?.percentEncodedQuery }) {
            target += "?\(query)"
        }
        guard var upstream = URL(string: target, relativeTo: Self.apiOrigin) else {
            task.didFailWithError(URLError(.badURL))
            return
        }
        upstream = upstream.absoluteURL
        var outgoing = URLRequest(url: upstream)
        outgoing.httpMethod = request.httpMethod
        outgoing.httpBody = request.httpBody
        // The browser's own headers are carried across; the shell adds none.
        for (key, value) in request.allHTTPHeaderFields ?? [:] {
            outgoing.setValue(value, forHTTPHeaderField: key)
        }
        // The upstream must see the site it is, not the shell's scheme.
        outgoing.setValue(Self.apiOrigin.absoluteString, forHTTPHeaderField: "Origin")

        Self.apiSession.dataTask(with: outgoing) { [weak self] data, response, error in
            guard let self else { return }
            // WebKit delivers stop on the main queue — the stopped check
            // and every response call join it there, so a stop can never
            // interleave between the check and the answer. Answering a
            // stopped task throws, so this ordering is what keeps the
            // proxy from taking the app down.
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                // The page may have abandoned the request while it was in
                // flight. A stopped task is never answered.
                if self.wasStopped(taskID) {
                    self.clearStopped(taskID)
                    return
                }
                defer { self.clearStopped(taskID) }
                if let error {
                    task.didFailWithError(error)
                    return
                }
                guard let http = response as? HTTPURLResponse else {
                    task.didFailWithError(URLError(.badServerResponse))
                    return
                }
                var headers: [String: String] = [:]
                for (key, value) in http.allHeaderFields {
                    guard let name = key as? String, let text = value as? String else { continue }
                    // The body URLSession hands back has already been decoded,
                    // so the upstream's encoding and length no longer describe
                    // it. Carrying them over would describe the wrong bytes.
                    let lower = name.lowercased()
                    if lower == "content-encoding" || lower == "content-length" || lower == "transfer-encoding" {
                        continue
                    }
                    headers[name] = text
                }
                // The response is same-origin, so the browser's CORS check does
                // not apply — but the site sends an allow-origin for its own
                // origin, and that would not match the shell's.
                headers.removeValue(forKey: "Access-Control-Allow-Origin")
                // An upstream header the response object will not carry is not
                // a reason to take the app down: the response is rebuilt with
                // the one header that matters, and the status still stands.
                let url = request.url ?? upstream
                let response = HTTPURLResponse(
                    url: url, statusCode: http.statusCode, httpVersion: "HTTP/1.1", headerFields: headers
                ) ?? HTTPURLResponse(
                    url: url,
                    statusCode: http.statusCode,
                    httpVersion: "HTTP/1.1",
                    headerFields: ["Content-Type": headers["Content-Type"] ?? "application/json"]
                )
                guard let response else {
                    task.didFailWithError(URLError(.badServerResponse))
                    return
                }
                task.didReceive(response)
                task.didReceive(data ?? Data())
                task.didFinish()
            }
        }.resume()
    }

/// Tell the shell that a photograph could not be served.
    ///
    /// The name is the file's own, not a path: the user needs to know
    /// which photograph to look for, and the full path is noise. Only
    /// media paths report — a missing asset inside the viewer bundle is
    /// the app's own bug, not the user's missing photograph.
    private func reportMissing(_ url: URL, _ failure: MediaFailure) {
        guard url.host?.lowercased() == "media" else { return }
        let name = url.lastPathComponent.removingPercentEncoding ?? url.lastPathComponent
        onMediaMissing?(name, failure)
    }

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard let url = urlSchemeTask.request.url else {
            urlSchemeTask.didFailWithError(URLError(.badURL))
            return
        }

        switch resolver.resolve(url) {
        case .badURL:
            urlSchemeTask.didFailWithError(URLError(.badURL))

        case .forbidden:
            // 403: the path is outside every granted root. A silent 404
            // would hide a permission bug behind a missing-file message.
            if url.host?.lowercased() == "media" {
                // A refused original is a blank frame the user cannot
                // explain, so it is traced rather than swallowed.
                Trace.log("media refused: \(url.path)")
            }
            let response = HTTPURLResponse(
                url: url, statusCode: 403, httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "text/plain"]
            )!
            urlSchemeTask.didReceive(response)
            urlSchemeTask.didFinish()

        case .api(let relative):
            // The proxy answers later, so the task has to be one WebKit can
            // still stop: a request the page abandons must not be answered
            // afterwards — WebKit raises on a task that has been stopped.
            let taskID = ObjectIdentifier(urlSchemeTask)
            stoppedTasksLock.lock()
            inflightTasks.insert(taskID)
            stoppedTasksLock.unlock()
            proxyAPI(relative: relative, request: urlSchemeTask.request, task: urlSchemeTask, taskID: taskID)

        case .notFound:
            let response = HTTPURLResponse(
                url: url, statusCode: 404, httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "text/plain"]
            )!
            urlSchemeTask.didReceive(response)
            urlSchemeTask.didFinish()
            reportMissing(url, .gone)

        case .file(let fileURL, let mimeType):
            // Originals are large and reads belong off WebKit's queue —
            // mapped so a big file does not sit resident in memory.
            let taskID = ObjectIdentifier(urlSchemeTask)
            self.stoppedTasksLock.lock()
            self.inflightTasks.insert(taskID)
            self.stoppedTasksLock.unlock()
            readQueue.async { [weak self] in
                guard let self else { return }
                // A task stopped before its read starts owes nothing — the
                // identifier leaves the set with it so a recycled
                // ObjectIdentifier is never mistaken for it.
                if self.wasStopped(taskID) { self.clearStopped(taskID); return }
                // The reason the read failed is kept, not swallowed: a 404
                // that cannot be explained is a bug report waiting to
                // happen, and the trace is where the explanation lives.
                let read: Result<Data, Error>
                do {
                    read = .success(try Data(contentsOf: fileURL, options: [.mappedIfSafe]))
                } catch {
                    read = .failure(error)
                }
                // WebKit delivers stop on the main queue — the stopped
                // check and every response call join it there, so a stop
                // can never interleave between the check and the answer.
                DispatchQueue.main.async { [weak self] in
                    guard let self else { return }
                    if self.wasStopped(taskID) { self.clearStopped(taskID); return }
                    guard case .success(let data) = read else {
                        // A vanished file answers 404, so the page can tell
                        // "this photograph is gone" from "this photograph
                        // failed to decode".
                        let response = HTTPURLResponse(
                            url: url, statusCode: 404, httpVersion: "HTTP/1.1",
                            headerFields: ["Content-Type": "text/plain"]
                        )!
                        urlSchemeTask.didReceive(response)
                        urlSchemeTask.didFinish()
                        self.reportMissing(url, self.failure(for: fileURL, read))
                        self.clearStopped(taskID)
                        return
                    }
                    let response = HTTPURLResponse(
                        url: url, statusCode: 200, httpVersion: "HTTP/1.1",
                        headerFields: [
                            "Content-Type": mimeType,
                            "Content-Length": "\(data.count)",
                            // A rescan must not serve a stale frame.
                            "Cache-Control": "no-cache",
                        ]
                    )!
                    urlSchemeTask.didReceive(response)
                    urlSchemeTask.didReceive(data)
                    urlSchemeTask.didFinish()
                    self.clearStopped(taskID)
                }
            }
        }
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {
        let taskID = ObjectIdentifier(urlSchemeTask)
        stoppedTasksLock.lock()
        // Only a task still holding a read can be stopped — a late stop on
        // a finished task is noise, and recording it would pin the
        // identifier forever.
        if inflightTasks.remove(taskID) != nil {
            stoppedTasks.insert(taskID)
        }
        stoppedTasksLock.unlock()
    }

    /// Why a photograph could not be read.
    ///
    /// The file's absence and the read's failure are different facts. A
    /// file that is simply not there is the folder's business — the user
    /// moved it, renamed it or deleted it. A file that is *there* and
    /// still could not be opened is the app's own failure, and saying
    /// otherwise to the user would be a lie they would act on.
    private func failure(for fileURL: URL, _ read: Result<Data, Error>) -> MediaFailure {
        let reason: String
        if case .failure(let error) = read {
            reason = error.localizedDescription
        } else {
            reason = "the file could not be read"
        }
        // The trace names the path and the reason, so a report can be
        // acted on rather than merely believed.
        Trace.log("media read failed: \(fileURL.path) — \(reason)")
        guard FileManager.default.fileExists(atPath: fileURL.path) else { return .gone }
        return .unreadable(reason)
    }

    /// Whether this task's request was stopped before its read completed —
    /// the entry stays recorded so a late completion still drops out.
    private func wasStopped(_ taskID: ObjectIdentifier) -> Bool {
        stoppedTasksLock.lock()
        defer { stoppedTasksLock.unlock() }
        return stoppedTasks.contains(taskID)
    }

    /// Forget a task once it answered or was dropped — both sets only ever
    /// hold in-flight or stopped tasks, never every task the handler has
    /// ever served.
    private func clearStopped(_ taskID: ObjectIdentifier) {
        stoppedTasksLock.lock()
        inflightTasks.remove(taskID)
        stoppedTasks.remove(taskID)
        stoppedTasksLock.unlock()
    }
}

extension URL {
    /// Resolves symlinks in the path even when the leaf file or its immediate
    /// folder has been deleted (for instance `/tmp/disposable/photo.jpg` after
    /// `/tmp/disposable` is removed, where `/tmp` -> `/private/tmp` still exists).
    func resolvingExistingSymlinksInPath() -> URL {
        let standardized = self.standardizedFileURL
        if FileManager.default.fileExists(atPath: standardized.path) {
            return standardized.resolvingSymlinksInPath()
        }
        var current = standardized
        var tail: [String] = []
        while current.path != "/" && !FileManager.default.fileExists(atPath: current.path) {
            tail.append(current.lastPathComponent)
            current = current.deletingLastPathComponent()
        }
        var resolved = current.resolvingSymlinksInPath()
        for component in tail.reversed() {
            resolved.appendPathComponent(component)
        }
        return resolved.standardizedFileURL
    }
}
