# Manorama web-admin redesign plan

Status: draft for owner approval — nothing in this document is implemented.
Supersedes nothing; it narrows megaplan P10's remaining work to the one surface
that still carries the pre-redesign shell.

## 1. Objective and authority

The iPhone redesign shipped under `docs/manorama-redesign-megaplan.md` (the plan
of record, merged through PR #148). Its visual contract — a quiet full-screen
gallery, photography first, management in deliberate surfaces — already governs
every shared component the web dashboard mounts: `GalleryDetailsView`,
`GalleryEditSheet`, `WebSettings`, `WebReorderView`, `AddGallerySheet`,
`GalleryShareSheet`.

What was never redesigned is the web **workbench shell itself**: the Library
card list, its inline-editing card anatomy, the URL row, the action icon row,
the account edge-tab drawer, the plan footer, and the toast. This plan restyles
that shell to the shipped design language — the `lib-card` anatomy the iOS
Library and the prototype establish — without inventing a third admin.

Authority order, unchanged: the merged code is the truth for what shipped;
`docs/redesign-prototype/` is the truth for presentation; this document governs
only the gap between them inside `app/islands/Admin.tsx` and its styles.

## 2. Decisions needed from the owner

These are the places where the current web shell does something the iOS Library
does not. Each is flagged with a recommendation; none is silently decided.

- **D1 — Inline card editing.** Web cards edit title, caption and slug in
  place. iOS has no inline editing; every change goes through Details → edit
  sheet, which the web already mounts and wires (`saveEditFromDetails`).
  *Recommend:* remove inline editing from cards; one editing path everywhere.
- **D2 — The URL row.** Cards display `manorama.xyz/{owner}/{slug}` with a copy
  icon and an editable slug. iOS shows no address on a card; Share and Details
  both carry copy + address already.
  *Recommend:* drop the row from the card surface.
- **D3 — Card tap behavior.** iOS card title/rail opens the viewer. On web the
  gallery is a public page; the management surface is Details.
  *Recommend:* title and rail open the public gallery in a new tab (viewer is
  the product); the `···` menu leads with management verbs — matching the
  existing new-tab Open behavior rather than losing it.
- **D4 — The `···` menu contents.** iOS: Share link · Gallery details · Reorder
  photographs · Read the folder again · Remove gallery. Web-only verbs that
  have no iOS counterpart: Open in new tab (covered by D3) and Open source.
  *Recommend:* Share link · Gallery details · Reorder photographs · Open source
  (when `sourceUrl`) · Read the folder again (when `sourceUrl`) · Remove
  gallery. Open-in-new-tab folds into D3's card tap.
- **D5 — Locked/pipeline panel.** Today a full explanatory block with the
  expiry, the 30-day rule, and the Stripe upgrade link. iOS folds this into
  the sub line (`Temporary gallery · expires …`) and puts the upgrade path in
  the paywall surface. The Stripe `client_reference_id` link is load-bearing
  and must survive somewhere on this surface.
  *Recommend:* sub-line fold on the card; the full lock message + upgrade link
  moves into GalleryDetailsView's temporary block (verify it renders the
  upgrade href before removing the card panel — see §5).
- **D6 — Edge-tab drawer.** iOS exposes Settings as a full screen from a gear in
  the top bar; the web's edge tab opens a drawer whose remaining contents are
  two nav items (Settings, Privacy Policy).
  *Recommend:* replace the drawer with the shared `m-topbar` chrome — brand
  left, settings gear right — WebSettings stays the full-screen surface it
  already is, and Privacy joins the Settings surface (or stays in the site
  footer, which already links it).
- **D7 — Plan footer.** `admin-lib-foot` shows `N of M galleries · Free` plus a
  Plan button. WebSettings already receives `retainedCount`/`retainedLimit` and
  shows the plan meter in the new language.
  *Recommend:* remove the footer block; the quiet count stays in Settings.
- **D8 — Sponsored slot.** The `account-ad` panel already sits in the correct
  place (between heading and cards, matching iOS). Restyle its frame to the new
  radius/ink; no behavior change.
- **D9 — Strip behavior.** The web strip has bespoke pointer-pan and
  wheel-to-horizontal handlers; the iOS `LibraryRail` can't be reused — it is
  bound to the vault media loader.
  *Recommend:* keep the existing strip mechanics, restyle to the rail look
  (fixed height, aspect-true, zero gaps). No shared component extraction.
- **D10 — Desktop card parity.** The desktop Catalogue (PR #150) renders the
  same `admin-gallery-card` anatomy this plan replaces.
  *Recommendation:* hold desktop out of this plan's scope; once the web shell
  lands, decide whether `lib-card` ports to the desktop list as a separate
  lane, since desktop cards mix local and cloud records.

## 3. Scope

### Included

- `app/islands/Admin.tsx` render surface: heading row, gallery cards, menu
  sheet, empty state, sponsored slot frame, footer, toast.
- `app/styles.css`: restyle/rename of the `admin-gallery-*`, `gallery-card-*`,
  `admin-drawer`, `admin-edge-tab`, `admin-lib-foot`, `admin-toast`,
  `account-ad` selectors to the design language; retire `editable-value`,
  `is-editing`, `gallery-card-url-row`, `admin-icon-action` card usages
  (check desktop/test references before deleting any selector).
- A shared card-menu Sheet in the new language (the `Sheet` component already
  exists; the menu pattern mirrors `lib-menu` in `native/islands/GalleryList.tsx`).

### Excluded

- The shared sheets/views themselves (`GalleryDetailsView`, `WebSettings`,
  `WebReorderView`, `AddGallerySheet`, `GalleryShareSheet`) — already shipped.
- The public gallery viewer, landing, privacy, quick-add — already shipped or
  out of scope for the owner surface.
- Any API change. Every verb below already exists over cookie auth.
- Desktop Catalogue redesign (D10 — separate decision).
- Inline-editing removal in *behavior*, pending D1 approval — if the owner
  wants inline editing kept, the card head keeps it and this plan restyles it
  instead of deleting it.

## 4. Current code map (verified)

- `app/islands/Admin.tsx` — the whole workbench: gallery fetch/mutation
  handlers, `editableText` inline editor, strip pan handlers, edge-tab drawer
  (lines ~800–837), Library section (~839–891), toast (~893), and the already
  shared sheets (~896–1005).
- Card markup (`.admin-gallery-card`): editable title/count, editable caption,
  retention panel, `.gallery-card-url-row`, `.admin-gallery-strip-frame`,
  `.gallery-card-actions` = Details button + Open/Source/Refresh/Trash icons.
- iOS target anatomy (`native/islands/GalleryList.tsx` ~1245–1300):
  `LibraryRail` → `.lib-card-head` (title + `···`) → `.lib-card-sub`
  (`N photographs · Provider · Temporary gallery · expires … · device status`)
  → optional caption. `···` opens a `Sheet` containing a `role="menu"` list:
  Share link, Gallery details, Reorder photographs, Read the folder again,
  Remove gallery (`lib-menu-danger`).
- iOS heading row (~1486): `h1 Library` + `m-btn--primary` Add (+ icon);
  status line under; sponsored panel between heading and cards.
- iOS empty state (~1523): "No galleries yet / Paste a link to a folder or
  album you already share. Nothing is copied or moved. / Add a gallery".
- Web only: `admin-edge-tab` + `admin-drawer` (Settings, Privacy nav items),
  `admin-lib-foot` (count + Plan button), `admin-toast`, `account-ad`,
  `gallery-card-url-row`, `editableText` machinery.
- Behaviors that must survive untouched: `?details=` deep links, history
  Back/Forward across library/details/settings/reorder, PATCH title/caption/
  slug, POST refresh, DELETE gallery, copy link, new-tab open, source-link
  open, pipeline lock + expiry countdown + Stripe `client_reference_id`
  upgrade href, `aria-live` announcements, `adsShow` gating, theme, and the
  scroll-to-card on add.

## 5. Target contract per surface

**Library heading** — `h1 Library` + primary `Add` button with the `+` glyph,
a quiet status line beneath (toast text can share it), sponsored slot between
heading and first card — all matching the shipped iOS section.

**Card** — rail first (existing strip mechanics, rail appearance), then
`.lib-card-head` (title button + `···`), then `.lib-card-sub`:
`N photographs · {provider} · Temporary gallery · expires YYYY-MM-DD` when
locked. Caption below when present. No URL row, no icon row, no inline inputs
(pending D1/D2).

**Menu sheet** — shared `Sheet`, `role="menu"` list per D4. Remove gallery
carries `lib-menu-danger` styling and the same confirm pattern iOS uses
(the web currently uses `window.confirm` — keep the browser confirm or adopt
the iOS inline confirm group; flag: recommend the iOS inline confirm for
visual parity).

**Retention** — card folds to the sub line; verify `GalleryDetailsView` renders
the temporary/expires/upgrade block on web (props `temporary`, `expiresAt`
already passed; confirm the upgrade href reaches it — if not, the upgrade link
stays on the card's expanded lock block until Details grows it).

**Navigation** — `m-topbar` chrome with brand + settings gear (D6); drawer,
edge tab, and `admin-left` retire. `WebSettings` continues as the pushed
full-screen surface. Privacy stays reachable via the site footer and/or a
Settings row.

**Footer** — drop `admin-lib-foot`; plan/count lives in Settings (D7).

**Empty state** — the iOS copy verbatim: "No galleries yet / Paste a link to a
folder or album you already share. Nothing is copied or moved. / Add a
gallery".

**Toast** — keep `role="status" aria-live`, restyle to the quiet note
treatment.

## 6. Delivery plan

One lane, two PRs (the card work and the chrome work are independently
reviewable; no shared-file conflicts with anything in flight):

- **PR A — the card**: `.lib-card` anatomy on the web list, menu Sheet,
  sub-line metadata, caption, empty state copy, sponsored-frame restyle.
  Removes: URL row, icon row, retention panel, `editableText` (D1/D2 pending),
  `editable-value`/`is-editing`/`admin-icon-action` styles where unused.
- **PR B — the chrome**: `m-topbar` + gear, drawer/edge-tab removal, footer
  removal, toast restyle, plan line into Settings confirmation.

## 7. Verification

- `bunx tsc --noEmit` clean; `bun run test:unit` green (Admin has unit tests —
  update assertions rather than weakening them).
- Browser matrix `bunx playwright test` at 375×812, 1440×900, 2560×1440 —
  gallery card behavior specs exist (`qa.playwright.ts`, admin specs) and must
  keep passing or be updated for the new anatomy.
- Parity evidence: recapture the admin surfaces beside the iOS library.png at
  the same viewports under `docs/redesign-parity/web/`.
- Manual: deep links (`?details=`), Back/Forward, locked-gallery affordances,
  Stripe link encoding intact, add→scroll-to-card, theme both ways.

## 8. Risks

- **Inline editing removal is the only behavioral regression** in the plan —
  D1 is owner-gated for exactly this reason.
- `admin-gallery-*` classes are shared with the desktop Catalogue — rename or
  retire only after checking `desktop/` and test references; safest is new
  `lib-card` classes on web, leaving `admin-gallery-*` intact for desktop
  until D10 is decided.
- The Stripe `client_reference_id` upgrade link must have a verified home
  before the locked panel folds away (D5).
- The `Sheet`-based menu introduces the overlay-stack path into the web admin
  for the first time — the happy-dom reconcile quirk seen in native nav tests
  may surface; watch for it in workbench-style tests.
