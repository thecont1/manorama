import AppKit
import SwiftUI
import WebKit

/// The native macOS shell.
///
/// The chrome is native: real menus, real window buttons, real Space.
/// The viewing surface is the shared web Library + Viewer inside a WKWebView,
/// reached over a narrow bridge.
///
/// Launch is windowed by default. The former kiosk behaviour — the window
/// opening into its own fullscreen Space — is now a preference the user
/// sets in Settings ("Open in full screen"), applied once per launch by
/// `AppModel.applyLaunchWindowMode`. The green traffic light, the View
/// menu, and ⌃⌘F remain available either way.
@main
enum ManoramaMacMain {
    static func main() {
        // Prevent AppKit from treating CLI test flags (e.g. `--trace --eval <js>`)
        // as document paths to open when URL/document types are declared in Info.plist.
        UserDefaults.standard.set("NO", forKey: "NSTreatUnknownArgumentsAsOpen")
        ManoramaMacApp.main()
    }
}

struct ManoramaMacApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @State private var model: AppModel

    init() {
        // The bundle root is where the viewer bundle was copied into the
        // app's Resources. The scheme handler serves it from here.
        let bundleRoot = Bundle.main.resourceURL?
            .appendingPathComponent("ViewerBundle", isDirectory: true)
            ?? URL(fileURLWithPath: NSTemporaryDirectory())
        _model = State(wrappedValue: AppModel(bundleRoot: bundleRoot))
    }

    var body: some Scene {
        WindowGroup {
            ContentView(model: model)
                .environment(model)
                .frame(minWidth: 760, minHeight: 520)
                .onAppear {
                    delegate.model = model
                    for url in delegate.pendingOpenURLs {
                        model.bridge.deliverDeepLink(url)
                    }
                    delegate.pendingOpenURLs.removeAll()
                }
        }
        // The page owns everything behind the traffic lights: no drawn
        // titlebar, no title text. On macOS 27 the flag-era approach
        // (titlebarAppearsTransparent) still lands but the system draws
        // its own opaque bar over it — hiddenTitleBar is the style that
        // actually removes the chrome.
        .windowStyle(.hiddenTitleBar)
        .windowToolbarStyle(.unified(showsTitle: false))
        .defaultSize(width: 1280, height: 840)
        .commands {
            NativeCommands(model: model)
        }

        // One native setting, and it is only the launch behaviour — every
        // display and gallery preference stays where it belongs, in the
        // Library and the Viewer. SwiftUI supplies the Settings menu item
        // and ⌘, automatically.
        Settings {
            SettingsView()
        }
    }
}

/// Keeps the app alive when the last window closes and routes custom-scheme
/// deep links (`in.thecontrarian.manorama.desktop://...`) to the active window.
final class AppDelegate: NSObject, NSApplicationDelegate {
    var model: AppModel?
    var pendingOpenURLs: [String] = []
    /// A same-bundle-id sibling that is already running. Two installed copies
    /// claim one URL scheme, so LaunchServices can wake the copy that did not
    /// begin sign-in — this instance then exists only to relay its launch
    /// URLs to the running one, which holds the in-memory PKCE verifier.
    private var handoffTarget: NSRunningApplication?

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationWillFinishLaunching(_ notification: Notification) {
        // One instance, ever — two shells on one container would race the
        // catalogue, the folder store, the vault key file, and providers.json.
        // A second launch hands focus to the running app and exits before any
        // of that state opens.
        //
        // A launch may carry `--bundle-id <id>` to probe a different id
        // than the bundle's own — but only together with isolated
        // storage (`--store` + `--config`). Without them a fake id would
        // coexist with the installed app while still sharing the real
        // container's folders.json et al., so the override is ignored
        // unless the launch redirected that state. With no effective
        // override the check probes the real bundle id and detects other
        // instances as before.
        let args = CommandLine.arguments
        let bundleId: String? = {
            let isolated = args.contains("--store") && args.contains("--config")
            if isolated, let index = args.firstIndex(of: "--bundle-id"), args.indices.contains(index + 1) {
                return args[index + 1]
            }
            return Bundle.main.bundleIdentifier
        }()
        if let bundleId {
            let others = NSRunningApplication
                .runningApplications(withBundleIdentifier: bundleId)
                .filter { $0.processIdentifier != ProcessInfo.processInfo.processIdentifier }
            if let running = others.first {
                running.unhide()
                running.activate(options: [.activateAllWindows])
                // No terminate here — a launch can exist only to carry a
                // custom-scheme URL, and the GURL arrives after launch
                // finishes. Dying now drops a sign-in handoff minted for the
                // running copy's in-memory verifier.
                handoffTarget = running
            }
        }
        NSAppleEventManager.shared().setEventHandler(
            self,
            andSelector: #selector(handleGetURLEvent(_:withReplyEvent:)),
            forEventClass: AEEventClass(kInternetEventClass),
            andEventID: AEEventID(kAEGetURL)
        )
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        if handoffTarget != nil {
            // A relay, not an app: no Dock presence and no window, just long
            // enough for the launch's GURL to reach application(_:open:).
            // A duplicate launched with no URL exits on the same timer.
            NSApp.setActivationPolicy(.prohibited)
            DispatchQueue.main.asyncAfter(deadline: .now() + .seconds(2)) {
                NSApp.terminate(nil)
            }
            return
        }
        NSApp.setActivationPolicy(.regular)
        // No forced activation: a normal launch is activated by the
        // system, not by the app demanding focus. URL handoffs and Dock
        // reopens activate through the supported paths below.
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        // Only the Library window counts — `NSApp.windows.first` could be
        // the Settings window, and ordering it would leave the real window
        // hidden and break the reopen contract. With no recorded window
        // the default reopen behaviour creates one.
        if let window = model?.window {
            if window.isMiniaturized {
                window.deminiaturize(nil)
            }
            window.makeKeyAndOrderFront(nil)
        }
        return true
    }

    @MainActor
    func application(_ application: NSApplication, open urls: [URL]) {
        deliverURLs(urls.map(\.absoluteString))
    }

    @MainActor @objc private func handleGetURLEvent(_ event: NSAppleEventDescriptor, withReplyEvent replyEvent: NSAppleEventDescriptor) {
        guard let urlString = event.paramDescriptor(forKeyword: AEKeyword(keyDirectObject))?.stringValue else { return }
        deliverURLs([urlString])
    }

    @MainActor
    private func deliverURLs(_ urls: [String]) {
        if let target = handoffTarget, let bundleURL = target.bundleURL {
            // The running sibling may hold the verifier this handoff was
            // minted for — bounce the URL through LaunchServices to it. The
            // didFinishLaunching timer retires this copy; LaunchServices
            // delivers the GURL regardless of this process's lifetime.
            let config = NSWorkspace.OpenConfiguration()
            config.activates = true
            for urlString in urls where urlString.contains("://") {
                guard let url = URL(string: urlString) else { continue }
                Trace.log("deep-link relay → \(bundleURL.path) : \(url.host ?? urlString)")
                NSWorkspace.shared.open([url], withApplicationAt: bundleURL, configuration: config) { _, error in
                    if let error { Trace.log("deep-link relay failed: \(error.localizedDescription)") }
                }
            }
            return
        }
        // A deep link is a user-initiated handoff — the running app comes
        // forward through the supported activation API.
        NSApp.activate()
        if let window = model?.window {
            if window.isMiniaturized {
                window.deminiaturize(nil)
            }
            window.makeKeyAndOrderFront(nil)
        }
        for urlString in urls where urlString.contains("://") {
            Trace.log("deep-link received: \(URL(string: urlString)?.host ?? urlString)")
            if let model = self.model {
                model.bridge.deliverDeepLink(urlString)
            } else if !pendingOpenURLs.contains(urlString) {
                pendingOpenURLs.append(urlString)
            }
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        model?.schemeHandler.releaseAll()
    }
}

/// The native menu bar.
///
/// These are the commands a Mac user expects: ⌘O to open a folder, ⌃⌘F for
/// fullscreen, and a Gallery menu for stepping or closing an open gallery.
struct NativeCommands: Commands {
    /// Passed in, not looked up in the environment: the model must be the
    /// same instance whichever scene is key — the Library window or the
    /// Settings pane.
    var model: AppModel

    var body: some Commands {
        // Replace the stock "New" item — this app opens folders, not
        // documents.
        //
        // The command runs the Library's own add flow: the page picks the
        // folder, scans it and records it, so there is one catalogue and
        // one way of adding to it.
        CommandGroup(replacing: .newItem) {
            Button("Open Folder…") {
                model.webViewRef?.evaluateJavaScript("window.__manoramaAddFolder && window.__manoramaAddFolder();")
            }
            .keyboardShortcut("o", modifiers: .command)
        }

        CommandGroup(replacing: .help) {
            Button("manorama Help") {
                NSWorkspace.shared.open(URL(string: "https://manorama.xyz/privacy")!)
            }
        }

        // Gallery navigation — only meaningful while a gallery is open.
        //
        // The arrow key equivalents are ⌥-modified on purpose. The viewer's
        // own arrow handling is a viewport gesture on the web, and the page
        // holds the keyboard while a gallery is open, so a bare arrow here
        // would either shadow the viewer or sit inert in the menu bar
        // depending on where the focus happened to be. ⌥← and ⌥→ say what
        // they mean and never collide.
        //
        // Deliberately no bare `.escape` shortcut on "Close Gallery": a menu
        // key equivalent with bare Escape is intercepted by AppKit BEFORE the
        // WKWebView sees `keyDown`, which would prevent the Viewer from
        // dismissing its own overlays (Info sheet, Settings popover, Picker)
        // with Escape first. When the page does not consume Escape,
        // `Catalogue.tsx` posts `{ type: 'escape' }` which calls `closeGallery()`.
        CommandMenu("Gallery") {
            Button("Next Photograph") { model.step(1, in: model.webViewRef) }
                .keyboardShortcut(.rightArrow, modifiers: .option)
                .disabled(!model.isGalleryOpen)
            Button("Previous Photograph") { model.step(-1, in: model.webViewRef) }
                .keyboardShortcut(.leftArrow, modifiers: .option)
                .disabled(!model.isGalleryOpen)
            Divider()
            Button("Close Gallery") { model.closeGallery() }
                .disabled(!model.isGalleryOpen)
        }

        CommandGroup(after: .toolbar) {
            Button("Add Gallery…") {
                model.webViewRef?.evaluateJavaScript("window.__manoramaAddGallery && window.__manoramaAddGallery();")
            }
            .keyboardShortcut("n", modifiers: [.command, .shift])
            Button("Refresh") { model.reloadLibrary() }
                .keyboardShortcut("r", modifiers: .command)
        }
    }
}

/// Bridges SwiftUI to AppKit window behaviour the SwiftUI API does not
/// expose directly (fullscreen toggling, the key window).
///
/// The window is reported through `viewDidMoveToWindow`, not a one-shot
/// async hop: a deferred main-queue call can run before the view is in a
/// window, and a representable that only checks once leaves the window
/// permanently unconfigured on a slow attach.
struct WindowAccessor: NSViewRepresentable {
    var onWindow: (NSWindow) -> Void

    func makeNSView(context: Context) -> NSView {
        let view = ProbeView()
        view.onWindow = onWindow
        return view
    }

    func updateNSView(_ nsView: NSView, context: Context) {
        (nsView as? ProbeView)?.onWindow = onWindow
        if let window = nsView.window {
            onWindow(window)
        }
    }

    final class ProbeView: NSView {
        var onWindow: ((NSWindow) -> Void)?

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            if let window {
                onWindow?(window)
            }
        }
    }
}
