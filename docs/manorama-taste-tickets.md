# manorama taste implementation tickets

Implementation backlog · 1 November 2026

Sixteen tickets derived one-to-one from the baseline `manorama-taste-review.md`. These are portable ticket specifications, not issues published to GitHub or Linear. They describe the project's state at drafting time — check the current branch for status; no assignees, estimates or deadlines are implied.

## Baseline and working rules

- **Baseline:** review of `thecont1/manorama` at `264af13f69c5ff8de74c3e2dfcfd84caa3a1d850`. Recheck the current branch before coding; close a ticket as already resolved only with current evidence.
- **Priority:** P1 corresponds to review Priority A; P2 corresponds to Priority B. P1 means the first improvement pass, not an outage.
- **Evidence:** `manorama-taste-review.md` and the captured frames under `docs/redesign-parity/` (web captures in `web/`, native captures in `native/`). Fresh browser captures establish UI evidence, not actual iOS/macOS runtime certification.
- **Protected contracts:** uncropped photographs, density-aware image fitting, strip stepping and docking, natural-ratio rails, single-photograph Content Credentials, vault semantics, publication consent and owner/visitor permissions.
- **Protected choices:** Bricolage Grotesque, warm ink, quiet surfaces, the colourful mark, magenta for progress/selection, the approved frosted curtain and dissolve, and one-word viewer controls.
- **Scope discipline:** one review finding per ticket. Change shared primitives only with consumer tests; do not redesign unrelated operator screens or change billing, storage or publication policy to simplify the UI.
- **Readiness:** “Ready after baseline check” permits implementation planning, not automatic execution. Decision-gated tickets stop at their stated checkpoint.

## Backlog index

| ID | Priority | Ticket | Review | Dependencies / gate |
|---|---|---|---|---|
| TASTE-01 | P1 | Restore a compact web Library header | A1 | Header decision; coordinate with 04 |
| TASTE-02 | P1 | Remove ad-column reservation when no ad renders | A2 | None |
| TASTE-03 | P1 | Replace the macOS Library pitch with the owner shell | A3 | Header contract from 01; 04 |
| TASTE-04 | P1 | Apply shared owner typography across platforms | A4 | None |
| TASTE-05 | P1 | Restore concise, consistent Welcome copy | A5 | None; coordinate with 04 |
| TASTE-06 | P1 | Add the Library rail header to macOS local Details | A6 | Header contract from 01; 04 |
| TASTE-07 | P1 | Remove the visible Reorder move log | A7 | None |
| TASTE-08 | P1 | Replace prototype Visionary benefit copy | A8 | Product-policy verification |
| TASTE-09 | P2 | Keep revealed viewer controls off photographs | B1 | Interaction design approval |
| TASTE-10 | P2 | Distinguish Publish from Share link on macOS | B2 | Coordinate with 06 |
| TASTE-11 | P2 | Reduce redundant values in Gallery details | B3 | Coordinate with 06 |
| TASTE-12 | P2 | Tighten Library metadata spacing | B4 | 03 and 04 for cross-platform verification |
| TASTE-13 | P2 | Use the shared Settings gear on iOS | B5 | None |
| TASTE-14 | P2 | Clarify Display hints at narrow widths | B6 | None; coordinate with 09 |
| TASTE-15 | P2 | Bring Privacy into the shared reading style | B7 | 04 |
| TASTE-16 | P2 | Standardise action labels and touch targets | B8 | Final integration after affected UI tickets |

## Shared shell and Library

### TASTE-01 · Restore a compact web Library header

- **Priority / readiness:** P1; design decision required.
- **Problem:** the reviewed web Library uses a 560×187px wordmark at 1440px and pushes the first gallery down. The latest reviewed commit introduced this deliberately, so do not silently classify it as a regression.
- **Scope:** propose one compact owner-header contract based on the shared 140×47px mark and 52px bar. Put Library and Add on the same title row. Keep the large wordmark on Welcome only. Obtain product-owner confirmation of this reconciliation before replacing the newer header.
- **Code:** `app/islands/Admin.tsx`; `app/styles.css` selectors `admin-hero-brand`, `landing-brand-mark`, `admin-library-heading`, `admin-add-pill`; shared `TopBar`.
- **Acceptance:**
  - [ ] Header placement, logo size and responsive behaviour are documented and approved.
  - [ ] Library and Add share a row without overlap at 375/390px and enlarged text.
  - [ ] Owner Library no longer renders a landing-page-sized wordmark.
  - [ ] Logo dimensions are reserved before loading; no logo-induced layout shift.
  - [ ] Settings, Add, account navigation and empty-state actions remain reachable.
- **Verification:** before/after captures at 390/1440/2560px, empty and populated, both owner themes. Keep Welcome unchanged in this ticket.

### TASTE-02 · Remove ad-column reservation when no ad renders

- **Priority / readiness:** P1; ready after baseline check.
- **Problem:** `.gallery-list` reserves 460px at 1440px even without `.account-ad`; inherited styling also narrows the macOS catalogue.
- **Scope:** make the two-column layout conditional on a rendered sponsored placement and scope it to the owning surface. Restore the list's available width when the placement is absent. Preserve the approved mobile placement and existing ad eligibility rules.
- **Code:** `app/styles.css`, especially the `min-width: 900px` selector; `app/islands/Admin.tsx`; `desktop/islands/Catalogue.tsx`.
- **Acceptance:**
  - [ ] Disabled, absent and unavailable-ad states leave no reserved ad column.
  - [ ] A rendered ad and the gallery list fit without horizontal page overflow.
  - [ ] macOS local Library does not inherit a web-only ad gutter.
  - [ ] Switching placement state does not reset rail position or lose gallery focus.
  - [ ] Ad targeting, visibility policy and provider integration are unchanged.
- **Verification:** inspect computed layout with ad present/absent at 899/900px, 1440px and 2560px; include the macOS minimum window.

### TASTE-03 · Replace the macOS Library pitch with the owner shell

- **Priority / readiness:** P1; depends on the header contract from TASTE-01 and typography work in TASTE-04.
- **Problem:** the macOS catalogue puts a large product pitch, greeting, plan and import explanation above the galleries, then repeats much of that in the account drawer.
- **Scope:** adopt the compact Library shell with mark, Library, Add and Settings. Retain concise local/cloud scope and actionable sync status. Move folder/import explanations to the relevant workflow, not a persistent introduction.
- **Code:** `desktop/islands/Catalogue.tsx`; `desktop/styles.css`; inherited `admin-overview` and account-drawer rules.
- **Acceptance:**
  - [ ] Returning users see galleries before repeated marketing or dictionary copy.
  - [ ] No duplicate product pitch appears in Library and account navigation.
  - [ ] Local-only users can still add folders without signing in.
  - [ ] Account, sign-in/out, sync, plan and appearance functions remain accessible.
  - [ ] Sync failures remain actionable and are not hidden for visual simplicity.
- **Verification:** signed-out/local-only and signed-in accounts; empty/populated catalogue; unavailable source; sync pending/error; minimum supported window and 1280/1440px. Exercise keyboard navigation in the packaged app before release.

### TASTE-04 · Apply shared owner typography across platforms

- **Priority / readiness:** P1; ready after baseline check.
- **Problem:** the web Library renders Manrope while newer owner screens use Bricolage; macOS and Privacy retain legacy font systems.
- **Scope:** apply the shared owner font and scale to the actual shell roots. Remove conflicting overrides only after identifying consumers. Preserve legitimate monospace for code/keys and exclude unrelated operator surfaces.
- **Code:** `app/styles.css`, `native/styles.css`, `desktop/styles.css`, `Admin.tsx`, `Catalogue.tsx`, `app/components/PrivacyPolicy.tsx`.
- **Acceptance:**
  - [ ] Computed font family for Library titles, controls, gallery names and ordinary owner-screen text is Bricolage Grotesque.
  - [ ] The font is actually loaded, including in native bundles; CSS declarations alone do not satisfy the test.
  - [ ] Owner light/dark themes retain readable contrast and hierarchy.
  - [ ] Text reflow does not clip controls, values or long names.
  - [ ] No unreviewed global font deletion changes viewer content or operator tools.
- **Verification:** runtime font checks and side-by-side Library/Details/Settings/Privacy captures. TASTE-15 owns Privacy layout changes; this ticket owns the typography baseline.

### TASTE-12 · Tighten Library metadata spacing

- **Priority / readiness:** P2; baseline diagnosis can begin independently; cross-platform verification follows TASTE-03/04.
- **Problem:** native captures separate count/source and caption too widely, weakening the gallery-card grouping.
- **Scope:** inspect the complete computed CSS cascade and fix the responsible spacing. Keep title → metadata → caption compact; reserve larger spacing for the next gallery. Do not impose fixed card heights or fill blank space with invented content.
- **Code:** `.lib-card`, `.lib-card-sub`, `.native-gallery-caption`, inherited paragraph/list rules in native/shared styles.
- **Acceptance:**
  - [ ] No-caption cards have no empty caption space.
  - [ ] One-line and multi-line captions stay visually attached to their gallery.
  - [ ] Saving status/progress can appear without overlapping adjacent text.
  - [ ] Natural image ratios, rail scrolling and full-bleed treatment remain intact.
  - [ ] Spacing tokens and any justified platform differences are documented.
- **Verification:** captures with zero/one/many caption lines, long titles, progress and enlarged text.

### TASTE-13 · Use the shared Settings gear on iOS

- **Priority / readiness:** P2; ready after baseline check.
- **Problem:** the native Library's Settings button depicts a sun-like appearance symbol rather than the gear used on the web.
- **Scope:** reuse the shared gear graphic in the existing top-bar slot. Do not move appearance controls out of Settings.
- **Code:** `native/islands/GalleryList.tsx`, `TopBar` end slot and shared icon source.
- **Acceptance:**
  - [ ] The icon is recognisably Settings and consistent with the web gear.
  - [ ] Accessible name remains “Settings.”
  - [ ] The hit area is at least 44×44 CSS pixels on touch.
  - [ ] Activating it opens Settings; keyboard focus and return navigation work.
- **Verification:** phone-size screenshot plus semantic button and navigation tests.

## Welcome, Details and editing

### TASTE-05 · Restore concise, consistent Welcome copy

- **Priority / readiness:** P1; ready to restore the previously approved wording; alternative copy requires approval.
- **Problem:** web and native Welcome use the older “WOW-est” headline and lengthy introduction.
- **Scope:** restore “Your shared folders, shown properly.” and the previously approved factual support sentence, adapted only where a platform capability differs. Keep provider sign-in controls and required legal access.
- **Code:** `app/components/PublicWelcome.tsx`, `native/islands/Welcome.tsx`, Welcome styles.
- **Acceptance:**
  - [ ] Web and native share the approved headline and consistent supporting meaning.
  - [ ] No photographs appear before sign-in.
  - [ ] Sign-in remains the clearest next action; existing providers and accessible labels are preserved.
  - [ ] The headline is compact without being forced into tiny text.
  - [ ] Sign-in error and returning-user states still fit.
- **Verification:** phone/tablet/desktop captures, 200% text enlargement, keyboard focus and sign-in initiation tests. Do not actually authenticate a user or alter provider configuration during visual QA.

### TASTE-06 · Add the Library rail header to macOS local Details

- **Priority / readiness:** P1; depends on TASTE-01's header contract and TASTE-04.
- **Problem:** local Details repeats the title in the bar and body, omits the logo and lacks the approved scrolling photograph strip.
- **Scope:** use the shared owner header and a reusable Library rail, followed by one title and concise local-source metadata. Keep platform capability differences; no cloud-only switches should be invented.
- **Code:** `desktop/islands/LocalGalleryDetails.tsx`, `app/components/GalleryDetailsView.tsx`, desktop/shared rail components.
- **Acceptance:**
  - [ ] Details shows the same gallery sequence and natural thumbnail ratios as Library.
  - [ ] The rail scrolls by trackpad/mouse and is keyboard accessible.
  - [ ] Selecting a photograph opens the correct viewer position.
  - [ ] The gallery name is not repeated in both the top bar and main heading.
  - [ ] Back preserves the relevant Library/viewer context.
  - [ ] Disconnected sources and zero-photo galleries have truthful states.
- **Verification:** local folder/card sources, one/many/no photographs, unavailable source, and narrow/wide macOS windows. Preserve original files and permissions.

### TASTE-07 · Remove the visible Reorder move log

- **Priority / readiness:** P1; ready after baseline check.
- **Problem:** `.native-editor-note` displays “Moved … to position …,” contrary to the approved behaviour, and the top bar repeats the gallery name.
- **Scope:** separate the visible instruction/status from a visually hidden live region. Keep useful picked-up, saving, saved and error feedback. Set the top-bar title to “Reorder.”
- **Code:** `native/islands/GalleryEditor.tsx`, `native/styles.css`, editor unit/interaction tests.
- **Acceptance:**
  - [ ] A completed move does not display the move sentence in the visible UI.
  - [ ] The live region still announces the moved photograph and destination.
  - [ ] The bar reads Cancel / Reorder / Save.
  - [ ] Save remains disabled until there is a change; save errors remain visible.
  - [ ] Uniform image height, aspect ratios, slider position and tap-to-place behaviour are unchanged.
- **Verification:** pick/move/cancel/save/error tests; screen-reader announcement check; screenshots before and after a move. Update tests to assert the hidden announcement rather than reinstate the removed copy.

### TASTE-11 · Reduce redundant values in Gallery details

- **Priority / readiness:** P2; ready after baseline check; coordinate with TASTE-06.
- **Problem:** the shared Details header and action rows repeat the gallery path and potentially long caption.
- **Scope:** remove the Share link row's path preview when the full address is visible above. Review Name/Caption values for editing usefulness; suppress duplicate long prose without losing the ability to inspect or edit it.
- **Code:** `app/components/GalleryDetailsView.tsx`, edit-sheet consumers.
- **Acceptance:**
  - [ ] The full address remains discoverable; Share link still works.
  - [ ] Long captions are not reproduced as competing paragraph blocks.
  - [ ] Name and Caption remain clear, accessible edit actions.
  - [ ] Empty captions, long names and disabled/locked states remain understandable.
  - [ ] No arbitrary limit is imposed on how often a useful name may appear.
- **Verification:** short/long/empty content at 375/390px and desktop; keyboard opening and closing of edit sheets; no metadata changes during visual tests.

## Plan, publication and viewing

### TASTE-08 · Replace prototype Visionary benefit copy

- **Priority / readiness:** P1; policy-verification gate.
- **Problem:** the paywall presents “256 MB → larger” and “Kept, not for 30 days” as benefits without stating clear product rules.
- **Scope:** first trace gallery limits, storage allowances and retention behaviour to their authoritative modules/configuration. Record a short source-to-copy mapping, resolve any contradictions with the product owner, then render accurate benefits from shared policy where feasible.
- **Code:** `native/islands/Paywall.tsx`, `native/lib/billing.ts`, vault-cap and retention-policy modules found during verification.
- **Acceptance:**
  - [ ] Every displayed entitlement/limit has a verified source.
  - [ ] No “larger” placeholder or ambiguous retention comparison remains.
  - [ ] If a benefit has no fixed number, the actual rule is described without inventing a number.
  - [ ] Free and active-Visionary states show appropriate actions.
  - [ ] Restore, Manage subscription, legal links and the store-price flow remain available.
  - [ ] Entitlements, product IDs and billing/retention policy are unchanged.
- **Verification:** component tests against policy fixtures; unavailable-store, active-plan and restoration states; real store sheet checked on device without making a purchase.

### TASTE-09 · Keep revealed viewer controls off photographs

- **Priority / readiness:** P2; design-gated, not ready for production implementation.
- **Problem:** temporary Library/position/Display/Info/Details controls still overlay the stage, despite the no-controls-on-photographs principle.
- **Scope:** prepare a small interaction prototype using non-image space for controls. Compare it with the current viewer and explicitly resolve how space is allocated while preserving the image viewport and scroll target. Obtain approval before changing production geometry.
- **Code after approval:** `app/components/viewer/ViewerChrome.tsx`, `app/islands/Viewer.tsx`, `.m-chrome*` rules and arrow-bar layout.
- **Acceptance:**
  - [ ] Approved prototype covers controls hidden/revealed, arrows on/off, and all view modes.
  - [ ] Controls never overlap a photograph in the approved layout.
  - [ ] Auto-hide does not repeatedly resize images or shift the current scroll target.
  - [ ] Strip stepping/docking, orientation changes, image-fit and reduced-motion behaviour remain correct.
  - [ ] Owner/visitor controls, video/fold behaviour and keyboard access are preserved.
- **Verification:** geometry assertions and before/after interaction recordings; actual iOS safe-area and macOS window tests. Stop and report any incompatible constraints rather than silently weakening the image rules.

### TASTE-10 · Distinguish Publish from Share link on macOS

- **Priority / readiness:** P2; ready after inspecting the current publication state model; coordinate with TASTE-06.
- **Problem:** “Publish/Share” conflates uploading originals to create a public gallery with distributing an existing link.
- **Scope:** label the upload/publication workflow “Publish”; expose “Share link” when a usable public link exists. Before upload consent, name the destination and explain what will be sent. Preserve cancellation and existing publication behaviour.
- **Code:** `desktop/islands/LocalGalleryDetails.tsx`, `Catalogue.tsx`, `ShareFlow.tsx`.
- **Acceptance:**
  - [ ] Local-only and published galleries have truthful, distinct actions.
  - [ ] Opening the workflow never starts an upload without explicit consent.
  - [ ] Existing-link sharing does not unnecessarily republish or upload files.
  - [ ] Unconfigured-provider, signed-out, uploading, cancelled and failed states are clear.
  - [ ] Retry does not accidentally duplicate publication.
- **Verification:** state-machine/component tests with mocked providers; system sharing checked in packaged macOS. “Not configured in this build” in a fixture is not treated as a production incident.

### TASTE-14 · Clarify Display hints at narrow widths

- **Priority / readiness:** P2; ready after baseline check; coordinate with TASTE-09 if sheet placement changes.
- **Problem:** Canvas meanings require explanation, but long inline hints compete with labels at narrow widths.
- **Scope:** retain concise help that distinguishes Blank/Dark/Light and the layouts. Stack help below controls when needed. Preserve contextual keyboard-shortcut help rather than showing or hiding it solely based on viewport width.
- **Code:** `app/components/viewer/DisplaySheet.tsx`, shared sheet-label/hint styles, capability detection in `Viewer.tsx`.
- **Acceptance:**
  - [ ] All options remain understandable without reading a cramped side label.
  - [ ] No overlap or clipping at 375px and 200% text enlargement.
  - [ ] Touch-only and fine-pointer contexts show appropriate help.
  - [ ] Changes still apply immediately and persist as before.
  - [ ] Focus trapping, Escape and return focus remain correct.
- **Verification:** separate touch/fine-pointer fixtures, not merely phone/desktop viewport sizes; include native device keyboard checks where supported.

### TASTE-15 · Bring Privacy into the shared reading style

- **Priority / readiness:** P2; follows TASTE-04.
- **Problem:** Privacy switches to serif prose, a tracked monospace date and nested cards that feel detached from the app.
- **Scope:** retain all legal text and its shared source, but use the app reading typography, consistent headings and a simpler single-column layout. Preserve originating-screen navigation; keep Print a desktop utility.
- **Code:** `app/components/PrivacyPolicy.tsx`, `.policy-document*` styles, native Privacy wrapper and route.
- **Acceptance:**
  - [ ] Legal wording, dates and destinations are unchanged.
  - [ ] Body type and headings follow the shared system and remain readable in both themes.
  - [ ] No unnecessary nested card frames interrupt continuous prose.
  - [ ] Native Privacy stays in-app; Back returns to its origin.
  - [ ] Desktop printing remains usable; phone controls do not crowd the header.
- **Verification:** text-content comparison before/after; 390px and desktop screenshots; enlarged text, long links, print preview and back-navigation tests.

## Integration and release

### TASTE-16 · Standardise action labels and touch targets

- **Priority / readiness:** P2; define the label table early, verify after affected tickets land.
- **Problem:** Add/Add Gallery, Library/Your galleries and rescan labels vary; some controls use sub-44px sizing.
- **Scope:** define canonical labels and documented platform exceptions, then apply them across the affected screens. Measure actual hit areas, not just visible glyphs or CSS declarations. Preserve one-word viewer controls without applying that restriction to explanatory forms.
- **Code:** shared buttons and icons, `admin-add-pill`, `native-editor-cancel/save`, `Catalogue.tsx`, `LocalGalleryDetails.tsx`, relevant accessible-name tests.
- **Acceptance:**
  - [ ] A concise copy table defines the canonical labels and intentional exceptions.
  - [ ] Touch controls have at least 44×44 CSS-pixel hit areas without overlapping neighbouring targets.
  - [ ] Compact desktop controls remain legible and keyboard accessible.
  - [ ] Long labels and enlarged text do not truncate essential meaning.
  - [ ] Accessible names, locators and documentation match the final visible wording.
- **Verification:** automated bounding-box checks in touch contexts, tab-order tests and cross-platform screenshot comparison. Do not pad invisible targets over photographs to make the numbers pass.

## Suggested delivery sequence

- **Independent first fixes:** TASTE-02, 07 and 13 can land separately; TASTE-04 establishes the typography baseline. TASTE-08 can begin its policy investigation in parallel.
- **Shell consolidation:** approve TASTE-01's header contract, then implement 01, 03 and 06 in small changes. Coordinate shared styles to avoid concurrent contradictory edits.
- **Content and polish:** 05, 08, 10, 11, 12, 14 and 15. TASTE-16 supplies the final consistency pass.
- **Viewer geometry:** TASTE-09 runs as its own reviewed design/implementation track. Do not bundle it into token or copy cleanup.

## Common definition of done

- [ ] Current-branch baseline checked; each ticket links its review finding and implementation diff.
- [ ] Before/after evidence captured with equivalent data, viewport and theme.
- [ ] Relevant unit and interaction tests pass; changed labels update tests without weakening behavioural assertions.
- [ ] Web checked at 390/1440/2560px; native UI at 375/390px; macOS at minimum supported window and 1280/1440px where affected.
- [ ] Relevant empty/populated, ads absent/present, long-content, light/dark, keyboard/touch and reduced-motion states covered.
- [ ] Protected photo geometry, strip navigation, credentials, vault and publication contracts remain green.
- [ ] Actual WKWebView/Tauri checks completed for changed native behaviours before release. Browser mocks alone are not the native release gate.
- [ ] No prototype entitlement copy, synthetic test content or development-only configuration message is accidentally presented as production product information.

## Explicitly excluded

Do not create tickets to vertically centre Reorder, add icons to every share option, remove approved curtain blur, rename Details to Gallery, or remove useful Info-dialog identification. Do not carry forward unmeasured address-contrast, slider-overlap or end-card claims from the old prototype review. These were withdrawn or left unverified in the final review.
