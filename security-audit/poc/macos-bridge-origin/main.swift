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
        // swallows the popup before createWebViewWith ever runs — post a
        // real HID click instead, which WebKit honours as a gesture. A click
        // recorder and a hit test separate "the click missed" from "the
        // gesture was not trusted" — both would report as no open.
        _ = try await js("""
            window.__blankClicks = 0;
            document.querySelector('a[target=_blank]').addEventListener('click', () => window.__blankClicks++);
            'ok'
            """)
        let linkXY = (try await js("""
            (() => { const r = document.querySelector('a[target=_blank]').getBoundingClientRect();
              return `${r.x + r.width / 2},${r.y + r.height / 2}` })()
            """) ?? "0,0").split(separator: ",").compactMap { Double($0) }
        if linkXY.count == 2 {
            let hitId = try await js("document.elementFromPoint(\(linkXY[0]), \(linkXY[1]))?.id ?? 'miss'")
            // WKWebView is flipped: page coords map straight into view coords.
            let winPt = webView.convert(CGPoint(x: linkXY[0], y: linkXY[1]), to: nil)
            let scrPt = window.convertPoint(toScreen: winPt)
            // CGEvent space is global display coordinates, origin top-left.
            let cgPt = CGPoint(x: scrPt.x, y: NSScreen.screens[0].frame.height - scrPt.y)
            // The HID event lands on whatever window is topmost at the point —
            // float the probe window and re-activate so it is ours.
            window.level = .floating
            window.orderFrontRegardless()
            NSApp.activate(ignoringOtherApps: true)
            try? await Task.sleep(nanoseconds: 500_000_000)
            // Three delivery paths for the click, in rising order of how much
            // of the event stack they traverse: a real NSEvent through
            // sendEvent (AppKit dispatch), a CGEvent into this pid, and a HID
            // post (needs Input Monitoring — usually filtered, kept last as
            // the fallback that works on a signed-in desktop).
            let clickIn = NSEvent.mouseEvent(with: .leftMouseDown, location: winPt, modifierFlags: [],
                timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
                context: nil, eventNumber: 0, clickCount: 1, pressure: 1)
            let clickOut = NSEvent.mouseEvent(with: .leftMouseUp, location: winPt, modifierFlags: [],
                timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
                context: nil, eventNumber: 0, clickCount: 1, pressure: 1)
            if let clickIn, let clickOut {
                NSApp.sendEvent(clickIn)
                NSApp.sendEvent(clickOut)
            }
            let pid = ProcessInfo.processInfo.processIdentifier
            CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: cgPt, mouseButton: .left)?.postToPid(pid)
            CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: cgPt, mouseButton: .left)?.postToPid(pid)
            CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: cgPt, mouseButton: .left)?.post(tap: .cghidEventTap)
            CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: cgPt, mouseButton: .left)?.post(tap: .cghidEventTap)
            print("STEP2a click aimed at \(hitId ?? "?") screen=\(Int(cgPt.x)),\(Int(cgPt.y))")
        }
        try? await Task.sleep(nanoseconds: 2_000_000_000)
        let opensAfterBlank = opened.count
        let blankClicks = try await js("String(window.__blankClicks)") ?? "?"
        // A click event the DOM saw is not necessarily gesture-trusted —
        // delivered-but-untrusted events are popup-blocked exactly like the
        // synthetic .click() was. userActivation is the honest test: only a
        // click WebKit counted as a gesture may demand the _blank route.
        let gestureSeen = (try await js("String(!!(navigator.userActivation && navigator.userActivation.hasBeenActive))")) == "true"
        print("STEP2a after target=_blank click: url=\(webView.url?.absoluteString ?? "?") clicks=\(blankClicks) gesture=\(gestureSeen) opened=\(opened.map { $0.absoluteString })")

        // Second external-link idiom: window.open().
        _ = try await js("window.open(document.querySelector('a[target=_blank]').href, '_blank', 'noopener')")
        try? await Task.sleep(nanoseconds: 2_000_000_000)
        let opensAfterWindowOpen = opened.count
        print("STEP2b after window.open: url=\(webView.url?.absoluteString ?? "?") opened=\(opened.map { $0.absoluteString })")

        // The renderer's other navigation path — a plain location change.
        _ = try await js("location.assign(document.querySelector('a[target=_blank]').href)")
        try? await Task.sleep(nanoseconds: 2_000_000_000)
        let opensAfterAssign = opened.count
        print("STEP2c after location.assign: url=\(webView.url?.absoluteString ?? "?") opened=\(opened.map { $0.absoluteString })")

        // The upgrade/support fallbacks ship as mailto: anchors — a same-
        // frame navigation, so no gesture needed, but it must still reach
        // the opener rather than die at the scheme filter.
        _ = try await js("document.querySelector('a[href^=mailto]').click()")
        try? await Task.sleep(nanoseconds: 1_000_000_000)
        let opensAfterMailto = opened.count
        print("STEP2d after mailto click: opened=\(opened.map { $0.absoluteString })")

        // The bundle is the only document the web view should ever hold up
        // to this point. Each opener idiom gets its own count, so a route
        // that quietly dies cannot hide behind a sibling's success —
        // window.open, location.assign and mailto must each have routed.
        // A landed _blank click must also route; an undelivered one (event
        // injection is filtered in headless sessions) is reported, not
        // assumed.
        let stayedBundled = (webView.url?.absoluteString ?? "").hasPrefix("manorama://localhost")
        let blankClicksInt = Int(blankClicks) ?? 0
        // Only a gestured click may fail for not routing. A click the DOM
        // saw without user-activation is popup-blocked by design — the same
        // as a synthetic .click(), not a finding.
        let blankLandedButUnrouted = blankClicksInt > 0 && gestureSeen && opensAfterBlank == 0
        let windowOpenRouted = opensAfterWindowOpen > opensAfterBlank
        let assignRouted = opensAfterAssign > opensAfterWindowOpen
        let mailtoRouted = opensAfterMailto > opensAfterAssign
        let remoteRouted = windowOpenRouted && assignRouted && mailtoRouted && !blankLandedButUnrouted
        print("STEP2 summary: stayedBundled=\(stayedBundled) blankClicks=\(blankClicksInt) gesture=\(gestureSeen) blankOpens=\(opensAfterBlank) windowOpenRouted=\(windowOpenRouted) assignRouted=\(assignRouted) mailtoRouted=\(mailtoRouted)")

        // STEP3 — a same-origin child frame loads (the nav policy allows the
        // bundle inside a frame) but its messages die at the isMainFrame gate.
        // The reply slot to watch is the MAIN document's __rt: settle replies
        // via webView.evaluateJavaScript, which always runs in the main frame
        // — a leaked reply to the frame's invoke lands here, never inside
        // the iframe's own window. Clear it first so only id 9 can fill it.
        _ = try await js("window.__rt = null; 'ok'")
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
                let rt = try await js("window.__rt && window.__rt.id === 9 ? JSON.stringify(window.__rt) : 'null'")
                if rt != nil && rt != "null" { frameReply = rt; break }
                try? await Task.sleep(nanoseconds: 100_000_000)
            }
        }
        let frameSays = frameReply.map { "FR-RESULT: \($0)" } ?? (frameSent ? "FR-RESULT: null" : "NO FRAME SCRIPT")
        print("STEP3 child frame report: \(frameSays)")

        // STEP3b — a remote iframe is a navigation this policy must cancel
        // WITHOUT opening a tab. Two witnesses: the opener's count does not
        // move, and the loopback server never sees the document fetched.
        let opensBeforeRemoteFrame = opened.count
        let hitsBeforeRemoteFrame = remoteHits
        _ = try await js("""
            const rf = document.createElement('iframe');
            rf.src = 'http://localhost:\(remotePort)/evil.html';
            document.body.appendChild(rf);
            'ok'
            """)
        try? await Task.sleep(nanoseconds: 2_000_000_000)
        let remoteFrameSpawnedTab = opened.count > opensBeforeRemoteFrame
        let remoteFrameFetched = remoteHits > hitsBeforeRemoteFrame
        print("STEP3b remote iframe: spawnedTab=\(remoteFrameSpawnedTab) fetched=\(remoteFrameFetched) opened=\(opened.count)")

        // STEP4 — the untrusted-document case for the message gate itself.
        // A remote URL can never commit (STEP2 proved that), so the closest
        // stand-in is an opaque about:blank document: not manorama://localhost,
        // so the origin check must refuse it. The document can still see the
        // handler — it is registered for every page — but any message it
        // sends must be dropped before the bridge parses it.
        webView.loadHTMLString(evil, baseURL: nil)
        // Wait for the page's own completion marker — polling before the
        // script ran its course reads a slot it has not even declared yet.
        var remoteRan = false
        for _ in 0..<60 {
            if ((try await js("document.title")) ?? "").hasPrefix("PROGRESS: ") { remoteRan = true; break }
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
        print("STEP4 untrusted document url=\(webView.url?.absoluteString ?? "?") title=\(try await js("document.title") ?? "?")")
        // The message must have been SENT for silence to mean anything —
        // a script that died before postMessage leaves a null slot too.
        // The page stamps __postSent on the line after a non-throwing call.
        var remoteSent = false
        if remoteRan {
            remoteSent = (try await js("String(window.__postSent === true)")) == "true"
        }
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
            || remoteFrameSpawnedTab || remoteFrameFetched
        // NOT-REACHABLE means the probe ran to completion: the trusted doc
        // got its reply (the gate is not just dead), the frame's script
        // actually posted, and the untrusted document's invoke really left
        // the page (a postMessage that never ran would fake a pass too).
        // Anything less is inconclusive, not a pass.
        if leaked {
            print("VERDICT: BRIDGE-LEAKED-SESSION-TOKEN")
        } else if !trustedReply || !frameSent || !remoteSent {
            print("VERDICT: INCONCLUSIVE (probe incomplete: trustedReply=\(trustedReply) frameSent=\(frameSent) remoteSent=\(remoteSent))")
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
        <a id="mail" href="mailto:support@manorama.xyz">support</a>
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
      window.__postSent = true;
      out.push('post=SENT');
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

// Counts every request the "attacker" origin actually serves — a remote
// iframe that never reaches the wire proves the nav policy cancelled it.
let hitLock = NSLock()
var remoteHits = 0

DispatchQueue.global().async {
    let body = [UInt8](evil.utf8)
    while true {
        var client = sockaddr_in()
        var clen = socklen_t(MemoryLayout<sockaddr_in>.size)
        let fd = withUnsafeMutablePointer(to: &client) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            Darwin.accept(listener, $0, &clen) } }
        if fd < 0 { continue }
        hitLock.lock(); remoteHits += 1; hitLock.unlock()
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
