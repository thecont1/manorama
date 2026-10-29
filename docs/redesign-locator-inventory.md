# Redesign locator inventory (P0, 28 Oct 2026)

Every Playwright locator / unit-test assertion tied to something the redesign
changes, mapped to the phase that changes it and the replacement assertion to
write. Phase numbers are the megaplan §7 stages. The point is that no coverage
is silently dropped: when a locator dies, the behaviour it protected gets a new
assertion in the same change.

Repeated locators are listed once with all line numbers.

## `qa.playwright.ts` (3275 lines — the viewer + admin + API monolith)

| file:line | Locator / assertion | Behaviour it protects | Phase | Replacement assertion |
|---|---|---|---|---|
| qa:84–87, 178–242, 632–652, 2737+ (also helper `dismissCurtain`) | `[data-curtain]` click→hidden; `is-lifting` class + transform; `.curtain-kicker`/`.curtain-prompt` absent | Curtain exists, dismisses on tap/swipe, lifts upward before hiding, carries title/caption/count | P3 | New curtain = frosted veil dissolving (no `is-lifting`/transform). Assert: veil visible over target photo, text fades ~350ms, dissolve ~1.1s, hidden after dismissal, reduced-motion = 200ms opacity fade, no lift/slide transform. Kicker/prompt stay absent. |
| qa:127–130, 361–464, 693, 739–745, 1042, 1087–1126, 1113–1126, 1173–1185, 1306–1311, 1367–1371, 1621–1626, 1726–1738, 1945–1955, 2650, 2707, 2727, 2749 (27 uses) | `getByRole('button', { name: 'Gallery controls' })` — the brand pill | Pill opens display settings; wake-radius, drag-transparency, rise-from-edge, bob | P3 | No brand pill exists. Chrome = tap-stage reveals top bar (Library + position) and bottom row (Display, Info, owner-only Details); auto-hide after 3s; hidden controls unfocusable. New helper `showChrome()` replaces every `Gallery controls` click. |
| qa:375, 432, 720, 1936–1970 + `.control-logo .brand-mark-wrap` | logo tab peeks below stage edge, `logo-tab-bob` animation name, 4.9s delay, rise-on-hover, pill `borderTopLeftRadius 999px` | Brand pill geometry/bob/wake zone | P3 | All deleted. Cover the protected behaviours via: tap toggles chrome; drag/wheel/magnifier/video action does NOT toggle chrome; auto-hide timer restarts. |
| qa:453–466, 481–483, 1050, 1835, 1875–1883 | `getByRole('dialog', { name: /display settings/i })` and `CONTROL_NAME = /image information and content credentials/i` for the single combined dialog; `.mode-options label` radio labels | One dialog hosts layout radios + info + C2PA | P3 | Two sheets: `dialog { name: 'Display' }` (Layout Strip/Scroll/One by one, Canvas Black/Dark/Light, Arrows, web Fullscreen, fine-pointer shortcut help) and `dialog { name: 'Info' }` (position, file, size, camera, C2PA panel). Rename mode labels: `Horizontal Strip`→Strip, `Vertical scroll`→Scroll, `One at a time`→One by one. |
| qa:1041–1070, 1994–2010, 483, 1707 | `I` / `⇧I` keys, `[data-c2pa-panel]`, "close image information" | Info entry points, lazy C2PA check on open for flagged stills, Shift+I external deep link | P3 | Same keys open the new Info sheet; same lazy one-photograph check with dedupe + stale-result discard; `⇧I` keeps the `c2pa.thecontrarian.in/?uri=` deep link and its video/non-http fallback. |
| qa:1089, 1100–1128, 1152–1210, 1482–1530 | `enter fullscreen` button; `[data-nav-arrow]` count 0↔2; `show/hide navigation arrows`; `next/previous photograph` buttons; ↑/↓ stacked arrows in vertical | Arrows toggle lives in the dialog; arrows dock at viewport corners | P3+P4 | Arrows switch moves into the Display sheet; `[data-nav-arrow]` assertions now check the reserved 64px bar below the stage (bar never overlaps image bounds; stage height shrinks; ↑/↓ stack in Scroll). Position/prev/next naming kept or renamed to match new copy. |
| qa:1230–1320, 3157, 3253–3275 | `.stage-seq`, `.stage-seq-num`, `.stage-seq-tally`, `.stage-seq-hint` ("open picker"), `.stage-seq-detail`, aria-label `Photograph N of M — open <id>` | Position count is the picker affordance; hover pill expansion | P3 | Small count remains the picker affordance at rest — keep aria-label contract (`Photograph N of M`), assert count tap opens picker; drop hover-stretch pill styling assertions if visual changes; `G` key still opens picker. |
| qa:1321–1354 | `.viewer-frame--entering`/`--leaving`, `data-sweep-dir="fwd"` | Single-mode directional sweep | P4 | Sweep removed: 90ms fade-out then 160ms fade-in after decode; rapid presses commit only the latest target; reduced motion swaps instantly. Assert no `data-sweep-dir`, decode-gated reveal. |
| qa:1537–1620 | `.viewer-endcap`, `back to start` button, rewind to index 1, endcap reachable in vertical | End card + back-to-start | P4 | End card buttons renamed `Rewind` (+ `Library` when a library destination exists); fixed 750ms ease-in-out rewind (instant under reduced motion); reachable in all three layouts; never counted in position. |
| qa:256–330 | `.viewer-filmstrip`, `[data-grid-item]`, `aria-current`, `.filmstrip-scrim`, `[data-grid-active]` | In-viewer photo picker/filmstrip grid | P3 | Picker retained (count button + `G`); same matrix, aspect-true thumbs, pink active highlight, Esc/scrim close returns to same frame. |
| qa:1707–1740 | `.mode-options label` vertical/one-at-a-time + `.position-value` `2 / N` | Mode radios switch + preserve position | P3 | Same assertions through the Display sheet segmented control. |
| qa:2032–2115 | `.landing-page`, `.landing-brand`, `.landing-brand-mark` (logo src), `.landing-brand-intro` text, `h1.admin-galleries-heading`, `Manorama-fy it!` button, `.admin-gallery-*` family, `manorama / gallery workbench` absent | Public landing + dashboard structure/copy | P9+P10 | Welcome screen: same logo asset 140×47, one sentence, three full-width provider buttons (Apple first). Dashboard → Library with cards/⋯ menus. `Manorama-fy it!` → `Add gallery`. `Your galleries` → `Library`. Icon action buttons → `···` menu items. |
| qa:2115–2200, 2264–2330 | `edit gallery slug`, `edit gallery title`, `edit gallery caption` textboxes, `.admin-toast` "Saved"/"Order saved", `.admin-gallery-strip-item` reorder drags | Inline title/caption/slug editing and inline strip reorder with read-back | P7+P8+P10 | Editing moves to Details sheets (Name/Caption one-field sheets; Address edit row preserves slug edit + public-link warning). Reorder moves to dedicated Reorder view (Save/Cancel top bar, draft state, read-back). `.admin-toast` copy updated. |
| qa:2058, 3059–3066 | `Account menu` button → retention disclosure in drawer; `a[href^="mailto:"]` "Upgrade"; `aria-disabled` temp-gallery actions; `Delete ui-d` | Account drawer holds retention/upgrade copy; temp galleries read-only but deletable | P9+P10 | Disclosure moves to Settings › Plan ("2 of 3 free galleries · Plan" footline + true-ratio usage). Temp-gallery restrictions preserved on Library card/Details; `Delete` in ··· menu/Details Remove row. |
| qa:2365–2455 | `/privacy` headings, `.policy-personas`, `.policy-card`, `.policy-document`, persona names incl. "Pro or Forever", print black-on-white, axe clean | Privacy page content/semantics/layout/print/a11y | P9 | Policy becomes platform-free data in `packages/core/privacy-policy.ts` rendered by Hono components on web/native/desktop; parity test that all renderers read the one module; keep print + axe + overflow assertions. "Pro" persona copy → Visionary wording where user-facing. |
| qa:2488–2498 | `getByLabel(/public dropbox...mega link/i)` + `Manorama-fy it!` + `Done! … is at the top` toast + `Add gallery` absent | Zero-click direct create, no intermediate preview | P7+P10 | Add sheet: URL field + Paste + optional Name + pinned `Add gallery` CTA; direct create preserved (no preview step); toast/copy updated; duplicate 409 reopen path kept. |
| qa:2513–2540 | `[data-quickadd]`, `[data-quickadd-signin]` href carry-through | Quick-add sign-in detour preserves whole URL incl. fragment | P10 | Unchanged contract; restyle only. Keep the assertion verbatim. |
| qa:2572–2728 | `.magnifier-lens`, `.viewer-stage.is-magnified`, `.shortcuts` "magnify" | `M` magnifier, lens hidden under modal, shortcut hint in dialog | P3 | Magnifier unchanged; shortcut help moves into the Display sheet on fine pointers — assert it there instead of the old dialog. |
| qa:2749–2750 | `dialog { name: 'Display settings' }` open blocks video mount | Inertness behind curtain/modals | P3 | Same invariant against the Display sheet name. |
| qa:3157, 3253–3275 | `.stage-seq` tap opens `.viewer-filmstrip` "instead of the brand pill" | Count tap = picker | P3 | Keep — count tap opens picker; no pill to compare against. |
| qa:3262–3267 | test name only | — | P3 | Rename test to drop "brand pill" reference. |

## `native-vault-controls.playwright.ts` (evidence spec — ignored by default run)

| file:line | Locator / assertion | Behaviour it protects | Phase | Replacement |
|---|---|---|---|---|
| nvc:13–109 | `.native-gallery-row-with-thumb`, `.native-gallery-list > li` card structure (title+count line, caption, address, cover photo, `.native-gallery-actions` icon buttons), `.native-gallery-caption-edit` inline edit, `Edit the running order` → `[data-gallery-editor]`, `.native-editor-*` | Native library card layout, inline caption edit, editor entry | P6+P7+P8 | Library cards become rail + name + counts + caption + one `···` menu; caption editing moves to Details sheets; `Edit the running order` → Reorder view (Cancel/Save top bar). New six-state captures per AGENTS.md. |
| nvc:113–148 | `Account` dialog, `.native-load-policy`, `.native-house-cards`, `.native-drawer-brand`, brand mark/intro parity page-vs-drawer | Account drawer contents: download policy, house cards, brand | P6+P9+P11 | These surfaces move to Settings (This iPhone / plan / house placement at Library top). Assert Settings rows instead. |
| nvc:152–207 | `.native-gallery-cover-open`, `[data-curtain]` loop-dismiss, `button.control-logo .brand-mark-wrap` opacity 0.45 + `native-logo-bob` animation, `Display settings` dialog, `Don't download this gallery` checkbox, `Streaming from cloud` status, `[data-global-view]`, `Back to your galleries` | Viewer entry, pill bob, device controls inside Display settings, Global View, return-to-list | P3+P7+P11 | Curtain = veil dissolve. Pill gone → temporary chrome. `Don't download this gallery` → `Keep a copy` positive switch under Details › On this iPhone (stored key unchanged). Global View via count/`G`. Back chip reads `Library`. |
| nvc:213–233 | reduced-motion: `native-logo-bob` absent | Motion preference honoured | P3 | Temporary chrome + curtain dissolve honour reduced motion (200ms opacity-only). |

## `native/ads.playwright.ts` (ad-safety contract — assertions must keep passing)

| file:line | Locator / assertion | Behaviour it protects | Phase | Replacement |
|---|---|---|---|---|
| ads:92–115, 144–145 | `[data-curtain]` click, `[data-track]` | Entry for all ad specs | P3 | New curtain dismissal; otherwise unchanged. |
| ads:177–247 | `[data-ad-frame]`, `[data-ad-position]`, `.ad-plate-cta`, `.ad-plate-badge` 'Sponsored', `.ad-plate-headline`, `aria-label 'Sponsored: manorama'`, position count `/of 36/`, `.stage-seq-tally` | Seeded ~25-image cadence, never first/last/adjacent, suppressed in short galleries, not in `imagesJson`/count, badge+headline dressing, end-cap adjacency | P4+P6 | Identical assertions — dressing changes to portrait fit/contain house creative only; no live AdMob in redesigned Library. Keep every policy assertion verbatim. |
| ads:348–443 | frame `aria-label`, `[data-track] [data-index]` counts, transform m41 strip position, `.stage-seq` aria-label | Click-safety (CTA tappable only centred & at rest), strip physics with plates | P4 | Same; plus arrow-bar-reserved geometry must not break rest-detection. |

## `native/global-view.playwright.ts`

| file:line | Locator / assertion | Behaviour it protects | Phase | Replacement |
|---|---|---|---|---|
| gv:57–124 | `Enter gallery` button, `open global fixture` button, `[data-global-view]`, `[data-grid-frame]` (12 cells + imgs), `[data-global-scroll]` scrollTo bottom lazy load, `.stage-seq-tally` '8 of 12' | Global View/picker entry, vertical matrix, lazy thumb materialization, frame jump reports position | P3+P11 | Picker access preserved via count button + `G` (Settings controls native cross-gallery scope). Same matrix and lazy-load assertions; entry locator renamed to the new affordance. |

## `fold.playwright.ts` / `admin-fold.playwright.ts`

| file:line | Locator / assertion | Behaviour it protects | Phase | Replacement |
|---|---|---|---|---|
| fold:71–331 | `[data-curtain]`, `[data-diptych-stage]`, `[data-diptych-frame]`, `.stage-seq` aria-labels | Diptych two-segment layout, curtain dismissal, seq reporting, no hinge overlap | P3+P11 | Same contracts on the new curtain/chrome; assert no control/modal/photo straddles the hinge. |
| admin-fold:14–33 | `[data-admin-ready]`, `.admin-page`/`.native-account-shell`, `.admin-welcome`, `.gallery-import`, `.native-gallery-import`, `Account menu`/`Close account menu` | Account surfaces stay off vertical hinge, focus restore | P9+P11 | Same against Settings/Library panes — nothing may straddle the hinge. |

## `doodle-background.playwright.ts`

| file:line | Locator / assertion | Behaviour it protects | Phase | Replacement |
|---|---|---|---|---|
| doodle:44–70, 257–301 | `.control-logo` waits/clicks to open display settings; `[data-curtain]` | Helper path into viewer settings | P3 | Open Display sheet via temporary chrome instead. |
| doodle:116–186 | `radiogroup 'Background behind photographs'`, `input[name="background-mode"]`, `[data-doodle-bg]`, `.viewer-stage.bg-*` | Canvas background none/dark/light = doodle layer | P3 | Same control as Canvas (Black/Dark/Light) in the Display sheet; keep `[data-doodle-bg]`/`.bg-*` assertions. |
| doodle:220–238 | `.mode-options label` vertical scroll → `.mode-vertical` | Mode switch under background matrix | P3 | Via Display sheet Segmented (Scroll). |

## `video-playback.playwright.ts` / `video-size-cap.playwright.ts`

| file:line | Locator / assertion | Behaviour it protects | Phase | Replacement |
|---|---|---|---|---|
| video-playback:27–47 | `.control-logo` wait, `[data-curtain]` force-click loop | Entry helper | P3 | Curtain veil dismissal + chrome. |
| video-playback:153–155 | `video` count 0, `[data-media-type="video"] .frame-ph` | No `<video>` mounts before entry/under modal; placeholder only | P3+P4 | Same invariant vs. new curtain/sheets; add suspension-while-Details-open assertion. |
| video-size-cap:21–39 | `.control-logo`, `input[name="view-mode"]` | Mode switch to measure video size caps | P3 | Display sheet Layout segmented control. |

## `theme-persistence.playwright.ts`

| file:line | Locator / assertion | Behaviour it protects | Phase | Replacement |
|---|---|---|---|---|
| theme:28–160 | `.admin-drawer-action` control list, `Account menu` + `dialog 'Account'`, `Switch to light/dark mode` buttons, `manorama:theme` key, origin separation | Theme toggle lives in the account drawer; per-origin persistence | P9+P10+P11 | Theme becomes a Settings row (both owner themes, Appearance group) + native Preferences adapter with the same two values; keep storage key, reload and origin-separation assertions against the Settings surface. |

## `admin-appearance.playwright.ts` / `desktop-admin.playwright.ts` / `desktop-catalogue.playwright.ts` (evidence specs — ignored by default run)

| file:line | Locator / assertion | Behaviour it protects | Phase | Replacement |
|---|---|---|---|---|
| admin-app:35–128 | `[data-admin-ready]`, `Account menu`/`Account` dialog/`Close account menu`, `.admin-hamburger`, `region 'Welcome to manorama'`, `region 'Add a gallery'`, `heading 'Your galleries'`, `Photo Editor` absent, `.admin-brand-logo` inside pane bounds, `.admin-intro/.admin-greeting/.admin-drawer-action/.site-footer-*` contrast ≥4.5 both themes, `Sign out` focus return, `.admin-gallery-strip` rail | Dashboard chrome, focus/contrast, both themes, rail geometry | P9+P10 | Same assertions on Library/Settings surfaces (TopBar logo 140×47, Settings dialog/sheet focus trap + return focus, both owner themes ≥4.5:1). `Your galleries` → `Library`; `Add a gallery` region → Add sheet. |
| desktop-admin:50–218 | same family + `.admin-greeting-url` 'manorama.xyz/thecontrarian', `.native-drawer-brand` parity, `.native-load-policy`, `.native-house-cards`, `.native-gallery-cover-open`, `control-logo`/`native-logo-bob`, `Don't download this gallery`, `Streaming from cloud`, `Back to your galleries`, `[data-global-view]` | Desktop webview workbench + native account drawer + viewer device controls | P6+P7+P9+P11 | Library/Details/Settings equivalents; `Keep a copy` positive switch; `Library` back chip; picker via count/`G`. |
| desktop-cat:142–283 | `.desktop-catalogue`, `.admin-welcome-note` 'You are a Pro User.' + 'N galleries on this Mac', `.admin-limit-count`, `.desktop-sync-state`, region `Add a gallery` 'Choose a folder or card', `.admin-gallery-*`, `Account menu`/`Switch to light mode`, `Back to the catalogue`, `.curtain` | Desktop local catalogue truth (local folders ≠ public galleries), theme, publish gating, viewer curtain | P9+P11 | Same local-truth assertions; `Pro User` copy → Visionary wording; new curtain dismissal; Details actions for local galleries (Open, Publish/Share, Read folder again, Remove). |

## `viewer-preferences.playwright.ts`

| file:line | Locator / assertion | Behaviour it protects | Phase | Replacement |
|---|---|---|---|---|
| vp:43–114 | `[data-curtain]` retry-dismiss, `.stage-seq` aria-label `/Photograph N of \d+/`, `#img-2` → clean URL + back returns to first image | Curtain dismissal, deep-link lands then URL cleans, reload starts at first | P3+P10 | New curtain; keep clean-URL/reload-first assertions; add transient `?photo=<media-id>` rail-entry intent consumed by `replaceState` (invalid ids → first image). |

## `capture-harness.playwright.ts` (evidence spec)

| file:line | Locator / assertion | Behaviour it protects | Phase | Replacement |
|---|---|---|---|---|
| capture:15–34 | `[data-curtain]`, `dialog 'Display settings'`, `Public Dropbox… link` label, `Manorama-fy it!`, `[data-grid-frame]` count 22 | Six-state capture states | P3+P7+P9 | Update state mapping to new labels (Display sheet, `Add gallery`); add Details/Reorder/Settings/Visionary/theme captures per megaplan §8.4. |

## `vendo-slot.playwright.ts` / `vendo-surface.playwright.ts`

| file:line | Locator / assertion | Behaviour it protects | Phase | Replacement |
|---|---|---|---|---|
| vendo-slot:40–49, vendo-surface:54–101 | `.landing-brand`, `[data-curtain]`, `#vendo-*` absent/`data-vendo-launcher` 'Ask Manu' | Vendo overlay never leaks into surfaces | — (out of redesign scope) | Keep as-is; re-point `.landing-brand`/curtain waits if those landmarks change (P10). |

## `desktop-auth-local.playwright.ts`

| file:line | Locator / assertion | Behaviour it protects | Phase | Replacement |
|---|---|---|---|---|
| dal:10–24 | `heading 'Local development account'`, `link 'Return to manorama'` | Dev-seed sign-in page + handoff | — | Unchanged (dev-seed page, not product UI). |

## Native/desktop unit tests

| file:line | Locator / assertion | Behaviour it protects | Phase | Replacement |
|---|---|---|---|---|
| `native/islands/GalleryList.account.test.tsx`:338–347 | `Continue with Apple/Google/Dropbox`, Apple before Dropbox; `Global view` absent | Sign-in orb order/labels | P9 | Three full-width buttons, Apple first, on the new Welcome view. |
| :486–550 | `.native-gallery-import` placement (overview not card), `.native-gallery-row/-thumb/-caption/-link/-cover-open/-actions`, greeting `Hello, <mark class="admin-greeting-name">…`, `aria-label="Account menu"` | Import form location, card structure, greeting, account tab | P6+P9 | Library card + `···` menu + Add sheet; greeting removed (Library title+Add); Settings gear replaces Account menu tab. |
| :591–603 | greeting + `.admin-owner-slug-input` | Editable owner slug input in drawer | P9+P10 | Address edit row in Settings › Account (server PATCH `ownerSlug`). |
| :649–701 | drawer sections `House cards`, `How galleries load`, `Photo picker` h2s; `.native-house-cards-status` 'House cards shown · …' | Account drawer policy surfaces | P6+P9 | House placement = Library top slot (house-only); load policy → Settings › This iPhone › New galleries; picker switch → Settings › This iPhone › Photo picker. |
| :728–766 | card DOM order `.native-gallery-heading`/`-link`/`-row`/`-cover-open`/`-actions`; `.native-gallery-remove-confirm` | Card structure + remove confirm | P6+P7 | Card = rail+meta+`···`; named Remove confirmation (provider-neutral "originals remain at their source"). |
| :798–811 | `.native-gallery-list > li` count 5, `.native-gallery-thumb.is-active` 0, 'Temporary gallery' text | List rendering + temp badge | P6 | Library cards show real status (temporary/retained labels preserved). |
| :827–1180 | `aria-label="Account menu"` clicks ×~15 | Drawer open for account actions | P9+P11 | Settings screen equivalents (sign-out, delete, identities). |
| :1202–1268 | `.native-gallery-caption` inline edit `.native-gallery-caption-edit`; `.native-gallery-import input` aria-label; `.native-drawer-brand .landing-brand-mark`, `.landing-brand-intro` 'adj.' | Inline caption edit, import input label, drawer brand | P7+P9 | Caption edit via Details sheet; Add sheet URL field label; brand = shared TopBar logo box. |
| `native/islands/GalleryList.test.tsx`:4–13 | `galleryStatusMessage` strings 'Opening gallery…', 'Available offline. Full resolution returns with your connection.', 'That gallery could not be opened.' | Status copy honest about offline vs failure | P6 | Keep strings or update copy in the same change; honesty invariant stays tested. |
| `native/islands/GalleryEditor.test.tsx`:175–321 | `[data-gallery-editor]`, `.native-global-grid .native-global-cell`, `.native-editor-save` disabled→enabled, `.native-editor-note` 'in hand'/'position 1 of 3'/'saved'/'did not take that order'/'That order could not be saved', `[aria-label="Close the editor"]`, `.is-active` | Draft reorder, pick/place, save/read-back, error paths | P8 | ReorderView: Cancel/Save pinned top bar (Save disabled until diff), picked outline + moved positions in data pink, visually-hidden live region announces moves (no visible "Moved…" line), same failure paths. |
| `native/islands/GlobalView.test.tsx`:133–356 | `GlobalView` props: `downloadNote="Saving 0 of 1 photos to your encrypted vault…"`, `onOpenFrame`, tier/current/onlineGallery | Picker matrix + vault note + frame open | P11 | Same component contract; note copy may move to Details/This iPhone surfaces. |
| `native/islands/Paywall.test.tsx`:84–85 | buttons `Terms of Use`, `Privacy Policy` | Paywall legal links | P9 | Same links on the Visionary sheet (store opens only via explicit CTA). |
| `native/islands/VaultSettings.test.tsx`:156–290 | 'Total on this device', cap options free vs pro `unlimited`, `data-vault-gallery` rows, 'Tap again to remove', 'could not verify'/'try again', 'Filesystem enumeration unavailable', 'No galleries are stored', 'Unreadable cache' | Vault usage/caps/purge controls + error states | P9+P11 | Same controls inside Settings › This iPhone / Details; copy kept truthful (actual bytes, enforced cap, purge confirmations). |
| `native/islands/Diptych.test.tsx`:98–110 | `data-diptych-mode`, geometry `left:760px`, no `<button>` overlay, no `object-fit:cover` | Fold rendering, no controls straddling hinge | P11 | Same assertions on new chrome (no control/photo straddles hinge). |
| `native/lib/ads.test.ts`:14–20 | house frame on fill fail/empty; pro → house plate, no network fill | House-only ad policy | P6 | Same (house-only everywhere in redesign). |
| `native/lib/admob-account-adapter.test.ts`:13,182 | fallback to house plate when AdMob can't paint | Live-adapter retirement | P6 | Redesigned Library never calls the live adapter; keep adapter tests for the unwired path or mark retirement per P6. |
| `desktop/islands/Catalogue.workbench.test.tsx`:162–290 | `.admin-page`, `.admin-welcome` aria-label 'Welcome to manorama', `.gallery-import`, `.admin-edge-tab` 'Account menu' + `#admin-account-drawer`, `.admin-drawer-panel/-scrim`, `.admin-gallery-*`, `.landing-page.desktop-welcome`, `Continue with Apple` | Desktop workbench structure, drawer, local catalogue, sign-in | P9+P11 | Shared Library/Settings components via desktop adapter; local folder truth preserved (no invented public links). |
| `app/server.test.ts`:182–185,199 | 'Continue with', `aria-label="Continue with Dropbox/Google Drive/Apple"`; `curtain` markup | Web sign-in orbs + gallery SSR shell | P9+P10 | Full-width buttons on new Welcome (Apple first); keep provider href/aria-label contracts. |
| `app/quickadd-route.test.ts`:174 | 'Manorama-fying…' copy | Quick-add interstitial text | P10 | New copy per redesign; keep no-client-load regression. |
| `app/admin-retention.render.test.ts`:97 | absence of `.admin-gallery-editor-label` | Admin DOM hygiene | P10 | Update to the Library card DOM. |

## Cross-cutting locators kept unchanged (do not break)

`[data-stage]`, `[data-track]`, `[data-index]`, `aria-current`, `.frame-img`, `.frame-ph`, `[data-image-id]`, `.position-value` semantics (position reporting — may move into Info sheet), `.viewer-filmstrip`/`[data-grid-frame]` picker grid, `[data-c2pa-panel]`, `C2PA_VIEWER_URL` deep link, `.viewer-endcap` (renamed buttons only), `.magnifier-lens`, `video.frame-video` + mute/pause buttons, `[data-admin-ready]`, `manorama:theme`, `manorama:view:<slug>` prefs keys, `/.dev-seed/*` seams, `[data-ad-frame]` family.
