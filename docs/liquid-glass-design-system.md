# Liquid Glass design system

The design reference for manorama's Liquid Glass work across iOS, iPadOS, macOS
(including iPhone Duo) and Android. This is the epic document the glass phases
(G0–G6) implement; it is updated as phases land.

The product thesis still holds: **the viewing experience is the product.** Glass
is a functional layer — control chrome, sheets, dialogs, scrims. It never
decorates the photographic canvas, and no `.glass-*` surface is ever an ancestor
of an `<img>`.

## Rendering model — four tiers

| Tier | Where | What |
| --- | --- | --- |
| **N — native glass** | macOS 26+ (shipped); iOS/iPadOS 26+ overlay | `.buttonStyle(.glass)` capsules inside `GlassEffectContainer` with `.glassEffectID` identities — one merged silhouette at rest, native press deformation on touch. macOS expands under pointer proximity, keyboard and VoiceOver focus; iOS reports held-finger/focus explicitly (no hover separation on touch). Reduce-Transparency solid sibling at identical geometry; 44×44 minimum targets |
| **A — web bend** *(pending — no producer sets `data-android-glass` yet)* | Android Chromium WebView only | SVG `feDisplacementMap` through `backdrop-filter`, refracting the backdrop under chrome pills and stage arrows; the displacement never touches foreground paint, so glyphs stay crisp. Activation requires feature detection, a single-segment check and a same-session no-bend baseline |
| **B — web frost** | in-document surfaces, all shells, all OS versions | backdrop-filter blur+saturate, specular rim, edge line, `--glass-*` fills |
| **0 — solid** | reduced transparency / increased contrast / no backdrop-filter | CSS fallback for web; a Swift branch for native — RT is not a media query there |

Tier A is specified but not yet implemented — nothing in tree sets
`data-android-glass`. Until a producer lands, Android surfaces remain Tier B.

On the web side, real bend does not render in WebKit — the frost tier is the
ceiling inside WKWebView. Native shell chrome is where true Liquid Glass lives.

## Two gates — never conflate them

**Takeover gate** — `:root[data-macos-glass]`, `:root[data-ios-glass]`.
Set by the shell only when a native capsule has replaced the web element
(OS ≥ 26). These attributes gate **only** `visibility:hidden` rules that retire
the web pills. Widening them to shell presence would delete viewer chrome on
iOS 17–25 and Android permanently.

**Frost gate** — `:root[data-ios-shell]`, `:root[data-android-shell]`,
`:root[data-macos-shell]`. Shell presence on **every** OS version. These
attributes gate Tier-B paint overrides only — never `visibility:hidden`.

| Marker | Set by | Scope |
| --- | --- | --- |
| `data-macos-shell` | SwiftUI shell injects at document start (`ViewerWebView.swift`) | every document in the shell webview, any macOS |
| `data-macos-glass` | same, `#available(macOS 26)` | takeover active |
| `data-ios-shell` | `SceneDelegate` injects at document start | iOS + iPadOS, any version |
| `data-ios-glass` | same, `#available(iOS 26)` — **added in G1 with the overlay** | takeover active |
| `data-android-shell` | blocking inline script in `native/index.html` (UA sniff) | Capacitor Android |
| `data-android-glass` | **pending — no producer yet**; spec: only after `feDisplacementMap` + `backdrop-filter url()` support, a single-segment viewport, and a same-session no-bend baseline | bend active |

`body.manorama-native` / `body.manorama-desktop` are static classes on the
bundles' `<body>` (FOUC-free; no script timing). The desktop bundle is served
by the SwiftUI shell — `data-macos-shell` is its frost gate; legacy Tauri
(Windows/Linux) gets none of these attributes and keeps today's look.
manorama.xyz and the homepage demo get neither gate — their base declarations
are frozen.

What runs where: web chrome elements mount on every OS; on <26 they are
repainted Tier B under the frost gate; on 26+ they stay mounted (they own the
handlers the shell fires) but are hidden while native capsules render.

## The native/web chrome contract (macOS and iOS)

Every transition has exactly one owner. Sheets are entirely web-owned: no
native material ever sits on top of the web panel during the handoff — the
earlier travelling `SheetGlassSurface` is retired on both platforms.

The contract is small and bounded:

- **`__manoramaShell.activateControl(id)`** — the shell names a control
  (`library | position | settings | info`); the page fires its own mounted
  pill. No selector string crosses the bridge. On iOS the surface is
  installed by `native/lib/ios-shell.ts` when the `data-ios-glass` stamp is
  present; on macOS by `desktop-shell/bridge.ts`.
- **`__manoramaShell.setChromeActive(bool)`** — native interaction (pointer
  proximity and focus on macOS; held finger, keyboard and VoiceOver focus on
  iOS) is reported as explicit activity state, so the page's idle clock
  keeps the hidden pills mounted. Replaces the synthetic-pointermove
  keep-alive.
- **`__manoramaShell.focusStage()` / `{type:'focus'}`** — focus ownership
  handed off in both directions: Escape on a native control returns the
  stage; the page reports which control was focused so VoiceOver and the
  key loop land on the same capsule.
- **`{type:'chrome-layout'}`** — the web bar's rect (finite-validated) seats
  the native cluster over the chrome's real box, and `inert` state closes it
  while a sheet owns the stage.
- Validation: main-frame + trusted-document + `manorama://localhost` origin
  before any body is parsed; `didCommit` resets ready/chrome state so a new
  document generation never inherits the last one's listeners.

## Tokens

`app/styles/glass.css` defines `--glass-*` custom properties following the
`--m-*` convention: dark defaults on `:root`, light values under `html.light`,
dark re-pinned under `.m-dark` (viewer chrome never follows `html.light`).
Numbers the checks need live in `packages/core/glass-tokens.ts` as a plain TS
object — no CSS strings, no platform logic.

Families: fills (lens / regular / frost / tint / rim), flat-in-glass
(child / chip / trough), rim key & counter, edge line, text-on-glass,
accent-on-glass, dim, shadow.

Material classes (all scoped under the frost gate): `.glass-lens` (clearest —
floating single controls), `.glass-regular` (pills, toolbars, popovers),
`.glass-frost` (sheets, dialogs), `.glass-tint` (exactly one prominent action),
`.glass-flat` / `.glass-trough` (children of glass — flat, never a second lens).

## Rules

- Children flat above the optics; **no lens-on-lens**; concentric radii.
- Rim ~1px: bright key edge (top-left), dimmer counter (bottom-right), dark
  edge line outside.
- Glass tints from the backdrop (saturation boosted, never desaturated);
  no heavy fixed tint.
- Legibility wins: text ≥4.5:1 measured *after* blur on the real backdrop;
  where a token misses, darken/lighten the surface or raise the fill.
- Blur ceilings (community-derived, flagged): ≤40px phone, ≤60px iPad/Mac for
  glass surfaces. **Named exempt dims** keep their existing filters —
  `.native-global-view` (120px), `.filmstrip-scrim` (76px), `.curtain` (28px),
  `.viewer-filmstrip` (112px — the picker surface, not a scrim); the
  "never desaturate" rule does not apply to them.
- Compositing: no per-thumb glass, chrome only (picker matrix and Global View
  are the risk).
- New `.glass-*` surfaces are never ancestors of `<img>` — enforced by
  `scripts/check-glass.test.ts` (CSS level) and the DOM assertion in
  `specs/glass-freeze.playwright.ts`.
- Frozen web selectors — base declarations never edited:
  `.m-chrome-pill`, `.curtain`, `.filmstrip-scrim`, `.viewer-filmstrip`,
  `.admin-gallery-strip-frame` (the last is shared by web admin and the
  desktop catalogue). Shell styling reaches them only through frost-gated
  overrides, proven by `specs/glass-freeze.playwright.ts`.

## Enforcement

- `scripts/check-glass.test.ts` — runs inside `bun test` (unit mirror + CI):
  resolves `--glass-*` against `packages/core/glass-tokens.ts` for blur budgets,
  requires a reduced-transparency/`@supports` fallback on every `.glass-*` rule,
  rejects `.glass-*` selectors outside the frost gate or containing `img`,
  rejects `visibility:hidden` under a frost attribute.
- `specs/glass-freeze.playwright.ts` — loads the viewer and admin with **no**
  shell attributes and snapshots the frozen selectors' computed styles; also
  asserts no `backdrop-filter` ancestor within 3 levels of viewer/picker images.
- Meniscus `check_code` + hig-mcp — advisory external MCP tools (design source);
  the in-repo gate above is authoritative and stands without them.

## Phase map

| Phase | Scope | Status |
| --- | --- | --- |
| G0 | tokens, markers, gates, `check-glass` + `glass-freeze` | merged |
| G1 | iOS/iPadOS native overlay (spike capsule → always-separate cluster, `SheetGlassSurface`, non-touch keep-alive) | PR #235 merged; second review #237 merged |
| G2a/b/c | frost surfaces: chrome+overlays · library+commerce · canvas-adjacent | #227/#236, #228/#239, #229/#240 merged |
| G3 | macOS desktop-bundle frost + native parity | PR #242 |
| G4 | iPhone Duo — close #35, side-pill fill override, Duo glass | PR #243 |
| G5 | Android tier-A bend, session-scoped degradation | PR #244 |
| G6 | evidence refresh + docs | this branch |

Two details the phases added that the tier table above does not show:
- **Duo seating is native-side too.** `SceneDelegate` publishes the active
  `reservedRegions` to the overlay model on the same pass that posts
  `__MANORAMA_IOS_LAYOUT__`; capsules clear a leading system bar and the
  bottom cluster centres in the widest unreserved run of screen.
- **Vertical-bar pills keep `.92`.** Under the frost gate
  `.m-chrome--side .m-chrome-pill` retains its near-opaque fill — a Tier-B
  blur inside the system bar's thin strip is invisible, and the arm outlives
  Tier 0 because the bar is always dark.
