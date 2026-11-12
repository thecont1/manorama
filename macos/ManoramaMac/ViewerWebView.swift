import AppKit
import SwiftUI
import WebKit

/// The native half of the bridge.
///
/// The page is loaded from `manorama://localhost/index.html` — the app's own
/// Library, served from the app's resources — and the originals are fetched
/// from `manorama://media/local/<absolute path>`, answered only for a path
/// inside a root the user granted. The page never learns a filesystem path
/// it did not already have from the catalogue.
final class ViewerCoordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate {
    /// Called when the page reports it is mounted.
    var onReady: (() -> Void)?
    /// Called when the committed photograph changes.
    var onPosition: ((Int, String, Int) -> Void)?
    /// Called when the user asks to leave the gallery.
    var onEscape: (() -> Void)?
    /// Called when the page reports which gallery is open, if any.
    var onGalleryState: ((Bool, String?) -> Void)?
    /// The native shell's runtime API — the commands the app's own bundle
    /// asks of the machine.
    var bridge: NativeBridge?
    /// Where an out-of-shell link is sent: the system browser, which has no
    /// bridge and no reach into the app's files. The boundary probe
    /// substitutes a recorder so nothing real opens during a test run.
    var openExternal: (URL) -> Void = { url in
        // The bridge's own opener scope: https anywhere, localhost http for
        // dev, and mailto for the upgrade/support fallbacks the Library
        // carries. Anything outside that stays dead — the right default for
        // schemes that could reach a third-party handler.
        guard NativeCapabilities.isAllowedOpenerURL(url.absoluteString) != nil else { return }
        NSWorkspace.shared.open(url)
    }

    /// The one origin that may load inside this web view and speak to the
    /// bridge: the app's own bundle, served by the scheme handler.
    private static let viewerScheme = "manorama"
    private static let viewerHost = "localhost"

    static func isViewerURL(_ url: URL?) -> Bool {
        url?.scheme?.lowercased() == viewerScheme && url?.host?.lowercased() == viewerHost
    }

    /// Whether the page has reported itself ready.
    private var pageReady = false
    /// A gallery waiting for the page to become ready.
    private var pendingPayload: [String: Any]?
    /// The web view, so a queued payload can be delivered the moment the
    /// page says it is up.
    private weak var webView: WKWebView?
    /// Whether the committed document is the app's own bundle. Cached at
    /// commit/finish so a message never asks WebKit what is on screen —
    /// the check rides on the navigation we already decided to allow.
    private var trustedDocument = false
    /// The last link handed to the system browser for a new-window request.
    /// WebKit can offer the same gesture twice — once through
    /// createWebViewWith and once as a navigation action with no target
    /// frame — and the browser must not be opened a second time.
    private var lastExternalOpen: (url: URL, at: Date)?

    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage) {
        guard message.name == "manorama" else { return }
        // The bridge is the app's own, not the web's: only the main frame of
        // a committed bundle document may use it. A subframe — or any page
        // that is not manorama://localhost — is dropped before its body is
        // even parsed, so remote script can never reach the file commands.
        guard message.frameInfo.isMainFrame,
              trustedDocument,
              message.frameInfo.securityOrigin.protocol == Self.viewerScheme,
              message.frameInfo.securityOrigin.host == Self.viewerHost else { return }
        guard let body = message.body as? [String: Any],
              let type = body["type"] as? String else { return }
        Trace.log("message \(type)")
        switch type {
        case "ready":
            pageReady = true
            onReady?()
            // The shell may have asked for a gallery before the page's
            // module ran. Deliver it now.
            if let pending = pendingPayload {
                pendingPayload = nil
                send(pending)
            }
        case "position":
            let index = body["index"] as? Int ?? 0
            let imageId = body["imageId"] as? String ?? ""
            let total = body["total"] as? Int ?? 0
            onPosition?(index, imageId, total)
        case "escape":
            Trace.log("escape count=\(body["count"] as? Int ?? -1)")
            onEscape?()
        case "error":
            let text = body["message"] as? String ?? "Unknown error"
            NSLog("manorama viewer error: %@", text)
        case "invoke":
            // A runtime command from the app's bundle: the folder picker,
            // the private files, the vault, the filesystem.
            bridge?.handle(body)
        case "gallery":
            // The page says which gallery it has open.
            let open = body["open"] as? Bool ?? false
            let title = body["title"] as? String
            onGalleryState?(open, title)
        default:
            break
        }
    }

    /// Mount a gallery in the page.
    ///
    /// If the page has not reported ready the payload is held until it
    /// does. Evaluating `window.manoramaNative.open(...)` against a page
    /// whose module has not run yet would *succeed* — the expression
    /// short-circuits to `undefined` — so a failed call cannot be
    /// detected by its error, only by the ready signal.
    func open(_ payload: [String: Any], in webView: WKWebView) {
        self.webView = webView
        guard pageReady else {
            pendingPayload = payload
            return
        }
        send(payload)
    }

    private func send(_ payload: [String: Any]) {
        guard let webView else { return }
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8) else { return }
        let script = "window.manoramaNative && window.manoramaNative.open(\(json));"
        webView.evaluateJavaScript(script) { [weak self] _, error in
            if let error {
                NSLog("manorama open failed: %@", error.localizedDescription)
            }
            // Give the page the keyboard.
            //
            // Without this the web view is never the first responder, so it
            // never forwards a key to the page: the viewer's own shortcuts
            // (`g` for the picker, `m` for the magnifier) fall on the floor
            // and the native menu ends up owning every key the user
            // presses. Opening a document should move the keyboard into it.
            webView.becomeFirstResponder()
            _ = self
        }
    }

    // MARK: navigation boundary

    /// Only the app's own bundle may load in place. Every other destination
    /// is cancelled — a plain link is handed to the system browser, where no
    /// bridge exists, and anything that is not a link goes nowhere at all.
    /// `about:blank` stays legal: it is an opaque, empty document that some
    /// of WebKit's own loads need, and the message gate already refuses it.
    func webView(_ webView: WKWebView,
                 decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.cancel)
            return
        }
        if Self.isViewerURL(url) || url.absoluteString == "about:blank" {
            decisionHandler(.allow)
            return
        }
        decisionHandler(.cancel)
        // A subframe asking for a remote document is cancelled in place —
        // it must not also open a browser tab the page never asked for.
        // Only main-frame and new-window (nil-target) actions may hand off.
        if let target = navigationAction.targetFrame, !target.isMainFrame { return }
        // A new-window request (target=_blank) is decided HERE, with no
        // target frame — createWebViewWith only runs once an action is
        // allowed, and nothing external ever is. This early return would
        // leave a gestured _blank click dead, so the route is shared:
        // _blank hands off here, window.open in createWebViewWith, and the
        // dedup covers a WebKit that consults both seams for one click.
        if let last = lastExternalOpen, last.url == url, Date().timeIntervalSince(last.at) < 2 { return }
        // Only a GET can be handed to the browser honestly — a POST body
        // would be silently dropped on the way out.
        guard (navigationAction.request.httpMethod ?? "GET").uppercased() == "GET" else { return }
        lastExternalOpen = (url, Date())
        openExternal(url)
    }

    /// A committed navigation is what flips the message gate: the document
    /// that just arrived decides whether the bridge may answer. This runs
    /// at both didCommit and didFinish because either edge is a fine time to
    /// notice the document changed — and a cancelled navigation flips nothing.
    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        trustedDocument = Self.isViewerURL(webView.url)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        trustedDocument = Self.isViewerURL(webView.url)
    }

    // MARK: WKUIDelegate — links that want a new window

    /// `target="_blank"` and `window.open` never get a second web view.
    /// Without this method WebKit swallows them silently; with it they go
    /// where an external link belongs — the user's own browser.
    func webView(_ webView: WKWebView,
                 createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction,
                 windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url,
           (navigationAction.request.httpMethod ?? "GET").uppercased() == "GET" {
            lastExternalOpen = (url, Date())
            openExternal(url)
        }
        return nil
    }
}

/// The WKWebView wrapper.
struct ViewerWebView: NSViewRepresentable {
    let schemeHandler: LocalSchemeHandler
    let coordinator: ViewerCoordinator
    /// Hands the live webview back to the shell once it exists — the model
    /// needs it before any gallery opens, or `open` has nothing to drive.
    var onCreate: ((WKWebView) -> Void)?
    /// The scheme the page is loaded from.
    ///
    /// The host is `localhost` so the page's origin is
    /// `manorama://localhost` — the origin the API's CORS allowlist names
    /// for a native shell.
    var startURL: URL { URL(string: "manorama://localhost/index.html")! }

    func makeNSView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.setURLSchemeHandler(schemeHandler, forURLScheme: "manorama")
        configuration.userContentController.add(coordinator, name: "manorama")
        // A dark webview avoids a white flash before the page's own ground
        // paints.
        configuration.preferences.setValue(false, forKey: "developerExtrasEnabled")

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = coordinator
        // The UI delegate is what makes target=_blank and window.open work —
        // routed out to the system browser rather than silently swallowed.
        webView.uiDelegate = coordinator
        webView.setValue(false, forKey: "drawsBackground")
        webView.allowsMagnification = true
        webView.load(URLRequest(url: startURL))
        // Publishing during makeNSView is a state mutation inside a view
        // update — defer it one tick so SwiftUI never sees the write.
        if let onCreate {
            DispatchQueue.main.async { onCreate(webView) }
        }
        return webView
    }

    func updateNSView(_ nsView: WKWebView, context: Context) {}
}
