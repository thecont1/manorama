import UIKit
import Capacitor
import WebKit

private final class ManoramaWebView: WKWebView {
    var onReservedRegionsChange: (() -> Void)?

    override func updateConstraints() {
        // UIKit tracks reserved-region reads only inside this synchronous update.
        onReservedRegionsChange?()
        super.updateConstraints()
    }
}

private final class ManoramaBridgeViewController: CAPBridgeViewController {
    var windowScene: UIWindowScene?
    var onLayoutChange: (() -> Void)?
    var onNewDocument: (() -> Void)?
    private var documentLoadObservation: NSKeyValueObservation?
    private var reduceTransparencyObserver: NSObjectProtocol?
    /// iOS 26+ glass chrome: the model the injected observer feeds and the
    /// handler registered on the configuration (retained here for routing).
    fileprivate var glassModel: GlassChromeModel?
    private var glassHandler: GlassScriptHandler?

    override func webView(with frame: CGRect, configuration: WKWebViewConfiguration) -> WKWebView {
        let webView = ManoramaWebView(frame: frame, configuration: configuration)
        webView.onReservedRegionsChange = { [weak self] in self?.onLayoutChange?() }
        // A fresh document drops window.__MANORAMA_IOS_LAYOUT__; signal the
        // delegate to forget the last delivery so identical geometry is sent
        // again instead of being deduplicated away.
        documentLoadObservation = webView.observe(\.isLoading, options: .new) { [weak self] webView, _ in
            if webView.isLoading { self?.onNewDocument?() }
        }

        if #available(iOS 26.0, *) {
            // Liquid Glass takeover: stamp data-ios-glass and inject the
            // chrome/sheet/position observer before first paint; the
            // "manorama" handler is how those posts reach the overlay.
            let model = GlassChromeModel()
            let handler = GlassScriptHandler(model: model)
            configuration.userContentController.add(handler, name: "manorama")
            configuration.userContentController.addUserScript(
                WKUserScript(
                    source: GlassBridgeScript.marker + GlassBridgeScript.observer,
                    injectionTime: .atDocumentStart,
                    forMainFrameOnly: true
                )
            )
            glassModel = model
            glassHandler = handler
        }

        guard let windowScene else { return webView }

        webView.configuration.userContentController.addUserScript(
            WKUserScript(
                // data-reduced-transparency is a condition, not a gate — it
                // sits beside the shell marker so CSS need not rely on the
                // media query seeing the OS accessibility toggle.
                source: "document.documentElement.dataset.iosShell = '1';"
                    + "document.documentElement.toggleAttribute('data-reduced-transparency', \(UIAccessibility.isReduceTransparencyEnabled ? "true" : "false"));"
                    + SceneDelegate.layoutJavaScript(for: webView, windowScene: windowScene, dispatchEvent: false),
                injectionTime: .atDocumentStart,
                forMainFrameOnly: true
            )
        )
        return webView
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        // App-local plugin: folder picking and the Local gallery store. It
        // registers as an instance so JS sees "LocalGallery" alongside the
        // package plugins the config list loads.
        bridge?.registerPluginInstance(LocalGalleryPlugin())
        if #available(iOS 26.0, *), let glassModel, let webView {
            // The capsules ride above the webView in a pass-through
            // container; touches off-capsule belong to the page.
            glassModel.webView = webView
            GlassChromeInstaller.install(over: webView, in: self, model: glassModel)
        }
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
        // The document-start stamp covers page load; this covers the user
        // flipping Reduce Transparency while the app sits loaded. Same
        // toggleAttribute call, so the two paths can never disagree.
        reduceTransparencyObserver = NotificationCenter.default.addObserver(
            forName: UIAccessibility.reduceTransparencyStatusDidChangeNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            let enabled = UIAccessibility.isReduceTransparencyEnabled
            self?.webView?.evaluateJavaScript(
                "document.documentElement.toggleAttribute('data-reduced-transparency', \(enabled ? "true" : "false"));",
                completionHandler: nil
            )
        }
    }

    deinit {
        if let reduceTransparencyObserver {
            NotificationCenter.default.removeObserver(reduceTransparencyObserver)
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
        bridgeViewController.onNewDocument = { [weak self] in
            self?.lastInjectedLayout = nil
            // A replacement document has no observer and no contract yet —
            // the overlay must not inherit the last page's chrome state.
            (self?.window?.rootViewController as? ManoramaBridgeViewController)?.glassModel?.resetForNewDocument()
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
        // The native capsules reseat on the same geometry pass — an
        // identical payload means identical regions, so this belongs before
        // the dedup guard rather than after it.
        if #available(iOS 27.1, *) {
            (window?.rootViewController as? ManoramaBridgeViewController)?.glassModel?.reservedRegions =
                Self.activeReservedRegionFrames(for: webView)
        }
        guard javaScript != lastInjectedLayout else { return }
        let previousLayout = lastInjectedLayout
        // The cache tracks the most recently dispatched payload so a changed
        // geometry still goes out while an earlier evaluation is in flight.
        lastInjectedLayout = javaScript
        webView.evaluateJavaScript(javaScript) { [weak self] _, error in
            // A failed delivery restores the last good payload, keeping this
            // geometry retry-eligible without clobbering a newer dispatch.
            guard error != nil else { return }
            if self?.lastInjectedLayout == javaScript {
                self?.lastInjectedLayout = previousLayout
            }
        }
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

    /// Active reserved regions as window-coordinate frames — the glass
    /// overlay's capsule seats are published in window space, so the frames
    /// are converted rather than passed through in webView space.
    @available(iOS 27.1, *)
    private static func activeReservedRegionFrames(for webView: WKWebView) -> [CGRect] {
        (webView.reservedRegions(kind: .division, options: .includeInactive) +
            webView.reservedRegions(kind: .occlusion, options: .includeInactive))
            .filter(\.isActive)
            .map { webView.convert($0.frame, to: nil) }
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
