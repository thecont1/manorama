import AppKit
import SwiftUI
import WebKit

/// The native half of the bridge.
///
/// The page is loaded from `manorama://app/index.html`, and the originals
/// are fetched from `manorama://media/<token>/<relative path>`. The token
/// is minted by the shell when it opens a gallery and released when it
/// closes; the page never learns a filesystem path.
final class ViewerCoordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
    /// Called when the page reports it is mounted.
    var onReady: (() -> Void)?
    /// Called when the committed photograph changes.
    var onPosition: ((Int, String, Int) -> Void)?
    /// Called when the user asks to leave the gallery.
    var onEscape: (() -> Void)?

    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage) {
        guard message.name == "manorama" else { return }
        guard let body = message.body as? [String: Any],
              let type = body["type"] as? String else { return }
        switch type {
        case "ready":
            onReady?()
        case "position":
            let index = body["index"] as? Int ?? 0
            let imageId = body["imageId"] as? String ?? ""
            let total = body["total"] as? Int ?? 0
            onPosition?(index, imageId, total)
        case "escape":
            onEscape?()
        case "error":
            let text = body["message"] as? String ?? "Unknown error"
            NSLog("manorama viewer error: %@", text)
        default:
            break
        }
    }

    /// Mount a gallery in the page.
    func open(_ payload: [String: Any], in webView: WKWebView) {
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8) else { return }
        let script = "window.manoramaNative && window.manoramaNative.open(\(json));"
        // The bundle may still be evaluating when the first gallery is
        // opened, so a failed call is retried once rather than lost.
        webView.evaluateJavaScript(script) { [weak self] _, error in
            guard error != nil else { return }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
                webView.evaluateJavaScript(script) { _, error in
                    if let error {
                        NSLog("manorama open failed: %@", error.localizedDescription)
                    }
                }
            }
        }
    }
}

/// The WKWebView wrapper.
struct ViewerWebView: NSViewRepresentable {
    let schemeHandler: LocalSchemeHandler
    let coordinator: ViewerCoordinator
    /// The scheme the page is loaded from.
    var startURL: URL { URL(string: "manorama://app/index.html")! }

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
        return webView
    }

    func updateNSView(_ nsView: WKWebView, context: Context) {}
}
