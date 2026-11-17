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
/// - The keep-alive ping is a NON-TOUCH PointerEvent on `.viewer-stage` —
///   the web idle clock drops pointerType === 'touch'.
/// - Hide rules in app/styles.css key on data-ios-glass only.
/// - No GlassEffectContainer: it unions siblings nearer than `spacing`; the
///   iOS cluster is always-separate capsules 8pt apart.
/// - Sheet morph is a travelling surface (SheetGlassSurface), never
///   glassEffectID — native glass cannot sit behind the web panel's text.

enum GlassBridgeScript {
    /// Stamped only under #available(iOS 26) — the takeover gate.
    static let marker = "document.documentElement.dataset.iosGlass = '1';"

    /// Same observer the Mac injects: chrome visibility, curtain state, the
    /// .m-sheet box, plus the position pill's label scraped so the cluster's
    /// "n of m" needs no bundle-side post.
    static let observer = """
    (function () {
      var lastVisible = null;
      var lastRaised = null;
      var lastSheetKey = null;
      var lastPosition = null;
      function post(message) {
        try { window.webkit.messageHandlers.manorama.postMessage(message); } catch (e) {}
      }
      function report() {
        var on = document.querySelector('.m-chrome.is-visible [data-chrome-library]') !== null
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
        var sheet = document.querySelector('.m-sheet');
        var key = 'closed', rect = null;
        if (sheet) {
          var r = sheet.getBoundingClientRect();
          rect = { x: r.left, y: r.top, w: r.width, h: r.height };
          key = 'open:' + r.left + ',' + r.top + ',' + r.width + ',' + r.height;
        }
        if (key !== lastSheetKey) {
          lastSheetKey = key;
          document.documentElement.dataset.iosGlassSheet = sheet ? '1' : '';
          post({ type: 'sheet', open: sheet !== null, rect: rect });
        }
        var pos = document.querySelector('[data-chrome-position]');
        var label = pos ? pos.textContent : null;
        if (label !== lastPosition) {
          lastPosition = label;
          post({ type: 'position', label: label });
        }
      }
      window.__manoramaChromeObserver = new MutationObserver(report);
      window.__manoramaChromeObserver.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
      document.addEventListener('transitionend', function (e) {
        if (e.target && e.target.classList && e.target.classList.contains('m-sheet')) report();
      });
      document.addEventListener('DOMContentLoaded', report);
      report();
    })();
    """
}

/// Shared state between the injected observer, the overlay's capsules and
/// the keep-alive timer. All access on the main actor.
@MainActor
final class GlassChromeModel: ObservableObject {
    @Published var chromeVisible = false
    @Published var curtainRaised = false
    @Published var sheetRect: CGRect?
    @Published var positionLabel = "…"
    /// Capsule frames in window coordinates, published by the overlay so the
    /// pass-through container can hand every other touch to the WKWebView.
    @Published var hitRects: [CGRect] = []

    weak var webView: WKWebView?
    private var keepAliveTimer: Timer?
    private var touchActive = false

    /// Fire the page's own pill — mounted but hidden under data-ios-glass,
    /// still owning the focus path, the modal wiring and the handlers.
    /// JSONEncoder because JSONSerialization rejects a top-level string.
    func invoke(_ selector: String) {
        guard let data = try? JSONEncoder().encode(selector),
              let json = String(data: data, encoding: .utf8) else { return }
        webView?.evaluateJavaScript("var el = document.querySelector(\(json)); if (el) el.click();", completionHandler: nil)
    }

    /// A finger resting on a native capsule generates no page pointer
    /// events — the viewer's chrome idles out 3s after the last one and the
    /// pills would unmount beneath it. While any capsule is touched, dispatch
    /// a synthetic non-touch pointermove on the stage; the y alternates
    /// because the page's fine-move handler only wakes on travel > 4px.
    /// Level-based, not counted: a DragGesture re-fires onChanged for every
    /// move, so counting edges would inflate the touch depth. The second
    /// finger landing on another capsule while the first lifts is accepted
    /// as ending the ping early — single-touch chrome is the normal case.
    func setFingerDown(_ down: Bool) {
        guard down != touchActive else { return }
        touchActive = down
        if down {
            ping()
            keepAliveTimer = Timer.scheduledTimer(withTimeInterval: 1.1, repeats: true) { [weak self] _ in
                Task { @MainActor in self?.ping() }
            }
        } else {
            keepAliveTimer?.invalidate()
            keepAliveTimer = nil
        }
    }

    private func ping() {
        webView?.evaluateJavaScript(
            "var s = document.querySelector('.viewer-stage'); if (s) { window.__manoramaKeepAlive = !window.__manoramaKeepAlive; var y = s.clientHeight - 40 + (window.__manoramaKeepAlive ? 8 : -8); s.dispatchEvent(new PointerEvent('pointermove', {bubbles: true, clientX: s.clientWidth / 2, clientY: y})); }",
            completionHandler: nil
        )
    }

    func handle(_ body: [String: Any]) {
        switch body["type"] as? String {
        case "chrome":
            chromeVisible = body["visible"] as? Bool ?? false
        case "entered":
            curtainRaised = body["raised"] as? Bool ?? false
        case "sheet":
            if let r = body["rect"] as? [String: Any],
               let x = r["x"] as? Double, let y = r["y"] as? Double,
               let w = r["w"] as? Double, let h = r["h"] as? Double {
                sheetRect = CGRect(x: x, y: y, width: w, height: h)
            } else {
                sheetRect = nil
            }
        case "position":
            if let label = body["label"] as? String, !label.isEmpty {
                positionLabel = label
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

    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        // Capsule frames are published in window coordinates.
        let windowPoint = convert(point, to: nil)
        return hitRectsProvider().contains { $0.insetBy(dx: -8, dy: -8).contains(windowPoint) }
    }
}

/// Publishes each capsule's window-space frame for the pass-through test.
private struct GlassHitRectsKey: PreferenceKey {
    static var defaultValue: [CGRect] = []
    static func reduce(value: inout [CGRect], nextValue: () -> [CGRect]) { value += nextValue() }
}

@available(iOS 26.0, *)
struct GlassChromeOverlay: View {
    @ObservedObject var model: GlassChromeModel
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// The Settings seat in window coordinates — where a sheet's glass
    /// morph launches from.
    @State private var settingsSeat: CGRect = .zero

    var body: some View {
        GeometryReader { geometry in
            ZStack(alignment: .topLeading) {
                if model.chromeVisible {
                    libraryCapsule
                        .padding(.leading, 16)
                        .padding(.top, geometry.safeAreaInsets.top + 8)
                }
                if model.chromeVisible && model.curtainRaised {
                    controlsCluster
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
                        .padding(.bottom, geometry.safeAreaInsets.bottom + 16)
                }
                if let sheet = model.sheetRect {
                    SheetGlassSurface(start: settingsSeat, end: sheet, reduceMotion: reduceMotion, reduceTransparency: reduceTransparency)
                }
            }
        }
        // The sheet rect is posted viewport-relative — viewport 0 is the
        // webview's top, which sits under the status bar. Ignoring the safe
        // area on the reader keeps posted CSS rects and position space
        // identical; the capsules compensate with the explicit inset above.
        .ignoresSafeArea()
        .onPreferenceChange(GlassHitRectsKey.self) { model.hitRects = $0 }
    }

    /// Tracks the finger resting on a capsule so the keep-alive ping can run
    /// for exactly that span — the only moment the idle clock threatens.
    /// DragGesture(0) fires onChanged on touch-down and onEnded on lift;
    /// LongPressGesture(.infinity) never fires at all.
    private var touchProbe: some Gesture {
        DragGesture(minimumDistance: 0)
            .onChanged { _ in model.setFingerDown(true) }
            .onEnded { _ in model.setFingerDown(false) }
    }

    private var libraryCapsule: some View {
        let button = Button {
            model.invoke("[data-chrome-library]")
        } label: {
            Label("Library", systemImage: "chevron.left")
                .frame(minHeight: 44)
                .padding(.horizontal, 14)
                .font(.system(size: 16, weight: .semibold))
        }
        .controlSize(.large)
        .simultaneousGesture(touchProbe)

        return Group {
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
        .background(rectProbe)
    }

    /// Always-separate capsules 8pt apart — no GlassEffectContainer, which
    /// would union siblings nearer than its spacing. Every press fires the
    /// page's own hidden pill. The label, not the style, sets the 44pt
    /// minimum so Dynamic Type can grow the capsule.
    private var controlsCluster: some View {
        HStack(spacing: 8) {
            clusterButton(label: Text(model.positionLabel).monospacedDigit(),
                          action: "[data-chrome-position]",
                          accessibilityLabel: "Go to a photograph")
            clusterButton(label: Image(systemName: "slider.horizontal.3"),
                          action: "[data-chrome-bottom] [aria-label='Gallery Settings']",
                          accessibilityLabel: "Gallery Settings")
                .background(seatProbe)
            clusterButton(label: Image(systemName: "info"),
                          action: "[data-chrome-bottom] [aria-label='Info']",
                          accessibilityLabel: "Info")
        }
        .foregroundStyle(Color(red: 0.95, green: 0.94, blue: 0.91))
        .background(rectProbe)
    }

    private func clusterButton(label: some View, action: String, accessibilityLabel: String) -> some View {
        let button = Button {
            model.invoke(action)
        } label: {
            label
                .font(.system(size: 15, weight: .semibold))
                .padding(.horizontal, 14)
                .frame(minHeight: 44)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(accessibilityLabel)
        .simultaneousGesture(touchProbe)

        return Group {
            if reduceTransparency {
                button
                    .padding(.horizontal, 4)
                    .background(Capsule().fill(Color(white: 0.06, opacity: 0.92)))
            } else {
                button.glassEffect(.regular.interactive(), in: .capsule)
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

    /// The Settings segment's seat — the sheet morph's launch frame.
    private var seatProbe: some View {
        GeometryReader { geometry in
            Color.clear
                .onAppear { settingsSeat = geometry.frame(in: .global) }
                .onChange(of: geometry.size) { _, _ in settingsSeat = geometry.frame(in: .global) }
        }
        .allowsHitTesting(false)
    }
}

/// The travelling glass that carries a cluster segment into a sheet — the
/// iOS port of the Mac's SheetGlassSurface. Native glass always renders
/// above the webview, so it launches from the Settings seat, lands on the
/// sheet's reported box, and fades out as the web panel's own surface takes
/// over. To the eye the control simply grew into the panel.
@available(iOS 26.0, *)
private struct SheetGlassSurface: View {
    let start: CGRect
    let end: CGRect
    let reduceMotion: Bool
    let reduceTransparency: Bool

    @State private var arrived = false
    @State private var held: CGRect = .zero
    @State private var opacity: Double = 1

    var body: some View {
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
        .onAppear {
            held = end
            withAnimation(reduceMotion ? nil : .spring(response: 0.38, dampingFraction: 0.82)) {
                arrived = true
            }
            withAnimation(reduceMotion ? nil : .easeOut(duration: 0.3).delay(0.5)) {
                opacity = 0
            }
        }
        .onChange(of: end) { _, newEnd in
            withAnimation(reduceMotion ? nil : .spring(response: 0.38, dampingFraction: 0.82)) {
                held = newEnd
            }
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

/// Installs the glass overlay over the bridge's webView. Returns nil on
/// older systems — they keep the web pills, repainted under the frost gate.
@MainActor
enum GlassChromeInstaller {
    @available(iOS 26.0, *)
    static func install(over webView: WKWebView, in container: UIView, model: GlassChromeModel) {
        let host = UIHostingController(rootView: GlassChromeOverlay(model: model))
        host.view.backgroundColor = .clear

        let passthrough = GlassPassthroughView(frame: webView.bounds)
        passthrough.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        passthrough.backgroundColor = .clear
        passthrough.hitRectsProvider = { [weak model] in model?.hitRects ?? [] }
        passthrough.isUserInteractionEnabled = true

        container.addSubview(passthrough)
        passthrough.addSubview(host.view)
        host.view.frame = passthrough.bounds
        host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    }
}
