import UIKit
import Capacitor
import WebKit

private final class ManoramaBridgeViewController: CAPBridgeViewController {
    var foldDocumentStartScript = ""

    override func webView(with frame: CGRect, configuration: WKWebViewConfiguration) -> WKWebView {
        let webView = super.webView(with: frame, configuration: configuration)
        guard !foldDocumentStartScript.isEmpty else { return webView }

        webView.configuration.userContentController.addUserScript(
            WKUserScript(
                source: foldDocumentStartScript,
                injectionTime: .atDocumentStart,
                forMainFrameOnly: true
            )
        )
        return webView
    }
}

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    /// Creates the Capacitor bridge and forwards the scene connection to its proxy.
    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        let bridgeViewController = ManoramaBridgeViewController()
        bridgeViewController.foldDocumentStartScript = foldJavaScript(for: windowScene)

        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = bridgeViewController
        window?.makeKeyAndVisible()

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
        injectFoldGeometry(for: scene)
    }

    func sceneDidBecomeActive(_ scene: UIScene) {
        injectFoldGeometry(for: scene)
    }

    func sceneWillEnterForeground(_ scene: UIScene) {
        injectFoldGeometry(for: scene)
    }

    /// Refreshes fold geometry when the system changes the scene's effective geometry,
    /// including posture changes that do not recreate or foreground the scene.
    @available(iOS 26.0, *)
    func windowScene(_ windowScene: UIWindowScene, didUpdateEffectiveGeometry previousEffectiveGeometry: UIWindowScene.Geometry) {
        injectFoldGeometry(for: windowScene)
    }

    /// Populates `window.__MANORAMA_IOS_FOLD__` with size classes and hinge
    /// geometry so the platform-free core layer can resolve diptych layouts.
    /// Safe-area insets are provided by the WebView CSS env() vars and are not
    /// duplicated here. See packages/core/fold.ts.
    private func injectFoldGeometry(for scene: UIScene) {
        guard let windowScene = scene as? UIWindowScene else { return }

        let js = foldJavaScript(for: windowScene)
        (window?.rootViewController as? CAPBridgeViewController)?
            .webView?
            .evaluateJavaScript(js, completionHandler: nil)
    }

    private func foldJavaScript(for windowScene: UIWindowScene) -> String {

        let horizontal = Self.sizeClassToString(windowScene.traitCollection.horizontalSizeClass)
        let vertical = Self.sizeClassToString(windowScene.traitCollection.verticalSizeClass)

        var json = "{\"horizontalSizeClass\":\"\(horizontal)\",\"verticalSizeClass\":\"\(vertical)\""

        if #available(iOS 27.1, *) {
            if let hinge = Self.detectHinge(in: windowScene) {
                json += ",\"hinge\":{\"axis\":\"\(hinge.axis)\",\"start\":\(hinge.start),\"size\":\(hinge.size)}"
            }
        }

        json += "}"

        return "window.__MANORAMA_IOS_FOLD__ = \(json);"
    }

    private static func sizeClassToString(_ cls: UIUserInterfaceSizeClass?) -> String {
        switch cls {
        case .regular: return "regular"
        case .compact: return "compact"
        default: return "regular"
        }
    }

    /// iOS 27.1: reads the physical hinge region from UIView.reservedRegions
    /// and maps it to the { axis, start, size } shape expected by
    /// packages/core/fold.ts#segmentsFromHinge.
    @available(iOS 27.1, *)
    private static func detectHinge(in scene: UIWindowScene) -> (axis: String, start: CGFloat, size: CGFloat)? {
        guard let rootView = scene.windows.first(where: { $0.isKeyWindow })?.rootViewController?.view else { return nil }
        let regions = rootView.reservedRegions(kind: .division, options: [])
        guard let region = regions.first(where: { $0.isActive }) else { return nil }
        let frame = region.frame
        // A wider-than-tall region is a horizontal hinge splitting top/bottom
        // panes. A taller-than-wide region is a vertical hinge splitting left/right.
        if frame.width > frame.height {
            return ("horizontal", frame.minY, frame.height)
        } else {
            return ("vertical", frame.minX, frame.width)
        }
    }

    /// Forwards URLs opened in this scene to Capacitor plugins.
    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    /// Forwards continued user activities to Capacitor plugins.
    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}
