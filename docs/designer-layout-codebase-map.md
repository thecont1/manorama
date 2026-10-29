# manorama iPhone layout inventory and codebase map

This document is meant for a designer reviewing the current iPhone app with the explicit goal of simplification. It describes what appears in the supplied screenshots, identifies the main interaction patterns and visual tensions, and maps each visible area to the most likely parts of the codebase.

## Purpose

The current app presents itself as a photography-first gallery viewer, but the screenshots show several competing identities at once: a gallery product, an account dashboard, a paywall, a settings sheet, and a gallery-management tool. That is useful context for redesign because the interface problem is not only typography or spacing; it is also structural density.

The screenshots suggest a future redesign should decide much more aggressively what belongs in the primary flow, what should move into secondary sheets, and what should become progressive disclosure.

## What is visible in the screenshots

### 1. Entry and sign-in screen

Observed in the screen with the large manorama logo, tagline text, and three sign-in choices.

Visible elements:
- Large multicolour `manorama.xyz` wordmark on a black background.
- Tagline text: “adj. a view that is delightful to the mind. Also, the WOW-est way to enjoy a photo gallery with anyone!”
- Section label: `CONTINUE WITH`.
- Three large authentication choices: Apple, Dropbox, Google Drive.
- Footer links/text: Privacy Policy and copyright attribution.

Design reading:
- This screen is brand-heavy and sparse.
- It feels distinct from the rest of the product, which becomes denser, more utilitarian, and more form-driven.
- The designer should treat this as one end of the current spectrum: theatrical intro / low information density.

Likely code locations:
- Authentication entry UI, probably in `app/routes` and shared components in `app/components`.
- Supporting product copy is also echoed in App Store review notes and submission docs.
- Verified shipped copy: `Continue with` renders in `app/lib/signin.tsx` (the `signin-lead` lead-in before provider buttons), `app/quickadd.ts` (the "Continue with Dropbox/Google" link labels), and `native/islands/GalleryList.tsx` (the same `signin-lead` plus `Continue with {provider}` aria-labels on the sign-in buttons).

### 2. Home / account / gallery list screen

Observed in the screens showing:
- owner path input `manorama.xyz/vidya-rao-2`
- greeting to `Vidya Rao`
- free-tier status
- add-gallery form
- list of existing galleries
- thumbnail card with row actions
- a floating hamburger/menu button
- in one version, a sponsored card above the account area

Visible elements:
- Brand logo at top.
- Hamburger menu button in a circular outline at top right.
- Optional sponsored/promotional block near the top.
- Owner/account path field.
- Greeting and free-tier usage message.
- `Add a gallery` heading.
- URL input with placeholder `Paste a public folder or album link`.
- Primary CTA button: `Manorama-fy it!`
- `Your galleries` heading.
- Gallery card for `cinder-fen-fall` with `(58 items)` count.
- Caption affordance: `Add a caption`.
- Canonical gallery URL.
- Large thumbnail preview.
- Action row with icon buttons, including a destructive delete action.

Design reading:
- This is the busiest screen in the current set.
- It mixes account state, publishing workflow, monetization, navigation, content management, and gallery preview in one continuous scroll.
- The gallery card itself contains both descriptive information and a toolbelt.
- The hierarchy is visually heavy at several levels at once: giant `Your galleries`, large gallery title, large preview image, prominent buttons, and promotional card.
- This is probably the strongest candidate for aggressive simplification and regrouping.

Likely code locations:
- Gallery/account dashboard pages are likely under `app/routes`.
- Reusable gallery card and icon-button components are likely in `app/components`.
- The `Add a caption` string appears in `native-vault-controls.playwright.ts`, indicating the gallery card caption row exists in native/web-tested UI.
- The `Manorama-fy it!` label is explicitly referenced in `capture-harness.playwright.ts`.

### 3. Gallery splash / title screen

Observed in the screen with a black background, centered logo, and the gallery title `cinder-fen-fall`.

Visible elements:
- Brand logo, much smaller than on the sign-in screen but still dominant.
- Large centered gallery title.
- No obvious secondary controls on screen.

Design reading:
- This appears to be a transitional stage before entering the viewer.
- It gives the gallery a ceremonial opening, but it also inserts another branded layer before content.
- A designer may want to question whether this is necessary, whether it should be shortened, or whether title/context could be integrated directly into the viewer shell.

Likely code locations:
- Viewer route or opening state in `app/routes`.
- Potential native wrapper or island component in `app/islands`, `native/islands`, or `desktop/islands` if the splash is animated or staged differently by platform.
- Technical behaviour is described in `TECH-SPEC.md`, which references a quiet stage and a brand pill leading into display settings.

### 4. Main photo viewer: horizontal strip

Observed in the long scrolling/continuous image screens, including:
- a feed of large photographs stacked vertically within the screenshot, but described elsewhere as `Horizontal Strip`
- dark canvas around the images
- oversized images shown nearly edge to edge
- occasional overlaid brand pill
- very limited visible chrome

Visible elements:
- Photographs dominate the viewport.
- Black or near-black background.
- Minimal control chrome during viewing.
- One screenshot shows a pill-shaped manorama logo overlay on top of an image.
- Another screenshot shows a close button and a split/comparison-like arrangement, suggesting a different viewer state or a collage/reorder-related presentation.

Design reading:
- This is the purest articulation of the app’s core promise: let the photographs carry the experience.
- It is also the least visually cluttered part of the app.
- The strongest redesign lesson may be that this viewer state already contains the clearest product philosophy.
- If the product is to become more “Swiss” and minimal, the rest of the app may need to borrow its restraint from here.

Likely code locations:
- Viewer rendering logic likely spans route-level code plus a gallery-view component, probably in `app/routes`, `app/components`, and platform-specific mirrors in `native/` or `desktop/`.
- The exact label `Horizontal Strip` appears in automation tests, which confirms a display mode selector exists in tested UI.
- `TECH-SPEC.md` also describes the viewer as a photo-first stage and references the brand pill opening display settings.

### 5. Display settings sheet / dialog

Observed in the screens titled `Display settings`, including both a cropped version and a longer scrolled version.

Visible elements:
- Small brand logo at top.
- Gallery title in lowercase with generous letter spacing: `cinder fen fall`.
- Title `Display settings`.
- Close button (`X`) at top right.
- Back button: `Back to your galleries`.
- Section `On this device` with option `Don’t download this gallery`.
- Explanatory body copy.
- Download progress indicator.
- Section `View mode` with large stacked choices:
  - `Horizontal Strip`
  - `Vertical scroll`
  - `One at a time`
- Section `Background` with large stacked choices:
  - `None`
  - `Dark`
  - `Light`
- Additional action buttons:
  - `Show navigation arrows`
  - `Enter fullscreen`
- Footer text including privacy policy and copyright.

Design reading:
- This screen bundles together navigation, device-storage behavior, presentation mode, background theme, control visibility, and fullscreen.
- The controls are clear individually, but the sheet is very long and visually repetitive because many options share the same large button-card treatment.
- The result is cognitively heavier than the viewer itself.
- A designer may want to separate “how photos are shown” from “device/offline behavior” and from “app/legal controls.”

Likely code locations:
- Strongly evidenced by `native-vault-controls.playwright.ts`, which locates a dialog named `Display settings` and targets `Don’t download this gallery`.
- Also referenced in `capture-harness.playwright.ts`.
- UI implementation is likely shared in app/native components, possibly with a dialog/sheet component and setting-option cards.

### 6. Information / subscription / photo-picker sheet

Observed in the screen that starts with the logo and descriptive copy, and includes `View subscription options`, `How galleries load`, and `Photo picker`.

Visible elements:
- Logo and close button.
- Short product explanation and current account path (`Vidya Rao · manorama.xyz/vidya-rao-2`).
- Prominent button: `View subscription options`.
- Section `How galleries load`.
- Explanation text about opening an online gallery.
- A selection control showing `Download to encrypted vault (default)`.
- Explanatory text about vault copies and streaming.
- Section `Photo picker`.
- Checkbox or toggle-like control for preparing on-device photos.
- Explanatory text about encryption and local device storage.
- Button: `Open photo picker`.

Design reading:
- This screen mixes help text, monetization, storage policy, and a device capability feature.
- It reads partly like onboarding, partly like settings, and partly like a product explainer.
- The prose load is high relative to the rest of the app.
- This is another strong candidate for decomposition into smaller, more purpose-specific screens or disclosure panels.

Likely code locations:
- The `View subscription options` string is referenced in submission docs, showing it is a real surfaced action and significant enough for app review.
- `Open photo picker` and related device-local behavior are likely implemented in native-capable code paths, potentially spanning `native/`, `ios/`, and shared UI in `app/components` or `app/routes`.

### 7. Reorder screen

Observed in the `Reorder cinder-fen-fall` screen.

Visible elements:
- Large title: `Reorder cinder-fen-fall`.
- Instructional subhead: tap a photograph to pick it up, then tap where it belongs.
- Status line: `Moved “09a” to position 7 of 58.`
- Dense mosaic/grid of images in mixed sizes.
- Bottom action buttons: `Save order` and `Discard changes`.
- Close button at top right.

Design reading:
- This is an explicitly task-oriented utility screen.
- Compared with the viewer, it is much more tool-like and operational.
- The image grid is information-dense and necessarily so, but the surrounding chrome could likely be simplified further.
- The verbal instruction model suggests this flow may benefit from more obvious state change design rather than copy-heavy guidance.

Likely code locations:
- Reorder behaviour is likely a dedicated route/component in `app/routes` plus drag/resequence utilities in shared logic.
- The gallery management card on the home screen likely links here.
- If there is platform-specific touch behavior, related code may also appear in `native/` or `desktop/` mirrors.

## Emerging structure from the screenshots

Across the screenshots, the product appears to have at least six functional layers:

1. Brand/sign-in.
2. Account and gallery administration.
3. Gallery creation/import.
4. Gallery viewing.
5. Gallery display/settings.
6. Advanced gallery management such as reorder, captioning, copy/open/delete, and device-local controls.

That matters because the current visual complexity may reflect a product-model complexity rather than a purely visual-design failure. The redesign should therefore evaluate not only spacing, type, and controls, but also whether these layers should remain adjacent.

## Codebase areas to inspect first

The repository structure suggests a shared app with multiple platform targets.

### Highest-priority directories

| Area | Why it matters |
|---|---|
| `app/routes` | Most likely location for page/screen-level composition. |
| `app/components` | Most likely location for reusable UI blocks such as gallery cards, buttons, sheets, and viewer controls. |
| `app/islands` | Likely location for interactive client-side islands if the app uses partial hydration or interactive slices. |
| `native/` | Likely native-specific implementations or wrappers for device behavior, vault logic, picker integration, and native viewer polish. |
| `desktop/` | Useful if some UI ideas are mirrored from desktop and then adapted to mobile. |
| `ios/` | Native shell/integration layer; relevant mainly for device capability hooks rather than layout design. |
| `TECH-SPEC.md` | Important narrative description of intended product behavior and screen philosophy. |
| Playwright files | Valuable as a UI inventory because tests often reveal stable labels, dialogs, and intended flows even before reading all source. |

### Most relevant files already evidenced by text matches

| File | Why it is relevant |
|---|---|
| `native-vault-controls.playwright.ts` | Confirms `Display settings`, `Don’t download this gallery`, and `Add a caption`. |
| `capture-harness.playwright.ts` | Confirms `Manorama-fy it!` and the display-settings dialog flow. |
| `TECH-SPEC.md` | Describes the staged viewer and brand pill behaviour. |
| `submission/02-app-review-notes.md` | Gives a plain-language walkthrough of first screen, sign-in, gallery opening, and viewer intent. |
| `submission/01-app-store-listing.md` and `submission/06-app-store-connect-fields.md` | Confirm `View subscription options` as a visible and important action. |

## Probable screen-to-code mapping

This mapping is intentionally pragmatic rather than exhaustive. It is meant to help a designer talk to engineering about specific surfaces.

| Screen / layout area | Likely code home | Notes for designer |
|---|---|---|
| Sign-in / intro screen | `app/routes` + auth-related components in `app/components` | Brand-first, sparse, likely one self-contained route or state. |
| Account home / gallery list | `app/routes` + gallery card, input, menu, and CTA components in `app/components` | Highest-density page; probably worth redesigning first. |
| Sponsored/promo block | `app/components` and monetization/subscription logic | Should be treated separately from gallery-management hierarchy. |
| Gallery creation form | `app/components` and route state in `app/routes` | Includes owner/link input and primary CTA. |
| Gallery card actions | `app/components` | Likely contains reorder, duplicate/copy, open/share, refresh, delete actions. |
| Viewer shell | `app/routes`, `app/components`, maybe `app/islands` | Core photography experience; likely the conceptual anchor for redesign. |
| Display settings dialog | `app/components` or route-adjacent dialog component; tested in Playwright | Strong candidate for splitting into smaller groups. |
| Info/subscription/photo-picker sheet | Shared modal/sheet components + native integration | Currently overloaded with explanation and feature policy. |
| Reorder interface | Dedicated route/component + reorder logic utilities | Utility-heavy screen; designer should focus on task clarity. |
| Native vault / device toggles | `native/` plus shared UI | Important when deciding which settings are truly first-class in layout. |

## Specific design tensions visible now

### Product identity tension

The app alternates between:
- a poetic photography object,
- a publishing tool,
- a cloud-import utility,
- a subscription product,
- and a gallery-management admin panel.

A redesign should decide which identity leads and which ones recede.

### Hierarchy tension

Several screens use large, high-emphasis treatments for many different things at once: logo, headings, buttons, previews, and cards. This reduces calmness and makes it harder to see the single primary action.

### Sheet overload

At least two overlay-style surfaces (`Display settings` and the info/subscription/photo-picker sheet) combine unrelated settings and explanation. They are likely functionally accurate but visually and cognitively long.

### Viewer versus admin mismatch

The viewer is close to the stated product ideal: dark canvas, image-first, almost no chrome. The account, settings, and gallery-management surfaces are much more verbose and operational. That gap may be the core redesign problem.

## Suggested handoff approach for the designer

When reading the codebase, the designer should start from the following order:

1. Identify the route/component for the account home screen.
2. Identify the gallery card component and all of its actions.
3. Identify the viewer shell component.
4. Identify the display-settings dialog component.
5. Identify the subscription/info/photo-picker sheet.
6. Identify the reorder route/component.
7. Only after that, inspect native/offline implementation details.

This order mirrors the visible complexity in the screenshots and should make it easier to separate primary layout questions from platform-implementation questions.

## A simple framing for redesign conversations

A useful way to frame the redesign may be:

- **Primary surface:** viewing photographs.
- **Secondary surface:** opening and choosing galleries.
- **Tertiary surface:** editing, reordering, captioning, storage behavior, subscriptions, and device-specific options.

If the redesign follows that principle consistently, the codebase can likely be reorganized around clearer UI layers as well.
