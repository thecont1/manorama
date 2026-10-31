# Manorama web-admin redesign plan

Status: **shipped.** PR A (the card) landed as PR #151; PR B (the chrome) as
PR #153. One deliberate divergence from §5: the `···` menu is a list of native
buttons and links inside the shared Sheet, not `role="menu"`/`role="menuitem"` —
a menu role without arrow-key/roving-focus navigation is worse semantics than
none. Every owner decision below is resolved — D10 last, approved to port
`lib-card` to the desktop Catalogue as a separate lane whose implementation
lives outside this document.
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

## 2. Owner decisions — all resolved

These are the places where the pre-redesign web shell did something the iOS
Library does not. D1–D9 were approved as recommended and shipped; D10 was
subsequently approved for a separate lane and is the only item below whose
implementation is still pending.

- **D1 — Inline card editing.** Web cards edited title, caption and slug in
  place; iOS has no inline editing — every change goes through Details → edit
  sheet, which the web already mounts and wires (`saveEditFromDetails`).
  **Shipped (PR #151):** inline editing removed; one editing path everywhere.
- **D2 — The URL row.** Cards displayed `manorama.xyz/{owner}/{slug}` with a
  copy icon and an editable slug; iOS shows no address on a card — Share and
  Details both carry copy + address already.
  **Shipped (PR #151):** the row is dropped from the card surface.
- **D3 — Card tap behavior.** iOS card title/rail opens the viewer; on web the
  gallery is a public page and the management surface is Details.
  **Shipped (PR #151):** title and rail open the public gallery in a new tab;
  the `···` menu leads with management verbs.
- **D4 — The `···` menu contents.** iOS: Share link · Gallery details · Reorder
  photographs · Read the folder again · Remove gallery. Web-only verbs with no
  iOS counterpart: Open in new tab (covered by D3) and Open source.
  **Shipped (PR #151):** Share link · Gallery details · Reorder photographs ·
  Open source (when `sourceUrl`) · Read the folder again (when `sourceUrl`) ·
  Remove gallery. Open-in-new-tab folded into D3's card tap.
- **D5 — Locked/pipeline panel.** Was a full explanatory block with the expiry,
  the 30-day rule, and the Stripe upgrade link; iOS folds it into the sub line
  and puts the upgrade path in the paywall surface. The Stripe
  `client_reference_id` link is load-bearing.
  **Shipped (PR #151):** sub-line fold on the card; the full lock message +
  upgrade link lives in `GalleryDetailsView`'s temporary block behind the
  `upgradeHref` prop added for this surface (verified before the panel was
  removed — §5).
- **D6 — Edge-tab drawer.** iOS exposes Settings as a full screen from a gear
  in the top bar; the web's edge tab opened a drawer whose remaining contents
  were two nav items (Settings, Privacy Policy).
  **Shipped (PR #153):** the shared `m-topbar` chrome carries the brand and a
  settings gear; `WebSettings` stays the full-screen surface, and Privacy is
  reachable inside it (and the site footer).
- **D7 — Plan footer.** `admin-lib-foot` showed `N of M galleries · Free` plus
  a Plan button; `WebSettings` already receives `retainedCount`/`retainedLimit`
  and shows the plan meter in the new language.
  **Shipped (PR #153):** the footer block is gone; the quiet count stays in
  Settings.
- **D8 — Sponsored slot.** The `account-ad` panel already sat in the correct
  place (between heading and cards, matching iOS).
  **Shipped (PR #151):** frame restyled to the new radius/ink; no behavior
  change.
- **D9 — Strip behavior.** The web strip keeps its bespoke pointer-pan and
  wheel-to-horizontal handlers; the iOS `LibraryRail` can't be reused — it is
  bound to the vault media loader.
  **Shipped (PR #151):** existing mechanics kept under the rail look (fixed
  height, aspect-true, zero gaps, real `ul`/`li` semantics). No shared
  component extraction.
- **D10 — Desktop card parity.** The desktop Catalogue (PR #150) renders the
  same `admin-gallery-card` anatomy this plan replaced.
  **Open — lane approved:** the owner decided to port `lib-card` to the
  desktop list as a separate lane, since desktop cards mix local and cloud
  records. Implementation is pending outside this document's scope.

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
- Inline-editing removal in *behavior* — resolved under D1 and shipped in
  PR #151; the card head carries no editing surface.

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
`.lib-card-head` (title link + `···`), then `.lib-card-sub`:
`N photographs · {provider} · Temporary gallery · expires YYYY-MM-DD` when
locked. Caption below when present. No URL row, no icon row, no inline inputs
(D1/D2, shipped).

**Menu sheet** — shared `Sheet`, plain button/link rows per D4 (see the
shipped-status note above on why `role="menu"` was dropped). Remove gallery
carries `lib-menu-danger` styling and, from the card menu, the iOS inline
confirm pattern; the Details path (`removeGalleryFromDetails`) still uses
`window.confirm`.

**Retention** — card folds to the sub line; `GalleryDetailsView` renders the
temporary/expires/upgrade block on web behind the `upgradeHref` prop this
work added (verified before the card's lock panel was removed).

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
  Removes: URL row, icon row, retention panel, `editableText` (D1/D2, shipped),
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

- **Inline editing removal was the only behavioral regression** in the plan —
  D1 was owner-gated for exactly this reason; it resolved for removal and
  shipped.
- `admin-gallery-*` classes are shared with the desktop Catalogue — rename or
  retire only after checking `desktop/` and test references; safest is new
  `lib-card` classes on web, leaving `admin-gallery-*` intact for desktop
  until D10 is decided.
- The Stripe `client_reference_id` upgrade link must have a verified home
  before the locked panel folds away (D5).
- The `Sheet`-based menu introduces the overlay-stack path into the web admin
  for the first time — the happy-dom reconcile quirk seen in native nav tests
  may surface; watch for it in workbench-style tests.
