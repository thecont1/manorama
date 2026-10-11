# iOS admin de-clutter — plan and findings (2026-10-11)

Six owner requests, all on the **native** account surfaces
(`native/islands/GalleryList.tsx`, `native/styles.css`).

## 1. Remove the space reserved for the left-edge tab
- The account page is `main.native-list-shell.native-account-shell`
  (GalleryList.tsx:1021) with a `button.native-account-menu.native-account-edge-tab`
  (:1022-1033) that carries BOTH the tab label and the hamburger SVG.
- Above 820px the tab label shows (left edge, vertically centred); below it the
  hamburger shows (`app/styles.css:1972,1977` — `.admin-hamburger` display rules;
  the media queries are `max-width: 819px`).
- The page still reserves a gutter for that tab. Find the padding/margin that
  reserves it (native/styles.css `.native-account-shell` / `.native-list-shell`)
  and let the page take the full width, keeping the hamburger at the top right.

## 2. Ad size
- Native ad markup is `aside.native-account-ad` with `native-account-ad-badge`,
  `native-account-ad-headline`, `native-account-ad-cta` (GalleryList.tsx:939-952).
- Plate rules live in `docs/native-launch-plan.md` §B (ten plate rules, issue #19).
- Answer: whether the size is fixed by a standard, and what the current size is.

## 3. Welcome message line spacing
- Greeting block: `.admin-greeting` (:1056-1078) with
  `p.admin-greeting-url`, `p.admin-greeting-hello` (contains
  `mark.admin-greeting-name`), `p.admin-greeting-plan`.
- The name is a `mark` with its own line-height, which is why the spacing differs
  line to line. Make the three paragraphs share one line-height.

## 4. Add a Gallery
- Remove `<label htmlFor="native-source-url">Public Dropbox, Google Drive,
  iCloud, or MEGA link</label>` (:1084) from the admin page; make the input
  keep an accessible name (visually hidden label or aria-label).
- Move that sentence into the hamburger menu as a line of guidance.

## 5. Hamburger menu (drawer)
- `div.native-drawer` (:1149) with `.native-drawer-scrim`, `.native-drawer-panel`,
  `.native-drawer-head` (:1164) and a small `button.native-drawer-close` (:1168).
- Wanted: logo + subtitle at exactly the same position as on the admin page; all
  content starts below them; replace the tiny close "x" with a large X in a
  circle at the same pixel position as the hamburger.

## 6. Your galleries card format
- Wanted order: 1) `title (NN items)` 2) caption (present or editable) 3) url
  4) thumbnail (alternating edge) 5) one row of square icon buttons exactly as
  the web UI.
- Current: `accountGalleryRow()` (GalleryList.tsx:887) renders the cover button
  plus the text opener; `div.native-gallery-actions` (:1127-1132) holds four
  text chips (Copy link / Open source / Refresh / Delete).
- Web reference (`app/islands/Admin.tsx`): icons `CopyIcon` (:83), `TrashIcon`
  (:84), `OpenIcon` (:85), `RefreshIcon` (:86), `SourceIcon` (:87); button class
  `.admin-icon-action` — 36x36, 1px `rgba(var(--ink),.22)` border, grid centred,
  icon 17px, colour `rgba(var(--ink),.68)`; `--delete` hover is warm red
  (`app/styles.css:641-645`).
- The caption is editable in the web UI (`editableText(gallery, 'caption', ...)`).
  Check whether the native API can PATCH a caption before promising inline edit.

## Verification habit for this task
`bunx tsc --noEmit`; `bun run test:unit`; rebuild the native bundle AND the
capture fixture (`CAPTURE_PORT=4182 bun .work/build-global-view-fixture.ts`),
restart `.work/capture-server.ts` on 4182, then
`CAPTURE_URL=http://localhost:4182 bunx playwright test native-vault-controls.playwright.ts`.
Evidence lands in `demo-captures/admin-gallery-focus/`; install on the phone with
`bun run native:sync` + xcodebuild + `xcrun devicectl device install app`.