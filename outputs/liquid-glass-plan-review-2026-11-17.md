# Liquid Glass megaplan — review against `main` @ b5d2c6e

Reviewed 2026-11-17 against the working tree. Every claim below is grounded in a file read; citations are `path:line`.

## Premise correction (read this first)

The plan treats "the desktop bundle" as one host. It is two, and they stamp differently. The same `desktop/` web bundle ships in (a) the Tauri app and (b) the SwiftUI-hosted Mac app (`macos/ManoramaMac/ViewerWebView.swift` — the app's only webview, confirmed at `ViewerWebView.swift:258-351`). In the Tauri host the document gets no shell marker at all: `body.manorama-desktop` is a static class in `desktop/index.html:26`, so Tauri CSS sees `body.manorama-desktop` and nothing else. In the SwiftUI host, `ViewerWebView` loads the same bundle and its user script stamps `document.documentElement.dataset.macosShell` unconditionally (`ViewerWebView.swift:265`) and `dataset.macosGlass` inside `#available(macOS 26.0, *)` (`ViewerWebView.swift:277`). The stamps are `data-*` attributes, so the correct selectors are `html[data-macos-shell]` / `html[data-macos-glass]` (the form `app/styles.css:2039-2051` already uses), not a `.macos-shell` class. For the Capacitor shell, `body.manorama-native` is a static class in `native/index.html:22` — not something `native/main.tsx` injects. So G3's line "desktop bundle gets Tier-B frost via the same gated CSS — `data-macos-glass` already stamps its document at start" is wrong in two directions at once: the Tauri bundle receives no stamp ever, while the SwiftUI-hosted bundle does receive `data-macos-glass` — but only on macOS 26+, and only in ViewerWebView's webview (the app has no second host, but any future one would need the same user script before the claim generalises). G3 is still "add new gates", not "reuse existing gate": frost rules must distinguish the hosts. The SwiftUI gate is `html[data-macos-glass]` — OS-stamped, so it only ever matches macOS 26+ and older SwiftUI hosts fall through to the existing `html[data-macos-shell]` web chrome untouched. The Tauri gate cannot be `body.manorama-desktop` alone — that class is static markup (`desktop/index.html:26`), so it is also present inside the SwiftUI webview; it must be scoped to exclude the shell, e.g. `:root:not([data-macos-shell]) body.manorama-desktop`.

Second, the plan's verification gates need an honest tooling story. `check_code` (the Meniscus MCP) and `hig-mcp` are advisory external tools — available in some agent environments, never part of the repo toolchain, so nothing in the definition-of-done may depend on them. Meniscus itself is the token authority the plan cites, and `packages/core/glass-tokens.ts` references it for the budget vocabulary (`glass-tokens.ts:9-24`). The authoritative in-repo gate is `scripts/check-glass.test.ts`, which runs inside `bun run test:unit` and enforces the frost-gating and fallback structure. On attribution: the 40px phone / 60px larger-device blur ceilings are community best practice, as `glass-tokens.ts` itself states — "the numeric ceilings are community-bestpractice" — not Apple HIG values, so the plan must not cite HIG for them. The HIG reference belongs to the functional-layer rule only (glass as a layer for chrome, per https://developer.apple.com/design/human-interface-guidelines/materials).

Third, the blur budget must be assessed against every consumer of `.native-global-view`, not just the photo picker. `native/styles/global-view.css:9-13` puts `blur(120px) saturate(.16) brightness(.42)` on the class itself — a full-viewport dim. Three surfaces mount that class and import the stylesheet: the photo picker (`native/islands/GlobalView.tsx:282`), the native Post-to-X dialog (`native/islands/PostToX.tsx:327`, class `native-global-view native-postto`), and the desktop Post-to-X dialog (`desktop/islands/PostToX.tsx:277`, class `native-global-view native-postto native-postto--desktop`). Assessed together: the 40/60px ceilings cover functional chrome layers (pills, sheets, popovers) per `glass-tokens.ts`; a full-viewport dim shared identically by all three consumers is a different surface type, so there is no conflict — but the plan must say so by naming a separate dim/scrim tier rather than silently exempting the surface, and any "reconcile to tokens" that touches the 120px is a visual change to all three dialogs at once, needing before/after captures of each.

## What the plan gets right

1. The four-tier model (N/A/B/0) and the "older OS keeps today's web chrome verbatim" contract match the existing macOS precedent (`macos/ManoramaMac/ContentView.swift` gates `#available(macOS 26.0, *)`; iOS plan mirrors it). Correct and consistent with invariant 4 / floors.
2. Reusing `invokeWebControl` (JSONEncoder, not JSONSerialization — `macos/ManoramaMac/AppModel.swift:241-248`) and `keepViewerChromeAlive` verbatim is the right call; the plan names both. The silent-no-op bug is already documented in code.
3. Native glass only on control chrome, never over photograph pixels, aligns with invariants 2 and 13. The plan states this explicitly (`Guardrails`).
4. Tier-0 fallback under `prefers-reduced-transparency` / `prefers-contrast: more` / `@supports not (backdrop-filter)` reuses the existing pattern (`app/styles.css:2070`: `@supports not (backdrop-filter: blur(12px)) { .m-chrome-pill { background: rgba(10,10,10,.85); } }`). No new invention needed.
5. G4 correctly reuses `SceneDelegate` reserved-region plumbing and `packages/core/fold.ts` rather than re-deriving hinge geometry. `native/lib/fold.ts` already scales native frames into CSS pixels.
6. The "no lens-on-lens / flat children" rule is the right Meniscus-style constraint and is enforceable by review.

## Claim-by-claim

### 1. "G1 ports the macOS pattern to iOS" — PARTIAL

The macOS pattern is a ZStack-sibling native overlay (`macos/ManoramaMac/ContentView.swift:57-58` ZStack with webview + native capsules as siblings, not `.overlay`). The plan says "Container is passthrough: only capsules hit-test" and names the hit-testing risk. Good. But two unstated gaps:

- **Touch has no hover.** The macOS cluster expands "under the pointer" (`ContentView.swift:48-50` `clusterExpanded` toggled via `onHover`). On iOS there is no hover; the plan never defines the iOS expand trigger (tap, long-press, always-expanded). This is a UX decision, not an implementation detail, and it affects every G1 screenshot. Decide before G1 ships, or the cluster is either permanently expanded (clutter) or unexpandable (dead).
- **iOS chrome idle-hide vs native presses** is named as a risk but the fix is "port `keepViewerChromeAlive`". On iOS the capsule is a native SwiftUI sibling of the webview — DOM touch handlers cannot see it, and the macOS `onHover` hook (`ContentView.swift:97-100`) has no touch equivalent. The keep-alive must instead be a native gesture or press hook on the capsule (e.g. a `DragGesture(minimumDistance: 0)` probe or the button's pressed state) that invokes the web control's keep-alive ping from the native side — the page's own `keepViewerChromeAlive` signal fired on finger-down, kept alive while the finger rests, and released on lift or cancellation. Specify that hook; DOM handlers are not an option.

### 2. "G2 applies Tier-B to every surface" — OVERSCOPE, UNSCHEDULABLE AS ONE PR

G2's table lists ~20 surfaces across `app/components/viewer/*`, `native/islands/*`, `native/styles/*.css`, and `app/styles.css` (the endcap block at 1527-1600, `.m-chrome-pill` at 2049). AGENTS.md lane discipline is one issue/branch/PR with disjoint file sets, and `app/styles.css` touchpoints are explicitly sequenced G1→G2→G4. G2 as written is a single PR touching the same file three phases are fighting over, with no internal ordering. Suggestion: split into G2a (viewer chrome pills + sheets + dialogs + scrim), G2b (library/account/commerce islands), G2c (global view + picker + endcard + curtain), each owning disjoint CSS sections, with a shared "gating + token plumbing" PR (G0 extended) landing first that only widens selectors and adds `native/styles/glass.css` without restyling anything. Also define `app/styles.css` section ownership so G1/G2/G4 don't three-way conflict.

### 3. "G3 desktop gets Tier-B frost" — WRONG GATE (see premise correction)

Desktop frost needs two disjoint host gates, not one: `html[data-macos-glass]` is the only frost-correct SwiftUI gate — `data-macos-shell` is unconditional and would enable frost on pre-26 macOS, where the host must instead keep its existing web chrome as the stated fallback — and the Tauri side must exclude the SwiftUI webview (`:root:not([data-macos-shell]) body.manorama-desktop`), since `body.manorama-desktop` is static markup present in both. Additionally, the desktop bundle already has its own frost-ish surfaces (stage arrows at `body.manorama-desktop .stage-arrows`, desktop toast stack, etc.) — these should be reconciled to the new tokens, but the plan's "extend native chrome where surfaces float beyond the viewer: audit Catalogue rail header" is vague. Name the specific surfaces: `.desktop-share`, `.desktop-paste`, `.admin-drawer-panel`, `.desktop-toast-stack`, stage arrows. Without that list, G3's scope is unreviewable.

### 4. "G4 closes #35 + Duo glass" — PARTIAL, DEPENDENCY ORDERING RISK

#35 (E3) is blocked by E2 and requires Xcode 27.1 / iOS 27.1 SDK. The plan says "E3 checklist on the installed Xcode 27.1 / iOS 27.1 SDK". Verified toolchain exists (AGENTS.md §4). But the plan also says "iOS 27.x sims render blank on this host — only iOS 26.5 runtime usable for captures". So Duo captures cannot be produced from the simulator at all; they need a real device or Device Hub. The plan acknowledges this in Key risks but the G6 evidence gate still demands `demo-captures/duo/` refresh in all poses. Make the evidence gate explicitly accept "real-device captures only, simulator not usable" so a reviewer doesn't block on missing sim screenshots. Also: the plan's G4 says "spread-mode chrome per segment" but the spread-mode diptych is #33 (not #35). Confirm whether #33 is in scope for glass dressing or whether glass only applies to single-photo chrome. The plan's invariants say "a diptych spread cannot carry a plate" (native-launch-plan §B) — does that also mean no glass on the spread? Clarify.

### 5. "G5 Android tier-A bend" — DEGRADATION CRITERIA UNDEFINED

The plan says "degrade to Tier B on failure or frame-budget blowout (measure on a mid-range device)" with no threshold. Without a number, "frame-budget blowout" is unfalsifiable and the fallback never triggers. Define: e.g. if `requestAnimationFrame` frame time exceeds 20ms for 3 consecutive seconds, disable SVG displacement for the session and persist the choice. Also: `feDisplacementMap` over text-containing glass elements will distort glyphs — the plan must state that tier-A bend applies only to chrome elements without text, or accept illegible controls. Finally, Android foldable detection via `@media (horizontal-viewport-segments: 2)` is Chromium-only and may be absent in older WebView versions; `native/lib/fold.ts` already has a Chromium media-query path, but there's no JS fallback. Add one (feature-detect `CSS.supports('selector(:has())')` is not enough; check the media query itself).

### 6. "Blur ≤40/60px, ≤4 layers, 4.5:1" — RIGHT NUMBERS, WRONG ATTRIBUTION AND SCOPE

See premise correction. The 40/60px ceilings are community best practice (per `glass-tokens.ts`, which flags them as "community-bestpractice"), so the plan should not attribute them to HIG — the HIG citation covers only the functional-layer rule. Suggestion: replace the single blur number with a per-surface table (chrome pills ≤40/60, sheets/popovers ≤40/60, full-viewport dims/scrims like `.native-global-view` in their own tier — the 120px stays, native glass = OS-managed). `hig-mcp` is an advisory external tool; the numbers live audibly in `glass-tokens.ts` and the enforceable gate is `scripts/check-glass.test.ts`.

### 7. "G0 creates `native/styles/glass.css`" — GOOD, BUT TOKEN NAMING MUST MATCH EXISTING CONVENTION

Existing tokens are `--m-*` (dark default) with `html.light` overrides (`app/styles.css` `:root` block: `--m-ground`, `--m-surface`, etc.). The plan says "Meniscus tokens as custom properties in light + dark". Specify the naming (`--g-*` or `--glass-*`?) and the override mechanism (`.m-dark` / `html.light` / `prefers-color-scheme`). Without this, G2 implementers will invent inconsistent names. Also: the plan says "Platform-free token values may also land in `packages/core` as data if islands need them in JS (allowed — data, not platform code)." This is fine per invariant 8, but it must be plain data (no CSS strings that assume a platform). Clarify the shape (a TS object of numbers/strings), not CSS.

### 8. "iOS overlay hit-testing" — RISK NOT DE-RISKED BEFORE G1

The plan lists this as a Key risk but schedules no spike. Given that the entire G1 depends on it, and that the macOS lesson ("overlay as sibling, not `.overlay`, with passthrough container") had to be learned the hard way, add a G1.0 spike (1-2 days) that ports only the Library capsule to iOS and verifies on a real device: passthrough hit-testing, chrome keep-alive on touch, sheet morph. Gate G1b (bottom cluster) on G1.0 passing. This is cheap insurance against a week lost to touch-routing bugs.

### 9. "G6 evidence gates" — SIMULATOR GAP

`bunx playwright test` matrix + 2-segment fold viewport is required for chrome changes. But Duo poses (flat-open/book/folded) cannot be produced by the sim (per plan's own Key risks). Either mark Duo evidence as "real-device only, documented as such" or add a Playwright project that drives the fold via the CSS segment media queries (geometry coverage, not native evidence). The plan says "a browser segment simulation is useful geometry coverage, not a substitute" (from `outputs/duo-and-macos-plan-2026-10-11.md`). Align G6's gate with that honesty: sim captures = geometry only, real-device captures = native evidence, and both must be labeled.

### 10. "No image bytes" / "pixelated images anathema" — GLASS MUST NOT OBSCURE INTRINSIC SIZE

Invariant 13: "Never render a bitmap larger than its intrinsic pixel dimensions." Glass surfaces with backdrop-filter over a photograph area can cause the browser to promote a compositing layer that masks the true image size. The plan says glass lands only where chrome floats. But the Global View contact sheet refinement and picker edit-mode could introduce glass backgrounds behind thumbnails. Add an explicit rule to the plan's guardrails: "No glass surface may be an ancestor of or sibling-behind an `<img>` element; glass is only on control chrome, scrims, and sheets that do not contain photographs." And add a Playwright assertion that `.viewer-frame img` and `.native-global-cell img` have no `backdrop-filter` ancestor within 3 levels. This is enforceable and cheap.

## Change before implementation (ordered by owning phase)

1. **G0**: Name `scripts/check-glass.test.ts` the authoritative verification gate — it already runs inside `bun run test:unit` and enforces the frost-gating and fallback structure. `check_code` (Meniscus MCP) and `hig-mcp` stay advisory external tools: useful during implementation, never load-bearing in the definition-of-done. Attribute the 40/60px ceilings as community best practice (per `glass-tokens.ts`); HIG covers the functional-layer rule only. (G0 owns it; everything else depends on it.)
2. **G0**: Fix the desktop gating error: desktop frost gates on `html[data-macos-glass]` for the SwiftUI-hosted bundle — the OS-stamped marker that exists only on macOS 26+, so pre-26 hosts keep their existing `html[data-macos-shell]` web chrome as the fallback — and on `body.manorama-desktop` scoped to exclude the shell (`:root:not([data-macos-shell])`), because the static class is present inside the SwiftUI webview too and an unscoped `body.manorama-desktop` would match both hosts. Update the selector list in G1's `app/styles.css` bullet accordingly.
3. **G0**: Define the token naming (`--glass-*`) and the light/dark override mechanism (`html.light` + `.m-dark`), matching the existing `--m-*` convention. Specify the `packages/core` data shape (plain TS object).
4. **G0**: Resolve the blur budget by naming a dim/scrim tier in the per-surface table: the 120px dim on `.native-global-view` is shared by the photo picker and both Post-to-X dialogs, so it gets its own line — not an exemption, and not the chrome budget. Any change to it is a visual change to all three consumers and requires before/after captures of each.
5. **G1**: Add G1.0 spike (Library capsule only on iOS, real device) before G1b. Define the iOS cluster expand trigger (tap-to-expand recommended) and the touch keep-alive ping.
6. **G2**: Split into G2a/G2b/G2c with disjoint CSS section ownership; land a "gating + token plumbing" PR first.
7. **G4**: Mark Duo evidence as real-device-only; clarify whether glass applies to spread-mode diptych chrome. Confirm #33 (diptych geometry) is a prerequisite or out of scope.
8. **G5**: Define degradation threshold (frame time >20ms for 3s → disable bend for session); state that bend applies only to text-free chrome; add JS fallback for fold media query.
9. **All**: Add the "no glass ancestor of an image" rule + Playwright assertion.
10. **G6**: Align evidence gates with the simulator's Duo limitation; label sim captures as geometry-only.

## Hypotheses (not confirmed here)

- The plan assumes iOS 26+ runtime provides `.glassEffect(.regular.interactive())` with the same API shape as macOS 26. I did not verify the iOS 26 SwiftUI glass API; the iOS SDK in the tree is 27.1. If the API differs (e.g., `.glassEffect` is macOS-only and iOS uses `UIGlassEffect`), G1's `GlassChromeView` needs a UIKit rewrite, not a port. Check `UIGlassEffect.h` in the iOS 26 SDK headers before committing to the SwiftUI overlay approach.
- The plan assumes Android's Chromium WebView supports SVG `feDisplacementMap` at 60fps. I did not measure. The degradation threshold (change 8) covers this, but the default-on decision should wait for measurement.
- The plan assumed `body.manorama-native` was set by `native/main.tsx` at module load and might arrive too late for first paint. In fact the class is already static markup — `<body class="manorama-native">` at `native/index.html:22` — present before the stylesheet is parsed, so there is no FOUC mechanism to remediate and no flash has been demonstrated. If a first-paint flash of un-glass styles ever appears, the cause lies elsewhere (e.g. a late-stamped `data-*` attribute like `data-ios-glass`), not in this class.

## Could not verify

- ~~Whether `hig-mcp` or `Meniscus` exist as external MCP servers.~~ Resolved: both are advisory external MCP tools, available in some agent environments but never part of the repo toolchain — nothing in the definition-of-done may depend on them. `scripts/check-glass.test.ts` is the authoritative in-repo gate.
- Whether `#33` (diptych geometry) is complete enough to support glass dressing on spread-mode chrome. Did not read #33's implementation status.
- Real-device Duo behavior: no device available in this environment.

## What runs

- `check_code` (Meniscus MCP) and `hig-mcp` are advisory external tools, not repo dependencies; Meniscus is referenced by `packages/core/glass-tokens.ts`. `scripts/check-glass.test.ts` is the authoritative in-repo gate inside `bun run test:unit`.
- `grep` for `data-macos-glass` in source (excluding dist/build): `macos/ManoramaMac/ViewerWebView.swift:277` and `:319`. Confirms the SwiftUI-hosted desktop webview stamps it (macOS 26+ only); the Tauri bundle has no stamp.
- `grep` for `data-ios-glass`, `data-android-glass`, `data-shell-glass`: zero hits at review time. (`data-ios-glass` has since been implemented for the iOS 26 overlay.)
- `grep` for `data-macos-shell` / `body.manorama-desktop`: `app/styles.css:2039-2051` attribute form; `body.manorama-desktop` is a static class in `desktop/index.html:26`. Confirms the two host markers.
- Read `native/index.html:22`: `<body class="manorama-native">` — the Capacitor shell marker is static markup, not added by `native/main.tsx`.
- Read `native/styles/global-view.css:9-13`: `blur(120px)` on `.native-global-view` itself, consumed by the photo picker (`native/islands/GlobalView.tsx:282`), native Post-to-X (`native/islands/PostToX.tsx:327`) and desktop Post-to-X (`desktop/islands/PostToX.tsx:277`).
- Read `macos/ManoramaMac/ContentView.swift:48-50, 57-58, 88-106, 116-120`: cluster expand on hover, ZStack sibling overlay, `#available(macOS 26.0, *)`. Confirms iOS hover/touch gaps.
- Read `macos/ManoramaMac/AppModel.swift:241-259`: `invokeWebControl` (JSONEncoder) and `keepViewerChromeAlive`. Confirms reuse targets.
- Read `ios/App/App/SceneDelegate.swift` (full): reserved regions, `data` injection, `didUpdateEffectiveGeometry`. Confirms Duo plumbing exists.
- Read `native/lib/fold.ts` (full): fold runtime adapter. Confirms scaling of native frames.
- Read `packages/core/fold.ts` (first 60 lines): platform-free fold model. Confirms invariant 8 compliance.
- `git log --oneline -15`: confirms baseline b5d2c6e, PR #222 (macOS glass) merged.

No code was changed by this review. No tests were run (review-only task).
