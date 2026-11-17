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
    /// The shell's model, passed down from the app. A direct property is
    /// enough — this view always has the model — and Observation still
    /// tracks everything the body reads.
    let model: AppModel

    /// Matches `src-tauri/tauri.conf.json` `backgroundColor: "#111312"`.
    private static let canvasColor = Color(red: 0x11 / 255.0, green: 0x13 / 255.0, blue: 0x12 / 255.0)

    /// Reduced transparency swaps the glass for a surface the system
    /// cannot misread — the capsule stays, its material does not.
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    /// Reduced motion keeps the opacity swap but drops the easing.
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ZStack {
            Self.canvasColor

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
                accessibilityStatusReadout
            }
        }
        // The Library exit is native glass on 26+: the webview marks its
        // page so the web pill stays out of the way, and the capsule takes
        // its seat — appearing and leaving with the viewer's chrome rather
        // than hovering over a photograph at rest.
        .overlay(alignment: .topLeading) {
            if #available(macOS 26.0, *), model.isGalleryOpen, model.viewerChromeVisible {
                libraryReturnCapsule
                    // The safe area already clears the traffic lights —
                    // +8 lands the capsule on the bar's own top edge.
                    .padding(.top, 8)
                    .padding(.leading, 41)
                    .transition(.opacity)
            }
        }
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.2), value: model.isGalleryOpen && model.viewerChromeVisible)
        .background(WindowAccessor { window in
            model.configureWindow(window)
            model.applyLaunchWindowMode()
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

    /// Status and position readout for Accessibility (`AXProbe`, VoiceOver)
    /// without painting a competing bar over the viewer's `.stage-arrows`.
    ///
    /// Note: SwiftUI omits `.opacity(0)` views from the macOS Accessibility
    /// hierarchy (`kAXChildrenAttribute`). Keeping `.opacity(0.01)` on a
    /// 1pt-tall transparent strip preserves the `AXStaticText` nodes in the
    /// native AX tree while leaving the stage visually and interactively
    /// unobstructed.
    private var accessibilityStatusReadout: some View {
        HStack(spacing: 12) {
            Text(model.galleryTitle ?? model.status)
                .font(.caption2)
                .foregroundStyle(Color.white.opacity(0.01))
            Spacer()
            if model.position.total > 0 {
                Text("\(model.position.index + 1) of \(model.position.total)")
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(Color.white.opacity(0.01))
            }
        }
        .frame(height: 1)
        .allowsHitTesting(false)
    }

    /// The floating Library return — a capsule of the system's own glass
    /// where the page's pill used to sit. `.interactive()` lets it answer
    /// the pointer like real glass; under Reduce Transparency it is a
    /// quiet dark surface instead, because a user who asked the system
    /// not to blur should not get a blurred button back.
    @available(macOS 26.0, *)
    @ViewBuilder private var libraryReturnCapsule: some View {
        let button = Button {
            model.closeGallery()
        } label: {
            Label("Library", systemImage: "chevron.left")
                // The web pill it replaces was 44px tall — the shell's
                // minimum target — so the label, not the style, sets the
                // capsule's size.
                .frame(minHeight: 44)
                .padding(.horizontal, 14)
                .font(.system(size: 16, weight: .semibold))
        }
        .controlSize(.large)

        if reduceTransparency {
            button
                .buttonStyle(.plain)
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
                .background(Capsule().fill(Color(white: 0.06, opacity: 0.92)))
                .foregroundStyle(Color(red: 0.95, green: 0.94, blue: 0.91))
        } else {
            button.buttonStyle(.glass)
        }
    }
}
