import UIKit
import WebKit
import SwiftUI

/// iOS Liquid Glass chrome overlay — the iOS 26+ port of the macOS shell
/// pattern (macos/ManoramaMac/ContentView.swift). The page's pills stay
/// mounted and own every handler; the overlay draws the system's own glass
/// capsules above the WKWebView and asks the page to fire them. See
/// docs/liquid-glass-design-system.md — Tier N.
///
/// Contracts, ported verbatim:
/// - `data-ios-shell` is stamped for every iOS (G0); `data-ios-glass` and the
///   observer script go in only on iOS 26+, where the capsules exist.
/// - Actions are bounded control IDs — the overlay calls
///   `window.__manoramaShell?.activateControl('position'|'settings'|'info'|'library')`
///   and the page fires its own mounted pill. No selector crosses the bridge.
/// - A held finger, keyboard or VoiceOver focus is reported explicitly:
///   `setChromeActive(true|false)` keeps the page chrome mounted while a
///   native interaction is in flight — no synthetic pointer events.
/// - Escape or an exit command returns focus through `focusStage()`; the
///   page's own {type:'focus', control} posts land VoiceOver and the key
///   loop on the same capsule.
/// - Sheets are entirely web-owned — no native material ever covers web
///   text during a transition. The travelling SheetGlassSurface is retired.
/// - The cluster lives in one GlassEffectContainer: a single coherent
///   silhouette at rest, native press deformation on touch. On touch,
///   controls must not move away from the finger — the Mac's hover
///   separation is not ported.

/// Bounded actions the overlay may ask the page to fire — the same enum the
/// macOS shell and the shared ViewerChromeHandle both speak.
enum ViewerChromeControl: String, Hashable {
    case library, position, settings, info
}

enum GlassBridgeScript {
    /// Stamped only under #available(iOS 26) — the takeover gate.
    static let marker = "document.documentElement.dataset.iosGlass = '1';"

    /// Same observer the Mac injects: chrome visibility, curtain state, plus
    /// the position pill's label scraped so the cluster's "n of m" needs no
    /// bundle-side post.
    static let observer = """
    (function () {
      var lastVisible = null;
      var lastRaised = null;
      var lastPosition = null;
      function post(message) {
        try { window.webkit.messageHandlers.manorama.postMessage(message); } catch (e) {}
      }
      function report() {
        // is-visible alone is not enough — an open overlay inerts the
        // chrome's siblings, so a pill can be "visible" yet untouchable.
        // Native capsules must follow inert state or they float tappable
        // dead ends over the modal.
        var chrome = document.querySelector('.m-chrome.is-visible [data-chrome-library]');
        var on = chrome !== null
          && chrome.closest('[inert]') === null
          && document.querySelector('.viewer-filmstrip') === null;
        if (on !== lastVisible) {
          lastVisible = on;
          post({ type: 'chrome', visible: on });
        }
        var curtain = document.querySelector('[data-curtain]');
        var raised = !curtain || curtain.hidden === true;
        if (raised !== lastRaised) {
          lastRaised = raised;
          post({ type: 'entered', raised: raised });
        }
        var pos = document.querySelector('[data-chrome-position]');
        var label = pos ? pos.textContent : null;
        if (label !== lastPosition) {
          lastPosition = label;
          post({ type: 'position', label: label });
        }
      }
      window.__manoramaChromeObserver = new MutationObserver(report);
      // inert changes availability without touching class; characterData
      // fires on the position pill's "n of m" text alone.
      window.__manoramaChromeObserver.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'inert'], characterData: true });
      document.addEventListener('DOMContentLoaded', report);
      report();
    })();
    """
}

/// Shared state between the injected observer, the overlay's capsules and
/// the activity contract. All access on the main actor.
@MainActor
final class GlassChromeModel: ObservableObject {
    @Published var chromeVisible = false
    @Published var curtainRaised = false
    @Published var positionLabel = "…"
    /// Capsule frames in window coordinates, published by the overlay so the
    /// pass-through container can hand every other touch to the WKWebView.
    @Published var hitRects: [CGRect] = []
    /// The real safe-area insets, reported by the UIKit container — a
    /// GeometryReader under .ignoresSafeArea() reports zero, which was
    /// pinning the capsules into the status bar and home indicator.
    @Published var safeInsets: UIEdgeInsets = .zero
    /// Active reserved regions in window coordinates — the hinge and the
    /// vertical system bar on iPhone Duo. SceneDelegate feeds them from the
    /// same layout pass that posts __MANORAMA_IOS_LAYOUT__, so a capsule
    /// can never seat inside a region the system owns.
    @Published var reservedRegions: [CGRect] = []
    /// Set the moment the position capsule is tapped — the picker's own
    /// chrome:false report follows a bridge round-trip behind it, so
    /// without this the capsules linger ~300ms over the opening filmstrip.
    @Published var pickerSuppress = false
    /// The control the page last asked native focus to land on, and the
    /// revision that request arrived at — the same focus-revision pattern
    /// AppModel uses on macOS, so a repeated request still re-fires.
    @Published private(set) var focusTarget: ViewerChromeControl?
    @Published private(set) var focusRevision = 0
    /// Measured capsule frames (window coordinates) so reserved-region
    /// filtering tests the controls' real bands, including Dynamic Type —
    /// a camera cutout near the top must not shift bottom controls.
    @Published var libraryFrame: CGRect?
    @Published var clusterFrame: CGRect?

    weak var webView: WKWebView?
    /// The pending suppression release — cancelled whenever a new picker
    /// session starts so only the latest timer can clear pickerSuppress.
    private var pickerReleaseWork: DispatchWorkItem?

    /// The position capsule opens the picker — hide the capsules now rather
    /// than waiting on the observer's filmstrip report. If the picker never
    /// opens (activate missed its pill), the timeout hands the capsules back
    /// instead of leaving them stuck off. A release scheduled by an earlier
    /// session is cancelled first — otherwise its 1.5s deadline could fire
    /// mid-session and bring the capsules back over the open picker.
    func openPicker() {
        pickerReleaseWork?.cancel()
        pickerSuppress = true
        let release = DispatchWorkItem { [weak self] in
            self?.pickerSuppress = false
        }
        pickerReleaseWork = release
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5, execute: release)
        activateControl(.position)
    }

    /// The bounded action contract: the page fires its own mounted pill,
    /// which keeps owning the focus path, the modal wiring and the handlers.
    func activateControl(_ control: ViewerChromeControl) {
        webView?.evaluateJavaScript("window.__manoramaShell?.activateControl('\(control.rawValue)');", completionHandler: nil)
    }

    /// Held-finger, keyboard and VoiceOver activity on the native chrome is
    /// explicit state — the page's idle clock keeps the hidden pills mounted
    /// for exactly the interaction in flight instead of guessing at pointer
    /// traffic a native capsule never generates.
    func setChromeActive(_ active: Bool) {
        webView?.evaluateJavaScript("window.__manoramaShell?.setChromeActive(\(active));", completionHandler: nil)
    }

    /// Escape on a native capsule hands focus back to the viewer stage.
    func focusStage() {
        webView?.evaluateJavaScript("window.__manoramaShell?.focusStage();", completionHandler: nil)
    }

    /// A fresh document has no observer and no __manoramaShell yet — drop
    /// every piece of reported state so a navigation never inherits the last
    /// document's chrome, picker suppression or focus target.
    func resetForNewDocument() {
        chromeVisible = false
        curtainRaised = false
        pickerSuppress = false
        pickerReleaseWork?.cancel()
        pickerReleaseWork = nil
        focusTarget = nil
        positionLabel = "…"
        hitRects = []
        libraryFrame = nil
        clusterFrame = nil
    }

    func handle(_ body: [String: Any]) {
        switch body["type"] as? String {
        case "chrome":
            chromeVisible = body["visible"] as? Bool ?? false
            if chromeVisible { pickerSuppress = false }
        case "entered":
            curtainRaised = body["raised"] as? Bool ?? false
        case "position":
            if let label = body["label"] as? String, !label.isEmpty {
                positionLabel = label
            }
        case "focus":
            if let name = body["control"] as? String,
               let control = ViewerChromeControl(rawValue: name) {
                focusTarget = control
                focusRevision += 1
            }
        default:
            break
        }
    }
}

/// WKScriptMessageHandler for the injected observer. main-frame only, and
/// only for documents the bridge itself loaded — a remote frame can never
/// reach this handler's model.
final class GlassScriptHandler: NSObject, WKScriptMessageHandler {
    let model: GlassChromeModel

    init(model: GlassChromeModel) {
        self.model = model
    }

    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage) {
        guard message.name == "manorama",
              message.frameInfo.isMainFrame,
              let body = message.body as? [String: Any] else { return }
        Task { @MainActor in model.handle(body) }
    }
}

/// The overlay is mounted in a plain UIView container covering the webView.
/// Its hit test answers true only where a capsule actually is — every other
/// touch falls through to the WKWebView, the sibling-not-overlay lesson from
/// the Mac port (an always-on top view would eat the photograph's gestures).
final class GlassPassthroughView: UIView {
    var hitRectsProvider: (() -> [CGRect]) = { [] }
    var onSafeAreaInsets: ((UIEdgeInsets) -> Void)?

    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        // Capsule frames are published in window coordinates.
        let windowPoint = convert(point, to: nil)
        return hitRectsProvider().contains { $0.insetBy(dx: -8, dy: -8).contains(windowPoint) }
    }

    override func safeAreaInsetsDidChange() {
        super.safeAreaInsetsDidChange()
        onSafeAreaInsets?(safeAreaInsets)
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        onSafeAreaInsets?(safeAreaInsets)
    }
}

/// Publishes each capsule's window-space frame for the pass-through test.
private struct GlassHitRectsKey: PreferenceKey {
    static var defaultValue: [CGRect] = []
    static func reduce(value: inout [CGRect], nextValue: () -> [CGRect]) { value += nextValue() }
}

/// The measured window-space frame of one control surface — reserved-region
/// filtering tests intersection against the control's real band, so only a
/// region that actually crosses the control's vertical span may move it.
private struct GlassLibraryFrameKey: PreferenceKey {
    static var defaultValue: CGRect? { nil }
    static func reduce(value: inout CGRect?, nextValue: () -> CGRect?) { value = nextValue() ?? value }
}
private struct GlassClusterFrameKey: PreferenceKey {
    static var defaultValue: CGRect? { nil }
    static func reduce(value: inout CGRect?, nextValue: () -> CGRect?) { value = nextValue() ?? value }
}

@available(iOS 26.0, *)
struct GlassChromeOverlay: View {
    @ObservedObject var model: GlassChromeModel
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    /// Tracks a finger resting on a capsule. @GestureState resets itself on
    /// release AND on cancellation — a plain onChanged/onEnded pair leaves
    /// the activity state set when the system interrupts the touch.
    @GestureState private var fingerDown = false
    @FocusState private var focusedControl: ViewerChromeControl?
    @AccessibilityFocusState private var accessibleControl: ViewerChromeControl?
    @Namespace private var clusterNamespace

    /// Native interaction in flight — a held finger, keyboard focus or
    /// VoiceOver focus — keeps the page's hidden chrome alive through
    /// __manoramaShell.setChromeActive. On touch there is no hover phase:
    /// the finger IS the interaction, so this is the whole set.
    private var nativeActive: Bool {
        fingerDown || focusedControl != nil || accessibleControl != nil
    }

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .topLeading) {
                if model.chromeVisible && !model.pickerSuppress {
                    libraryCapsule
                        .padding(.leading, leadingSeat)
                        .padding(.top, model.safeInsets.top + 8)
                }
                if model.chromeVisible && model.curtainRaised && !model.pickerSuppress {
                    controlsCluster
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
                        .padding(.bottom, model.safeInsets.bottom + 16)
                        .offset(x: clusterOffset(in: geo.size.width))
                }
            }
        }
        // The posted rects are viewport-relative — viewport 0 is the
        // webview's top, which sits under the status bar. Ignoring the safe
        // area on the reader keeps posted CSS rects and position space
        // identical; the capsules compensate with the explicit inset above.
        .ignoresSafeArea()
        .onPreferenceChange(GlassHitRectsKey.self) { model.hitRects = $0 }
        .onPreferenceChange(GlassLibraryFrameKey.self) { model.libraryFrame = $0 }
        .onPreferenceChange(GlassClusterFrameKey.self) { model.clusterFrame = $0 }
        .onChange(of: nativeActive) { model.setChromeActive(nativeActive) }
        .onDisappear { model.setChromeActive(false) }
        .onChange(of: model.chromeVisible) {
            if !model.chromeVisible {
                focusedControl = nil
                accessibleControl = nil
            }
        }
        .onChange(of: model.focusRevision) {
            // The page asked native focus to land on a control — VoiceOver
            // and the key loop must arrive on the same capsule.
            DispatchQueue.main.async {
                guard model.chromeVisible else { return }
                focusedControl = model.focusTarget
                accessibleControl = model.focusTarget
            }
        }
    }

    /// Leading padding that clears a reserved region hugging the left edge —
    /// the Duo's vertical system bar when it lands leading. Safe-area insets
    /// do not describe that bar, so the seat is measured from regions. The
    /// region must cross the capsule's own measured vertical band: a
    /// horizontal division spans the full width but never meets the top
    /// seat, and must not push the capsule sideways.
    private var leadingSeat: CGFloat {
        let bandTop = model.libraryFrame?.minY ?? model.safeInsets.top + 8
        let bandBottom = model.libraryFrame?.maxY ?? bandTop + 44
        let barEdge = model.reservedRegions
            .filter { $0.minX <= 1 && $0.minY < bandBottom && $0.maxY > bandTop }
            .map(\.maxX)
            .max() ?? 0
        return barEdge > 0 ? barEdge + 16 : 16
    }

    /// Centre of the widest run of screen not covered by a reserved region,
    /// as an offset from the container's own centre. On an unfolded Duo the
    /// hinge's division region splits the width in two; the cluster takes
    /// the wider half — the segment without the system bar. Only regions
    /// that cross the cluster's own measured band count: a camera cutout
    /// near the top must not shift bottom controls. Zero keeps the default
    /// centring when nothing relevant is reserved.
    private func clusterOffset(in width: CGFloat) -> CGFloat {
        let band = model.clusterFrame
        let regions = model.reservedRegions.filter { region in
            guard let band else { return true }
            return region.minY < band.maxY && region.maxY > band.minY
        }
        guard !regions.isEmpty, width > 0 else { return 0 }
        var cuts: [CGFloat] = [0, width]
        for region in regions {
            cuts.append(min(max(region.minX, 0), width))
            cuts.append(min(max(region.maxX, 0), width))
        }
        cuts.sort()
        var best: (start: CGFloat, width: CGFloat) = (0, 0)
        for i in 0..<(cuts.count - 1) {
            let gap = cuts[i + 1] - cuts[i]
            let mid = cuts[i] + gap / 2
            let covered = regions.contains { mid >= $0.minX && mid <= $0.maxX }
            if gap > best.width, !covered { best = (cuts[i], gap) }
        }
        return best.width > 0 ? best.start + best.width / 2 - width / 2 : 0
    }

    /// Feeds the capsule's touch into the shared @GestureState — true while
    /// the finger is down, automatically false again on end or cancellation.
    private var touchProbe: some Gesture {
        DragGesture(minimumDistance: 0)
            .updating($fingerDown) { _, state, _ in state = true }
    }

    /// One capsule: the button style owns the material (regular glass in the
    /// normal path, a solid sibling under Reduce Transparency at identical
    /// geometry), the system derives foreground from the backdrop, and the
    /// action is a bounded control ID. Focus and VoiceOver focus land on
    /// the same capsule the page named; an exit command returns the stage.
    private func chromeButton(_ control: ViewerChromeControl, label: String, @ViewBuilder content: () -> some View) -> some View {
        let button = Button {
            focusedControl = nil
            accessibleControl = nil
            if control == .position { model.openPicker() } else { model.activateControl(control) }
        } label: {
            content().frame(minWidth: 44, minHeight: 44)
        }
        .accessibilityLabel(label)
        .focused($focusedControl, equals: control)
        .accessibilityFocused($accessibleControl, equals: control)
        // Hardware Escape (keyboards) and the VoiceOver escape gesture both
        // hand focus back to the stage — the page owns where "back" lands.
        .onKeyPress(.escape) {
            focusedControl = nil
            accessibleControl = nil
            model.focusStage()
            return .handled
        }
        .accessibilityAction(.escape) {
            focusedControl = nil
            accessibleControl = nil
            model.focusStage()
        }
        .simultaneousGesture(touchProbe)

        let styled = Group {
            if reduceTransparency {
                // Solid sibling at identical geometry — the same label
                // padding, no extra insets, so the fallback never moves the
                // controls it replaces.
                button
                    .buttonStyle(.plain)
                    .foregroundStyle(Color(red: 0.95, green: 0.94, blue: 0.91))
                    .background(Capsule().fill(Color(white: 0.06, opacity: 0.94)))
            } else {
                button
                    .buttonStyle(.glass)
                    .buttonBorderShape(.capsule)
            }
        }
        // Stable material identity inside the container — the union morphs
        // the group, never the individual targets, away from a touch.
        return styled.glassEffectID(control, in: clusterNamespace)
    }

    private var libraryCapsule: some View {
        chromeButton(.library, label: "Library") {
            Label("Library", systemImage: "chevron.left")
                .font(.subheadline.weight(.semibold))
                .padding(.horizontal, 12)
        }
        .background(libraryFrameProbe)
        .background(rectProbe)
    }

    /// One coherent control group: the GlassEffectContainer unions the
    /// capsules into a single silhouette at rest (HStack spacing sits under
    /// the container's union threshold), while .buttonStyle(.glass) keeps
    /// each press deforming natively. Targets stay distinct — every label
    /// carries its own 44×44 frame and its own bounded control ID.
    private var controlsCluster: some View {
        Group {
            if reduceTransparency {
                clusterButtons
            } else {
                GlassEffectContainer(spacing: 16) { clusterButtons }
            }
        }
        .background(clusterFrameProbe)
        .background(rectProbe)
    }

    private var clusterButtons: some View {
        HStack(spacing: 8) {
            chromeButton(.position, label: "Go to a photograph") {
                Text(model.positionLabel)
                    .font(.subheadline.weight(.semibold))
                    .monospacedDigit()
                    .padding(.horizontal, 12)
            }
            .accessibilityValue(model.positionLabel)
            chromeButton(.settings, label: "Gallery Settings") {
                Image(systemName: "slider.horizontal.3")
                    .font(.body.weight(.semibold))
                    .padding(.horizontal, 14)
            }
            chromeButton(.info, label: "Info") {
                Image(systemName: "info")
                    .font(.body.weight(.semibold))
                    .padding(.horizontal, 14)
            }
        }
    }

    /// Publishes a view's own frame (window space) to the pass-through.
    private var rectProbe: some View {
        GeometryReader { geometry in
            Color.clear.preference(key: GlassHitRectsKey.self, value: [geometry.frame(in: .global)])
        }
        .allowsHitTesting(false)
    }

    /// Measured control frames for reserved-region filtering — window space,
    /// same coordinate system the regions arrive in.
    private var libraryFrameProbe: some View {
        GeometryReader { geometry in
            Color.clear.preference(key: GlassLibraryFrameKey.self, value: geometry.frame(in: .global))
        }
        .allowsHitTesting(false)
    }
    private var clusterFrameProbe: some View {
        GeometryReader { geometry in
            Color.clear.preference(key: GlassClusterFrameKey.self, value: geometry.frame(in: .global))
        }
        .allowsHitTesting(false)
    }
}

/// Installs the glass overlay over the bridge's webView. Nothing is
/// installed on older systems — they keep the web pills, repainted under
/// the frost gate.
@MainActor
enum GlassChromeInstaller {
    @available(iOS 26.0, *)
    static func install(over webView: WKWebView, in owner: UIViewController, model: GlassChromeModel) {
        let host = UIHostingController(rootView: GlassChromeOverlay(model: model))
        host.view.backgroundColor = .clear
        // UIKit containment keeps the hosting controller alive for the
        // overlay's lifetime — capsule taps, onAppear and Dynamic Type
        // updates all depend on it.
        owner.addChild(host)

        let passthrough = GlassPassthroughView(frame: webView.bounds)
        passthrough.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        passthrough.backgroundColor = .clear
        passthrough.hitRectsProvider = { [weak model] in model?.hitRects ?? [] }
        passthrough.onSafeAreaInsets = { [weak model] in model?.safeInsets = $0 }
        passthrough.isUserInteractionEnabled = true

        owner.view.addSubview(passthrough)
        passthrough.addSubview(host.view)
        host.view.frame = passthrough.bounds
        host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        host.didMove(toParent: owner)
    }
}
