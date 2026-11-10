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
final class ViewerCoordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
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

    /// Whether the page has reported itself ready.
    private var pageReady = false
    /// A gallery waiting for the page to become ready.
    private var pendingPayload: [String: Any]?
    /// The web view, so a queued payload can be delivered the moment the
    /// page says it is up.
    private weak var webView: WKWebView?

    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage) {
        guard message.name == "manorama" else { return }
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
