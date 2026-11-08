import AppKit
import SwiftUI
import WebKit

/// The native macOS shell.
///
/// The chrome is native: a real sidebar, real menus, real window buttons.
/// The viewing surface is the shared web Viewer inside a WKWebView, reached
/// over a narrow bridge.
///
/// Deliberately NOT fullscreen on launch. The Tauri build declares
/// `"fullscreen": true`, which puts the app in its own macOS Space with no
/// traffic lights and a menu bar that only appears when the pointer reaches
/// the top of the screen. A Mac app opens in a window; fullscreen is
/// something the user asks for with ⌃⌘F.
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
                    model.refreshGalleries()
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
        CommandGroup(replacing: .newItem) {
            Button("Open Folder…") { model.addFolder() }
                .keyboardShortcut("o", modifiers: .command)
        }

        CommandGroup(replacing: .help) {
            Button("manorama Help") {
                NSWorkspace.shared.open(URL(string: "https://manorama.xyz/privacy")!)
            }
        }

        // Gallery navigation — only meaningful while a gallery is open.
        CommandMenu("Gallery") {
            Button("Next Photograph") { model.step(1, in: model.webViewRef) }
                .keyboardShortcut(.rightArrow, modifiers: [])
                .disabled(model.openGallery == nil)
            Button("Previous Photograph") { model.step(-1, in: model.webViewRef) }
                .keyboardShortcut(.leftArrow, modifiers: [])
                .disabled(model.openGallery == nil)
            Divider()
            Button("Close Gallery") { model.closeGallery() }
                .keyboardShortcut(.escape, modifiers: [])
                .disabled(model.openGallery == nil)
        }

        CommandGroup(after: .toolbar) {
            Button("Add Folder…") { model.addFolder() }
                .keyboardShortcut("n", modifiers: [.command, .shift])
            Button("Refresh") { model.refreshGalleries() }
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
