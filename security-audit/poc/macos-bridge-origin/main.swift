import AppKit
import WebKit

/// Adversarial probe for the macOS shell's webview boundary.
///
/// Reproduces the app's own webview configuration (same scheme handler, same
/// message-handler name, same WKUIDelegate wiring) and loads the app's own
/// index page from `manorama://localhost`. Then it tries every route a page
/// has to reach a remote origin — a `target="_blank"` link, `window.open`,
/// and `location.assign` — and separately asks a *loaded* remote document
/// and a bundled child frame to drive the native bridge.
///
/// Everything the app itself would do is done by the app's own code paths:
/// ViewerCoordinator, LocalSchemeHandler and NativeBridge are the shipped
/// files, not copies. The system-browser hand-off is recorded through the
/// coordinator's `openExternal` seam rather than really opened.

let canaryToken = "AUDIT-CANARY-SESSION-TOKEN"

final class HarnessDelegate: NSObject, NSApplicationDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    var coordinator: ViewerCoordinator!
    var bridge: NativeBridge!
    var schemeHandler: LocalSchemeHandler!
    var root: URL!
    var remotePort: Int = 0
    /// URLs the coordinator handed to the "system browser".
    var opened: [URL] = []

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
        try makeBundle()

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
        coordinator.openExternal = { [weak self] url in self?.opened.append(url) }
        schemeHandler = LocalSchemeHandler(bundleRoot: root)

        let configuration = WKWebViewConfiguration()
        configuration.setURLSchemeHandler(schemeHandler, forURLScheme: "manorama")
        configuration.userContentController.add(coordinator, name: "manorama")
        webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 1200, height: 800), configuration: configuration)
        webView.navigationDelegate = coordinator
        webView.uiDelegate = coordinator
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

        // Sanity: the gate must not strangle the app's own document — a
        // main-frame invoke on the trusted origin still gets a reply.
        _ = try await js("""
            window.__rt = null;
            window.__manoramaShellSettle = (j) => { window.__rt = j; };
            window.webkit.messageHandlers.manorama.postMessage({ type: 'invoke', id: 1, cmd: 'read_private_file', args: { name: 'missing.json' } });
            'ok'
            """)
        var trustedReply = false
        for _ in 0..<50 {
            if (try await js("window.__rt === null ? 'null' : 'reply'")) == "reply" { trustedReply = true; break }
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
        print("STEP1a trusted document bridge reply: \(trustedReply ? "REPLY" : "SILENT")")

        // STEP2 — the remote origin must never render inside this web view.
        // Each external-link idiom should instead show up in `opened`.

        // Click the target=_blank link the Library ships (ad CTA / share
        // link). A synthetic .click() carries no user gesture, so WebKit
        // swallows the new window before createWebViewWith ever runs — the
        // assertion here is the security property: no navigation happens.
        // The opener routing itself is proven by window.open below, which
        // takes the same createWebViewWith path a gestured _blank would.
        _ = try await js("document.querySelector('a[target=_blank]').click()")
        try? await Task.sleep(nanoseconds: 2_000_000_000)
        print("STEP2a after target=_blank click: url=\(webView.url?.absoluteString ?? "?") opened=\(opened.map { $0.absoluteString })")

        // Second external-link idiom: window.open().
        _ = try await js("window.open(document.querySelector('a[target=_blank]').href, '_blank', 'noopener')")
        try? await Task.sleep(nanoseconds: 2_000_000_000)
        print("STEP2b after window.open: url=\(webView.url?.absoluteString ?? "?") opened=\(opened.map { $0.absoluteString })")

        // The renderer's other navigation path — a plain location change.
        _ = try await js("location.assign(document.querySelector('a[target=_blank]').href)")
        try? await Task.sleep(nanoseconds: 2_000_000_000)
        print("STEP2c after location.assign: url=\(webView.url?.absoluteString ?? "?") opened=\(opened.map { $0.absoluteString })")

        // The bundle is the only document the web view should ever hold up
        // to this point, and every external idiom belongs in `opened`.
        let stayedBundled = (webView.url?.absoluteString ?? "").hasPrefix("manorama://localhost")
        let remoteRouted = opened.contains { $0.absoluteString.contains("evil.html") }
        print("STEP2 summary: stayedBundled=\(stayedBundled) externalOpens=\(opened.count)")

        // STEP3 — a same-origin child frame loads (the nav policy allows the
        // bundle inside a frame) but its messages die at the isMainFrame gate.
        _ = try await js("""
            const f = document.createElement('iframe');
            f.src = 'manorama://localhost/frame.html';
            document.body.appendChild(f);
            'ok'
            """)
        // The frame posts and marks itself sent; the harness reads the
        // reply slot directly — in-page timers are throttled in subframes,
        // so waiting inside the page is not a measurement. First wait for
        // the frame's script to run at all (FR-SENT), then for a reply.
        var frameSent = false
        for _ in 0..<40 {
            if (try await js("document.querySelector('iframe')?.contentDocument?.title")) == "FR-SENT" { frameSent = true; break }
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
        var frameReply: String?
        if frameSent {
            for _ in 0..<40 {
                let rt = try await js("JSON.stringify(document.querySelector('iframe').contentWindow.__rt)")
                if rt != nil && rt != "null" { frameReply = rt; break }
                try? await Task.sleep(nanoseconds: 100_000_000)
            }
        }
        let frameSays = frameReply.map { "FR-RESULT: \($0)" } ?? (frameSent ? "FR-RESULT: null" : "NO FRAME SCRIPT")
        print("STEP3 child frame report: \(frameSays)")

        // STEP4 — the untrusted-document case for the message gate itself.
        // A remote URL can never commit (STEP2 proved that), so the closest
        // stand-in is an opaque about:blank document: not manorama://localhost,
        // so the origin check must refuse it. The document can still see the
        // handler — it is registered for every page — but any message it
        // sends must be dropped before the bridge parses it.
        webView.loadHTMLString(evil, baseURL: nil)
        try? await Task.sleep(nanoseconds: 3_000_000_000)
        print("STEP4 untrusted document url=\(webView.url?.absoluteString ?? "?") title=\(try await js("document.title") ?? "?")")
        // Same measurement as the frame: read the reply slot for a few
        // seconds rather than trusting the page's own timers.
        var remoteReply: String?
        for _ in 0..<50 {
            let rt = try await js("JSON.stringify(window.__rt)")
            if rt != nil && rt != "null" { remoteReply = rt; break }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        let result = "RESULT: title=\(try await js("document.title") ?? "?") | bridgeReply=\(remoteReply ?? "null")"
        print("STEP4 remote page says: \(result)")

        // Was the canary actually handed over, or did any untrusted context
        // get a bridge reply at all?
        let replyText = result.components(separatedBy: "bridgeReply=").dropFirst().first
        let remoteGotReply = replyText != nil && replyText != "null"
        let frameGotReply = frameSays.hasPrefix("FR-RESULT:") && frameSays != "FR-RESULT: null"
        let leaked = result.contains(canaryToken)
            || frameSays.contains(canaryToken)
            || remoteGotReply || frameGotReply || !stayedBundled || !remoteRouted
        if leaked {
            print("VERDICT: BRIDGE-LEAKED-SESSION-TOKEN")
        } else {
            print("VERDICT: BRIDGE-NOT-REACHABLE")
        }
    }

    /// index.html mimics the shipped Library's one relevant behaviour: an
    /// anchor with target="_blank" and rel="noopener". frame.html is the
    /// same-origin child frame that tries the bridge from a subframe.
    func makeBundle() throws {
        let index = """
        <!doctype html><html><head><meta charset="utf-8"><title>bundled</title></head>
        <body><h1>bundled library</h1>
        <a id="ad" href="http://localhost:\(remotePort)/evil.html" target="_blank" rel="noopener">sponsor</a>
        </body></html>
        """
        try index.write(to: root.appendingPathComponent("index.html"), atomically: true, encoding: .utf8)
        let frame = """
        <!doctype html><html><head><meta charset="utf-8"><title>frame</title></head><body>
        <script>
        (() => {
          window.__rt = null;
          window.__manoramaShellSettle = (j) => { window.__rt = j; };
          try {
            window.webkit.messageHandlers.manorama.postMessage({ type: 'invoke', id: 9, cmd: 'read_private_file', args: { name: 'session.json' } });
          } catch (e) {}
          document.title = 'FR-SENT';
        })();
        </script></body></html>
        """
        try frame.write(to: root.appendingPathComponent("frame.html"), atomically: true, encoding: .utf8)
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
  try {
    out.push('origin=' + location.origin);
    out.push('handler=' + !!(window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.manorama));
    // A cross-origin fetch to the custom scheme can hang on the shell's real
    // upstream — race it so the verdict is about the bridge, not the network.
    try {
      const r = await Promise.race([
        fetch('manorama://localhost/api/account').then(x => 'status ' + x.status),
        new Promise(res => setTimeout(() => res('TIMEOUT'), 2000)),
      ]);
      out.push('directFetch=' + r);
    } catch (e) { out.push('directFetch=BLOCKED'); }
    window.__rt = null;
    window.__manoramaShellSettle = (j) => { window.__rt = j; };
    try {
      window.webkit.messageHandlers.manorama.postMessage({ type: 'invoke', id: 7, cmd: 'read_private_file', args: { name: 'session.json' } });
    } catch (e) { out.push('post=THREW'); }
    document.title = 'PROGRESS: ' + out.join(' | ');
  } catch (e) { out.push('error=' + e); document.title = 'PROGRESS: ' + out.join(' | '); }
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
