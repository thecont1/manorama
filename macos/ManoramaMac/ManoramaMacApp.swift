import AppKit
import SwiftUI
import WebKit

/// The native macOS shell.
///
/// The chrome is native: real menus, real window buttons, real Space.
/// The viewing surface is the shared web Library + Viewer inside a WKWebView,
/// reached over a narrow bridge.
///
/// Fullscreen on launch is deliberate — a kiosk decision, not an accident.
/// The photographs are the product, and the app gives them the whole
/// screen with no window chrome in the way. The View menu still offers
/// Exit Full Screen for the times the user wants the window back.
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
    @StateObject private var model: AppModel

    init() {
        // The bundle root is where the viewer bundle was copied into the
        // app's Resources. The scheme handler serves it from here.
        let bundleRoot = Bundle.main.resourceURL?
            .appendingPathComponent("ViewerBundle", isDirectory: true)
            ?? URL(fileURLWithPath: NSTemporaryDirectory())
        _model = StateObject(wrappedValue: AppModel(bundleRoot: bundleRoot))
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(model)
                .frame(minWidth: 760, minHeight: 520)
                .onAppear {
                    delegate.model = model
                    for url in delegate.pendingOpenURLs {
                        model.bridge.deliverDeepLink(url)
                    }
                    delegate.pendingOpenURLs.removeAll()
                }
        }
        .windowToolbarStyle(.unified(showsTitle: false))
        .defaultSize(width: 1280, height: 840)
        .commands {
            NativeCommands(model: model)
        }
    }
}

/// Keeps the app alive when the last window closes and routes custom-scheme
/// deep links (`in.thecontrarian.manorama.desktop://...`) to the active window.
final class AppDelegate: NSObject, NSApplicationDelegate {
    var model: AppModel?
    var pendingOpenURLs: [String] = []

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationWillFinishLaunching(_ notification: Notification) {
        // One instance, ever — two shells on one container would race the
        // catalogue, the folder store, the vault key file, and providers.json.
        // A second launch hands focus to the running app and exits before any
        // of that state opens.
        //
        // A launch may carry `--bundle-id <id>` to probe a different id
        // than the bundle's own — the focus-test suite uses one so its
        // instance coexists with an installed copy instead of handing the
        // installed app focus and exiting. With no override the check
        // probes the real bundle id and detects other instances as before.
        let args = CommandLine.arguments
        let bundleId: String? = {
            if let index = args.firstIndex(of: "--bundle-id"), args.indices.contains(index + 1) {
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
                NSApp.terminate(nil)
                return
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
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if let window = model?.window ?? NSApp.windows.first {
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
        NSApp.activate(ignoringOtherApps: true)
        if let window = model?.window ?? NSApp.windows.first {
            if window.isMiniaturized {
                window.deminiaturize(nil)
            }
            window.makeKeyAndOrderFront(nil)
        }
        for urlString in urls where urlString.contains("://") {
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
    @ObservedObject var model: AppModel

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
struct WindowAccessor: NSViewRepresentable {
    var onWindow: (NSWindow) -> Void

    func makeNSView(context: Context) -> NSView {
        let view = NSView()
        DispatchQueue.main.async {
            guard let window = view.window else { return }
            self.onWindow(window)
        }
        return view
    }

    func updateNSView(_ nsView: NSView, context: Context) {
        DispatchQueue.main.async {
            guard let window = nsView.window else { return }
            self.onWindow(window)
        }
    }
}
