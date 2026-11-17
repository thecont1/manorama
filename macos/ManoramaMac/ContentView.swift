import AppKit
import SwiftUI
import WebKit

/// The Settings segment's frame, published by the cluster so the sheet's
/// glass knows where to launch from.
private struct SettingsAnchorKey: PreferenceKey {
    static let defaultValue: CGRect = .zero
    static func reduce(value: inout CGRect, nextValue: () -> CGRect) { value = nextValue() }
}

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
    /// The cluster rides one glass surface until the pointer asks for
    /// more — then the controls separate into their own pills.
    @State private var clusterExpanded = false

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
        // The viewer's own bottom controls, in the shell's glass: one
        // merged surface at rest that separates under the pointer. The
        // web pills stay mounted behind it — a native press fires the
        // real handler inside the page.
        .overlay(alignment: .bottom) {
            if #available(macOS 26.0, *), model.isGalleryOpen, model.viewerChromeVisible, model.viewerSheetRect == nil {
                viewerControlsCluster
                    .padding(.bottom, 16)
                    .transition(.opacity)
            }
        }
        // The Settings morph — when a sheet opens, the segment's glass
        // travels to the sheet's reported box and fades as the web
        // panel's own surface takes over. The surface ignores the safe
        // area because the reported rect is in webview coordinates —
        // the window's own, untrimmed space.
        .overlay {
            if #available(macOS 26.0, *), model.isGalleryOpen, model.viewerSheetRect != nil {
                SheetGlassSurface(
                    start: model.settingsAnchor,
                    end: model.viewerSheetRect,
                    reduceMotion: reduceMotion,
                    reduceTransparency: reduceTransparency
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .ignoresSafeArea()
            }
        }
        .onPreferenceChange(SettingsAnchorKey.self) { model.settingsAnchor = $0 }
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

    /// The viewer's bottom controls as one glass surface: the position,
    /// Gallery Settings and Info, merged at rest and separating under
    /// the pointer. Every press fires the page's own (hidden) pill, so
    /// the picker's focus path, the settings popover and the info sheet
    /// keep their web wiring untouched.
    @available(macOS 26.0, *)
    @ViewBuilder private var viewerControlsCluster: some View {
        if reduceTransparency {
            HStack(spacing: 8) {
                clusterSolidButton(label: Text(positionText), action: "[data-chrome-position]", accessibilityLabel: "Go to a photograph")
                clusterSolidButton(label: Image(systemName: "slider.horizontal.3"), action: "[data-chrome-bottom] [aria-label='Gallery Settings']", accessibilityLabel: "Gallery Settings")
                    .background(anchorProbe)
                clusterSolidButton(label: Image(systemName: "info"), action: "[data-chrome-bottom] [aria-label='Info']", accessibilityLabel: "Info")
            }
            .padding(.horizontal, 6)
            .padding(.vertical, 4)
            .background(Capsule().fill(Color(white: 0.06, opacity: 0.92)))
        } else {
            // Inside the container, controls nearer than `spacing` blend
            // into one surface; further apart they are their own pills.
            // Rest sits at 0 — a single bar — and the pointer opens the
            // spacing so the three land as separate glass.
            GlassEffectContainer(spacing: 14) {
                HStack(spacing: clusterExpanded ? 18 : 0) {
                    Button {
                        model.invokeWebControl("[data-chrome-position]")
                    } label: {
                        Text(positionText)
                            .font(.system(size: 15, weight: .semibold))
                            .monospacedDigit()
                            .frame(minWidth: 52, minHeight: 40)
                    }
                    .accessibilityLabel("Go to a photograph")

                    Button {
                        model.invokeWebControl("[data-chrome-bottom] [aria-label='Gallery Settings']")
                    } label: {
                        Image(systemName: "slider.horizontal.3")
                            .font(.system(size: 17))
                            .frame(minWidth: 44, minHeight: 40)
                    }
                    .accessibilityLabel("Gallery Settings")
                    .background(anchorProbe)

                    Button {
                        model.invokeWebControl("[data-chrome-bottom] [aria-label='Info']")
                    } label: {
                        Image(systemName: "info")
                            .font(.system(size: 15, weight: .semibold))
                            .frame(minWidth: 44, minHeight: 40)
                    }
                    .accessibilityLabel("Info")
                }
                .buttonStyle(.glass)
                .font(.system(size: 15))
            }
            .onHover { hovering in
                withAnimation(reduceMotion ? nil : .spring(response: 0.34, dampingFraction: 0.78)) {
                    clusterExpanded = hovering
                }
            }
        }
    }

    /// What the position segment reads — the same "n of m" the web pill
    /// carries, fed by the page's own position reports.
    private var positionText: String {
        model.position.total > 0 ? "\(model.position.index + 1) of \(model.position.total)" : "…"
    }

    /// The cluster's Settings seat, published to the model in window
    /// coordinates — where the sheet's glass morphs from.
    private var anchorProbe: some View {
        GeometryReader { geometry in
            Color.clear.preference(key: SettingsAnchorKey.self, value: geometry.frame(in: .global))
        }
        .allowsHitTesting(false)
    }

    /// Reduce-Transparency sibling of a cluster button — same action,
    /// plain surface, no glass.
    private func clusterSolidButton(label: some View, action: String, accessibilityLabel: String) -> some View {
        Button {
            model.invokeWebControl(action)
        } label: {
            label
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(Color(red: 0.95, green: 0.94, blue: 0.91))
                .frame(minWidth: 44, minHeight: 40)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(accessibilityLabel)
    }
}

/// The travelling glass that carries a cluster segment into a sheet.
/// The native overlay always renders above the webview, so the glass
/// cannot sit *behind* the panel's text — instead it launches from the
/// Settings segment's seat, lands on the sheet's reported box as the
/// sheet enters, and fades out as the web panel's own surface takes
/// over. To the eye the control simply grew into the panel.
@available(macOS 26.0, *)
private struct SheetGlassSurface: View {
    /// The morph's launch frame — the Settings segment's seat, or the
    /// sheet's own box when no cluster was up to open it (a keyboard
    /// shortcut, a deep link). Falling back to the box means the surface
    /// simply appears instead of morphing from nowhere.
    let start: CGRect
    /// The live box the observer reports; nil while closing.
    let end: CGRect?
    let reduceMotion: Bool
    let reduceTransparency: Bool

    /// Whether the surface has landed on the sheet's box.
    @State private var arrived = false
    /// The box the surface currently holds — chases `end` as the sheet
    /// settles out of its enter animation.
    @State private var held: CGRect = .zero
    /// The handoff — once landed, the glass yields to the web panel's
    /// own surface.
    @State private var opacity: Double = 1

    var body: some View {
        // No recorded anchor (no cluster was up) or the morph is done —
        // the surface simply holds the sheet's box. Otherwise it is
        // still at the segment's seat, travelling.
        let frame = (arrived || start == .zero) ? held : start
        Group {
            if reduceTransparency {
                RoundedRectangle(cornerRadius: 18)
                    .fill(Color(white: 0.06, opacity: 0.94))
            } else {
                RoundedRectangle(cornerRadius: 18)
                    .fill(.clear)
                    .glassEffect(.regular, in: .rect(cornerRadius: 18))
            }
        }
        .frame(width: frame.width, height: frame.height)
        .position(x: frame.midX, y: frame.midY)
        .opacity(opacity)
        .transition(.opacity)
        .onAppear {
            held = end ?? start
            withAnimation(reduceMotion ? nil : .spring(response: 0.38, dampingFraction: 0.82)) {
                arrived = true
            }
            withAnimation(reduceMotion ? nil : .easeOut(duration: 0.3).delay(0.5)) {
                opacity = 0
            }
        }
        .onChange(of: end) {
            guard let end else { return }
            withAnimation(reduceMotion ? nil : .spring(response: 0.38, dampingFraction: 0.82)) {
                held = end
            }
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}
