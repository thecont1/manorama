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
        /// The URL could not be understood.
        case badURL
    }

    /// The viewer bundle's root on disk.
    var bundleRoot: URL
    /// The folders currently granted, keyed by the token the page uses.
    private var mediaRoots: [String: URL] = [:]

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
        case "app":
            let relative = url.path.hasPrefix("/") ? String(url.path.dropFirst()) : url.path
            guard !relative.isEmpty else { return .badURL }
            guard let target = containedPath(root: bundleRoot, relative: relative) else {
                return .forbidden
            }
            return .file(url: target, mimeType: Self.mimeType(for: target.pathExtension))

        case "media":
            let components = url.path.split(separator: "/", omittingEmptySubsequences: false)
            guard components.count >= 2 else { return .badURL }
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
    /// The check is on the *standardised* path, not the string: `..`
    /// segments are collapsed first, so `%2e%2e` and `../` are caught by
    /// the same rule, and a symlink is followed by the standardiser.
    private func containedPath(root: URL, relative: String) -> URL? {
        guard !relative.contains("..") else { return nil }
        let candidate = root.appendingPathComponent(relative).standardizedFileURL
        let rootPath = root.standardizedFileURL.path
        guard candidate.path.hasPrefix(rootPath) else { return nil }
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

    /// The live security scopes, keyed by token.
    private struct ScopedAccess {
        let url: URL
        let started: Bool
    }
    private var heldScopes: [String: ScopedAccess] = [:]

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
            let response = HTTPURLResponse(
                url: url, statusCode: 403, httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "text/plain"]
            )!
            urlSchemeTask.didReceive(response)
            urlSchemeTask.didFinish()

        case .notFound:
            let response = HTTPURLResponse(
                url: url, statusCode: 404, httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "text/plain"]
            )!
            urlSchemeTask.didReceive(response)
            urlSchemeTask.didFinish()

        case .file(let fileURL, let mimeType):
            // A vanished file answers 404, so the page can tell "this
            // photograph is gone" from "this photograph failed to decode".
            guard let data = try? Data(contentsOf: fileURL) else {
                let response = HTTPURLResponse(
                    url: url, statusCode: 404, httpVersion: "HTTP/1.1",
                    headerFields: ["Content-Type": "text/plain"]
                )!
                urlSchemeTask.didReceive(response)
                urlSchemeTask.didFinish()
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
        }
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {}
}
