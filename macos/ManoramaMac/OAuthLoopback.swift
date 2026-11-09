import Darwin
import Foundation

/// Ephemeral loopback HTTP receiver for Google's installed-app OAuth, plus
/// capability-scoped URL validation for the opener and HTTP plugins.
///
/// Mirrors `src-tauri/src/lib.rs` (`LoopbackHandle`, `oauth_target_from`,
/// `oauth_loopback_begin`, `oauth_loopback_cancel`, `oauth_loopback_finish`)
/// and the URL scopes in `src-tauri/capabilities/default.json`.
enum NativeCapabilities {
    /// Matches `src-tauri/capabilities/default.json` `opener:allow-open-url`,
    /// plus `mailto:` which the desktop Library's upgrade and support links use.
    static func isAllowedOpenerURL(_ raw: String) -> URL? {
        guard let url = URL(string: raw.trimmingCharacters(in: .whitespacesAndNewlines)),
              let scheme = url.scheme?.lowercased() else { return nil }
        switch scheme {
        case "https":
            guard let host = url.host, !host.isEmpty else { return nil }
            return url
        case "http":
            guard let host = url.host?.lowercased(),
                  host == "localhost" || host == "127.0.0.1",
                  url.port == 5173 else { return nil }
            return url
        case "mailto":
            return url
        default:
            return nil
        }
    }

    /// Matches `src-tauri/capabilities/default.json` `http:default`:
    /// `https://*.proton.me`, `https://*.protonvpn.com`,
    /// `https://g.api.mega.co.nz` and `https://*.userstorage.mega.co.nz` —
    /// the MEGA entries let the native transport reach the ufa attribute
    /// endpoint, whose answers carry no CORS headers.
    static func isAllowedHttpURL(_ raw: String) -> URL? {
        guard let url = URL(string: raw.trimmingCharacters(in: .whitespacesAndNewlines)),
              url.scheme?.lowercased() == "https",
              let host = url.host?.lowercased() else { return nil }
        if host == "proton.me" || host.hasSuffix(".proton.me")
            || host == "protonvpn.com" || host.hasSuffix(".protonvpn.com")
            || host == "g.api.mega.co.nz"
            || host == "userstorage.mega.co.nz" || host.hasSuffix(".userstorage.mega.co.nz") {
            return url
        }
        return nil
    }
}

/// One in-flight loopback listener for Google's installed-app OAuth.
///
/// Google forbids custom-scheme redirects for desktop clients; the documented
/// path is an ephemeral `http://127.0.0.1:<port>` receiver. Only a `GET`
/// carrying `/?...code=` or `/?...error=` consumes the listener — stray probes
/// or favicon fetches receive `400 Bad Request` and leave the flow waiting.
final class OAuthLoopbackServer: @unchecked Sendable {
    private final class Handle: @unchecked Sendable {
        let fd: Int32
        let port: UInt16
        private let lock = NSLock()
        private var claimed = false
        private var cancelled = false

        init(fd: Int32, port: UInt16) {
            self.fd = fd
            self.port = port
        }

        deinit {
            close(fd)
        }

        func claim() -> Bool {
            lock.lock()
            defer { lock.unlock() }
            if claimed { return false }
            claimed = true
            return true
        }

        func cancel() {
            lock.lock()
            cancelled = true
            lock.unlock()
        }

        var isCancelled: Bool {
            lock.lock()
            defer { lock.unlock() }
            return cancelled
        }
    }

    private let stateLock = NSLock()
    private var current: Handle?

    static let timeoutSeconds: TimeInterval = 300
    static let readTimeoutSeconds: Int = 5
    static let pollMicroseconds: useconds_t = 50_000

    /// Only the provider redirect carries OAuth response params — anything else
    /// on the port (a probe, a favicon fetch, local noise) is not allowed to
    /// consume the one connection the flow is waiting for.
    static func oauthTarget(from requestLine: String) -> String? {
        let parts = requestLine.split(whereSeparator: { $0.isWhitespace })
        guard parts.count >= 2, parts[0] == "GET" else { return nil }
        let target = String(parts[1])
        guard target.hasPrefix("/?"),
              target.contains("code=") || target.contains("error=") else {
            return nil
        }
        return target
    }

    /// Binds `127.0.0.1:0` and returns the assigned port. Beginning a new flow
    /// cancels any listener still waiting on an abandoned one.
    func begin() throws -> UInt16 {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else {
            throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno), userInfo: [NSLocalizedDescriptionKey: "Could not open loopback socket"])
        }
        var yes: Int32 = 1
        _ = setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &yes, socklen_t(MemoryLayout<Int32>.size))

        var addr = sockaddr_in()
        addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = in_port_t(0).bigEndian
        addr.sin_addr = in_addr(s_addr: inet_addr("127.0.0.1"))

        let bindResult = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        guard bindResult == 0 else {
            let code = Int(errno)
            close(fd)
            throw NSError(domain: NSPOSIXErrorDomain, code: code, userInfo: [NSLocalizedDescriptionKey: "Could not bind loopback listener"])
        }
        guard Darwin.listen(fd, 8) == 0 else {
            let code = Int(errno)
            close(fd)
            throw NSError(domain: NSPOSIXErrorDomain, code: code, userInfo: [NSLocalizedDescriptionKey: "Could not listen on loopback socket"])
        }

        var bound = sockaddr_in()
        var len = socklen_t(MemoryLayout<sockaddr_in>.size)
        let nameResult = withUnsafeMutablePointer(to: &bound) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                getsockname(fd, $0, &len)
            }
        }
        guard nameResult == 0 else {
            let code = Int(errno)
            close(fd)
            throw NSError(domain: NSPOSIXErrorDomain, code: code, userInfo: [NSLocalizedDescriptionKey: "Could not read loopback port"])
        }

        let flags = fcntl(fd, F_GETFL, 0)
        _ = fcntl(fd, F_SETFL, flags | O_NONBLOCK)

        let port = UInt16(bigEndian: bound.sin_port)
        let handle = Handle(fd: fd, port: port)

        stateLock.lock()
        let previous = current
        current = handle
        stateLock.unlock()
        previous?.cancel()

        return port
    }

    /// Releases a waiting receiver when the front end abandons the flow.
    func cancel() {
        stateLock.lock()
        let previous = current
        current = nil
        stateLock.unlock()
        previous?.cancel()
    }

    private func currentHandle() -> Handle? {
        stateLock.lock()
        defer { stateLock.unlock() }
        return current
    }

    private func clearIfCurrent(_ handle: Handle) {
        stateLock.lock()
        if current === handle {
            current = nil
        }
        stateLock.unlock()
    }

    /// Waits for the browser's redirect, answers the matching request with a
    /// "return to the app" page, and resolves with its request target
    /// (`/?code=…&state=…`).
    func finish(timeout: TimeInterval = OAuthLoopbackServer.timeoutSeconds) async throws -> String {
        guard let handle = currentHandle(), handle.claim() else {
            throw NSError(domain: "ManoramaOAuth", code: 1, userInfo: [NSLocalizedDescriptionKey: "No loopback listener is waiting"])
        }

        defer {
            clearIfCurrent(handle)
        }

        return try await withCheckedThrowingContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                let deadline = Date().addingTimeInterval(timeout)
                while true {
                    if handle.isCancelled {
                        continuation.resume(throwing: NSError(domain: "ManoramaOAuth", code: 2, userInfo: [NSLocalizedDescriptionKey: "The provider connection was cancelled"]))
                        return
                    }
                    if Date() >= deadline {
                        continuation.resume(throwing: NSError(domain: "ManoramaOAuth", code: 3, userInfo: [NSLocalizedDescriptionKey: "Timed out waiting for the provider redirect"]))
                        return
                    }
                    var clientAddr = sockaddr_in()
                    var clientLen = socklen_t(MemoryLayout<sockaddr_in>.size)
                    let clientFd = withUnsafeMutablePointer(to: &clientAddr) {
                        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                            Darwin.accept(handle.fd, $0, &clientLen)
                        }
                    }
                    if clientFd < 0 {
                        if errno == EWOULDBLOCK || errno == EAGAIN {
                            usleep(Self.pollMicroseconds)
                            continue
                        }
                        continuation.resume(throwing: NSError(domain: NSPOSIXErrorDomain, code: Int(errno), userInfo: [NSLocalizedDescriptionKey: "Loopback accept failed"]))
                        return
                    }

                    // Ensure accepted socket is blocking with a bounded read timeout.
                    let cFlags = fcntl(clientFd, F_GETFL, 0)
                    _ = fcntl(clientFd, F_SETFL, cFlags & ~O_NONBLOCK)
                    var tv = timeval(tv_sec: Self.readTimeoutSeconds, tv_usec: 0)
                    _ = setsockopt(clientFd, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))

                    var buffer = [UInt8](repeating: 0, count: 16 * 1024)
                    let bytesRead = Darwin.read(clientFd, &buffer, buffer.count)
                    guard bytesRead > 0 else {
                        close(clientFd)
                        continue
                    }
                    let requestText = String(decoding: buffer[0..<bytesRead], as: UTF8.self)
                    let firstLine = requestText.split(whereSeparator: { $0 == "\r" || $0 == "\n" }).first.map(String.init) ?? ""
                    guard let target = Self.oauthTarget(from: firstLine) else {
                        let bad = "HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                        _ = bad.withCString { Darwin.write(clientFd, $0, bad.utf8.count) }
                        close(clientFd)
                        continue
                    }

                    let page = "<!doctype html><title>manorama</title><p>Connected. You can close this tab and return to manorama.</p>"
                    let response = "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: \(page.utf8.count)\r\nConnection: close\r\n\r\n\(page)"
                    _ = response.withCString { Darwin.write(clientFd, $0, response.utf8.count) }
                    close(clientFd)
                    continuation.resume(returning: target)
                    return
                }
            }
        }
    }
}
