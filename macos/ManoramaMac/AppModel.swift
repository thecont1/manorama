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
@Observable
final class AppModel {
    /// What the shell is doing, in one line.
    private(set) var status: String = "Opening the library…"
    /// The committed photograph, as the page reports it.
    private(set) var position: (index: Int, total: Int) = (0, 0)
    /// Whether a gallery is open.
    private(set) var isGalleryOpen: Bool = false
    /// The open gallery's title.
    private(set) var galleryTitle: String?
    /// Something the user must be told about.
    var errorMessage: String?

    /// The photographs already reported as unreadable this session — one
    /// report per photograph, so a retried frame cannot nag. Bookkeeping,
    /// not interface: nothing renders from it.
    @ObservationIgnored private var reportedFailures: Set<String> = []

    let folderStore: FolderStore
    let schemeHandler: LocalSchemeHandler
    let bridge: NativeBridge
    let coordinator = ViewerCoordinator()

    /// The folders the media handler answers for. The set changes when the
    /// user picks a folder; the handler asks about it for every photograph
    /// it serves, so the list is computed once and cached.
    let grantedRoots = GrantedRoots()
    /// The live webview, so menu commands can drive the viewer. A handle,
    /// not interface state — nothing renders from it.
    @ObservationIgnored var webViewRef: WKWebView?
    /// The Library's host window — the only window the shell ever drives.
    /// The Settings scene is never recorded here, so gallery and deep-link
    /// actions cannot land on the wrong window. Weak: a window that is
    /// released on close must not be resurrected through the delegate.
    @ObservationIgnored weak var window: NSWindow?

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
    /// The guard is per window, not per app lifetime: closing the Library
    /// and reopening it can hand the scene a different NSWindow, and that
    /// window still needs its chrome configured.
    ///
    /// Note: `configureWindow` is called from `WindowAccessor.updateNSView`,
    /// so we must not call `setFrameAutosaveName` here (which triggers
    /// `windowDidResize` → SwiftUI view update → `updateNSView`). The
    /// `window` handle itself is `@ObservationIgnored`, so recording it
    /// cannot re-trigger the representable's update cycle.
    func configureWindow(_ window: NSWindow) {
        if self.window !== window {
            self.window = window
        }
        guard configuredWindows.insert(ObjectIdentifier(window)).inserted else { return }
        window.titlebarAppearsTransparent = true
        window.backgroundColor = NSColor(red: 0x11 / 255.0, green: 0x13 / 255.0, blue: 0x12 / 255.0, alpha: 1.0)
        window.isMovableByWindowBackground = false
    }

    /// The windows whose chrome has been configured.
    @ObservationIgnored private var configuredWindows: Set<ObjectIdentifier> = []

    /// The UserDefaults key the Settings scene writes and the launch
    /// decision reads — one source of truth for both sides.
    static let launchFullScreenDefaultsKey = "openInFullScreen"

    /// Apply the launch window mode, once per process.
    ///
    /// The contract:
    ///   * `--windowed` is a test override and always wins.
    ///   * Otherwise the "Open in full screen" setting decides whether the
    ///     window enters its own Space.
    ///   * The saved window frame restores either way — the preference
    ///     governs only fullscreen, and only at launch. Reopening the
    ///     Library or handing it a deep link never re-applies it.
    ///   * A fullscreen record left over from the kiosk era does not get
    ///     to defeat the windowed default: a launch that decided
    ///     "windowed" undoes one restored fullscreen entry.
    func applyLaunchWindowMode() {
        guard !didApplyLaunchMode, let window else { return }
        didApplyLaunchMode = true
        let wantFullScreen = !CommandLine.arguments.contains("--windowed")
            && UserDefaults.standard.bool(forKey: Self.launchFullScreenDefaultsKey)
        if wantFullScreen {
            enterFullScreenOnce(window)
        } else {
            leaveFullScreenIfRestored(window)
        }
    }

    /// Whether the launch mode has already been applied.
    @ObservationIgnored private var didApplyLaunchMode = false
    /// The one-shot observer used while the launch mode is pending.
    @ObservationIgnored private var launchModeObserver: NSObjectProtocol?
    /// Disarms a pending launch-mode observer once the launch has settled.
    @ObservationIgnored private var launchModeDeadline: DispatchWorkItem?

    /// Enter fullscreen once the window is ready — only if the launch
    /// decision asked for it and the window is not already there. AppKit
    /// will not animate a window into a Space before it is on screen, so a
    /// window that is not yet visible is deferred to the occlusion-state
    /// notification rather than an arbitrary timer.
    private func enterFullScreenOnce(_ window: NSWindow) {
        guard !window.styleMask.contains(.fullScreen) else { return }
        if window.isVisible {
            window.toggleFullScreen(nil)
            return
        }
        launchModeObserver = NotificationCenter.default.addObserver(
            forName: NSWindow.didChangeOcclusionStateNotification,
            object: window,
            queue: .main
        ) { [weak self, weak window] _ in
            // The observer runs on the main queue, so the main actor is
            // already where this executes.
            MainActor.assumeIsolated {
                self?.disarmLaunchMode()
                guard let window,
                      window.occlusionState.contains(.visible),
                      !window.styleMask.contains(.fullScreen) else { return }
                window.toggleFullScreen(nil)
            }
        }
        // The visibility check above races the order-in: if the window
        // became visible before the observer landed, act now.
        if window.isVisible {
            disarmLaunchMode()
            window.toggleFullScreen(nil)
        }
    }

    /// Undo a fullscreen the window restored on its own. A launch that
    /// decided "windowed" can still arrive in a Space when the system
    /// resumes an old fullscreen record — one that predates the setting.
    /// That record is corrected once, during the launch settle only; a
    /// fullscreen the user enters afterwards is their own and stands.
    private func leaveFullScreenIfRestored(_ window: NSWindow) {
        if window.styleMask.contains(.fullScreen) {
            window.toggleFullScreen(nil)
            return
        }
        launchModeObserver = NotificationCenter.default.addObserver(
            forName: NSWindow.didEnterFullScreenNotification,
            object: window,
            queue: .main
        ) { [weak self, weak window] _ in
            MainActor.assumeIsolated {
                self?.disarmLaunchMode()
                guard let window, window.styleMask.contains(.fullScreen) else { return }
                window.toggleFullScreen(nil)
            }
        }
        // Restoration finishes promptly after the window orders in; three
        // seconds covers a slow Space transition without lingering long
        // enough to undo a deliberate shortcut.
        let deadline = DispatchWorkItem { [weak self] in self?.disarmLaunchMode() }
        launchModeDeadline = deadline
        DispatchQueue.main.asyncAfter(deadline: .now() + 3, execute: deadline)
    }

    /// Drop the pending launch-mode observer, if any.
    private func disarmLaunchMode() {
        if let launchModeObserver { NotificationCenter.default.removeObserver(launchModeObserver) }
        launchModeObserver = nil
        launchModeDeadline?.cancel()
        launchModeDeadline = nil
    }

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
