# Liquid Glass megaplan — review against `main` @ b5d2c6e

Reviewed 2026-11-17 against the working tree. Every claim below is grounded in a file read; citations are `path:line`.

## Premise correction (read this first)

The plan is written as if the desktop shell were a native macOS WKWebView that stamps `data-macos-glass`. It is not. `data-macos-glass` is injected only by the macOS native shell (`macos/ManoramaMac/ViewerWebView.swift:275-277`, inside `#available(macOS 26.0, *)`). The desktop (Tauri) bundle is a different surface: it stamps `html.macos-shell` / `body.manorama-desktop` (`app/styles.css` rules are gated on `html.macos-shell body.manorama-desktop` and `body.manorama-desktop`), and `native/main.tsx:13` adds `body.manorama-native` for the Capacitor shell. So G3's line "desktop bundle gets Tier-B frost via the same gated CSS — `data-macos-glass` already stamps its document at start" is factually wrong: desktop frost will not apply unless the gating selectors also include `html.macos-shell` / `body.manorama-desktop`. This reframes G3 from "reuse existing gate" to "add a new gate", and it is the single most expensive latent bug in the plan because every desktop frost rule written against `data-macos-glass` would silently no-op.

Second, the plan's verification gates name three tools that do not exist anywhere in the tree: `check_code` (Meniscus), `Meniscus` itself (tokens/spec/component/QA ritual), and `hig-mcp` (budget source). Grep across `*.md/*.ts/*.tsx/*.css/*.swift/*.json/*.sh` (excluding `node_modules`/`.worktrees`) returns zero hits for all three. The budget numbers (blur ≤40/60px, ≤4 compositing layers, 4.5:1 contrast) are sound Apple-HIG values, but they are currently unverifiable in-repo and the gating depends on a tool nobody can run. This must be resolved in G0 before any surface work, or the "definition of done per phase" is not enforceable.

Third, the blur budget conflicts with an existing surface: `.native-global-view` uses `blur(120px)saturate(.16)brightness(.42)` (built bundle CSS; see `native/styles/global-view.css` consumers). The plan's "≤60px on iPad & Mac" would cut that in half. Either the Global View is exempt (it is a full-screen dim, not chrome) or the budget needs per-surface-type tiers. The plan does not say which, and "reconcile to tokens" implies a visual change that should be flagged as one.

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
- **iOS chrome idle-hide vs native presses** is named as a risk but the fix is "port `keepViewerChromeAlive`". That works for hover (macOS). On touch, the native control is pressed, not hovered, so the keep-alive ping must fire on `touchstart`/`touchmove` of the native capsule, not on hover. The macOS `onHover` hook (`ContentView.swift:97-100`) has no touch equivalent in the plan. Add it.

### 2. "G2 applies Tier-B to every surface" — OVERSCOPE, UNSCHEDULABLE AS ONE PR

G2's table lists ~20 surfaces across `app/components/viewer/*`, `native/islands/*`, `native/styles/*.css`, and `app/styles.css` (the endcap block at 1527-1600, `.m-chrome-pill` at 2049). AGENTS.md lane discipline is one issue/branch/PR with disjoint file sets, and `app/styles.css` touchpoints are explicitly sequenced G1→G2→G4. G2 as written is a single PR touching the same file three phases are fighting over, with no internal ordering. Suggestion: split into G2a (viewer chrome pills + sheets + dialogs + scrim), G2b (library/account/commerce islands), G2c (global view + picker + endcard + curtain), each owning disjoint CSS sections, with a shared "gating + token plumbing" PR (G0 extended) landing first that only widens selectors and adds `native/styles/glass.css` without restyling anything. Also define `app/styles.css` section ownership so G1/G2/G4 don't three-way conflict.

### 3. "G3 desktop gets Tier-B frost" — WRONG GATE (see premise correction)

Desktop frost must gate on `html.macos-shell` / `body.manorama-desktop`, not `data-macos-glass`. Additionally, the desktop bundle already has its own frost-ish surfaces (stage arrows at `body.manorama-desktop .stage-arrows`, desktop toast stack, etc.) — these should be reconciled to the new tokens, but the plan's "extend native chrome where surfaces float beyond the viewer: audit Catalogue rail header" is vague. Name the specific surfaces: `.desktop-share`, `.desktop-paste`, `.admin-drawer-panel`, `.desktop-toast-stack`, stage arrows. Without that list, G3's scope is unreviewable.

### 4. "G4 closes #35 + Duo glass" — PARTIAL, DEPENDENCY ORDERING RISK

#35 (E3) is blocked by E2 and requires Xcode 27.1 / iOS 27.1 SDK. The plan says "E3 checklist on the installed Xcode 27.1 / iOS 27.1 SDK". Verified toolchain exists (AGENTS.md §4). But the plan also says "iOS 27.x sims render blank on this host — only iOS 26.5 runtime usable for captures". So Duo captures cannot be produced from the simulator at all; they need a real device or Device Hub. The plan acknowledges this in Key risks but the G6 evidence gate still demands `demo-captures/duo/` refresh in all poses. Make the evidence gate explicitly accept "real-device captures only, simulator not usable" so a reviewer doesn't block on missing sim screenshots. Also: the plan's G4 says "spread-mode chrome per segment" but the spread-mode diptych is #33 (not #35). Confirm whether #33 is in scope for glass dressing or whether glass only applies to single-photo chrome. The plan's invariants say "a diptych spread cannot carry a plate" (native-launch-plan §B) — does that also mean no glass on the spread? Clarify.

### 5. "G5 Android tier-A bend" — DEGRADATION CRITERIA UNDEFINED

The plan says "degrade to Tier B on failure or frame-budget blowout (measure on a mid-range device)" with no threshold. Without a number, "frame-budget blowout" is unfalsifiable and the fallback never triggers. Define: e.g. if `requestAnimationFrame` frame time exceeds 20ms for 3 consecutive seconds, disable SVG displacement for the session and persist the choice. Also: `feDisplacementMap` over text-containing glass elements will distort glyphs — the plan must state that tier-A bend applies only to chrome elements without text, or accept illegible controls. Finally, Android foldable detection via `@media (horizontal-viewport-segments: 2)` is Chromium-only and may be absent in older WebView versions; `native/lib/fold.ts` already has a Chromium media-query path, but there's no JS fallback. Add one (feature-detect `CSS.supports('selector(:has())')` is not enough; check the media query itself).

### 6. "Blur ≤40/60px, ≤4 layers, 4.5:1" — UNVERIFIABLE, CONFLICTS WITH EXISTING 120px GLOBAL VIEW

See premise correction. Suggestion: replace the single blur number with a per-surface table (chrome pills ≤40/60, sheets/popovers ≤40/60, scrims/dims ≤120 with reduced-saturation, native glass = OS-managed). And replace `hig-mcp` citations with direct HIG URLs so the numbers are auditable without a tool.

### 7. "G0 creates `native/styles/glass.css`" — GOOD, BUT TOKEN NAMING MUST MATCH EXISTING CONVENTION

Existing tokens are `--m-*` (dark default) with `html.light` overrides (`app/styles.css` `:root` block: `--m-ground`, `--m-surface`, etc.). The plan says "Meniscus tokens as custom properties in light + dark". Specify the naming (`--g-*` or `--glass-*`?) and the override mechanism (`.m-dark` / `html.light` / `prefers-color-scheme`). Without this, G2 implementers will invent inconsistent names. Also: the plan says "Platform-free token values may also land in `packages/core` as data if islands need them in JS (allowed — data, not platform code)." This is fine per invariant 8, but it must be plain data (no CSS strings that assume a platform). Clarify the shape (a TS object of numbers/strings), not CSS.

### 8. "iOS overlay hit-testing" — RISK NOT DE-RISKED BEFORE G1

The plan lists this as a Key risk but schedules no spike. Given that the entire G1 depends on it, and that the macOS lesson ("overlay as sibling, not `.overlay`, with passthrough container") had to be learned the hard way, add a G1.0 spike (1-2 days) that ports only the Library capsule to iOS and verifies on a real device: passthrough hit-testing, chrome keep-alive on touch, sheet morph. Gate G1b (bottom cluster) on G1.0 passing. This is cheap insurance against a week lost to touch-routing bugs.

### 9. "G6 evidence gates" — SIMULATOR GAP

`bunx playwright test` matrix + 2-segment fold viewport is required for chrome changes. But Duo poses (flat-open/book/folded) cannot be produced by the sim (per plan's own Key risks). Either mark Duo evidence as "real-device only, documented as such" or add a Playwright project that drives the fold via the CSS segment media queries (geometry coverage, not native evidence). The plan says "a browser segment simulation is useful geometry coverage, not a substitute" (from `outputs/duo-and-macos-plan-2026-10-11.md`). Align G6's gate with that honesty: sim captures = geometry only, real-device captures = native evidence, and both must be labeled.

### 10. "No image bytes" / "pixelated images anathema" — GLASS MUST NOT OBSCURE INTRINSIC SIZE

Invariant 13: "Never render a bitmap larger than its intrinsic pixel dimensions." Glass surfaces with backdrop-filter over a photograph area can cause the browser to promote a compositing layer that masks the true image size. The plan says glass lands only where chrome floats. But the Global View contact sheet refinement and picker edit-mode could introduce glass backgrounds behind thumbnails. Add an explicit rule to the plan's guardrails: "No glass surface may be an ancestor of or sibling-behind an `<img>` element; glass is only on control chrome, scrims, and sheets that do not contain photographs." And add a Playwright assertion that `.viewer-frame img` and `.native-global-cell img` have no `backdrop-filter` ancestor within 3 levels. This is enforceable and cheap.

## Change before implementation (ordered by owning phase)

1. **G0**: Replace `check_code`/Meniscus/hig-mcp references with a real, implementable gate: a `scripts/check-glass.sh` (or a vitest/playwright lint) that enforces blur budgets, `@supports` fallback presence, no `lens-on-lens` (glass inside glass), and `prefers-reduced-transparency` override. Cite HIG URLs for the numbers. (G0 owns it; everything else depends on it.)
2. **G0**: Fix the desktop gating error: desktop frost gates on `html.macos-shell` / `body.manorama-desktop`, not `data-macos-glass`. Update the selector list in G1's `app/styles.css` bullet accordingly.
3. **G0**: Define the token naming (`--glass-*`) and the light/dark override mechanism (`html.light` + `.m-dark`), matching the existing `--m-*` convention. Specify the `packages/core` data shape (plain TS object).
4. **G0**: Resolve the blur budget conflict: per-surface-type table, with Global View's 120px either exempted (full-screen dim) or reduced. Document the visual-change impact and require before/after captures.
5. **G1**: Add G1.0 spike (Library capsule only on iOS, real device) before G1b. Define the iOS cluster expand trigger (tap-to-expand recommended) and the touch keep-alive ping.
6. **G2**: Split into G2a/G2b/G2c with disjoint CSS section ownership; land a "gating + token plumbing" PR first.
7. **G4**: Mark Duo evidence as real-device-only; clarify whether glass applies to spread-mode diptych chrome. Confirm #33 (diptych geometry) is a prerequisite or out of scope.
8. **G5**: Define degradation threshold (frame time >20ms for 3s → disable bend for session); state that bend applies only to text-free chrome; add JS fallback for fold media query.
9. **All**: Add the "no glass ancestor of an image" rule + Playwright assertion.
10. **G6**: Align evidence gates with the simulator's Duo limitation; label sim captures as geometry-only.

## Hypotheses (not confirmed here)

- The plan assumes iOS 26+ runtime provides `.glassEffect(.regular.interactive())` with the same API shape as macOS 26. I did not verify the iOS 26 SwiftUI glass API; the iOS SDK in the tree is 27.1. If the API differs (e.g., `.glassEffect` is macOS-only and iOS uses `UIGlassEffect`), G1's `GlassChromeView` needs a UIKit rewrite, not a port. Check `UIGlassEffect.h` in the iOS 26 SDK headers before committing to the SwiftUI overlay approach.
- The plan assumes Android's Chromium WebView supports SVG `feDisplacementMap` at 60fps. I did not measure. The degradation threshold (change 8) covers this, but the default-on decision should wait for measurement.
- The plan assumes `body.manorama-native` is set early enough for CSS gating to apply on first paint. `native/main.tsx:13` runs at module load, which is after `<head>` CSS is parsed but before first paint in most cases. Verify no FOUC of un-glass styles; if FOUC occurs, move the class to `index.html` body or set it in a blocking inline script.

## Could not verify

- Whether `hig-mcp` or `Meniscus` exist as external MCP servers the owner has access to. If they do, the plan should name them as external dependencies with setup instructions, not as if they are repo tools. If they don't, the plan must define them.
- Whether `#33` (diptych geometry) is complete enough to support glass dressing on spread-mode chrome. Did not read #33's implementation status.
- Real-device Duo behavior: no device available in this environment.

## What runs

- `grep` across repo (excluding node_modules/.worktrees) for `check_code`, `meniscus`, `Meniscus`, `hig-mcp`, `hig_mcp`: zero hits. Confirms the three tools are not in-repo.
- `grep` for `data-macos-glass` in source (excluding dist/build): only `macos/ManoramaMac/ViewerWebView.swift:277` and `:319`. Confirms desktop does not stamp it.
- `grep` for `data-ios-glass`, `data-android-glass`, `data-shell-glass`: zero hits. Confirms none exist yet.
- `grep` for `html.macos-shell` / `body.manorama-desktop`: `app/styles.css` (multiple rules). Confirms desktop gating convention.
- Read `native/main.tsx:13`: `document.body.classList.add('manorama-native')`. Confirms Capacitor shell marker.
- Read built CSS: `.native-global-view` uses `blur(120px)`. Confirms blur-budget conflict.
- Read `macos/ManoramaMac/ContentView.swift:48-50, 57-58, 88-106, 116-120`: cluster expand on hover, ZStack sibling overlay, `#available(macOS 26.0, *)`. Confirms iOS hover/touch gaps.
- Read `macos/ManoramaMac/AppModel.swift:241-259`: `invokeWebControl` (JSONEncoder) and `keepViewerChromeAlive`. Confirms reuse targets.
- Read `ios/App/App/SceneDelegate.swift` (full): reserved regions, `data` injection, `didUpdateEffectiveGeometry`. Confirms Duo plumbing exists.
- Read `native/lib/fold.ts` (full): fold runtime adapter. Confirms scaling of native frames.
- Read `packages/core/fold.ts` (first 60 lines): platform-free fold model. Confirms invariant 8 compliance.
- `git log --oneline -15`: confirms baseline b5d2c6e, PR #222 (macOS glass) merged.

No code was changed by this review. No tests were run (review-only task).
