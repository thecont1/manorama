import AppKit
import SwiftUI
import WebKit

/// The shell's layout: a native sidebar listing the galleries, and the
/// viewer surface beside it.
///
/// This is the part the Tauri build cannot have — a real `List` with real
/// selection, real keyboard navigation, real row menus, and a real
/// `NavigationSplitView` that collapses.
struct ContentView: View {
    @EnvironmentObject private var model: AppModel
    @State private var columnVisibility: NavigationSplitViewVisibility = .all

    var body: some View {
        NavigationSplitView(columnVisibility: $columnVisibility) {
            sidebar
        } detail: {
            detail
        }
        .navigationSplitViewStyle(.balanced)
        .toolbar {
            ToolbarItemGroup {
                Button {
                    model.addFolder()
                } label: {
                    Label("Open Folder", systemImage: "folder.badge.plus")
                }
                .help("Open a folder of photographs (⌘O)")
            }
        }
    }

    // MARK: - Sidebar

    private var sidebar: some View {
        List(selection: $model.selectedGalleryID) {
            Section {
                if model.galleries.isEmpty {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("No folders yet")
                            .font(.headline)
                        Text("Open a folder of photographs to view them in place. Nothing is copied or uploaded.")
                            .font(.callout)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                        Button("Open Folder…") { model.addFolder() }
                            .controlSize(.large)
                    }
                    .padding(.vertical, 8)
                    .listRowSeparator(.hidden)
                } else {
                    ForEach(model.galleries) { gallery in
                        GalleryRow(gallery: gallery)
                            .tag(gallery.id)
                            .contextMenu {
                                Button("Refresh") { model.refreshGalleries() }
                                Button("Reveal in Finder") { reveal(gallery) }
                                Divider()
                                Button("Remove Folder", role: .destructive) {
                                    model.removeGallery(gallery)
                                }
                            }
                    }
                }
            } header: {
                Text("Library")
            }
        }
        .listStyle(.sidebar)
        .onChange(of: model.selectedGalleryID) { newValue in
            guard let newValue,
                  let gallery = model.galleries.first(where: { $0.id == newValue })
            else { return }
            model.open(gallery, in: model.webViewRef)
        }
    }

    private func reveal(_ gallery: LocalGallery) {
        guard let entry = model.folderStore.entries.first(where: { $0.id == gallery.id }),
              let root = model.folderStore.resolve(entry) else { return }
        NSWorkspace.shared.activateFileViewerSelecting([root])
    }

    // MARK: - Detail

    @ViewBuilder
    private var detail: some View {
        ZStack {
            Color(nsColor: .windowBackgroundColor)

            // The webview mounts with the window, not with the first
            // gallery — `open` needs a live view to drive, and the shell's
            // empty state covers it until then.
            ViewerWebView(
                schemeHandler: model.schemeHandler,
                coordinator: model.coordinator,
                onCreate: { webView in model.webViewRef = webView }
            )
            .ignoresSafeArea()

            if model.openGallery == nil {
                emptyState
            }
        }
        .overlay(alignment: .bottom) {
            if model.openGallery != nil {
                statusBar
            }
        }
        .background(WindowAccessor { window in
            model.window = window
        })
    }

    private var emptyState: some View {
        VStack(spacing: 14) {
            Image(systemName: "photo.on.rectangle.angled")
                .font(.system(size: 42, weight: .light))
                .foregroundStyle(.secondary)
            Text("No gallery open")
                .font(.title3)
            Text("Choose a folder, then pick a gallery from the sidebar.")
                .font(.callout)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    /// A thin native status bar — the shell's own, not the web's.
    private var statusBar: some View {
        HStack(spacing: 12) {
            Text(model.status)
                .font(.callout)
                .foregroundStyle(.secondary)
            Spacer()
            if model.position.total > 0 {
                Text("\(model.position.index + 1) of \(model.position.total)")
                    .font(.callout.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 7)
        .background(.bar)
    }
}

/// One row in the sidebar.
private struct GalleryRow: View {
    let gallery: LocalGallery

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: gallery.sourceKind == .card ? "externaldrive" : "folder")
                .foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 2) {
                Text(gallery.title)
                    .lineLimit(1)
                Text("\(gallery.itemCount) photograph\(gallery.itemCount == 1 ? "" : "s") · \(gallery.sourceKind.label)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
        .padding(.vertical, 2)
    }
}
