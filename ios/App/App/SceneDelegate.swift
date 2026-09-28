import UIKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    /// Creates the Capacitor bridge and forwards the scene connection to its proxy.
    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = CAPBridgeViewController()
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

    /// Populates `window.__MANORAMA_IOS_FOLD__` with size classes and hinge
    /// geometry so the platform-free core layer can resolve diptych layouts.
    /// Safe-area insets are provided by the WebView CSS env() vars and are not
    /// duplicated here. See packages/core/fold.ts.
    private func injectFoldGeometry(for scene: UIScene) {
        guard let windowScene = scene as? UIWindowScene else { return }

        let horizontal = Self.sizeClassToString(windowScene.traitCollection.horizontalSizeClass)
        let vertical = Self.sizeClassToString(windowScene.traitCollection.verticalSizeClass)

        var json = "{\"horizontalSizeClass\":\"\(horizontal)\",\"verticalSizeClass\":\"\(vertical)\"}"

        if #available(iOS 27.1, *) {
            if let hinge = Self.detectHinge(in: windowScene) {
                json += ",\"hinge\":{\"axis\":\"\(hinge.axis)\",\"start\":\(hinge.start),\"size\":\(hinge.size)}"
            }
        }

        json += "}"

        let js = "window.__MANORAMA_IOS_FOLD__ = \(json);"
        (window?.rootViewController as? CAPBridgeViewController)?
            .webView?
            .evaluateJavaScript(js, completionHandler: nil)
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
        let regions = rootView.reservedRegions(kind: .occlusion, options: [])
        guard let region = regions.first else { return nil }
        let frame = region.frame
        // A wider-than-tall region is a vertical hinge splitting left/right panes
        // (iPhone Duo book/open pose). A taller-than-wide region is a horizontal
        // hinge splitting top/bottom.
        if frame.width > frame.height {
            return ("vertical", frame.minX, frame.width)
        } else {
            return ("horizontal", frame.minY, frame.height)
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
