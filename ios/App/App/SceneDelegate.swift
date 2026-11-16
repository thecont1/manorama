import UIKit
import Capacitor
import WebKit

private final class ManoramaBridgeViewController: CAPBridgeViewController {
    var windowScene: UIWindowScene?
    var onLayoutChange: (() -> Void)?

    override func webView(with frame: CGRect, configuration: WKWebViewConfiguration) -> WKWebView {
        let webView = super.webView(with: frame, configuration: configuration)
        guard let windowScene else { return webView }

        webView.configuration.userContentController.addUserScript(
            WKUserScript(
                source: SceneDelegate.layoutJavaScript(for: webView, windowScene: windowScene, dispatchEvent: false),
                injectionTime: .atDocumentStart,
                forMainFrameOnly: true
            )
        )
        return webView
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        if #available(iOS 17.0, *) {
            registerForTraitChanges([UITraitHorizontalSizeClass.self, UITraitVerticalSizeClass.self]) {
                (self: ManoramaBridgeViewController, _) in
                self.onLayoutChange?()
            }
        }
        if #available(iOS 27.1, *) {
            registerForTraitChanges(UITraitCollection.systemTraitsAffectingVerticalBarEdge) {
                (self: ManoramaBridgeViewController, _) in
                self.onLayoutChange?()
            }
        }
    }

    override func viewSafeAreaInsetsDidChange() {
        super.viewSafeAreaInsetsDidChange()
        onLayoutChange?()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        DispatchQueue.main.async { [weak self] in
            self?.onLayoutChange?()
        }
    }
}

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?
    private var lastInjectedLayout: String?

    /// Creates the Capacitor bridge and forwards the scene connection to its proxy.
    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        let bridgeViewController = ManoramaBridgeViewController()
        bridgeViewController.windowScene = windowScene
        bridgeViewController.onLayoutChange = { [weak self] in
            guard let scene = self?.window?.windowScene else { return }
            self?.injectLayout(for: scene)
        }

        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = bridgeViewController
        window?.makeKeyAndVisible()

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
        injectLayout(for: scene)
    }

    func sceneDidBecomeActive(_ scene: UIScene) {
        injectLayout(for: scene)
    }

    func sceneWillEnterForeground(_ scene: UIScene) {
        injectLayout(for: scene)
    }

    @available(iOS 26.0, *)
    func windowScene(_ windowScene: UIWindowScene, didUpdateEffectiveGeometry previousEffectiveGeometry: UIWindowScene.Geometry) {
        injectLayout(for: windowScene)
    }

    private func injectLayout(for scene: UIScene) {
        guard let windowScene = scene as? UIWindowScene,
              let webView = (window?.rootViewController as? CAPBridgeViewController)?.webView else { return }
        let javaScript = Self.layoutJavaScript(for: webView, windowScene: windowScene, dispatchEvent: true)
        guard javaScript != lastInjectedLayout else { return }
        lastInjectedLayout = javaScript
        webView.evaluateJavaScript(javaScript, completionHandler: nil)
    }

    fileprivate static func layoutJavaScript(for webView: WKWebView, windowScene: UIWindowScene, dispatchEvent: Bool) -> String {
        let viewportSize: CGSize
        if webView.bounds.width > 0, webView.bounds.height > 0 {
            viewportSize = webView.bounds.size
        } else if #available(iOS 26.0, *) {
            viewportSize = windowScene.effectiveGeometry.coordinateSpace.bounds.size
        } else {
            viewportSize = windowScene.coordinateSpace.bounds.size
        }

        let snapshot: [String: Any] = [
            "viewport": ["width": Double(viewportSize.width), "height": Double(viewportSize.height)],
            "horizontalSizeClass": sizeClassToString(webView.traitCollection.horizontalSizeClass),
            "verticalSizeClass": sizeClassToString(webView.traitCollection.verticalSizeClass),
            "verticalBarEdge": verticalBarEdgeToString(webView.traitCollection),
            "safeAreaInsets": insetsDictionary(webView.safeAreaInsets),
            "regions": reservedRegionDictionaries(for: webView),
        ]

        guard let data = try? JSONSerialization.data(withJSONObject: snapshot),
              let json = String(data: data, encoding: .utf8) else {
            return "window.__MANORAMA_IOS_LAYOUT__ = {\"viewport\":{\"width\":0,\"height\":0},\"horizontalSizeClass\":\"unspecified\",\"verticalSizeClass\":\"unspecified\",\"verticalBarEdge\":\"unspecified\",\"safeAreaInsets\":{\"top\":0,\"right\":0,\"bottom\":0,\"left\":0},\"regions\":[]};"
        }

        let assignment = "window.__MANORAMA_IOS_LAYOUT__ = \(json);"
        guard dispatchEvent else { return assignment }
        return assignment + "window.dispatchEvent(new CustomEvent('manorama:layout', { detail: window.__MANORAMA_IOS_LAYOUT__ }));"
    }

    private static func reservedRegionDictionaries(for webView: WKWebView) -> [[String: Any]] {
        guard #available(iOS 27.1, *) else { return [] }
        let regions = webView.reservedRegions(kind: .division, options: .includeInactive) +
            webView.reservedRegions(kind: .occlusion, options: .includeInactive)
        return regions.map { region in
            [
                "kind": region.kind == .division ? "division" : "occlusion",
                "active": region.isActive,
                "frame": [
                    "x": Double(region.frame.origin.x),
                    "y": Double(region.frame.origin.y),
                    "width": Double(region.frame.width),
                    "height": Double(region.frame.height),
                ],
            ]
        }
    }

    private static func insetsDictionary(_ insets: UIEdgeInsets) -> [String: Double] {
        [
            "top": Double(insets.top),
            "right": Double(insets.right),
            "bottom": Double(insets.bottom),
            "left": Double(insets.left),
        ]
    }

    private static func sizeClassToString(_ sizeClass: UIUserInterfaceSizeClass) -> String {
        switch sizeClass {
        case .regular: return "regular"
        case .compact: return "compact"
        default: return "unspecified"
        }
    }

    private static func verticalBarEdgeToString(_ traits: UITraitCollection) -> String {
        guard #available(iOS 27.1, *) else { return "unspecified" }
        switch traits.verticalBarEdge {
        case .leading: return "leading"
        case .trailing: return "trailing"
        default: return "unspecified"
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
