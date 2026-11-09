import AppKit
import ImageIO
import SwiftUI
import WebKit

/// The app model — the native shell's whole state.
///
/// The web surface is reduced to one thing: the gallery currently open.
/// Everything else (the list, the picker, the menus, the folder access)
/// is native.
@MainActor
final class AppModel: ObservableObject {
    @Published private(set) var galleries: [LocalGallery] = []
    @Published var selectedGalleryID: UUID?
    @Published private(set) var openGallery: LocalGallery?
    @Published var status: String = "Choose a folder to begin"
    @Published private(set) var position: (index: Int, total: Int) = (0, 0)
    @Published var errorMessage: String?

    let folderStore: FolderStore
    let schemeHandler: LocalSchemeHandler
    let coordinator = ViewerCoordinator()

    /// The live webview, so menu commands can drive the viewer.
    @Published var webViewRef: WKWebView?
    /// The host window, so the shell can toggle fullscreen.
    @Published var window: NSWindow?

    /// The token the page uses for the open gallery's folder.
    private var mediaToken: String?
    /// The bundle's root on disk.
    private let bundleRoot: URL

    init(bundleRoot: URL) {
        self.bundleRoot = bundleRoot
        self.folderStore = FolderStore()
        self.schemeHandler = LocalSchemeHandler(bundleRoot: bundleRoot)

        coordinator.onReady = { [weak self] in self?.status = "Ready" }
        coordinator.onPosition = { [weak self] index, _, total in
            self?.position = (index, total)
        }
        coordinator.onEscape = { [weak self] in self?.closeGallery() }
    }

    // MARK: - Folders

    /// The user picked a folder. Grant it, remember it, and list it.
    func addFolder() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.prompt = "Add"
        panel.message = "Choose a folder of photographs to view in place."

        guard panel.runModal() == .OK, let url = panel.url else { return }
        guard let entry = folderStore.add(folder: url) else {
            errorMessage = "That folder could not be remembered for access."
            return
        }
        refreshGalleries()
        status = "Added \(entry.name)"
    }

    /// Rebuild the gallery list from the remembered folders.
    ///
    /// Bookmark resolution stays on the main actor (a stale renewal writes
    /// the store), but the directory walk runs detached — a card or a large
    /// folder must never stall the UI between the click and the list.
    func refreshGalleries() {
        folderStore.refreshAvailability()
        let roots = folderStore.availableFolders()
        Task.detached { [weak self] in
            var built: [LocalGallery] = []
            for (entry, root) in roots {
                let scan = LocalScanner.scan(root: root)
                guard !scan.items.isEmpty else { continue }
                built.append(
                    LocalGallery(
                        id: entry.id,
                        title: entry.name,
                        itemCount: scan.items.count,
                        sourceKind: LocalGallery.SourceKind(rawValue: entry.sourceKind) ?? .folder
                    )
                )
            }
            await MainActor.run {
                guard let self else { return }
                self.galleries = built
                if self.status == "Choose a folder to begin" && !built.isEmpty {
                    self.status = "\(built.count) folder\(built.count == 1 ? "" : "s")"
                }
            }
        }
    }

    func removeGallery(_ gallery: LocalGallery) {
        if let entry = folderStore.entries.first(where: { $0.id == gallery.id }) {
            folderStore.remove(entry)
        }
        if selectedGalleryID == gallery.id { selectedGalleryID = nil }
        refreshGalleries()
    }

    // MARK: - The gallery

    /// Open a gallery: grant the media scope, mint a token, and tell the
    /// page to mount it.
    ///
    /// `resolve` supplies the URL only — `schemeHandler.grant` is what starts
    /// the security scope, so the matching `release` stays the single
    /// balanced pair.
    func open(_ gallery: LocalGallery, in webView: WKWebView?) {
        guard let webView else { return }
        guard let entry = folderStore.entries.first(where: { $0.id == gallery.id }),
              let root = folderStore.resolve(entry) else {
            errorMessage = "\(gallery.title) is no longer accessible. Open the folder again to restore access."
            return
        }

        // Release any previous scope first — two open scopes would keep
        // two folders readable for no reason.
        if let token = mediaToken { schemeHandler.release(token: token) }

        let token = UUID().uuidString
        mediaToken = token
        schemeHandler.grant(token: token, url: root)

        let scan = LocalScanner.scan(root: root)
        let media = scan.items.map { item -> [String: Any] in
            let dims = pixelDimensions(of: item.url) ?? (width: 0, height: 0)
            let src = "manorama://media/\(token)/\(item.id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? item.id)"
            return [
                "id": item.id,
                "filename": item.name,
                "src": src,
                "width": dims.width,
                "height": dims.height,
                "alt": item.name,
                // Local files carry no provenance evidence — unchecked is
                // reported as absent, never claimed as present.
                "c2pa": false,
                // The dark aspect box every other manifest ships — the strip
                // shows it while the original streams in, keeping frames
                // laid out at their true ratio before a byte arrives.
                "placeholder": placeholder(width: dims.width, height: dims.height),
            ]
        }

        var payload: [String: Any] = [
            "slug": gallery.id.uuidString,
            "title": gallery.title,
            "images": media,
            "initialIndex": 0,
        ]
        if let truncated = scan.truncated {
            payload["truncated"] = truncated
        }

        openGallery = gallery
        selectedGalleryID = gallery.id
        status = scan.truncated
            .map { "\(gallery.title) — \(scan.items.count) of \($0) photographs" }
            ?? "\(gallery.title) — \(scan.items.count) photographs"
        coordinator.open(payload, in: webView)
    }

    /// One original's pixel dimensions, read from the file's metadata only —
    /// the viewer needs them to hold the honest-size rule before decode.
    private func pixelDimensions(of url: URL) -> (width: Int, height: Int)? {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? Int,
              let height = properties[kCGImagePropertyPixelHeight] as? Int else { return nil }
        return (width, height)
    }

    /// The same dark aspect box `desktop/lib/local-scan.ts` emits for a
    /// local gallery — real ratio, no pixels, nothing re-encoded.
    private func placeholder(width: Int, height: Int) -> String {
        "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 \(width) \(height)'%3E%3Crect width='100%25' height='100%25' fill='%23111212'/%3E%3C/svg%3E"
    }

    /// Leave the gallery and release the folder's scope. Closing is not a
    /// refresh trigger — the library does not change because a view ended,
    /// so the Escape path stays a cheap release, not a rescan.
    func closeGallery() {
        if let token = mediaToken {
            schemeHandler.release(token: token)
            mediaToken = nil
        }
        openGallery = nil
        position = (0, 0)
    }

    /// The page asked for the next/previous photograph.
    func step(_ delta: Int, in webView: WKWebView?) {
        guard let webView, openGallery != nil else { return }
        let total = position.total
        guard total > 0 else { return }
        let next = (position.index + delta + total) % total
        webView.evaluateJavaScript("window.manoramaNative && window.manoramaNative.goTo(\(next));")
    }

    func goTo(_ index: Int, in webView: WKWebView?) {
        guard let webView else { return }
        webView.evaluateJavaScript("window.manoramaNative && window.manoramaNative.goTo(\(index));")
    }

    /// Toggle the host window's fullscreen.
    ///
    /// `toggleFullScreen(nil)` is the AppKit path the green traffic light
    /// uses — it animates into the Space properly and leaves the menu bar
    /// reachable by hover, which is the behaviour a Mac user expects.
    func toggleFullScreen() {
        window?.toggleFullScreen(nil)
    }
}
