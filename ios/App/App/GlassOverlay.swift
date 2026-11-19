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

/// Where UIKit parked the system bar on a Duo — fed to the overlay model on
/// the same layout pass as the reserved regions.
enum GlassBarEdge {
    case unspecified, leading, trailing
}

enum GlassBridgeScript {
    /// Stamped only under #available(iOS 26) — the takeover gate.
    static let marker = "document.documentElement.dataset.iosGlass = '1';"

    /// Same observer the Mac injects: chrome visibility, curtain state, plus
    /// the position pill's label scraped so the cluster's "n of m" needs no
    /// bundle-side post.
    ///
    /// Every post carries this document's generation. A committed
    /// replacement document mints its own — the shell treats the first post
    /// of a new generation as the document boundary — and a generation the
    /// shell has already retired is dropped. `__manoramaChromeReplay`
    /// re-registers a surviving document under a fresh generation and reposts
    /// everything: the explicit answer when a cancelled navigation leaves
    /// this page alive after the shell reset. `__manoramaChromeGen` is the
    /// handle bundle code (`iosPost`) reads to tag its own posts.
    static let observer = """
    (function () {
      var gen = 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
      window.__manoramaChromeGen = gen;
      var lastVisible = null;
      var lastRaised = null;
      var lastPosition = null;
      function post(message) {
        message.gen = gen;
        try { window.webkit.messageHandlers.manorama.postMessage(message); } catch (e) {}
      }
      function report() {
        // is-visible alone is not enough — an open overlay inerts the
        // chrome's siblings, so a pill can be "visible" yet untouchable.
        // Native capsules must follow inert state or they float tappable
        // dead ends over the modal. The iOS picker mounts .native-global-view
        // (Global View and Post-to-X, marked [data-global-view]), never
        // .viewer-filmstrip — either surface suppresses the capsules for as
        // long as it is mounted.
        var chrome = document.querySelector('.m-chrome.is-visible [data-chrome-library]');
        var on = chrome !== null
          && chrome.closest('[inert]') === null
          && document.querySelector('.viewer-filmstrip, .native-global-view, [data-global-view]') === null;
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
      window.__manoramaChromeReplay = function () {
        gen = 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
        window.__manoramaChromeGen = gen;
        lastVisible = null;
        lastRaised = null;
        lastPosition = null;
        report();
      };
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
    /// Where UIKit put the system bar on iOS 27.1+ — the overlay's controls
    /// become a vertical column on that edge, the same adaptation the web
    /// chrome makes with .m-chrome--side.
    @Published var verticalBarEdge: GlassBarEdge = .unspecified
    /// The document generation currently feeding the model. Posts tagged
    /// with a different generation either arrive from a committed
    /// replacement document (adopted — a generation boundary resets state)
    /// or from a stale survivor (retired — dropped).
    private(set) var acceptedGeneration: String?
    /// Generations retired when a navigation started. Bounded — generation
    /// strings are minted per document and per replay, never reused.
    private var retiredGenerations: [String] = []
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

    /// Clears every piece of reported state. Called on the generation
    /// boundary — the first post of a new document — and on reset.
    private func clearDocumentState() {
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

    /// A navigation began: the current document may be replaced. Its
    /// generation is retired so posts already in flight cannot be mistaken
    /// for the next document's, and the reported state is dropped — a
    /// committed replacement must never inherit chrome, picker suppression
    /// or focus target. If the navigation is cancelled instead, the
    /// surviving document is asked to replay (see replaySurvivingDocument).
    func resetForNewDocument() {
        if let gen = acceptedGeneration {
            retiredGenerations.append(gen)
            if retiredGenerations.count > 16 { retiredGenerations.removeFirst() }
            acceptedGeneration = nil
        }
        clearDocumentState()
    }

    /// A navigation ended without a new document generation reporting —
    /// the load was cancelled or failed, so the old document (and its
    /// observer) is still on screen but the model was reset. Ask it to
    /// re-register under a fresh generation and repost its state. A
    /// committed document has already posted its own generation, so the
    /// request is a no-op there.
    func replaySurvivingDocument() {
        guard acceptedGeneration == nil else { return }
        webView?.evaluateJavaScript("window.__manoramaChromeReplay?.();", completionHandler: nil)
    }

    func handle(_ body: [String: Any]) {
        // Generation boundary first: a post from a retired generation is
        // stale; the first post of a new generation is the document's own
        // claim — reset, adopt, then apply it.
        if let gen = body["gen"] as? String {
            if retiredGenerations.contains(gen) { return }
            if gen != acceptedGeneration {
                clearDocumentState()
                acceptedGeneration = gen
            }
        }
        switch body["type"] as? String {
        case "chrome":
            chromeVisible = body["visible"] as? Bool ?? false
            if chromeVisible {
                pickerSuppress = false
                pickerReleaseWork?.cancel()
                pickerReleaseWork = nil
            }
        case "entered":
            curtainRaised = body["raised"] as? Bool ?? false
        case "position":
            if let label = body["label"] as? String, !label.isEmpty {
                positionLabel = String(label.prefix(64))
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
/// only when the posting frame's origin is the committed document's own
/// (capacitor://localhost) — a remote or subframe document can never reach
/// this handler's model. Generation handling lives in the model.
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
        // The posting frame must be the committed document itself — the
        // app's own page. Capacitor's delegation handler already refuses
        // remote main-frame commits (no allowNavigation hosts are
        // configured), so the committed URL is the app's own origin; a post
        // whose frame origin is anything else did not come from it.
        if let url = message.webView?.url {
            let origin = message.frameInfo.securityOrigin
            guard origin.protocol.lowercased() == url.scheme?.lowercased(),
                  origin.host.lowercased() == (url.host ?? "").lowercased() else { return }
        }
        Task { @MainActor in model.handle(body) }
    }
}

/// Forgiveness added around each capsule's own actionable rect — a graze on
/// a capsule's edge still lands. Strictly under half the 8pt inter-control
/// spacing: an expanded pair that met in the middle would swallow a swipe
/// starting in the gap (the UIKit point test decides capture before any
/// SwiftUI element can decline it), so the middle of a gap stays a real
/// passthrough lane.
private let capsuleHitExpansion: CGFloat = 2

/// The overlay is mounted in a plain UIView container covering the webView.
/// Its hit test answers true only where a capsule actually is — every other
/// touch falls through to the WKWebView, the sibling-not-overlay lesson from
/// the Mac port (an always-on top view would eat the photograph's gestures).
final class GlassPassthroughView: UIView {
    var hitRectsProvider: (() -> [CGRect]) = { [] }
    var onSafeAreaInsets: ((UIEdgeInsets) -> Void)?

    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        // Each capsule publishes its own frame in window coordinates —
        // never the cluster's bounding box, which would make the gaps
        // between controls (and the photograph around them) dead space.
        let windowPoint = convert(point, to: nil)
        return hitRectsProvider().contains {
            $0.insetBy(dx: -capsuleHitExpansion, dy: -capsuleHitExpansion).contains(windowPoint)
        }
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
    /// A focus request that arrived while chrome was hidden — applied once
    /// when the chrome returns, then consumed.
    @State private var pendingFocus = false

    /// Native interaction in flight — a held finger, keyboard focus or
    /// VoiceOver focus — keeps the page's hidden chrome alive through
    /// __manoramaShell.setChromeActive. On touch there is no hover phase:
    /// the finger IS the interaction, so this is the whole set.
    private var nativeActive: Bool {
        fingerDown || focusedControl != nil || accessibleControl != nil
    }

    /// The Duo system-bar adaptation: the controls become one column on the
    /// edge UIKit chose, the same shape the web chrome takes as .m-chrome--side.
    private var verticalMode: Bool {
        model.verticalBarEdge == .leading || model.verticalBarEdge == .trailing
    }

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .topLeading) {
                if verticalMode {
                    if model.chromeVisible && !model.pickerSuppress {
                        controlsColumn
                            .frame(maxWidth: .infinity, maxHeight: .infinity,
                                   alignment: model.verticalBarEdge == .leading ? .leading : .trailing)
                            .padding(.leading, model.verticalBarEdge == .leading ? columnSeat(in: geo.size) : 0)
                            .padding(.trailing, model.verticalBarEdge == .trailing ? columnSeat(in: geo.size) : 0)
                            .offset(y: columnOffsetY(in: geo.size))
                    }
                } else {
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
            } else if pendingFocus {
                // A focus request queued while chrome was hidden lands now —
                // consumed so a later hide/show does not replay it.
                focusedControl = model.focusTarget
                accessibleControl = model.focusTarget
                pendingFocus = false
            }
        }
        .onChange(of: model.focusRevision) {
            // The page asked native focus to land on a control — VoiceOver
            // and the key loop must arrive on the same capsule. While chrome
            // is hidden the request stays pending for the visibility change
            // above; applied at once when chrome is already up.
            DispatchQueue.main.async {
                if model.chromeVisible {
                    focusedControl = model.focusTarget
                    accessibleControl = model.focusTarget
                } else {
                    pendingFocus = true
                }
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

    /// Centre of the widest unreserved interval along one axis, or nil when
    /// no run can hold `needed` padded points. A too-narrow run would spill
    /// the cluster into the regions on both flanks, so nil hands the caller
    /// back to its unreserved default instead of pretending a run fits.
    private func widestRun(extent: CGFloat, spans: [(start: CGFloat, end: CGFloat)], needed: CGFloat) -> CGFloat? {
        guard extent > 0, !spans.isEmpty else { return nil }
        var cuts: [CGFloat] = [0, extent]
        for span in spans {
            cuts.append(min(max(span.start, 0), extent))
            cuts.append(min(max(span.end, 0), extent))
        }
        cuts.sort()
        var bestFit: (start: CGFloat, width: CGFloat) = (0, 0)
        for i in 0..<(cuts.count - 1) {
            let gap = cuts[i + 1] - cuts[i]
            let mid = cuts[i] + gap / 2
            if spans.contains(where: { mid >= $0.start && mid <= $0.end }) { continue }
            if gap >= needed, gap > bestFit.width { bestFit = (cuts[i], gap) }
        }
        return bestFit.width > 0 ? bestFit.start + bestFit.width / 2 : nil
    }

    /// Centre of the widest run of screen not covered by a reserved region,
    /// as an offset from the container's own centre. On an unfolded Duo the
    /// hinge's division region splits the width in two; the cluster takes
    /// the wider half — the segment without the system bar. Only regions
    /// that cross the cluster's own measured band count: a camera cutout
    /// near the top must not shift bottom controls. The cluster must fit
    /// with its hit padding on both sides — a narrow segment or large
    /// Dynamic Type cannot push it into a reserved edge. Zero keeps the
    /// default centring when nothing relevant is reserved.
    private func clusterOffset(in width: CGFloat) -> CGFloat {
        let band = model.clusterFrame
        let spans = model.reservedRegions
            .filter { band == nil || ($0.minY < band!.maxY && $0.maxY > band!.minY) }
            .map { (start: $0.minX, end: $0.maxX) }
        guard let centre = widestRun(extent: width, spans: spans,
                                   needed: (band?.width ?? 0) + capsuleHitExpansion * 2) else { return 0 }
        return centre - width / 2
    }

    /// The column's band before this layout's seat and y-offset move it.
    /// The probe reports the *placed* frame, and filtering regions by that
    /// frame would feed placement back into its own inputs — a stationary
    /// Duo window with a leading system region could then never settle.
    /// Only the measured size is reused; the unplaced origin is the
    /// frame's own contract: edge-aligned and centred in a full-size box.
    private func unplacedColumnBand(in size: CGSize) -> CGRect? {
        guard let placed = model.clusterFrame else { return nil }
        let x: CGFloat = model.verticalBarEdge == .leading ? 0 : size.width - placed.width
        return CGRect(x: x, y: (size.height - placed.height) / 2, width: placed.width, height: placed.height)
    }

    /// Padding between the column and the screen's leading/trailing edge,
    /// clearing a region hugging that edge — the Duo's vertical system bar.
    /// The region must cross the column's own measured vertical band: a
    /// horizontal division spans the full width but never meets the column,
    /// and must not push it sideways. Mirrors leadingSeat on the
    /// horizontal layout, for whichever edge the trait names.
    private func columnSeat(in size: CGSize) -> CGFloat {
        let band = unplacedColumnBand(in: size)
        if model.verticalBarEdge == .leading {
            let edge = model.reservedRegions
                .filter { $0.minX <= 1 && (band == nil || ($0.minY < band!.maxY && $0.maxY > band!.minY)) }
                .map(\.maxX)
                .max() ?? 0
            return edge > 0 ? edge + 16 : 16
        }
        guard size.width > 0 else { return 16 }
        let edge = model.reservedRegions
            .filter { $0.maxX >= size.width - 1 && (band == nil || ($0.minY < band!.maxY && $0.maxY > band!.minY)) }
            .map(\.minX)
            .min()
        guard let edge else { return 16 }
        return size.width - edge + 16
    }

    /// Vertical centring of the column inside the widest run of screen not
    /// covered by a reserved region, as an offset from centre — the
    /// transpose of clusterOffset onto the y-axis, filtered to regions that
    /// cross the column's own measured horizontal band. The column's padded
    /// height must fit the run it takes.
    private func columnOffsetY(in size: CGSize) -> CGFloat {
        let band = unplacedColumnBand(in: size)
        let spans = model.reservedRegions
            .filter { band == nil || ($0.minX < band!.maxX && $0.maxX > band!.minX) }
            .map { (start: $0.minY, end: $0.maxY) }
        guard let centre = widestRun(extent: size.height, spans: spans,
                                   needed: (band?.height ?? 0) + capsuleHitExpansion * 2) else { return 0 }
        return centre - size.height / 2
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
        return styled
            .glassEffectID(control, in: clusterNamespace)
            // Each actionable capsule publishes its own rect — the
            // passthrough hit test never sees the cluster's bounding box.
            .background(rectProbe)
    }

    private var libraryCapsule: some View {
        chromeButton(.library, label: "Library") {
            Label("Library", systemImage: "chevron.left")
                .font(.subheadline.weight(.semibold))
                .padding(.horizontal, 12)
        }
        .background(libraryFrameProbe)
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
    }

    /// The Duo vertical-bar adaptation: one column docked to the edge the
    /// system chose, Back at the navigation end — the same shape the web
    /// chrome takes as .m-chrome--side. The trailing controls still wait
    /// for the curtain to lift, as the bottom cluster does.
    private var controlsColumn: some View {
        Group {
            if reduceTransparency {
                columnButtons
            } else {
                GlassEffectContainer(spacing: 16) { columnButtons }
            }
        }
        .background(clusterFrameProbe)
    }

    private var columnButtons: some View {
        VStack(spacing: 8) {
            chromeButton(.library, label: "Library") {
                Image(systemName: "chevron.left")
                    .font(.body.weight(.semibold))
            }
            if model.curtainRaised {
                chromeButton(.position, label: "Go to a photograph") {
                    let parts = verticalPositionLabel
                    VStack(spacing: 0) {
                        Text(parts.lead)
                            .font(.subheadline.weight(.semibold))
                            .monospacedDigit()
                        if let rest = parts.rest {
                            Text(rest)
                                .font(.caption2)
                                .monospacedDigit()
                        }
                    }
                    .padding(.horizontal, 6)
                }
                .accessibilityValue(model.positionLabel)
                chromeButton(.settings, label: "Gallery Settings") {
                    Image(systemName: "slider.horizontal.3")
                        .font(.body.weight(.semibold))
                }
                chromeButton(.info, label: "Info") {
                    Image(systemName: "info")
                        .font(.body.weight(.semibold))
                }
            }
        }
    }

    /// The position capsule reads "12 of 30" horizontally; the column lays
    /// it out the way the web's side pill does — "12" over "of 30".
    private var verticalPositionLabel: (lead: String, rest: String?) {
        guard let range = model.positionLabel.range(of: " of ") else {
            return (model.positionLabel, nil)
        }
        return (String(model.positionLabel[..<range.lowerBound]),
                String(model.positionLabel[range.lowerBound...]).trimmingCharacters(in: .whitespaces))
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
