import AppKit
import SwiftUI
import WebKit

struct ContentView: View {
    let model: AppModel

    private static let canvasColor = Color(red: 0x11 / 255.0, green: 0x13 / 255.0, blue: 0x12 / 255.0)

    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.openWindow) private var openWindow
    @State private var libraryHovered = false
    @State private var clusterHovered = false
    @State private var clusterNearby = false
    @State private var clusterTrackingEnabled = false
    @Namespace private var clusterNamespace
    @FocusState private var focusedControl: ViewerChromeControl?
    @AccessibilityFocusState private var accessibleControl: ViewerChromeControl?

    private var chromeActive: Bool {
        libraryHovered || clusterHovered || clusterNearby || focusedControl != nil || accessibleControl != nil
    }

    private var clusterExpanded: Bool {
        reduceMotion || clusterHovered || clusterNearby
            || (focusedControl != nil && focusedControl != .library)
            || (accessibleControl != nil && accessibleControl != .library)
    }

    var body: some View {
        ZStack {
            Self.canvasColor
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

            if model.isGalleryOpen {
                VStack {
                    Spacer()
                    accessibilityStatusReadout
                }
            }

            if #available(macOS 26.0, *), model.isGalleryOpen, model.viewerChromeVisible {
                VStack {
                    HStack {
                        libraryReturnCapsule
                            .padding(.top, 8)
                            .padding(.leading, 41)
                            .onHover { libraryHovered = $0 }
                            .onDisappear { libraryHovered = false }
                        Spacer()
                    }
                    Spacer()
                }
                .transition(.opacity)

                if model.galleryEntered, let rect = model.viewerChromeRect {
                    viewerControlsCluster
                        .onHover { clusterHovered = $0 }
                        .background {
                            ClusterProximityTracking(isEnabled: clusterTrackingEnabled) { nearby in
                                if clusterTrackingEnabled && clusterNearby != nearby { clusterNearby = nearby }
                            }
                            // Only the tracking view grows, never the controls' hit regions.
                            .padding(-32)
                            .allowsHitTesting(false)
                            .accessibilityHidden(true)
                        }
                        .onAppear { clusterTrackingEnabled = true }
                        .onDisappear {
                            clusterTrackingEnabled = false
                            clusterHovered = false
                            clusterNearby = false
                        }
                        .position(x: rect.midX, y: rect.midY)
                        .ignoresSafeArea()
                        .transition(.opacity)
                }
            }
        }
        .onAppear {
            model.openLibraryWindow = { openWindow(id: AppModel.libraryWindowID) }
        }
        .onChange(of: chromeActive) { model.setChromeActive(chromeActive) }
        .onChange(of: model.viewerChromeVisible) {
            if !model.viewerChromeVisible {
                focusedControl = nil
                accessibleControl = nil
            }
        }
        .onChange(of: model.chromeFocusRevision) {
            DispatchQueue.main.async {
                guard model.isGalleryOpen, model.viewerChromeVisible else { return }
                focusedControl = model.chromeFocusTarget
                accessibleControl = model.chromeFocusTarget
            }
        }
        .onDisappear { model.setChromeActive(false) }
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

    // Zero opacity removes these status nodes from the native AX tree.
    private var accessibilityStatusReadout: some View {
        HStack(spacing: 12) {
            Text(model.galleryTitle ?? model.status)
                .font(.caption2)
                .foregroundStyle(Color.white.opacity(0.01))
            Spacer()
            if model.position.total > 0 {
                Text(positionText)
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(Color.white.opacity(0.01))
            }
        }
        .frame(height: 1)
        .allowsHitTesting(false)
    }

    @available(macOS 26.0, *)
    private var libraryReturnCapsule: some View {
        chromeButton(.library, label: "Library") {
            Label("Library", systemImage: "chevron.left")
                .font(.system(size: 16, weight: .semibold))
                .padding(.horizontal, 14)
        }
    }

    @available(macOS 26.0, *)
    @ViewBuilder private var viewerControlsCluster: some View {
        if reduceTransparency {
            clusterButtons
        } else {
            GlassEffectContainer(spacing: 24) { clusterButtons }
        }
    }

    @available(macOS 26.0, *)
    private var clusterButtons: some View {
        HStack(spacing: clusterExpanded ? 28 : 2) {
            chromeButton(.position, label: "Go to a photograph") {
                Text(positionText)
                    .font(.system(size: 15, weight: .semibold))
                    .monospacedDigit()
                    .padding(.horizontal, 12)
            }
            .accessibilityValue(positionText)
            chromeButton(.settings, label: "Gallery Settings") {
                Image(systemName: "slider.horizontal.3")
                    .font(.system(size: 17))
                    .padding(.horizontal, 14)
            }
            chromeButton(.info, label: "Info") {
                Image(systemName: "info")
                    .font(.system(size: 15, weight: .semibold))
                    .padding(.horizontal, 14)
            }
        }
        .animation(reduceMotion ? nil : .easeOut(duration: 0.24), value: clusterExpanded)
    }

    @available(macOS 26.0, *)
    private func chromeButton<LabelView: View>(_ control: ViewerChromeControl, label: String, @ViewBuilder content: () -> LabelView) -> some View {
        let button = Button {
            focusedControl = nil
            accessibleControl = nil
            model.activateControl(control)
        } label: {
            content().frame(minWidth: 44, minHeight: 44)
        }
        .accessibilityLabel(label)
        .focused($focusedControl, equals: control)
        .accessibilityFocused($accessibleControl, equals: control)
        .onExitCommand {
            focusedControl = nil
            accessibleControl = nil
            model.focusViewerStage()
        }

        return Group {
            if reduceTransparency {
                button
                    .buttonStyle(.plain)
                    .foregroundStyle(Color(red: 0.95, green: 0.94, blue: 0.91))
                    .background(Capsule().fill(Color(white: 0.06, opacity: control == .library ? 0.94 : 1)))
            } else if control == .library {
                button
                    .buttonStyle(.glass)
                    .buttonBorderShape(.capsule)
            } else {
                button
                    .buttonStyle(.glass)
                    .buttonBorderShape(.capsule)
                    .glassEffectID(control, in: clusterNamespace)
            }
        }
    }

    private var positionText: String {
        model.position.total > 0 ? "\(model.position.index + 1) of \(model.position.total)" : "…"
    }
}

private struct ClusterProximityTracking: NSViewRepresentable {
    var isEnabled: Bool
    var onChange: (Bool) -> Void

    func makeNSView(context: Context) -> TrackingView {
        TrackingView()
    }

    func updateNSView(_ nsView: TrackingView, context: Context) {
        nsView.onChange = onChange
        nsView.isEnabled = isEnabled
        nsView.updateTrackingAreas()
    }

    static func dismantleNSView(_ nsView: TrackingView, coordinator: ()) {
        nsView.onChange = nil
        nsView.isEnabled = false
        nsView.updateTrackingAreas()
        NotificationCenter.default.removeObserver(nsView)
    }

    final class TrackingView: NSView {
        var isEnabled = false
        var onChange: ((Bool) -> Void)?
        private var area: NSTrackingArea?
        private var nearby = false
        private var publicationPending = false

        override func hitTest(_ point: NSPoint) -> NSView? { nil }

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            NotificationCenter.default.removeObserver(self)
            if let window {
                for name in [NSWindow.didBecomeKeyNotification, NSWindow.didResignKeyNotification,
                             NSWindow.didMoveNotification, NSWindow.didResizeNotification] {
                    NotificationCenter.default.addObserver(self, selector: #selector(windowChanged(_:)), name: name, object: window)
                }
            }
            updateTrackingAreas()
        }

        override func layout() {
            super.layout()
            updateTrackingAreas()
        }

        override func updateTrackingAreas() {
            super.updateTrackingAreas()
            if let area { removeTrackingArea(area) }
            area = nil
            guard isEnabled, window != nil, !isHiddenOrHasHiddenAncestor, !bounds.isEmpty else {
                publish(false)
                return
            }
            let inside = pointerIsNearby
            var options: NSTrackingArea.Options = [.mouseEnteredAndExited, .activeInKeyWindow]
            if inside { options.insert(.assumeInside) }
            let trackingArea = NSTrackingArea(rect: bounds, options: options, owner: self, userInfo: nil)
            addTrackingArea(trackingArea)
            area = trackingArea
            publish(inside)
        }

        override func mouseEntered(with event: NSEvent) { publish(pointerIsNearby) }
        override func mouseExited(with event: NSEvent) { publish(pointerIsNearby) }

        @objc private func windowChanged(_ notification: Notification) {
            updateTrackingAreas()
        }

        private var pointerIsNearby: Bool {
            guard isEnabled, let window, window.isKeyWindow, window.isVisible,
                  !isHiddenOrHasHiddenAncestor else { return false }
            return visibleRect.contains(convert(window.mouseLocationOutsideOfEventStream, from: nil))
        }

        private func publish(_ value: Bool) {
            guard nearby != value else { return }
            nearby = value
            guard !publicationPending else { return }
            publicationPending = true
            // Layout and attachment can run during SwiftUI updates; coalesce before publishing.
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                self.publicationPending = false
                self.onChange?(self.nearby)
            }
        }
    }
}
