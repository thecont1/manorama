# iOS Liquid Glass renewal — proposed plan

Date: 2026-11-19. Status: proposed, not implemented for iOS. The macOS-side interaction contract named in §3 has landed on `fix/macos-glass-interaction` (bounded `activateControl`/`setChromeActive`/`focusStage` calls, `chrome-layout` seating, the travelling `SheetGlassSurface` retired). Physical interaction validation remains incomplete.

## Direction

**A photographic Library with a native, fluid control layer.** The photographs supply the personality; glass supplies depth, touch feedback and continuity. This is not a request to coat the entire interface in translucent cards.

The user withdrew the proposed mandatory image-left/text-right rows. There is no fixed row or two-column requirement. Choose gallery density from the available reading space, while preserving the separate pinned-gallery strips and the photo-picker/Global View matrix.

The newer request for expressive Liquid Glass supersedes the old flat-only aesthetic for native controls. It does not supersede photographic integrity, quiet viewing, accessibility, or the repository invariants.

## What was actually inspected

- Built the current working tree using the normal production API, Capacitor iOS sync and Xcode 27.1. The build succeeded and was installed over the existing app without uninstalling or resetting its data.
- Physical device: iPhone 16 Plus, iOS 27.0.1; captures are 1290×2796 pixels, corresponding to 430×932 points. The device reports Light appearance, Large text, and Reduce Motion, Reduce Transparency and Increase Contrast off. No system appearance settings were changed.
- This is the current local review tree based on `853d580`, including uncommitted shared/macOS work; it is not an App Store release or a clean-main comparison.
- Reviewed the fresh [signed-in Library capture](file:///Users/home/DEV/tools/manorama/demo-captures/device-iphone/2026-11-19-liquid-glass-audit/01-fresh-launch.png). It shows two narrow columns, wrapped titles and several lines of provider/count/storage metadata. The capture is scrolled; it does not establish the initial landing position.
- Opened the documented public gallery through its normal deep-link path and reviewed the [gallery curtain](file:///Users/home/DEV/tools/manorama/demo-captures/device-iphone/2026-11-19-liquid-glass-audit/04-after-keyboard.png). Its Library control is native glass, visibly a separate grey capsule. This still image is not evidence of animation quality.
- Device Hub's background window is exposed as a tiny Stage Manager thumbnail and does not expose the phone's controls in its accessibility tree. A background Space key did not dismiss the curtain. Reliable tapping, swiping, press feedback, Settings, Info and picker transitions have **not** been verified.
- No Duo simulator is listed as available in the installed iOS 27.1 runtime. Duo conclusions below are code/guidance findings, not physical-device observations. Historical blank-simulator notes are not a substitute for testing a future working runtime.

The audit made no iOS design implementation changes. No account/provider settings, gallery content, purchases or posting actions were changed.

## Why the current design falls short

| Priority | Finding | Evidence and consequence |
| --- | --- | --- |
| P1 | Native glass is deliberately prevented from behaving as a group. | [GlassOverlay.swift:391](file:///Users/home/DEV/tools/manorama/ios/App/App/GlassOverlay.swift#L391) specifies always-separated capsules and omits `GlassEffectContainer`. The controls can react individually, but cannot communicate a shared material identity. |
| P1 | A permanent dark backing limits material adaptation. | [GlassOverlay.swift:377](file:///Users/home/DEV/tools/manorama/ios/App/App/GlassOverlay.swift#L377) and [GlassOverlay.swift:431](file:///Users/home/DEV/tools/manorama/ios/App/App/GlassOverlay.swift#L431) put 28% black behind clear glass and fix the foreground colour. Clear glass is appropriate over media, but Apple does not recommend adding dimming indiscriminately over already-dark content. |
| P1 | The sheet transition has two independent visual owners. | [GlassOverlay.swift:465](file:///Users/home/DEV/tools/manorama/ios/App/App/GlassOverlay.swift#L465) sends a native glass shape across the web sheet while that sheet animates separately. The native shape sits above web text, then fades away; this is not a true shared-material transition. A visible flash remains a hypothesis until a physical transition is captured. |
| P1 | Library density is driven by a low width threshold rather than comfortable reading. | The physical Library capture matches [native/styles.css:926](file:///Users/home/DEV/tools/manorama/native/styles.css#L926): two columns at a 380px container, three at 700px. [GalleryList.tsx:1783](file:///Users/home/DEV/tools/manorama/native/islands/GalleryList.tsx#L1783) stacks substantial metadata under each cover. Merely changing the column count would leave the information hierarchy unresolved. |
| P1 | Duo's native control geometry is incomplete. | [SceneDelegate.swift:205](file:///Users/home/DEV/tools/manorama/ios/App/App/SceneDelegate.swift#L205) reports `verticalBarEdge` to JavaScript, while [GlassOverlay.swift:277](file:///Users/home/DEV/tools/manorama/ios/App/App/GlassOverlay.swift#L277) still seats the native cluster horizontally at the bottom. Its widest-gap calculation at line 327 projects every reserved rectangle onto the x-axis, without checking intersection with the control's vertical band. |
| P2 | Documentation overstates material and test parity. | [liquid-glass-design-system.md:16](file:///Users/home/DEV/tools/manorama/docs/liquid-glass-design-system.md#L16) describes regular interactive native glass, but the iOS implementation uses clear glass with dark backing. Existing CSS and browser checks do not prove native press behaviour, hit testing or compositing. |

## 1. Redesign the Library composition, not just its grid

### Proposed browsing pattern

Use **unboxed, image-led gallery previews**. Keep the gallery title directly associated with its cover and make that the strongest non-photographic element. Keep only a concise photograph/video count and an actionable state in the default reading path. A caption is secondary; omit its space when absent. Provider, hidden-image counts and storage-policy detail belong in the existing gallery details/settings rather than repeating beneath every cover. Expiry, unavailable/offline states and failures must remain visible when they affect what the person can do.

Keep pinned galleries as generous horizontal photographic strips. They already give the Library a distinctive browsing rhythm and their pin/retention semantics must not change. Compact Cloud, Saved and Hidden galleries use a consistent preview hierarchy. Local/device mirrors must not imply that a remote device's image bytes are present; preserve their actual availability state.

For compact previews, start with a minimum comfortable item width around 240–280 points, then tune using real titles and Dynamic Type. At the tested phone width that is likely to yield one spacious preview per row, with the image above its title—not a mandatory thumbnail-and-text table. On a sufficiently wide Duo content pane, two previews can sit alongside each other. At accessibility sizes, let density reduce naturally. Never add a column simply because the device is labelled “Duo”.

Keep covers at honest sizes within a bounded preview area, initially around 140–180 points high where the source permits it. Portrait and landscape images keep their proportions and square corners; short sources remain smaller. Do not fetch or cache oversized media just to fill an ornamental box. Use calm spacing between galleries, not borders, shadows or a glass card around each one.

### Library controls and hierarchy

- Give Library a compact, consistent native navigation/control group. Keep Add Gallery and Settings readily reachable; put secondary maintenance in the existing action path instead of making every item prominent.
- Consolidate plan/storage/account information into a quiet account summary linked to Settings. Keep relevant limits and errors explicit; do not remove or relocate the account advertising slot without separately checking its existing policy.
- Retain one gallery action menu. Quick actions are Level 0; Gallery Settings is the final Level 1, not another intermediary submenu.
- Preserve the exact gallery and scroll position after closing a viewer or a settings surface.
- Keep Bricolage Grotesque for application titles and content. Use semantic, Dynamic-Type-aware system typography for native controls, not fixed 15pt text masquerading as Dynamic Type.

Before implementing the layout, compare two measured compositions with the same real, authorized covers: the recommended roomy folio layout and a restrained two-column layout with reduced metadata. Judge title readability, first useful gallery visibility, scan effort and large-text reflow—not how many boxes fit. This comparison is a design gate, not a request for another user decision.

## 2. Give native controls a coherent material language

Use regular system Liquid Glass as the default for Library/navigation and text-heavy transient UI. Prototype regular glass for the viewer control group first: it handles mixed letterbox/photo backgrounds and aligns with the requested luminous feel. Retain clear glass only where the actual media backdrop and contrast evidence justify it. Do not hard-code white/blue coloration; let the system derive it from content and the user's glass preference.

Remove the unconditional black backing from the normal material path. Apple explicitly allows dimming behind clear glass on bright media, so “no dimming ever” is not the rule either. Prefer the regular variant over introducing a new per-frame image-luminance pipeline merely to rescue clear-glass readability.

Place Picker, Settings and Info in one `GlassEffectContainer`, with stable identities. Give the group a close, coherent silhouette at rest and let the pressed control deform/highlight using native interaction. Preserve distinct, non-overlapping targets of at least 44×44 points. On touch, do **not** port the Mac's hover separation literally: controls must not move away from the finger or require a first tap just to reveal the real targets. Support keyboard/pointer focus without making it the primary interaction model.

Chrome still appears on intent and disappears after the existing idle interval. A held finger, focus, open presentation or assistive interaction must keep the necessary controls available. No idle wobble, shimmer or decorative movement.

## 3. Make every transition have one owner

Remove the travelling `SheetGlassSurface` overlay rather than polishing a disconnected imitation. A native material must never briefly cover web text during handoff.

Introduce native presentation for the small, high-frequency viewer panels first: display controls and photo Info. Present SwiftUI/UIKit content with its material under the same native owner, using standard sheets/popovers and dismissal behaviour. Keep the current presentation while settings/actions are acknowledged; use stable source identity for a supported native transition. If a native source-to-presentation morph is not supported by the selected system component, use its standard transition—not a separate animated rectangle.

Keep complex owner forms and the photograph picker in their current content implementation initially. Their surfaces should be quiet, legible standard/solid material with coherent spacing, not falsely labelled native glass. One web-owned sheet is better than two competing owners. Convert additional panels only when their behaviour can be preserved without duplicating business logic.

Replace selector-driven action dispatch and synthetic pointer keep-alives with a small explicit native/web contract for chrome state, allowed action IDs, presentation state and interaction activity. Include main-frame/trusted-document validation, bounded payload validation, navigation generation handling, cancellation and teardown. Never send vault keys, session tokens or unnecessary image bytes through this UI contract.

Keep the application and gallery business state in its current owners. The bridge carries UI commands and necessary view state, not a second implementation of account, retention or provider rules. Hide web controls only after the native replacement is ready; failure or an older OS must leave a usable web control. The web app receives neither native persistence nor the new native presentation layer.

## 4. Adapt to Duo using system geometry, not pose-specific skins

Follow Apple's current Duo HIG: compact outer and regular inner size classes, continuous resizing, stable hierarchy and state, and standard toolbar adaptation. Do not invent a different app for each fold pose.

- Consume `verticalBarEdge` in the native control owner. Prefer standard grouped toolbar/navigation APIs where they can coexist with the immersive viewer; custom overlay placement must match the system's leading/trailing edge and safe regions.
- Put Back/Close at the navigation end of the vertical axis, retain coherent groups, and use system overflow for secondary actions rather than shrinking essential targets.
- Filter occlusions/divisions by intersection with each control's **actual measured bounds**, including Dynamic Type and hit target padding. A camera cutout near the top must not unnecessarily shift bottom controls.
- Clamp and validate geometry in one coordinate system. Preserve synchronous reserved-region reads in `updateConstraints()` and reliable replay after document replacement.
- Keep the current photograph, selected mode, picker selection, Library scroll and unsaved form draft through resize/fold/unfold transitions. Reposition only affected UI.
- Retain the existing photographic spread/diptych behaviour. Native controls avoid active fold/camera/bar regions without changing source aspect ratios or introducing crops.
- Library previews adapt to their usable content pane. Picker and Global View remain the vertically scrolling, equal-height, aspect-ratio-derived, zero-gap matrix with shocking-pink active selection; Apple's generic grid examples do not override this product invariant.

## 5. Accessibility and performance are part of the material

Test normal, Reduce Transparency, Reduce Motion, Increase Contrast, both appearances and the user's preferred glass treatment. Solid fallbacks must retain the same control hierarchy and sufficiently large targets. Do not add extra padding only to the fallback and unexpectedly move the controls.

Use semantic native foreground styles, Dynamic Type and VoiceOver labels/values. Announce the photograph position and return focus to the real native trigger after dismissal. Avoid duplicate accessible native/web controls. Test cancellation, rapid taps and a finger held through the idle interval; ensure the overlay's empty space does not swallow image swipes.

For remaining WKWebView UI, use flexible text containers and relative type sizing. Do not assume the new `meta text-scale` opt-in solves iOS Dynamic Type: the consulted guidance lists Safari as unsupported. Verify a public native-to-web text-scale integration or the existing supported WebKit mechanism on device, without double scaling.

Profile the real device at its supported refresh rate. The connected iPhone 16 Plus is not evidence of 120Hz operation on other phones. Capture frame timings, hitches, memory and energy while scrolling the Library, opening the picker and repeatedly presenting panels. Compare against the current build with the same gallery and cache state. Use public Instruments/Core Animation tooling; no private frame-rate switches. No per-thumbnail glass and no new image copies for decorative effects.

## Implementation order and gates

1. **Close the physical interaction evidence gap.** Establish a supported, reliable phone-input path; capture the current viewer controls, Settings, Info, picker, Library settings and Global View. Do not change Mac foreground state or enable global keyboard capture implicitly. Record still states and measured timings; recording video needs separate authorization.
2. **Library design prototype.** Compare the two compositions, choose density from evidence, and implement only the selected composition with existing metadata and media loaders. Preserve pinned/retention/tier behaviour. Test long titles, missing captions/covers, mixed aspect ratios, small source bitmaps, loading, offline and unavailable states.
3. **Native glass vertical slice.** Implement one coherent viewer control group plus one fully native display presentation. Remove its duplicate web/native transition. Verify material, hit testing, focus and contrast on dark, bright and high-detail photographs before expanding the treatment.
4. **Complete the interaction contract and presentation family.** Add Info and Library controls, consistent navigation/dismissal, and quiet owner sheets. No unrelated business-logic or provider changes.
5. **Duo integration.** Adapt the same native control owner to real system geometry and preserve state through display changes. Browser geometry checks may proceed before hardware, but cannot clear the native Duo gate.
6. **Regression, accessibility and documentation.** Update the actual design reference and verification claims to match what ships. Deliver fresh captures and independent review before declaring completion.

Each implementation issue gets its own branch/PR from the agreed base. The existing uncommitted macOS work must be reconciled first, not silently folded into an iOS redesign commit.

## Verification contract

Existing coverage to extend:

- [native/lib/fold.test.ts](file:///Users/home/DEV/tools/manorama/native/lib/fold.test.ts): native geometry parsing and reserved-region handling.
- [ViewerChrome.test.tsx](file:///Users/home/DEV/tools/manorama/app/components/viewer/ViewerChrome.test.tsx): control availability in vertical layouts.
- [GalleryList.account.test.tsx](file:///Users/home/DEV/tools/manorama/native/islands/GalleryList.account.test.tsx): pinned/compact/hidden partitions and account behaviour.
- [native-vault-controls.playwright.ts](file:///Users/home/DEV/tools/manorama/specs/native-vault-controls.playwright.ts): honest compact covers and early picker availability.
- [duo-spread.playwright.ts:245](file:///Users/home/DEV/tools/manorama/specs/duo-spread.playwright.ts#L245): picker, Library/draft containment and photographic geometry across injected layouts.
- [GlobalView.test.tsx](file:///Users/home/DEV/tools/manorama/native/islands/GlobalView.test.tsx) and [global-view.playwright.ts](file:///Users/home/DEV/tools/manorama/native/global-view.playwright.ts): tier scope, vault-backed frames and selection.
- [scripts/check-glass.test.ts](file:///Users/home/DEV/tools/manorama/scripts/check-glass.test.ts), [glass-freeze.playwright.ts](file:///Users/home/DEV/tools/manorama/specs/glass-freeze.playwright.ts) and [glass-frost.playwright.ts](file:///Users/home/DEV/tools/manorama/specs/glass-frost.playwright.ts): web invariants, gates and fallback contrast.

Add direct iOS-native coverage for material configuration, bridge navigation lifecycle, control hit rectangles, assistive focus, held-touch/cancel behaviour and presentation ownership. Browser tests alone cannot prove these.

Required before implementation is called complete:

- `bunx tsc --noEmit`, `bun run test:unit`, the applicable full viewer Playwright matrix and both native build checks pass. The previously observed local-source unit failure and unclassified broader viewer failures remain baseline blockers; focused green checks do not replace these gates.
- Text reaches 4.5:1 on the rendered backdrop, touch targets remain at least 44×44 points, and maximum accessibility text does not clip actions or hide state.
- Fast repeated activation causes one action per activation, no leaked sheets/timers and no missing or double chrome after navigation.
- Native overlay gaps pass gestures through; gallery swipes, zoom/video behaviour and advertisement click-safety remain intact.
- Photograph bytes, ICC/C2PA content, aspect ratio, honest dimensions, vault privacy and source-provider immutability are unchanged.
- Fresh six-state evidence covers iPhone, iPad landscape at 2752×2064 and macOS: opening, curtain, first photograph with controls, display settings, signed-in account/admin, Global View or the documented desktop selector. Shared changes must not regress macOS.
- Duo gets real native evidence across compact/regular displays, landscape vertical bars, active camera/fold regions and state-preserving transitions. If hardware/runtime is unavailable, the Duo claim stays explicitly unverified.

## Guidance used

- [Apple HIG: Materials](https://developer.apple.com/design/human-interface-guidelines/materials.md): Liquid Glass is the functional control/navigation layer; regular glass adapts for legibility; clear glass suits rich media, with dimming only when needed.
- [Apple HIG: Designing for iPhone Duo](https://developer.apple.com/design/human-interface-guidelines/designing-for-iphone-duo.md): adapt existing iOS hierarchy and controls to size classes, system bars and reserved regions; preserve functionality and state between displays.
- Modern Web Guidance `responsive-design`, `css-layout`, `form-factor-adaptation` and `respect-os-text-scale`: container-led composition, intrinsic media sizing, non-overlapping touch targets, unclipped text and explicit Safari text-scale limitations. These informed this plan; no CSS change is claimed.
