# manorama: redesign decisions

This answers the fresh-start brief and the one-page memo. The clickable prototype that goes with it is in `docs/redesign-prototype/index.html`. Open it at desktop width to see the design notes for each screen beside the phone, or at phone width to use it as the app.

> **Owner decisions, 28 Oct 2026 — superseding notes.** `docs/manorama-redesign-megaplan.md` is the owner-approved plan of record; precedence follows its §1 authority order — owner decisions, then AGENTS.md invariants, then this document, then the handoff, execution plan, prototype, and spec/tests. Settled then: every surface in scope (iPhone, iPad, Android shell, desktop, public web, owner dashboard, Welcome, quick-add, privacy, operations UI); release-ready, phased PRs into `feat/iphone-redesign`; iPhone folder/photo import deferred (Add is paste-link only); temporary viewer chrome overlays allowed, arrows still reserve a 64px bar; Library sponsored slot is house-only (restyle of the existing account placement, no live AdMob); picker/fold access preserved (count button and `G`); both dark and light owner themes; web Photo Editor keeps its horizontal row, native Reorder stays a vertical matrix; signed-out visitors get Display, Info, picker and Rewind only — no Library or Details; one coordinated release, not native-first. Inline corrections below are marked "(28 Oct 2026)".

## The product in one sentence

manorama turns a folder you already share into a quiet, full-screen gallery at your own address.

## Three layers

| Layer | Screens | Rule |
|---|---|---|
| Looking | Viewer, View options | Photographs and nothing else — except the curtain, a temporary orientation overlay that may show the mark, title, caption, and count before dissolving. Otherwise no brand, plan, storage or editing. A visitor with a shared link sees only this layer. |
| Galleries | Welcome, Library, Add a gallery, Gallery details | One task per screen. Each gallery is shown by its own photographs. |
| Upkeep | Reorder, Settings, Visionary | Explicit and confident. Reached on purpose, never shown in passing. |

## Answers to the brief's questions

1. **Viewer, manager or publisher?** A viewer with publishing attached. Every other screen exists to get someone to the viewer, or to keep a gallery ready for it.
2. **Default screen after sign-in:** the Library. Galleries newest first, each one shown as a strip of its first photographs at their true proportions.
3. **Before any galleries exist:** the Library keeps its title and its Add button, and an empty panel with one sentence and the same Add action. No illustration, no feature tour.
4. **Minimum interface to open and enjoy a gallery:** one tap on the strip or the name opens the curtain: a frosted veil over the first photograph, carrying the mark, title, caption and count. One more tap dissolves it. The words fade first (0.35s), then the frost thins from a 28px blur to none while the veil fades out (1.1s), and the same photograph comes up sharp, in place. Nothing moves; only focus changes. The viewer controls appear once the photograph is clear. Reduced motion is a plain 0.2s fade.
5. **Controls in the viewer:** at rest, only a small position count. One tap shows the controls, every one a single word with no icons. The top bar has Library on the left and "7 of 13" on the right, with no title, because the curtain has already named the gallery. The bottom row has Display, Info and, for owners only, Details. It hides itself after 3 seconds. There is no Share button in the viewer, because the viewer is for looking; sharing lives on Gallery details and in the Library ··· menu. Display opens a short sheet with Layout, Canvas and Arrows. Details opens Gallery details, whose back button then reads "Back" and returns to the same photograph without the curtain. With Arrows on, the canvas gives up a 64px bar at the foot and the arrows live there, so they never sit on a photograph in any layout.
6. **Display settings or device settings?** Display means Layout, Canvas, Arrows (and Fullscreen on the web only). These live in the viewer. "Don't download this gallery" and its progress bar are about the device, so they move to Gallery details › On this iPhone. The default for new galleries, vault usage and the photo picker move to Settings › This iPhone.
7. **Actions on a gallery card:** one tap to open, plus one ··· menu: Share link, Gallery details, Reorder photographs, Read the folder again, Remove gallery (last, in red). This replaces the five unlabelled icon buttons.
8. **Plan and subscription:** one quiet line at the foot of the Library ("2 of 3 free galleries · Plan"). It becomes a sentence only when the next gallery would be temporary ("All 3 of 3 free galleries used. A new one would last 30 days."). The Add sheet says the same thing at that moment, and nowhere else. Settings › Plan shows usage at its true ratio and a secondary "Go Visionary" button (the paid plan is Visionary, matching the RevenueCat product `…manorama.visionary.annual`). Visionary is a three-line before-and-after sheet that hands off to the App Store. Never in the viewer.
11. **Sponsored photographs:** two labelled placeholders, both shaped for a vertical photograph shown fit to height. One sits at the top of the Library, directly under the title and above every gallery. The other is an `AdFrame` plate in the viewer, following the spec: mid-sequence on the seeded cadence, never first or last, not counted in the position readout, suppressed in short galleries. The prototype shortens the cadence so one plate appears in a 13-photograph gallery. *(28 Oct 2026: the Library slot is house creative only — a restyle of the existing account placement, preserving eligibility and the master `/api/ads/visibility` suppression. No live AdMob adapter is wired in the redesigned Library.)*
11b. **Sponsored slot spacing:** the Library slot is its own surface panel, 24px under the title line and 40px above the first gallery (the same gap as between galleries), so it never reads as the first gallery.
12. **The mark:** one size and one place. 140 × 47px (`--logo-w`, `--logo-h`), centred horizontally in the 52px top bar (`--bar-h`), which starts at the top safe area (`--bar-top`), so its top edge is `bar-top + 2.5px`. Library, Gallery details, Settings and the curtain all resolve to the same box (on a 390px phone: x 125, y 16.5 below the safe area), so the mark never moves between them. Centre is the only position that works everywhere, because Gallery details and Settings need the left of the bar for Back. Welcome keeps the same size, centred lower down as the opening screen's hero, since nothing is on screen before it to jump from.
13. **Rewind:** the end card has two one-word buttons, Rewind and Library *(28 Oct 2026: Library only when that destination exists — signed-out visitors have none)*. Rewind glides the strip (or scroll) home in 0.75s with an ease-in-out curve, whatever the distance. One-by-one returns to the first photograph. Reduced motion jumps.
9. **One shell for owners and viewers?** One visual family, two behaviours. The viewer is the black canvas with chrome that hides itself. Owner screens are flat app screens on the same ground, using the same type. Owner tools never appear inside the viewer apart from the one Details button.
10. **Minimum interface to open a gallery:** sign in once, tap a strip.

## What moved where

| Was | Now |
|---|---|
| Sign-in: dictionary tagline, "WOW-est" line, CONTINUE WITH label, icon orbs | One sentence and three full-width sign-in buttons, Apple first. No photographs: nobody has signed in yet. Big logo only here. |
| Home: sponsored card | A sponsored slot at the top of the Library, above the galleries, shaped for a vertical photograph; a second one in the viewer strip at seeded in-sequence positions, never first or last |
| Home: owner path field `manorama.xyz/[vidya-rao-2]` | Settings › Account › Address |
| Home: greeting and "You are a Free User…" | The Library foot line; Settings › Plan |
| Home: inline paste field and "Manorama-fy it!" | The Add sheet behind the Library's Add button: a bottom sheet like Display, at most half the screen, with Add gallery pinned to its bottom edge so a long scan never pushes it out of reach. One path: paste a link. *(28 Oct 2026: choosing a folder or photographs on this iPhone is deferred; those buttons and their copy are omitted.)* The button says "Add gallery". The per-provider description list is gone. |
| Home: giant "Your galleries" | "Library", 28px. Every back button that leads there also says Library. |
| Gallery card: caption prompt, public URL, five icon buttons | Caption shown when it exists. URL and actions in the ··· menu and Gallery details. |
| Splash screen with logo and title | Kept as the curtain: a frosted veil over the first photograph with the mark, title, caption and count. It dissolves to reveal the photograph, sharp and in place. |
| Brand pill in the viewer | Removed. One tap shows the chrome. |
| Display settings: Back to your galleries | Viewer top bar |
| Display settings: Don't download this gallery, progress | Gallery details › On this iPhone (a "Keep a copy" switch with progress) |
| Display settings: View mode, Background | Display sheet: Layout (Strip / Scroll / One by one), Canvas (Black / Dark / Light). The chip says Display, not View: “View what?” |
| Display settings: Show navigation arrows, Enter fullscreen | Display sheet: Arrows switch. Arrows sit in a bar below the photographs, never on them. Fullscreen on the web only. |
| Display settings: privacy and copyright footer | Settings › About |
| Info sheet: product explainer, tagline | Removed (the Welcome sentence covers it) |
| Info sheet: View subscription options | Settings › Plan › Go Visionary |
| Info sheet: How galleries load | Settings › This iPhone › New galleries (Keep a copy / Stream only), with storage used against the limit |
| Info sheet: Photo picker and Open photo picker | Settings › This iPhone › Photo picker |
| Reorder: Save order / Discard changes at the foot, instruction paragraph; square crops | Cancel / Save in the top bar (Save stays disabled until something moves), pinned so it stays in reach while a large grid scrolls. The status line under it only instructs ("Tap a photograph to pick it up…", "Picked up 09a…"); there is no visible "Moved…" confirmation, because the photograph is already in its new place and carries its new position number. Screen readers still hear each move. The picked photograph is outlined. Every photograph is the same height (88px on a phone, which fits three 4:3 landscapes across), with its width following its own aspect ratio. Rows are left-aligned and end where they end; nothing is cropped or stretched to fill the width. A size slider pinned to the bottom of the screen, within thumb reach, runs from 56px (overview) to 248px (close look). |

## Visual system

From the True-black flat app style (taste-skill, seed 1740959148), with manorama's own colours and typeface kept.

*(28 Oct 2026: the owner approved both a dark and a light owner theme. The dark set below is the canonical dark palette; the light palette is defined in the megaplan, §5.1. Owner theme stays independent of the viewer canvas, which keeps its own Black/Dark/Light choice.)*

- **Ground** `#0a0a0a` (the existing gallery canvas). **Surface** `#161616`. **Raised** `#262626`. Elevation comes from lightness alone, with no borders or shadows on cards. Only sheets and dialogs cast a shadow.
- **Ink** `#f3f0e8` (brand cream). Secondary `#b8b4ab`, meta `#98948c`. Every text tier passes 4.5:1 on the surface it sits on.
- **Primary action** is made primary by inversion: a cream pill with black text. One per screen.
- **One data hue**, `#fc0fc0` (the existing selector pink). It is used only on progress (saving to the iPhone, plan usage, storage), the picked-up photograph in Reorder, and moved positions. It never goes on buttons, tabs or navigation.
- **Type:** Bricolage Grotesque only, already in `public/fonts`. Titles 28/700, sections 17/650, body 16, meta 13. Tabular figures everywhere. DM Mono, Playfair and Great Vibes go.
- **Shapes:** buttons and segmented controls are full pills. Panels use a 14px radius, sheets 22px. Photographs keep square corners, are never cropped in the viewer and never upscaled.
- **Touch:** every target is at least 44px.
- **Motion:** feedback only, meaning press, sheet rise and chrome fade. No entrances. Honours `prefers-reduced-motion`.

### Strip mode

Strip is a continuous horizontal row, every photograph fit to the height of the canvas, never cropped and never upscaled past its natural size (pixels ÷ devicePixelRatio), as `TECH-SPEC.md` has it. A frame with at least 2× the screen's height in pixels fills the height; a smaller one sits centred at its natural size. The prototype's sample frames are crops standing in for originals about 4× their size, so their declared dimensions are scaled accordingly.

### Gallery details

The header is the Library card again, so the same gallery looks the same in both places: the full-width strip of every photograph at its own proportions (pan it by touch, trackpad or mouse drag; tapping a photograph opens the viewer there), then the name, "13 photographs · Dropbox · Keeping 9 of 13" with the progress line while it saves, the caption, and the public address in a fainter line. The only difference is that the ··· button is absent, because everything it offered is on this page. Below that, nothing but action rows. Every row is the same 56px button with an icon, what it does, its current value, and a chevron or a switch. There are no text links and no Open/Share button pair of different sizes. The rows come in four groups, in this order:

1. Open gallery, Share link
2. Name, Caption, Reorder photographs
3. Keep a copy (switch), Read the folder again
4. Remove gallery, in red, with "Removing it leaves every photograph in Dropbox." under it

Name and Caption each open a small sheet with one field and Save. The ··· menu is gone from this page's top bar, since every action is already on the page.

### Content Credentials

These follow the C2PA contract in `TECH-SPEC.md` and `Viewer.tsx`. Each photograph carries a `c2pa` flag. Verification is client-side and lazy, moving from idle to loading to verified or unavailable, and iCloud media is never marked `c2pa`.

- **One photograph at a time:** credentials are never verified as a batch, so Gallery details has no Content Credentials row.
- **In the viewer:** the bottom row is Display, Info, Details. Info is the in-gallery information sheet, showing position, file, size, camera and Content Credentials. Opening it on a credentialed, unchecked photograph starts the check, as in `Viewer.tsx`. Verified photographs show who made and signed them, plus "Open in the C2PA viewer" (`c2pa.thecontrarian.in/?uri=…`). The keyboard follows the spec: `I` opens Info and `⇧I` goes straight to the C2PA viewer.

The prototype's credential flags, manifest details and camera settings are sample data.

### Share

Share link (on Gallery details and in the Library ··· menu) opens the platform's own share sheet instead of a list built by manorama. On iOS that is `Share.share` from `@capacitor/share`, which presents `UIActivityViewController`. On the web it is `navigator.share`, which opens the same sheet on phones and in Safari, Edge and Chrome on the desktop. Either way the person gets Copy, AirDrop, Messages, WhatsApp, Mail and every other app they have installed, in the order they use them. It shares the gallery name, its caption and the address, with no photograph attached. Only where no system sheet exists, or the browser refuses one, does manorama show its own short fallback sheet: the address, then Copy link, WhatsApp, Messages and Email.

### Privacy policy

Privacy policy, on the welcome screen and under Settings › About, opens a Privacy screen inside the app instead of going out to Safari. It has the same top bar and logo position as every other screen, and its back button returns to wherever the reader came from ("Settings", or "Back" on the welcome screen). The text is copied word for word from manorama.xyz/privacy (`app/routes/privacy.tsx`, last updated 1 October 2026) and set as one 16px reading column. Only the contact link leaves the app. In the real app, the web route and the native screen should read the policy from one shared module, so the two never drift apart.

### The thumbnail rail

Every gallery in the Library, and the Sequence panel in Gallery details, carries a rail of all its thumbnails at their own proportions. You can pan it by touch, trackpad or mouse drag, as in the dashboard contract. A drag only captures after 6px, so a plain tap still opens the gallery, and tapping a thumbnail opens the viewer at that photograph, through the curtain.

- **Kept on this iPhone:** thumbnails come out of the vault, so the rail is fully there at once. While a gallery is still saving, each photograph's thumbnail switches to its local copy the moment it lands.
- **Streamed:** the rail pans just the same. Each thumbnail shows the existing item placeholder first and fetches only when it scrolls near view, then fades in. An optional locally derived colour may only come from bytes already fetched, never an extra media fetch. This is slower and patchier than on-device, but costs nothing until someone looks along it. The prototype adds 0.35–1.1s of fake latency per streamed thumbnail. *(28 Oct 2026)*

Why the rail had stopped scrolling: a CSS grid item defaults to `min-width: auto`, so each gallery card grew to the full width of its thumbnails (1,332px) and the rail never had anything to scroll. The fix is `min-width: 0` on the card and `minmax(0, 1fr)` on the column; the real dashboard should be checked for the same trap.

### One by one

Fit to width on a vertical screen, fit to height on a horizontal one. If the fitted side would push the other edge off screen (a very tall portrait on a vertical screen, say), the photograph is contained instead, so it is never cropped. It is also never upscaled past natural size, so a small original stays smaller than the screen. Moving between photographs takes two steps: the current one fades out in 90ms, then the next fades in over 160ms once it has decoded, so it never pops in half-drawn. Rapid presses collapse onto the latest destination. Reduced motion swaps instantly. The prototype also treats a phone in landscape (height ≤ 500px) as full-screen app, not the laptop proposal layout.

### How Strip moves on the arrows

Strip uses `advanceStripByViewport` in `app/islands/Viewer.tsx` for the arrow buttons and the ←/→ keys, and the prototype now ports it line for line. Each press travels one stage width at most. If the current photograph ends sooner, the strip travels only that far, and the next photograph docks exactly at the left edge. A photograph wider than the stage is paged through in stage-width chunks, with the final press docking the next one. Back travels the lesser of one stage width or what is still hidden of the current photograph. Rapid presses accumulate from the pending destination. Ad plates and the end card count as frames. Back at the very start jumps to the last photograph.

One prototype-only adjustment: on a Dark or Light canvas, docking the first photograph returns to 0 rather than parking at the 10px canvas margin, where a further back press would otherwise do nothing. *(28 Oct 2026: `todo.md` line 42 said "slightly shorter than the viewport width" — corrected; the code advances at most one stage width, stopping sooner to dock the next frame.)*

### Arrows and the bubble

Per the viewer contract, arrows are off by default on touch. Enabled, they dock at the bottom corners in a 64px bar that the stage gives up, so they never sit on a photograph; in vertical scroll they stack as ↑/↓ at the bottom right. The sequence bubble rides left of the arrow cluster, or in its corner slot when arrows are off.

## Where this lands in the code

*(28 Oct 2026: superseded — the confirmed code map is `docs/manorama-redesign-megaplan.md` §4, which is based on source inspection. This table is the designer's first guess, kept for history.)*

| Surface | Likely home |
|---|---|
| Viewer chrome, Display sheet, curtain | `app/islands/Viewer.tsx` (stage, brand pill, display settings dialog) |
| Library, ··· menu, empty state | `native/islands/GalleryList.tsx`; web `app/islands/Admin.tsx` |
| Add sheet | Dashboard paste flow in `Admin.tsx` / `GalleryList.tsx`; scan API `/api/galleries*` |
| Gallery details | New route or sheet; gathers card actions from `Admin.tsx` and vault controls from `native/islands/VaultSettings.tsx` |
| Content Credentials, Info sheet | `app/islands/Viewer.tsx` (`credentialState`, `openCredentials`, `data-c2pa-panel`, `C2PA_VIEWER_URL`); per-item `c2pa` in `packages/core/imagesource.ts` |
| Reorder | Existing reorder surface; keep tap-to-pick, tap-to-place |
| Settings › This iPhone | `native/islands/VaultSettings.tsx`, `native/lib/vault-settings.ts` |
| Settings › Plan, Visionary sheet | `native/islands/Paywall.tsx`, `native/lib/billing.ts` |
| Tokens | `app/styles.css` (replace `--admin-*`, drop the monospace and script faces) |
| Ad plate | `packages/core/adframe.ts`, `native/lib/ads.ts` (placement rules unchanged; plate dressed for a vertical photograph) |

Playwright labels that change: `Manorama-fy it!` → `Add gallery`; the dialog `Display settings` → `Display`; `Don't download this gallery` → the switch `Keep a copy` (inverted meaning); `Horizontal Strip` → `Strip`.

## Sample content in the prototype

The photographs are your own frames, cut from the iPhone screenshots supplied with the brief, so they are low resolution. These are sample values to replace: the gallery `night-market`, both captions, the dates, the 61.4 MB and 22.8 MB sizes, the Dropbox and iCloud link fragments, the Apple sign-in email, the `shillong-december` sample link, and "1 file skipped: notes.pdf". The Visionary sheet deliberately shows no price. The two sponsored slots are placeholders with no image.
