import AppKit
import SwiftUI
import WebKit

/// The native macOS shell.
///
/// The chrome is native: a real sidebar, real menus, real window buttons.
/// The viewing surface is the shared web Viewer inside a WKWebView, reached
/// over a narrow bridge.
///
/// Fullscreen on launch is deliberate — a kiosk decision, not an accident.
/// The photographs are the product, and the app gives them the whole
/// screen with no window chrome in the way. The View menu still offers
/// Exit Full Screen for the times the user wants the window back.
@main
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
                .frame(minWidth: 900, minHeight: 560)
                .onAppear {
                    delegate.model = model
                }
        }
        .windowToolbarStyle(.unified(showsTitle: false))
        .defaultSize(width: 1280, height: 840)
        .commands { NativeCommands(model: model) }
    }
}

/// Keeps the app alive when the last window closes — a Mac app with one
/// window should stay in the Dock and the menu bar.
final class AppDelegate: NSObject, NSApplicationDelegate {
    var model: AppModel?

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationWillTerminate(_ notification: Notification) {
        model?.schemeHandler.releaseAll()
    }
}

/// The native menu bar.
///
/// These are the commands a Mac user expects and the Tauri shell does not
/// have: ⌘O to open a folder, ⌘1–⌘9 to jump to a gallery, ⌃⌘F for
/// fullscreen, and a View menu for the gallery navigation.
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
                model.webViewRef?.evaluateJavaScript("window.__manoramaAddGallery && window.__manoramaAddGallery();")
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
        CommandMenu("Gallery") {
            Button("Next Photograph") { model.step(1, in: model.webViewRef) }
                .keyboardShortcut(.rightArrow, modifiers: .option)
                .disabled(!model.isGalleryOpen)
            Button("Previous Photograph") { model.step(-1, in: model.webViewRef) }
                .keyboardShortcut(.leftArrow, modifiers: .option)
                .disabled(!model.isGalleryOpen)
            Divider()
            Button("Close Gallery") { model.closeGallery() }
                .keyboardShortcut(.escape, modifiers: [])
                .disabled(!model.isGalleryOpen)
        }

        CommandGroup(after: .toolbar) {
            Button("Add Folder…") {
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
