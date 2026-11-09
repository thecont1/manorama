import AppKit
import SwiftUI
import WebKit

/// The shell's layout: the app's own Library, filling the window, with the
/// shell's chrome around it.
///
/// There is no native sidebar, and that is the point. The Library is where
/// the account, the tier, the vault meter, the pinned galleries, the ad slot
/// and the local catalogue live; a second, native list of folders beside it
/// would deliver nothing the Library does not already deliver, and would
/// hide the services that do.
///
/// What the shell adds is what a web page cannot have: a real window, a
/// real menu bar, a real Space, and the machine's answers when the Library
/// asks for a folder or a vault key.
struct ContentView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        ZStack {
            Color(nsColor: .windowBackgroundColor)

            // The webview mounts with the window, not with the first
            // gallery — the shell's commands need a live view to drive, and
            // the Library mounts on its own.
            ViewerWebView(
                schemeHandler: model.schemeHandler,
                coordinator: model.coordinator,
                onCreate: { webView in
                    model.webViewRef = webView
                    model.bridge.webView = webView
                    model.startEvalProbe()
                }
            )
            .ignoresSafeArea()
        }
        .overlay(alignment: .bottom) {
            if model.isGalleryOpen {
                statusBar
            }
        }
        .background(WindowAccessor { window in
            model.window = window
            model.openInFullScreen()
        })
        .alert(
            "Something went wrong",
            isPresented: Binding(
                get: { model.errorMessage != nil },
                set: { if !$0 { model.errorMessage = nil } }
            ),
            presenting: model.errorMessage
        ) { _ in
            Button("OK") { model.errorMessage = nil }
        } message: { message in
            Text(message)
        }
    }

    /// A thin native status bar — the shell's own, not the web's.
    private var statusBar: some View {
        HStack(spacing: 12) {
            Text(model.galleryTitle ?? model.status)
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
