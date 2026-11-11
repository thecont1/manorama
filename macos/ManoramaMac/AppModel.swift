import AppKit
import ImageIO
import SwiftUI
import WebKit

/// The app model — the native shell's whole state.
///
/// The shell does not have a library of its own. The Library is the app's
/// own web surface — the tier line, the vault meter, the pinned strips, the
/// gallery grid, the local catalogue — and the shell's job is to give it a
/// real window, a real menu bar, a real Space, and the machine's answers
/// when it asks for a folder, a private file or a vault key.
///
/// What the shell owns is the chrome and the capability. What the page owns
/// is the Library.
@MainActor
final class AppModel: ObservableObject {
    /// What the shell is doing, in one line.
    @Published private(set) var status: String = "Opening the library…"
    /// The committed photograph, as the page reports it.
    @Published private(set) var position: (index: Int, total: Int) = (0, 0)
    /// Whether a gallery is open.
    @Published private(set) var isGalleryOpen: Bool = false
    /// The open gallery's title.
    @Published private(set) var galleryTitle: String?
    /// Something the user must be told about.
    @Published var errorMessage: String?

    /// The photographs already reported as unreadable this session — one
    /// report per photograph, so a retried frame cannot nag.
    private var reportedFailures: Set<String> = []

    let folderStore: FolderStore
    let schemeHandler: LocalSchemeHandler
    let bridge: NativeBridge
    let coordinator = ViewerCoordinator()

    /// The folders the media handler answers for. The set changes when the
    /// user picks a folder; the handler asks about it for every photograph
    /// it serves, so the list is computed once and cached.
    let grantedRoots = GrantedRoots()
    /// The live webview, so menu commands can drive the viewer.
    @Published var webViewRef: WKWebView?
    /// The host window, so the shell can toggle fullscreen.
    @Published var window: NSWindow?

    /// The bundle's root on disk.
    private let bundleRoot: URL

    init(bundleRoot: URL) {
        self.bundleRoot = bundleRoot

        // `--store <path>` puts the remembered folders somewhere else.
        // The default location is shared by every instance of the app, so
        // two running copies overwrite each other's grant list; the
        // boundary test gives each run its own file.
        let storeURL: URL? = {
            let arguments = CommandLine.arguments
            guard let index = arguments.firstIndex(of: "--store"), index + 1 < arguments.count else { return nil }
            return URL(fileURLWithPath: arguments[index + 1])
        }()
        // `--config <dir>` puts the app's private documents — the session,
        // the catalogue, the vault and the picker-approved roots — somewhere
        // else. The default is shared with the Tauri build, which is what
        // makes the two shells one app; a test run needs its own copy, or it
        // writes the user's catalogue.
        let configDir: URL? = {
            let arguments = CommandLine.arguments
            guard let index = arguments.firstIndex(of: "--config"), index + 1 < arguments.count else { return nil }
            return URL(fileURLWithPath: arguments[index + 1], isDirectory: true)
        }()
        self.folderStore = FolderStore(fileURL: storeURL, configDir: configDir)
        self.schemeHandler = LocalSchemeHandler(bundleRoot: bundleRoot)
        let roots = grantedRoots
        self.bridge = NativeBridge(
            folderStore: folderStore,
            grantedRoots: roots,
            configDir: configDir
        )
        coordinator.bridge = bridge
        // The media handler answers an absolute path only when it really is
        // inside a root the user granted. The list is read from the cache
        // the shell keeps up to date, because the handler asks on every
        // photograph it serves.
        schemeHandler.grantedRoots = { roots.all() }
        bridge.onRootsChanged = { [weak self] in
            Task { @MainActor in self?.refreshGrantedRoots() }
        }
        refreshGrantedRoots()

        // A photograph that could not be served is an error the user must
        // see. The page only knows it got a 404 and retries; the shell is
        // the one that has to say so.
        //
        // The wording has to be true. A file that is no longer on disk is
        // the folder's business and the message says so; a file that is
        // still on disk and could not be opened is the app's own failure,
        // and the message says that instead of blaming the user's
        // storage for it. Each photograph is reported once — a viewer
        // that retries a frame must not produce the same alert again and
        // again.
        schemeHandler.onMediaMissing = { [weak self] name, failure in
            // The scheme handler answers on WebKit's own queue, and the
            // alert and the status line are SwiftUI state — they are
            // published from the main actor or not at all.
            Task { @MainActor in
                guard let self else { return }
                guard !self.reportedFailures.contains(name) else { return }
                self.reportedFailures.insert(name)
                guard self.errorMessage == nil else { return }
                switch failure {
                case .gone:
                    Trace.log("media missing: \(name) — gone")
                    self.errorMessage = "\(name) is no longer in the folder. It may have been moved, renamed or deleted since the gallery was catalogued."
                    self.status = "Some photographs are missing"
                case .unreadable(let reason):
                    Trace.log("media unreadable: \(name) — \(reason)")
                    self.errorMessage = "\(name) is still in the folder, but the app could not open it: \(reason)."
                    self.status = "Some photographs could not be opened"
                }
            }
        }

        coordinator.onReady = { [weak self] in
            self?.status = "Library ready"
            // A test run asks for a folder to be added as the Library comes
            // up; the app's own add flow does the rest.
            // A test run asks for a folder to be added. The page runs the
            // add, not the shell: local galleries are a Visionary feature,
            // so the add cannot happen before the session says who the
            // owner is. The shell only raises the flag.
            if self?.bridge.hasSeededFolder == true {
                Trace.log("seeding the folder")
                self?.webViewRef?.evaluateJavaScript("window.__manoramaSeedRequested = true;")
            }
        }
        coordinator.onPosition = { [weak self] index, _, total in
            Trace.log("position index=\(index) total=\(total)")
            self?.position = (index, total)
        }
        coordinator.onEscape = { [weak self] in Trace.log("escape"); self?.closeGallery() }

        // The page reports the gallery it has open and the photograph it is
        // on, so the shell's status bar is the shell's own.
        coordinator.onGalleryState = { [weak self] open, title in
            self?.isGalleryOpen = open
            self?.galleryTitle = title
            if !open { self?.position = (0, 0) }
        }
    }

    // MARK: - The gallery

    /// Recompute the folders the media handler answers for.
    ///
    /// Main actor: it reads the folder store's published entries and
    /// backfills bookmarks for any reachable picker-approved roots in
    /// `roots.json` (such as folders picked in the Tauri build).
    func refreshGrantedRoots() {
        for root in bridge.savedGalleryRoots() {
            if folderStore.grantIfKnown(root) == nil {
                var isDir: ObjCBool = false
                if FileManager.default.fileExists(atPath: root, isDirectory: &isDir), isDir.boolValue {
                    if let entry = folderStore.add(folder: URL(fileURLWithPath: root)) {
                        _ = folderStore.startAccess(entry)
                    }
                }
            }
        }
        folderStore.refreshAvailability()
        grantedRoots.replace(folderStore.grantedRoots())
    }

    /// Reload the Library.
    ///
    /// The Library owns its own refresh — the account feed, the local
    /// catalogue and the vault meter each refresh themselves — so the
    /// native Refresh command reloads the page and lets the Library do it
    /// its own way.
    func reloadLibrary() {
        webViewRef?.reload()
    }

    /// Leave the gallery and go back to the Library.
    func closeGallery() {
        webViewRef?.evaluateJavaScript("window.__manoramaCloseGallery && window.__manoramaCloseGallery();")
    }

    /// The page asked for the next/previous photograph.
    func step(_ delta: Int, in webView: WKWebView?) {
        guard let webView, isGalleryOpen else { return }
        let total = position.total
        guard total > 0 else { return }
        let next = (position.index + delta + total) % total
        webView.evaluateJavaScript("window.__manoramaShell && window.__manoramaShell.goTo(\(next));")
    }

    /// The page asked for a specific photograph.
    func goTo(_ index: Int, in webView: WKWebView?) {
        guard let webView else { return }
        webView.evaluateJavaScript("window.__manoramaShell && window.__manoramaShell.goTo(\(index));")
    }

    // MARK: - The window

    /// Configure the host window's canvas. Unlike Tauri's `tauri.conf.json`
    /// (which overlaid a hidden titlebar via `.fullSizeContentView`), the
    /// unified toolbar keeps the traffic lights in real chrome above the
    /// webview — the page's top-left corner belongs to the page, which the
    /// `macos-shell` marker class lets the CSS know.
    ///
    /// Note: `configureWindow` is called from `WindowAccessor.updateNSView`,
    /// so we must not mutate `@Published var window` (which would re-trigger
    /// `updateNSView` on the next tick in an infinite loop) or call
    /// `setFrameAutosaveName` (which triggers `windowDidResize` → SwiftUI
    /// view update → `updateNSView`).
    func configureWindow(_ window: NSWindow) {
        if self.window !== window {
            self.window = window
        }
        guard !didConfigureWindow else { return }
        didConfigureWindow = true
        window.titlebarAppearsTransparent = true
        window.backgroundColor = NSColor(red: 0x11 / 255.0, green: 0x13 / 255.0, blue: 0x12 / 255.0, alpha: 1.0)
        window.isMovableByWindowBackground = false
    }

    private var didConfigureWindow = false

    /// Toggle the host window's fullscreen.
    ///
    /// `toggleFullScreen(nil)` is the AppKit path the green traffic light
    /// uses — it animates into the Space properly and leaves the menu bar
    /// reachable by hover, which is the behaviour a Mac user expects.
    func toggleFullScreen() {
        window?.toggleFullScreen(nil)
    }

    /// Open in its own Space, once.
    ///
    /// This is deliberate, not an accident: the photographs are the
    /// product, and a fullscreen window gives them the whole screen with
    /// no window chrome competing for attention. The View menu still
    /// offers Exit Full Screen for the times the user wants the window
    /// back.
    func openInFullScreen() {
        guard !didOpenInFullScreen, let window else { return }
        didOpenInFullScreen = true
        // A test run does not get to take over the screen. The kiosk
        // launch state is still exercised — the suite launches once
        // without this flag to prove it.
        if CommandLine.arguments.contains("--windowed") { return }
        // AppKit will not animate a window into a Space before it is on
        // screen, so this waits a beat after the window is reported.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
            NSApp.activate(ignoringOtherApps: true)
            window.toggleFullScreen(nil)
        }
    }

    /// Whether the window has already been sent to its Space.
    private var didOpenInFullScreen = false

    // MARK: - The probe

    /// The probe hook: `--eval <expression>` asks the page a question and
    /// writes the answer to the trace.
    ///
    /// The expression is re-asked on a timer rather than once, because the
    /// page is not ready when the app launches — a probe that asks "how
    /// many frames are mounted?" before a gallery is open gets zero, and
    /// a one-shot probe would stop there forever. Re-asking is what lets a
    /// probe wait for the thing it cares about and then act on it.
    func startEvalProbe() {
        let arguments = CommandLine.arguments
        guard let evalIndex = arguments.firstIndex(of: "--eval"),
              evalIndex + 1 < arguments.count else { return }
        ask(arguments[evalIndex + 1])
    }

    /// Ask the page the probe's question, and come back for the answer
    /// half a second later.
    private func ask(_ expression: String) {
        guard let webView = webViewRef else { return }
        eval(expression, in: webView)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in
            self?.ask(expression)
        }
    }

    /// Ask the page one question and record the answer.
    func eval(_ expression: String, in webView: WKWebView?) {
        guard let webView else {
            Trace.log("eval \(expression) — no webview")
            return
        }
        webView.evaluateJavaScript(expression) { value, error in
            if let error {
                Trace.log("eval \(expression) → error \(error.localizedDescription)")
            } else if let value {
                Trace.log("eval \(expression) → \(value)")
            } else {
                Trace.log("eval \(expression) → nil")
            }
        }
    }
}
