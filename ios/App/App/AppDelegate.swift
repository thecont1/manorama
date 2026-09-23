import UIKit
import Capacitor

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    /// Allows the app to launch without additional initialization.
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        return true
    }

    /// Receives notice that the app is leaving the active state.
    func applicationWillResignActive(_ application: UIApplication) {
    }

    /// Receives notice that the app has entered the background.
    func applicationDidEnterBackground(_ application: UIApplication) {
    }

    /// Receives notice that the app is returning to the foreground.
    func applicationWillEnterForeground(_ application: UIApplication) {
    }

    /// Receives notice that the app has become active.
    func applicationDidBecomeActive(_ application: UIApplication) {
    }

    /// Receives notice that the app is terminating.
    func applicationWillTerminate(_ application: UIApplication) {
    }

    /// Configures each new scene to use the Capacitor scene delegate.
    func application(_ application: UIApplication,
                     configurationForConnecting connectingSceneSession: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let config = UISceneConfiguration(name: "Default Configuration",
                                          sessionRole: connectingSceneSession.role)
        config.delegateClass = SceneDelegate.self
        return config
    }
}
