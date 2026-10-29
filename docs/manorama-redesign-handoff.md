# manorama redesign: handoff

Audience: the engineer or coding agent who will port the approved redesign into the manorama repository. You have not seen the design conversation. This document is everything you need to start. The companion file, `manorama-redesign-execution-plan.md`, says in what order to do it and how to know each step is done.

Status: this branch implements the P0–P2 slice — the contracts, tokens, theme, overlay primitives, and the navigation seam the later phases build on. Subsequent work should extend the completed discovery below, not repeat it.

Historical note: the design itself was approved by the product owner before implementation began.

> **Owner decisions, 28 Oct 2026 — superseding notes.** `docs/manorama-redesign-megaplan.md` is now the plan of record; where this document disagrees with it, the megaplan wins. Settled then: every surface in scope (not native-first — one coordinated release); both dark and light owner themes; temporary viewer chrome overlays allowed (arrows still reserve a 64px bar); Library sponsored slot is house-only with no live AdMob; iPhone folder/photo import deferred; UI runtime is Hono JSX; branches are `feat/iphone-redesign` (integration) + `feat/redesign-*` (PRs); the confirmed code map is megaplan §4, replacing the "likely home" guesses in §8 below. The open questions in §9 are answered. Inline corrections are marked "(28 Oct 2026)".

## 1. What exists

| Artifact | Where | What it is |
|---|---|---|
| Clickable prototype | `docs/redesign-prototype/` (open `index.html`; also deployed as "manorama redesign prototype") | Vanilla HTML, CSS and JS. The visual and behavioural reference. Not production code and not to be ported line by line. |
| Decisions record | `docs/manorama-redesign-decisions.md` | Every design decision, what moved where, the visual system, and a first code map. |
| This handoff | `docs/manorama-redesign-handoff.md` | The build brief. |
| Execution plan | `docs/manorama-redesign-execution-plan.md` | Stages, tasks, acceptance criteria. |
| Original brief and map | `docs/manorama-fresh-start-designer-brief.md`, `docs/manorama-one-page-design-direction-memo.md`, `docs/designer-layout-codebase-map.md` | Background. |
| Technical contract | `TECH-SPEC.md` | The behaviour you must not break. The redesign is bound by it except where section 6 lists a deliberate change. |

The prototype runs without a build step. To view it locally: `cd docs/redesign-prototype && python3 -m http.server 8000`, then open it at phone width (390 wide). The left rail in a wide window jumps to any screen. Add `#library`, `#viewer`, `#details`, `#reorder`, `#settings`, `#privacy` or `#welcome` to the address to land on a screen.

Not yet read by the author of this handoff: `Viewer.tsx`, `GalleryList.tsx`, `Admin.tsx`, `VaultSettings.tsx`, `Paywall.tsx` and the Playwright specs. The "likely home" column in section 8 comes from `TECH-SPEC.md` and the designer map, not from reading those files. Stage 0 of the plan is to confirm it. *(28 Oct 2026: done — the megaplan §4 is the confirmed map, based on source inspection.)*

## 2. Product philosophy (the owner's words, binding)

1. Photographs are sacred. Nothing sits on a photograph: no arrows, no buttons, no labels. *(28 Oct 2026 exception: temporary chrome overlays are allowed — top and bottom controls may overlay the photograph for three seconds after interaction, and the small position count remains. Arrows still reserve their own 64px bar below the photographs and never overlay one.)*
2. Photographs are never cropped, and never upscaled past their natural size.
3. Strip shows continuous images at their actual dimensions. A sufficiently hi-res image (2x the height of the screen) appears fit to height.
4. One by one is fit to width on a vertical screen and fit to height on a horizontal one. Changing photograph is a very quick fade out, then the next fades in.
5. In Strip, the arrows proceed one screen width at a time, except when the image ends earlier, in which case the strip proceeds to end exactly where the image ends (the existing `advanceStripByViewport` in `app/islands/Viewer.tsx`).
6. Content Credentials are verified for a single photograph, never in a batch.
7. One word per button where a button lives on a viewing surface.
8. Three layers, in this priority: Looking (viewer), Galleries (welcome, library, add, details), Upkeep (reorder, settings, Visionary). A visitor with a shared link sees only the first layer.

## 3. Visual system

Style: True-black flat app (taste-skill, seed 1740959148). *(28 Oct 2026: this is the dark owner theme; a light owner theme is also approved — palette in megaplan §5.1. Owner theme is independent of the viewer's Black/Dark/Light canvas.)*

| Token | Value | Use |
|---|---|---|
| Ground | `#0a0a0a` | Screens, viewer canvas |
| Surface | `#161616` | Panels, cards, sheets |
| Raised | `#262626` | Pressed, hovered, selected rows |
| Ink | `#f3f0e8` | Primary text, primary button fill |
| Secondary / meta | `#b8b4ab` / `#98948c` | Supporting text. Every tier must pass 4.5:1 on its surface. |
| Data hue | `#fc0fc0` | Only: progress (saving, plan usage, storage), the picked-up photograph in Reorder, moved positions. Never on buttons, tabs, navigation. |
| Negative | red used only for Remove gallery and Delete account | |
| Type | Bricolage Grotesque only, variable | Titles 28/700, sections 17/650, body 16, meta 13, tabular figures. DM Mono, Playfair and Great Vibes are removed. |
| Shapes | buttons and segmented controls are full pills; panels 14px radius; sheets 22px; photographs square | |
| Elevation | by lightness only; borders and shadows only on sheets and dialogs | |
| Touch | every target at least 44px | |
| Motion | feedback only (press, sheet rise, chrome fade). Honour `prefers-reduced-motion`. | |

The primary button is a cream pill with black text, one per screen.

Constants the prototype uses (CSS custom properties; copy the values):

| Constant | Value |
|---|---|
| Top bar height | 52px (`--bar-h`) |
| Logo box | 140 x 47px, horizontally centred in the bar, same x and y on every screen (measured x 125, y 16.5 at 390 wide) |
| Chrome auto-hide | 3 seconds |
| Arrow bar | 64px, below the photographs |
| Action row | 56px |
| Rail drag threshold | 6px before a drag captures; a tap below that still opens |
| Reorder cell height | default 88px; slider 56 to 248px |
| Add sheet | at most 50% of screen height, Add gallery pinned at its bottom edge |
| Curtain | frosted veil: backdrop blur 28px plus scrim; text fades in 0.35s, frost dissolves over 1.1s |
| One by one | fade out 90ms, fade in 160ms after decode |
| Back to start | 0.75s eased scroll (not a jump) |
| Library spacing | sponsored panel 24px under the status line, 40px above the first gallery (same as between galleries) |

## 4. Screens

### Welcome
Logo in the same 140 x 47 box as every other screen, centred lower as the opening focal point — not enlarged. *(28 Oct 2026: resolves the "large logo" versus fixed-size conflict in favour of the decisions record; megaplan §5.1.)* One sentence: "Your shared folders, shown properly." plus "Paste a Dropbox, Google Drive, iCloud or MEGA link and manorama turns it into a quiet, full-screen gallery at your own address." *(28 Oct 2026: "or pick a folder on this iPhone" removed — iPhone folder/photo import is deferred.)* Three full-width buttons, Apple first: Continue with Apple, Google, Dropbox. "Privacy policy" opens the in-app policy screen. No photographs before sign-in.

### Library
- Top bar: logo centred, Settings gear at the right.
- Title "Library" (28px) and an Add pill at the right.
- One status line under it, for example "cinder-fen-fall is saving to this iPhone, 9 of 13."
- Sponsored slot at the top, above every gallery: the existing account placement restyled — its own surface panel, a vertical photograph (fit to height) with a headline, one line, one link, using real house creative. Existing eligibility and the `/api/ads/visibility` master suppression still apply; the slot is never unconditional and there is no live AdMob path. *(28 Oct 2026)*
- Each gallery is a card: a full-bleed horizontal rail of every thumbnail at its own proportions, then name, "13 photographs · Dropbox · Saving 9 of 13", a magenta progress line while saving, the caption if there is one, and a ··· button.
- The rail pans by touch, trackpad or mouse drag. Tapping a thumbnail opens the viewer at that photograph through the curtain. Tapping elsewhere on the card opens the gallery at the first photograph.
- On-device (kept) galleries: thumbnails come from the vault, instant. While a gallery is still saving, each thumbnail switches to its local copy as it lands.
- Streamed galleries: the rail pans the same. Each thumbnail shows the existing placeholder, loads only when scrolled near view (IntersectionObserver), then fades in. Any optional locally derived colour comes from bytes already fetched — never another media fetch. Slower and patchier than on-device by design. *(28 Oct 2026)*
- The ··· menu: Share link, Gallery details, Reorder, Read the folder again, Remove (red, last).
- Pitfall found in the prototype: a CSS grid item defaults to `min-width: auto`, so a card grew to its thumbnails' full width and the rail had nothing to scroll. Fix: `min-width: 0` on the card and `minmax(0, 1fr)` on the column. Check the real layout for the same trap.

### Add a gallery (sheet)
A bottom sheet, at most half the screen, like the Display sheet. Fields: "Shared folder or album link" with a Paste button, and an optional Name. "Add gallery" is a single pill pinned to the bottom of the sheet, so long scan output never pushes it out of reach. *(28 Oct 2026: the "Choose a folder on this iPhone" / "Choose photographs" buttons and their "Originals stay encrypted…" line are deferred and omitted — no new native import or upload service. Existing desktop folder/card workflows remain.)* No per-provider description list. An iCloud Drive link shows the existing error: share the album as a Shared Album and paste that link.

### Gallery details
- Header is the Library card again: the same rail, then name, count and source with the live "Saving 9 of 13" and progress line, the caption, and a fainter line with the public address. The only difference from the Library card is no ··· button.
- Then only action rows, each 56px, with an icon, label, current value and a chevron or switch, in four groups:
  1. Open gallery, Share link
  2. Name, Caption, Reorder photographs
  3. Keep a copy (switch), Read the folder again
  4. Remove gallery (red), with "Removing it leaves every photograph in Dropbox." beneath
- Name and Caption each open a small sheet with one field and Save.
- The back button reads Library when you arrive from the Library. When you arrive from the viewer it reads Back and returns to the same photograph, skipping the curtain.
- There is no Content Credentials row here. Credentials are per photograph.

### Viewer
- Nothing on screen but photographs. One tap reveals the chrome, which hides after 3 seconds.
- Top bar: Library on the left, position ("2 of 13") on the right. No title.
- Bottom row, words only: Display, Info and, for owners only, Details. A visitor with a shared link sees Display and Info.
- No Share button in the viewer.
- Display sheet: Layout (Strip, Scroll, One by one), Canvas (Black, Dark, Light), Arrows (switch).
- Info sheet: position, file, size, camera, and Content Credentials for this photograph (see section 5).
- End card (after the last photograph): Rewind and Library.
- Arrows sit in their own 64px bar below the photographs and never overlap one. In Scroll mode they stack as up and down arrows at the bottom right. The sequence bubble rides left of the arrows, or in the arrows' corner when arrows are off.
- Ad plate: a vertical placeholder fit to height, mid-sequence only, following the existing `AdFrame` rules.

### Reorder
- Top bar: Cancel, "Reorder", Save. Save is disabled until something moves. The bar is pinned.
- One instruction line: "Tap a photograph to pick it up, then tap where it goes." After pick-up: "Picked up 09a…". There is no visible "Moved … to position N of M" message. Screen readers still hear it through a visually hidden live region.
- Every photograph is the same height, width following its own aspect ratio, left-aligned rows that end where they end. Nothing cropped or stretched.
- The picked photograph is outlined in the data hue; moved positions use the data hue.
- A size slider, pinned to the bottom within thumb reach, 56 to 248px.

### Settings
Groups: Account (Name, Address, Sign in with), Plan (usage meter, note, Go Visionary), This iPhone (New galleries: Keep a copy or Stream only; Encrypted copies usage; Photo picker switch), About (Privacy policy, Sign out), then Delete account. Display options are not here; they live in the viewer.

### Visionary sheet
Title "manorama Visionary". Three before-and-after lines, an App Store note, and "See price in the App Store". It deliberately shows no price. The figures in the prototype (3 to 99 galleries, 256 MB to larger, 30 days over the limit) are placeholders to be checked against `native/lib/billing.ts` and the retention code.

### Privacy policy (in app)
Opens inside the app from Welcome and Settings. Back returns to the origin. Text is word for word from `app/routes/privacy.tsx` (last updated 1 October 2026). Only the contact link leaves the app.

### Share
Share link calls the platform share sheet: `Share.share` from `@capacitor/share` (already in the root `package.json`) on iOS, `navigator.share` on the web. Payload: gallery name, caption, address; no photograph. Only if neither exists, or the browser refuses, show the fallback sheet: address, then Copy link, WhatsApp, Messages, Email.

## 5. Behaviour contracts to preserve or implement

Strip
- Fit to height, never cropped, never upscaled past natural size (pixels divided by device pixel ratio; the web caps the ratio at 2, native trusts the true ratio via `trustDeviceDpr` in `packages/core/image-staging.ts`). A frame with at least twice the screen's height in pixels fills the height; a smaller one sits centred at natural size.
- Arrows and the left and right keys use `advanceStripByViewport`. Each press travels at most one stage width. If the current photograph ends sooner, travel only that far so the next photograph docks exactly at the left edge. A photograph wider than the stage is paged in stage-width chunks, the last press docking the next. Back travels the lesser of one stage width or what is hidden of the current photograph. Rapid presses accumulate from the pending destination. Ad plates and the end card count as frames. Back at the very start jumps to the last photograph.
- On Dark or Light canvases, docking the first photograph returns to 0, not to the 10px canvas margin (otherwise the next back press does nothing). *(28 Oct 2026: decided — keep it, but only where required by a reproducing test; megaplan P4.)*

One by one
- Fit to width on a vertical screen, fit to height on a horizontal one. If the fitted side pushes the other edge off screen (a very tall portrait on a vertical screen), contain instead. Never upscale past natural size.
- Fade out 90ms, then fade in 160ms once the next photograph has decoded, so nothing pops in half-drawn. Rapid presses collapse onto the latest destination. Reduced motion swaps instantly.
- A phone in landscape (height 500px or less) counts as full-screen app, not the laptop proposal layout.

Scroll
- Fit to width, portraits included; a tall frame simply runs long. Unchanged from the spec.

Curtain
- A frosted veil over the first photograph carrying the mark, the title, the caption and the count. It dissolves to reveal that photograph sharp and in place. It does not lift or slide. Opening a specific photograph from a rail shows the same curtain over that photograph.

Content Credentials (C2PA)
- Each item carries `c2pa: boolean` (`packages/core/imagesource.ts`). iCloud media is never flagged.
- Verification is client-side, lazy, one photograph, and never uploads anything. States are idle, loading, verified, unavailable (the `credentialState` in `Viewer.tsx`). Copy from the existing viewer: "This photograph carries no Content Credentials.", "Checking Content Credentials locally…", "Content Credentials verified in this browser."
- Opening Info on a flagged, unchecked photograph starts the check automatically.
- Verified photographs show "made with", "signed by" and the signing time, plus an "Open in the C2PA viewer" button that goes to `c2pa.thecontrarian.in/?uri=…`. Keyboard: `I` opens Info, Shift+I goes straight to the C2PA viewer, with the existing fallback to the in-gallery sheet for videos and non-http origins.
- The 6 of 13 flagged photographs, the manifest (Adobe Lightroom Classic, Adobe Inc., 22 Oct 2026 18:40) and the camera lines in the prototype are invented. Use the real manifest and EXIF.

Accessibility
- Every target at least 44px. Text tiers meet 4.5:1. Sheets and dialogs trap focus and return it. Reorder keeps screen-reader announcements for each move. `prefers-reduced-motion` removes the curtain dissolve and the fades.

## 6. Deliberate changes to the technical contract

These conflict with the current `TECH-SPEC.md` or with existing Playwright specs. They are decisions, not accidents. Update the spec and tests in the same change as the code.

| # | Current contract | Redesign | Consequence |
|---|---|---|---|
| C1 | Stage shows only a half-hidden brand pill at the bottom edge, which opens display settings (view modes, arrows, fullscreen, shortcuts, info sheet) | No brand pill. One tap shows a top bar and a bottom row (Display, Info, Details). Info is its own sheet; Display holds only Layout, Canvas, Arrows (and fullscreen on the web). | Rewrite the Viewer chrome and dialog tests. Decide where the keyboard shortcuts list and Global View access live (open question Q4). |
| C2 | One-at-a-time sweeps the incoming photograph directionally over the current one behind an opaque card | Quick fade out, then fade in | Update the spec paragraph and the one-at-a-time Playwright checks. |
| C3 | Arrows dock at the viewport's bottom corners | Arrows live in a 64px bar below the photographs, which the stage gives up | Stage height changes when arrows are on; check strip fit and CLS. |
| C4 | Curtain behaviour per the existing `qa` spec | Frosted veil that dissolves; can open on any photograph | Re-baseline the curtain tests. |
| C5 | House-campaign ad plates appear only inside the viewer; `native/lib/ads.ts` is narrow by design | A sponsored slot at the top of the Library | *(28 Oct 2026: resolved — house creative only, restyling the existing account placement. Preserve eligibility and the `/api/ads/visibility` master suppression; no new placement API and no live AdMob adapter in the redesigned Library.)* |
| C6 | "Don't download this gallery" (a negative switch) | "Keep a copy" (positive) | UI inversion only. Do not rename or flip the stored preference in `vault-settings.ts`; invert at the view layer. |
| C7 | Store text and review notes name "View subscription options" and the product as Pro in places | "Go Visionary" | Update `submission/01-app-store-listing.md`, `submission/02-app-review-notes.md`, `submission/06-app-store-connect-fields.md` and the Playwright labels. Do not change the RevenueCat product id. |

Playwright label changes already known: `Manorama-fy it!` becomes `Add gallery`; the dialog `Display settings` becomes `Display`; `Don't download this gallery` becomes the switch `Keep a copy` (inverted meaning); `Horizontal Strip` becomes `Strip`; `Vertical scroll` becomes `Scroll`; `One at a time` becomes `One by one`; `Back to your galleries` becomes `Library`; `Back to start` becomes `Rewind`.

## 7. Copy deck (final strings)

| Place | String |
|---|---|
| Plan button, paywall entry | Go Visionary |
| Sheet title | manorama Visionary |
| Back buttons that lead to the list | Library |
| Library status example | cinder-fen-fall is saving to this iPhone, 9 of 13. |
| Viewer chips | Display, Info, Details |
| End card | Rewind, Library |
| Layout options | Strip, Scroll, One by one |
| Canvas options | Black, Dark, Light |
| Gallery details rows | Open gallery, Share link, Name, Caption, Reorder photographs, Keep a copy, Read the folder again, Remove gallery |
| Remove footnote | Removing it leaves every photograph in Dropbox. |
| Add sheet | Add a gallery; Shared folder or album link; Paste; Name; Add gallery *(28 Oct 2026: "Choose a folder on this iPhone" and "Choose photographs" removed — import deferred)* |
| Share fallback | Copy link, WhatsApp, Messages, Email |
| Reorder | Cancel, Reorder, Save; "Tap a photograph to pick it up, then tap where it goes." |

## 8. Where it lands in the code

*(28 Oct 2026: superseded — the confirmed code map is `docs/manorama-redesign-megaplan.md` §4, based on source inspection. This table is the pre-inspection guess, kept for history.)*

| Surface | Likely home (confirmed in megaplan §4) |
|---|---|
| Tokens, fonts | `app/styles.css` (replace `--admin-*`), `public/fonts` |
| Viewer chrome, Display, Info, curtain, arrows bar, end card | `app/islands/Viewer.tsx` |
| C2PA panel | `app/islands/Viewer.tsx` (`credentialState`, `openCredentials`, `data-c2pa-panel`, `C2PA_VIEWER_URL`) and `packages/core/imagesource.ts` |
| Strip, one-by-one, sizing math | `app/islands/Viewer.tsx`, `packages/core/image-staging.ts`, `packages/core/image-dims` |
| Ad plate | `packages/core/adframe.ts`, `native/lib/ads.ts` |
| Library, ··· menu, empty state, sign-in | `native/islands/GalleryList.tsx`; web `app/islands/Admin.tsx` |
| Gallery details | new native island; web counterpart is open (Q2) |
| Add sheet | paste flow in `GalleryList.tsx` / `Admin.tsx`; scan API `/api/galleries*` |
| Reorder | existing reorder surface; keep tap-to-pick, tap-to-place |
| Settings, This iPhone | `native/islands/VaultSettings.tsx`, `native/lib/vault-settings.ts` |
| Visionary sheet | `native/islands/Paywall.tsx`, `native/lib/billing.ts` |
| Privacy | `app/routes/privacy.tsx` plus a new shared module in `packages/core` |
| Share | new thin wrapper over `@capacitor/share` and `navigator.share` |
| Thumbnails for rails | `native/lib/thumbs.ts`, `native/lib/vault.ts`, `native/lib/offline-gallery.ts`; manifest in `app/api.ts` |
| Third target | `desktop/` (Tauri, `Catalogue` and `ShareFlow` islands) is not designed in the prototype. See Q2. |

## 9. Open questions and proposed defaults

*(28 Oct 2026: all answered by the owner; resolutions recorded in `docs/manorama-redesign-megaplan.md` §2 and §4. The table below keeps the original questions and defaults, annotated with the answer.)*

| # | Question | Proposed default | Answer (28 Oct 2026) |
|---|---|---|---|
| Q1 | The Library sponsored slot is a new ad placement. | Build the slot, hide it behind a flag driven by `/api/ads/visibility`, keep it off until the ad rule and App Store position are agreed. | House creative only — restyle the existing account placement; preserve eligibility and master suppression; no live AdMob. |
| Q2 | Does the web dashboard (`Admin.tsx`) and the Tauri desktop app adopt the new Library and Details? | Native first. Web and desktop follow once native ships, reusing the shared tokens and copy. Do not block native on them. | Every surface is in scope and ships together in one coordinated release. No separate native-first launch. |
| Q3 | Library rails for every gallery need thumbnails and dimensions without breaking "boot from vault, never the network". | Kept galleries read from the vault. Streamed galleries load a small thumbnail lazily with an average-colour placeholder (need a per-item colour in the manifest or a tiny derived field). Confirm the manifest can carry width, height and the colour. | Confirmed: `toSummary` already ships `previewImages` with dimensions, placeholder and video poster — no manifest or D1 change needed. The placeholder is not a verified average colour; derive colour locally only from bytes already fetched (megaplan §4, §6.3). |
| Q4 | Where do keyboard shortcuts help, Global View (the `G` filmstrip and the sequence bubble's "open global") and the fold/Diptych layout live now that the brand pill is gone? | Not designed. Keep the existing behaviour and the bubble; put the shortcuts list inside the Display sheet on fine pointers; treat Global View entry as a Library or Settings item. Ask the owner before shipping. | Preserve access: the position-count button and `G` open the picker/Global View; Settings controls the native cross-gallery scope; Display holds fine-pointer shortcut help; automatic fold/Diptych remains. |
| Q5 | Info starts the C2PA check on open, which fetches one original file. | Follow the spec (lazy, one photograph, client-side). Revisit if cellular data use is a concern. | Confirmed: lazy, client-side, one photograph, with deduplication and stale-result discard (megaplan §5.3). |
| Q6 | Visionary sheet figures (99 galleries, "larger" room, 30 days kept) | Replace with the real numbers from billing and retention, or remove the line that cannot be verified. | Real figures confirmed: 3 → 99 retained editable galleries, 30-day pipeline retention, free vault 256 MiB with paid configurable cap (megaplan §4). |
| Q7 | Dark/Light dock-to-zero adjustment on the first frame | Keep it; it fixes a dead back press. | Keep, but only where required by a reproducing test (megaplan P4). |

## 10. Known issues and risks

- The iOS keyboard will cover half-height sheets (Add, Name, Caption). They must resize or scroll with it.
- Animating the curtain's backdrop blur can stutter on older iPhones. Fall back to a plain dark scrim with an opacity fade if frame time suffers (`native/lib/fps-probe.ts` measures it).
- ~~`todo.md` line 42 says arrows advance "slightly shorter than the viewport width". The code advances one full width. Correct the line.~~ *(done 28 Oct 2026 — the line now reads "at most one stage width, stopping sooner to dock the next frame", matching the `Math.min` clamp in `advanceStripByViewport`)*
- The prototype's photographs are low-resolution crops of iPhone screenshots, with declared dimensions scaled up by 4 to stand in for originals. Do not copy the scaling into production.
- Ads: the AdMob provider must stay unwired until it can render without covering photographs; the Library slot does not change that.
- Hash routing in the prototype is a stand-in. Use the app's real router.

## 11. Sample data to replace

The gallery `night-market` and `cinder-fen-fall` content, both captions, the dates, the 61.4 MB and 22.8 MB sizes, the Dropbox and iCloud link fragments, the Apple sign-in email, the `shillong-december` sample link, "1 file skipped: notes.pdf", the C2PA flags, manifest and EXIF lines, the Visionary figures, and both sponsored placeholders.

## 12. Definition of done

- Every screen in section 4 matches the prototype at 375 x 812, and the viewer and Library also hold up at 1440 x 900 and 2560 x 1440 where they run on the web.
- Every contract in section 5 is covered by a Playwright test; every change in section 6 is reflected in `TECH-SPEC.md`.
- `bunx tsc --noEmit` and `bun run test:unit` pass; the Playwright matrix passes against the seeded dev server.
- The six-state evidence under `demo-captures/{ios,ipad,macos}/` is recaptured from fresh builds, and the `submission/` documents carry the new names.
- Lighthouse or equivalent accessibility pass on each screen; reduced-motion verified.
