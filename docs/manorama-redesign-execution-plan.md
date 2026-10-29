# manorama redesign: execution plan

Read `manorama-redesign-handoff.md` first. It defines the screens, the behaviour contracts, the deliberate contract changes (C1 to C7) and the open questions (Q1 to Q7). This plan says in what order to build them and how to know each step is done.

> **Owner decisions, 28 Oct 2026 — superseding notes.** `docs/manorama-redesign-megaplan.md` is the owner-approved plan of record; precedence follows its §1 authority order — owner decisions, then AGENTS.md invariants, then the redesign decisions, handoff, this plan, prototype, and spec/tests. Its §7 phases (P0–P12) and dependency/ownership rules supersede the stages below wherever they disagree. Settled then: every surface in scope with one coordinated release — not native-first; both dark and light owner themes; temporary viewer chrome overlays allowed, arrows still reserve a 64px bar; Library sponsored slot is house-only with no live AdMob; iPhone folder/photo import deferred; UI runtime is Hono JSX, not Preact; branches are `feat/iphone-redesign` (integration) + `feat/redesign-*` (PRs), not `redesign/true-black`; the confirmed code map is megaplan §4. Inline corrections are marked "(28 Oct 2026)".

Principles
- *(28 Oct 2026: superseded)* ~~Native first (iOS is the shipping target). Web and desktop follow, reusing tokens, copy and shared logic.~~ Every surface ships in one coordinated release; phases still integrate in dependency order via `feat/iphone-redesign`.
- Behaviour contracts in `TECH-SPEC.md` win unless the handoff lists a change. Update the spec and the Playwright specs in the same commit as the code that changes them.
- Shared logic goes in `packages/core` (platform-free: no Worker bindings, no `window`, no Node built-ins, no Capacitor imports).
- Small, reviewable commits. Each stage ends with the checks in its exit criteria, and nothing is merged with a red check.
- Size labels are relative effort, not time: S (a few hours), M (about a day), L (several days).

Conventions
- Work on `feat/redesign-*` PR branches targeting the `feat/iphone-redesign` integration branch (not `redesign/true-black`). Stacked work branches from its reviewed dependency; nothing merges to `main` until the coordinated release.
- Checks used throughout:
  - Types: `bunx tsc --noEmit`
  - Unit: `bun run test:unit` (never bare `bun test`; it dies `EMFILE` on the worktrees)
  - Acceptance: `GALLERY_URL=http://localhost:5173 GALLERY_VIDEO_SLUG=mixed-album bunx playwright test` against `bun run dev`, with the `MANORAMA_DEV_SOURCE_*` variables set
  - Native specs: `native/ads.playwright.ts`, `native/global-view.playwright.ts`
  - Contract drift: `bun run vendo:check` (Vendo is disabled, but the check is part of the verification list)
- Screenshot parity: for each screen, capture the real build at 390 x 844 and compare it side by side with the prototype at the same size. Keep the pairs in `docs/redesign-parity/`.

## Stage 0: Recon and decisions (S)

Goal: replace the handoff's "likely homes" with confirmed ones and settle the open questions that block code.

*(28 Oct 2026: largely superseded — the megaplan §4 is the confirmed code map, §2 answers the open questions, and P0 is the baseline/locator-inventory phase. What remains of this stage is recording the reproducible baseline and fixtures.)*

Tasks
1. Create the worktree and branch. Run the full check list on the untouched branch and record the baseline (which specs pass, which are flaky).
2. Read and note, per file, the exports and tests that touch the redesign: `app/islands/Viewer.tsx`, `app/islands/Admin.tsx`, `native/islands/{GalleryList,VaultSettings,Paywall}.tsx`, `native/lib/{thumbs,vault,offline-gallery,vault-settings,billing,ads}.ts`, `packages/core/{imagesource,image-staging,adframe}.ts`, `app/styles.css`, `app/routes/privacy.tsx`, and every `*.playwright.ts`.
3. Update the "Where it lands" table in the handoff with the confirmed paths. List every Playwright locator that will break (start with the label changes in the handoff).
4. Check that the gallery manifest can carry per-item width, height and an average colour (Q3). If not, specify the smallest addition to the manifest and the vault thumbnail record.
5. Pull the real Visionary figures from `native/lib/billing.ts` and the retention code (Q6).
6. Take the open questions to the owner: Q1 (ad slot), Q2 (web and desktop scope), Q4 (shortcuts help, Global View entry, fold layout). Record answers in the handoff.

Exit criteria: baseline recorded; code map confirmed; broken-locator list written; Q1, Q2, Q4 answered or given an explicit default by the owner.

## Stage 1: Foundations (S to M)

Goal: the new look available everywhere without changing behaviour yet.

Tasks
1. Tokens in `app/styles.css`: add ground, surface, raised, ink, secondary, meta, data hue, negative, radii, bar height, logo box. Keep the `--admin-*` names as aliases until Stage 7, so nothing breaks mid-migration.
2. Fonts: bundle Bricolage Grotesque (variable) in `public/fonts` and the native bundle; remove the Google Fonts request from native; delete DM Mono, Playfair Display and Great Vibes usage when the last screen is migrated.
3. Shared components (the repo's Hono JSX island style — `hono/jsx/dom`; 28 Oct 2026: no React, Preact, router package or component library): `TopBar` (logo box centred at 140 x 47 in a 52px bar, optional back and trailing slots), `Sheet` (grab handle, rise animation, max-height prop, focus trap, scrim), `ActionRow` (56px, icon, label, value, chevron or switch), `Panel`, `Pill` buttons (primary cream, secondary raised), `Meter` (data hue line), `Switch`, `Segmented`, `Toast`.
4. A single logo asset with explicit width and height attributes so layout never depends on the image decoding.
5. Unit tests for any logic (none expected) and a visual page listing the components, for parity checks.

Exit criteria: components render at 390 wide matching the prototype; logo measured at the same x and y inside `TopBar`; contrast of each text tier checked; types and unit tests green.

## Stage 2: Viewer (L, the riskiest stage)

Goal: the viewer chrome and behaviour of handoff sections 4 and 5, with every contract preserved except C1 to C4. Split into sub-steps so that each can be merged on its own.

2a. Chrome and sheets (M)
- Remove the brand pill and its bobbing animation. One tap on the stage toggles chrome. Auto-hide after 3 seconds, cancelled while a sheet is open.
- Top bar: Library back button and position text — the Library action stays for the owner, is omitted for signed-out public-link visitors, and returns a signed-in non-owner to their own Library only. Bottom row: Display, Info, Details (owner only; a visitor's view omits it). No Share.
- Display sheet: Layout, Canvas, Arrows, plus fullscreen on the web and the shortcuts list per the Q4 decision.
- Move the in-gallery information sheet out of display settings into its own Info sheet; keep the `I` and Shift+I keys.
- Tests: rewrite the display-settings and brand-pill specs; add focus-trap, Escape and return-focus tests for both sheets.

2b. Curtain (M)
- Frosted veil with backdrop blur 28px plus scrim, content fades in 0.35s, frost dissolves over 1.1s. Opens over a specific photograph when entered from a rail.
- Reduced motion: no dissolve, a plain cut.
- Performance fallback: if `fps-probe` reports poor frame time, use an opacity fade over a dark scrim, no blur.
- Tests: curtain behaviour in `qa`, rail-entry index, reduced motion.

2c. Strip and arrows (M)
- Confirm Strip sizing matches the spec (fit to height, density-aware, never upscaled). Do not change sizing math.
- Arrows move into a 64px bar the stage gives up; in Scroll mode they stack up and down at the bottom right; the bubble sits left of the arrows or in their corner.
- Keep `advanceStripByViewport` untouched. Add tests for: a press moves one stage width; a photograph that ends sooner docks the next exactly at the left edge; a photograph wider than the stage pages in chunks; back from a docked photograph; back at the start jumps to the last; rapid presses accumulate; ad plate and end card count as frames.
- Check that the shorter stage does not cause layout shift when arrows toggle (CLS spec).

2d. One by one (S to M)
- Fit rule per the handoff: width on vertical screens, height on horizontal, contain when the fitted side would overflow, never upscale.
- Replace the directional sweep with fade out 90ms then fade in 160ms after decode; rapid presses collapse onto the latest target; reduced motion swaps instantly.
- Update the spec paragraph (C2) and the one-at-a-time tests.

2e. Info and Content Credentials (M)
- Info sheet fields: position, file, size, camera (from EXIF), Content Credentials.
- Credential panel states idle, loading, verified, unavailable with the existing copy. Auto-start on open for flagged, unchecked photographs; one photograph at a time; no upload.
- Verified view: made with, signed by, signed time, and "Open in the C2PA viewer" to `C2PA_VIEWER_URL`. Videos and non-http origins fall back as the spec says.
- Tests: extend the existing C2PA spec to the new Info entry point; keep a test that iCloud items never show the flag.

2f. End card and ad plate dressing (S)
- End card: Rewind (eased scroll or index reset, 0.75s unless reduced motion) and Library.
- Ad plate: dress the existing `AdFrame` plate for a vertical photograph, fit to height. Cadence, suppression and tap rules do not change. Run `native/ads.playwright.ts`.

2g. Spec and test pass (S)
- Edit `TECH-SPEC.md` for C1 to C4. Remove or rewrite assertions that referenced the old chrome. Run the whole matrix at 375 x 812, 1440 x 900 and 2560 x 1440, including the video and fold specs.

Exit criteria for Stage 2: viewer checks in the Definition of Done pass; video slides, Diptych and Global View still work; *(28 Oct 2026)* temporary viewer chrome may overlay photographs — the no-overlap requirement applies only to controls that must reserve space, and arrows still reserve the 64px bar; the strip arrow tests above are green.

## Stage 3: Library, Add, Details (L)

Goal: handoff section 4 for Library, Add sheet and Gallery details.

3a. Thumbnail data path (M). Depends on Stage 0 task 4.
- The existing gallery summary already carries what the rail needs: per-item width and height and a thumbnail source — the existing thumbnail URL for streamed galleries, the vault key for kept ones. No average-colour metadata: do not add a manifest or vault-record colour field or migrate existing records for this rail.
- Kept galleries: read thumbnails from the vault, switching each to its local copy as it lands. Streamed galleries: show the existing item placeholder first, IntersectionObserver near-view loading, fade-in on decode; bounded concurrency (reuse the `thumbs.ts` limits). An optional locally derived colour may only come from bytes already fetched — never another media fetch.

3b. Library (M)
- Layout: top bar with Settings gear, title and Add pill, status line, sponsored slot (behind the Q1 flag, hidden when off), gallery cards.
- Card: full-bleed rail (drag after 6px; touch, trackpad and mouse; `min-width: 0` and `minmax(0, 1fr)` to avoid the grid trap), name and sub line with live saving state, progress line, caption, ··· menu.
- Tapping a thumbnail opens the viewer at that photograph through the curtain; tapping the card opens at the first.
- Empty state and error state (no galleries; offline; scan failure) in the same visual system.

3c. Add sheet (M)
- Half-height sheet, Add gallery pinned at the bottom; paste path only *(28 Oct 2026: the on-device folder/photo path is deferred)*; iCloud Drive error. Keyboard handling: the sheet resizes with the iOS keyboard (visual viewport) and the pinned button stays reachable.
- Playwright: the `Manorama-fy it!` label becomes `Add gallery`; update the quick-add and zero-click specs.

3d. Gallery details (M)
- New island and route. The header reuses the Library card component (rail, name, sub line, caption, address) minus the ··· button.
- Four row groups. Name and Caption edit sheets with one field. Keep a copy toggles the stored preference with inverted wording (C6). Read the folder again triggers a rescan and shows the last time. Remove gallery opens the confirmation dialog ("Keep" or "Remove").
- Back behaviour: to the Library, or to the same photograph when entered from the viewer, skipping the curtain.

3e. Share (S)
- Wrapper: Capacitor `Share.share` on iOS, `navigator.share` on the web, with `canShare` check; AbortError means the person dismissed it and nothing more happens; refusal falls to the four-row sheet. Payload is name, caption and address only.
- Tests: share called with the right payload; fallback shows when absent; Copy link writes the address.

Exit criteria: Library and Details pass parity screenshots; streamed rails load only near view (assert request count on a long gallery); drag threshold test; Add sheet usable with the keyboard up on a real iPhone.

## Stage 4: Reorder (M)

- Pinned top bar with Cancel, title and Save (disabled until a change). Uniform-height cells through a single height variable (default 88px), widths from each photograph's aspect ratio, rows left-aligned and ending where they end.
- Size slider 56 to 248px pinned at the bottom with a label for assistive technology; the value persists for the session.
- Instruction line only; remove the visible "Moved … to position N of M" line, keep a visually hidden live region announcing it.
- Keep tap-to-pick, tap-to-place, the picked outline and moved-position markers in the data hue.
- Tests: the admin reorder spec (visible message assertions removed; live region asserted instead), slider range, no cropping (rendered aspect ratio equals source).

Exit criteria: reorder parity screenshots at slider minimum, default and maximum; Save disabled until a move; screen-reader announcement verified.

## Stage 5: Welcome, Settings, Visionary, Privacy (M)

- Welcome: one sentence, three sign-in buttons (Apple first), no photographs, large logo here only. Remove the dictionary tagline, the "WOW-est" line and the "CONTINUE WITH" label. Keep Apple's sign-in requirements (button style and order) satisfied; confirm against the review notes in `submission/`.
- Settings: Account, Plan, This iPhone, About, Delete account, as in the handoff. The usage meter and vault meter use the data hue.
- Visionary sheet and the `Go Visionary` entry points (Settings and the Library over-limit line). Keep the RevenueCat product id and the `will_pay` entitlement. Replace placeholder figures (Q6). Keep the store sheet one tap further.
- Privacy: shared module in `packages/core` holding the policy text and its date; `app/routes/privacy.tsx` and the native screen both render it. In-app screen with the same top bar, back to origin. Unit test that the web route and the native screen read the same module.
- Update the label changes from the handoff (C7) in specs and in `submission/01`, `02`, `06`.

Exit criteria: sign-in flows unchanged functionally (run the auth specs); privacy text identical on web and native; no mention of "Pro" remains in user-visible strings (search the repo).

## Stage 6: Web and desktop parity (L)

Scheduled from the shared Stage 0 contracts as part of the coordinated release — web and desktop work proceeds alongside the later native stages rather than waiting on a native merge. *(28 Oct 2026: the former gate — "only after native is merged and the owner has answered Q2" — is superseded by the coordinated-release decision.)*
- Web dashboard (`Admin.tsx`): adopt the tokens, Library layout, Details route and Add sheet, reusing Stage 1 and 3 components. At 1440 x 900 and 2560 x 1440 decide the Library column width and rail behaviour (hover arrows are not needed; drag and wheel are).
- Desktop (`desktop/`, Tauri): `Catalogue` and `ShareFlow` get the same tokens and copy. Do not redesign `ShareFlow`'s flows in this pass.
- Update the web Playwright specs and the owner-scoped routing checks.

Exit criteria: web matrix green at all three sizes; desktop builds and passes its smoke path.

## Stage 7: Hardening and release (M)

1. Accessibility: keyboard and screen-reader pass on every screen; contrast check of all text tiers; focus order; reduced motion; 44px targets (automate with a Playwright check where possible).
2. Performance: curtain frame time on an older iPhone; rail memory on a 500-photograph gallery; thumbnail request counts; no layout shift from the logo or arrows bar.
3. Cleanup: remove the `--admin-*` aliases and the unused font files; delete dead components and their tests; correct `todo.md` line 42.
4. Evidence: recapture the six-state matrix under `demo-captures/{ios,ipad,macos}/` from fresh bundles (opening screen, gallery curtain, first image with controls, display popover, signed-in surface, Global View).
5. Submission documents: update `submission/` text for the new names and flows; re-read the App Store review notes for any step that no longer exists (the brand pill, "View subscription options").
6. Release candidate on TestFlight; smoke test on at least one small and one large iPhone, in portrait and landscape, with a kept gallery and a streamed one, a gallery with Content Credentials and one without, and an iCloud gallery.

Exit criteria: everything in the handoff's Definition of Done.

## Dependencies and ordering

- Stage 0 blocks everything. Stage 1 blocks 2 to 5. Stage 3a blocks 3b and 3d. Stage 5's shared privacy module is independent and can go early. *(28 Oct 2026: superseded — "Stage 6 waits for native" is replaced by the coordinated-release decision: web and desktop work is scheduled from the shared Stage 0 contracts and proceeds alongside the later native stages.)*
- Parallelisable after Stage 1: Stage 2 (viewer), Stage 3 (library and details), Stage 4 (reorder) and Stage 5 (welcome, settings, privacy) touch mostly different files. Run them as separate `feat/redesign-*` branches off `feat/iphone-redesign` and integrate in dependency order. *(28 Oct 2026: see the megaplan §7 phase graph P0–P12 for the authoritative ordering — and its warning that "mostly different files" is not permission for concurrent edits to the Viewer/GalleryShell and GalleryList monoliths; only one active lane edits each.)*

## Risk register

| Risk | Likelihood | Mitigation |
|---|---|---|
| Viewer rewrite breaks strip physics or video slides | Medium | Sub-steps 2a to 2g are separately mergeable; run the video, fold and ad specs at the end of each |
| Library rails on large galleries blow memory or the network | Medium | Near-view loading, bounded concurrency, virtualise rails beyond a threshold, measure on a 500-photograph gallery |
| Backdrop blur stutters on older iPhones | Medium | Opacity-fade fallback chosen by `fps-probe` |
| Manifest or vault record changes need a migration | Medium | Additive fields only; fill lazily; old records still render with a neutral placeholder |
| iOS keyboard covers half-height sheets | High | Visual-viewport resize; real-device test in Stage 3c |
| App Store review flags the new Library ad slot | Medium | *(28 Oct 2026: resolved — house creative only; do not wire AdMob in the redesigned Library)* |
| Playwright specs depend on removed labels and the brand pill | High | Stage 0 locator inventory; update specs in the same commits |
| Placeholder figures reach production (Visionary numbers, sample C2PA data) | Low | Stage 0 task 5; grep for the sample strings listed in the handoff before release |

## Acceptance checklist (tick before release)

- [ ] Stage 0 baseline and code map recorded in the handoff
- [ ] Tokens, fonts and shared components merged; logo position identical on all screens
- [ ] Viewer chrome, Display and Info sheets, curtain, arrows bar, One by one fade, end card
- [ ] Strip arrow tests (one width, early end, wide photograph, back, wrap, rapid presses)
- [ ] Content Credentials per photograph, no batch anywhere
- [ ] Library with rails (kept and streamed), Add sheet, Gallery details, Share
- [ ] Reorder: uniform height, slider, no visible "Moved" line, live region
- [ ] Welcome, Settings, Visionary, in-app Privacy from one shared module
- [ ] `TECH-SPEC.md` updated for C1 to C7; Playwright matrix green at three sizes
- [ ] Evidence recaptured; submission documents updated; TestFlight smoke test done
- [ ] No sample data or "Pro" wording left in user-visible strings
