import AppKit
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
    func refreshGalleries() {
        folderStore.refreshAvailability()
        var built: [LocalGallery] = []
        for entry in folderStore.entries {
            guard let root = folderStore.resolve(entry) else { continue }
            let items = LocalScanner.scan(root: root)
            guard !items.isEmpty else { continue }
            built.append(
                LocalGallery(
                    id: entry.id,
                    title: entry.name,
                    itemCount: items.count,
                    sourceKind: LocalGallery.SourceKind(rawValue: entry.sourceKind) ?? .folder
                )
            )
        }
        galleries = built
        if status == "Choose a folder to begin" && !built.isEmpty {
            status = "\(built.count) folder\(built.count == 1 ? "" : "s")"
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
    func open(_ gallery: LocalGallery, in webView: WKWebView?) {
        guard let webView else { return }
        guard let entry = folderStore.entries.first(where: { $0.id == gallery.id }),
              let root = folderStore.startAccess(entry) else {
            errorMessage = "\(gallery.title) is no longer accessible. Open the folder again to restore access."
            return
        }

        // Release any previous scope first — two open scopes would keep
        // two folders readable for no reason.
        if let token = mediaToken { schemeHandler.release(token: token) }

        let token = UUID().uuidString
        mediaToken = token
        schemeHandler.grant(token: token, url: root)

        let items = LocalScanner.scan(root: root)
        let media = items.map { item -> [String: Any] in
            [
                "id": item.id,
                "filename": item.name,
                "src": "manorama://media/\(token)/\(item.id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? item.id)",
                "alt": item.name,
                "c2pa": true,
            ]
        }

        let payload: [String: Any] = [
            "slug": gallery.id.uuidString,
            "title": gallery.title,
            "images": media,
            "initialIndex": 0,
        ]

        openGallery = gallery
        selectedGalleryID = gallery.id
        status = "\(gallery.title) — \(items.count) photographs"
        coordinator.open(payload, in: webView)
    }

    /// Leave the gallery and release the folder's scope.
    func closeGallery() {
        if let token = mediaToken {
            schemeHandler.release(token: token)
            mediaToken = nil
        }
        openGallery = nil
        position = (0, 0)
        refreshGalleries()
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
