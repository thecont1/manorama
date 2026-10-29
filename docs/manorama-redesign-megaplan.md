---
agent: devin-local
session: lava-donut
created: 2026-10-28T00:05:27Z
---
# Manorama redesign megaplan

Implement the approved photography-first design across native, desktop, and web through phased PRs, preserving media integrity and existing platform capabilities, then prepare one coordinated release.

## 1. Status, authority, and objective

**Status:** owner-approved 28 October 2026; implementation in progress. Grounded in source inspection on 28 October 2026. No application files, git references, dependencies, or services were changed during planning. Builds, tests, browser comparisons, and physical-device measurements had not been run when the plan was written.

**Inspected checkout:** `feat/iphone-redesign` at `69e334ae302b8f71657f77549d17a480c1e30b75`. Local `main` and `origin/main` both resolve to `08409df65b3e453edf6627a958d65326cd99ce5b`. The working tree was clean. Recheck at implementation start.

**Outcome:** one recognizable visual family, organized into Looking, Galleries, and Upkeep. Opening photographs remains the primary task; publishing, storage, account, and subscription controls move into deliberate management surfaces.

Authority, in order:

1. Owner decisions recorded in this planning conversation, including the explicit exceptions below.
2. Repository invariants in `AGENTS.md`, particularly original-byte integrity, no durable server-side image storage, platform boundaries, tier transitions, and provider-safe deletion.
3. `docs/manorama-redesign-decisions.md`.
4. `docs/manorama-redesign-handoff.md`, interpreted using the confirmed code map below.
5. `docs/manorama-redesign-execution-plan.md`, revised by this plan's dependencies and current implementation findings.
6. `docs/redesign-prototype/{index.html,app.css,app.js,data.js}` for visual and interaction reference, not production logic.
7. `TECH-SPEC.md`, `README.md`, `docs/manorama-operations.md`, and current tests for behavior not deliberately changed.

The prototype's presentation frame, fake phone status bar, navigation sidebar, sample accounts, simulated scans, synthetic C2PA results, artificial loading delays, and scaled source dimensions are not application requirements. Its wide layout is a proposal viewer, not the desktop app layout.

## 2. Decisions settled with the owner

| Topic | Approved decision | Implementation consequence |
|---|---|---|
| Platform scope | Every surface | Include iPhone, iPad, Android shell, desktop macOS/Windows/Linux, public web viewer, web owner dashboard, Welcome, quick-add, privacy, and existing operations UI styling. |
| Completion | Release ready | Real services, accessibility, lifecycle tests, native evidence, release artifacts and updated review instructions. |
| Packaging | Phased PRs | Dependency-ordered reviewable changes, integrated into `feat/iphone-redesign`. |
| Source precedence | Decisions first | Prototype contradictions are corrected, not silently reproduced. |
| iPhone imports | Defer | No new native folder/photo import or upload service; omit unsupported picker buttons and their public-link promise. Existing desktop folder/card workflows remain. |
| Viewer chrome | Temporary overlays allowed | Top and bottom controls may overlay the photograph for three seconds after interaction. Arrows still reserve a dedicated bar below images. |
| Library sponsored slot | House only | Restyle the existing account placement, preserve eligibility/master suppression, disable live AdMob for this redesign. |
| Picker and fold access | Preserve | Count button and `G` open the picker; Settings controls native cross-gallery scope; Display holds fine-pointer shortcut help; automatic fold/Diptych remains. |
| Owner themes | Keep both | Design and verify light and dark owner screens; do not conflate owner theme with viewer canvas. |
| Web Photo Editor | Keep horizontal row | Preserve the owner-approved non-wrapping web editor. Native Reorder remains a vertical matrix. |
| Signed-out visitor exit | Omit Library | Visitor viewer has Display, Info, picker, and Rewind; no Library or Details. |
| Release timing | One coordinated release | Validate iPhone early but do not ship it separately. September submission deadlines are historical. |

These answers supersede the earlier plan's native-first release, dark-only presentation, off-by-default new ad-placement assumption, and no-controls-over-photographs statement. Update those statements in the implementation documentation PR so future agents do not resurrect them.

## 3. Scope and explicit exclusions

### Included

- Welcome/sign-in, Library, Add, Gallery details, Reorder, Settings, Visionary, Privacy, share fallback.
- Viewer curtain, temporary chrome, Display and Info sheets, arrows bar, single-image fade, end card, picker entry.
- Existing photo/video, C2PA, magnifier, fold, ad cadence, entitlement, vault, account deletion, provider-link, deep-link, and desktop publishing functionality.
- Real Library progress and cached/streamed states; bounded loading for 500- and 1,000-item galleries.
- Dark/light owner themes and responsive adaptations; same controls with platform-appropriate labels.
- Current operations screen (`opman`/`AdminOps`) gets typography, tokens, and regression coverage; its administrative workflows are preserved.
- Existing legal and release surfaces, including Apple sign-in prominence, purchase restoration, customer management, subscription cancellation guidance, and noindex/security headers.

### Excluded

- New iPhone/Android folder or photo import; native photo publishing; new storage/upload providers.
- New desktop cloud-gallery browsing or encrypted desktop vault. Desktop keeps its local folder catalogue and explicit provider publishing.
- Server image caches, server thumbnail generation/persistence, new image formats or source re-encoding.
- Social features, ambient surfaces, widgets, screensavers, new platforms, P2P work, unrelated dependencies/security refactors.
- A new marketing site beyond the actual Welcome/public routes; no invented testimonials, example galleries, or stock photographs.
- Changes to product IDs, entitlement identifiers, tier semantics, scanner ordering rules, retention limits, or webhook logic.
- Publication, production deployment, remote migrations, store submission, release tags, or merges to `main` as part of implementation approval. Prepare these concretely for the final owner release step.

## 4. Confirmed code map and corrections to the earlier plan

| Concern | Confirmed current implementation | Required change |
|---|---|---|
| UI runtime | Hono JSX / `hono/jsx/dom`; `tsconfig.json` uses `jsxImportSource: hono/jsx` | Use existing runtime. Do not add React, Preact, a router package, or a component library. |
| Native shell | `native/main.tsx` renders `native/islands/GalleryList.tsx` | Extract screen composition while retaining auth, billing, deep-link and resource ownership. |
| Native navigation | `GalleryList.tsx` has conditional returns for viewer, editor and paywall; `frameKick` remounts frame selections | Introduce explicit screen/return state and preserve the viewer session during Details. |
| Curtain | `app/components/GalleryShell.tsx`; dismissal listeners inside `app/islands/Viewer.tsx`; shared CSS | Coordinate both files. Changing Viewer alone cannot implement the curtain. |
| Viewer | `app/islands/Viewer.tsx` contains navigation, filmstrip, modal, C2PA, decode and ad actionability logic | Change presentation in bounded steps; keep one owner of this file throughout implementation. |
| Image geometry | `packages/core/image-staging.ts` already contains single-mode contain sizing and native/web DPR handling | Keep math; portrait-width/landscape-height plus overflow-contain is already equivalent for stills. Change transitions and reserved stage height. |
| Web owner boundary | `app/routes/[owner].tsx` verifies the signed-in account before listing galleries | Preserve this authorization for all management screens. |
| Public viewer boundary | `app/routes/[owner]/[slug].tsx` renders GalleryShell + Viewer without owner action props | Derive owner privileges server-side before enabling Details; never infer ownership from a client URL. |
| Web management | `app/islands/Admin.tsx` owns creation, editing, reorder, theme and account actions | Separate shared presentation from cookie-authenticated commands. Preserve horizontal editor. |
| Media summaries | `app/lib/gallery-repository.ts`: `toSummary` includes all `previewImages`, with dimensions, placeholder, variants, video poster | No thumbnail-manifest endpoint or mandatory D1 migration needed for rails. |
| Placeholder | `GalleryMediaItem.placeholder` exists; provider implementations often use a neutral SVG | It is not verified average color. Show existing placeholder first; derive optional color locally only after bytes are already available. |
| Offline storage | `native/lib/offline-gallery.ts` stores original bytes under `thumbnailEntryId`; metadata v1 is written last as a completeness commit | Preserve original-byte cache and atomic completeness. Do not claim partially filled galleries are offline-ready. |
| Existing grid loader | `native/lib/global-view.ts`: `GridThumbLoader`, four reads concurrent, 96 live URLs by default | Reuse read/materialization ideas, but make Library leases visible-window-scoped and cancellation-aware; a URL count alone does not bound original-byte memory. |
| Native settings | `VaultSettings.tsx`, `vault-settings.ts`, `global-view.ts` | Reuse controllers; retain cap choices and explicit purge controls, even though prototype omits some. |
| Offline opening | `openGalleryNetworkFirst` fetches online and falls back to vault for network failures, invalidating on authoritative HTTP failures | Keep viewer opening semantics. Vault-first Library painting is a separate behavior. |
| Reorder identity | `GalleryEditor.tsx`: `orderKeyOf = ref ?? filename ?? id`; server uses `ref ?? filename` | Use provider ordering key, not presentation ID. Keep save/read-back verification. |
| Reorder bound | `MAX_GALLERY_ITEMS = 1000`; PATCH order currently slices at 500 | Fix the directly relevant bound before claiming 1,000-item reorder works. Preserve input validation and request limits. |
| Add name | POST creation uses provider title or quick-add random name; no ordinary title override currently | Add an optional validated ordinary-create title in the existing request, atomically with create. |
| Read timestamp | Gallery record has `createdAt`, no persisted last-read time | Show success-time feedback only when known in the current session; omit unknown historical timestamp. Do not relabel creation time. |
| Account name | PATCH account accepts `ownerSlug`, not display name | Name is informational; Address is editable. No fake chevron or unimplemented edit. |
| Tier limits | `app/lib/gallery-policy.ts`: 3 retained free, 99 paid, 30-day pipeline | Count retained galleries, not all list rows. Preserve read-only temporary galleries. |
| Native quota | `vault.ts`/`vault-settings.ts`: free 256 MiB, paid configurable larger/unlimited, paid default still 256 MiB | Accurate copy; never promise paid automatically enlarges or downloads everything. |
| Billing | `native/lib/billing.ts`: `will_pay`, `in.thecontrarian.manorama.visionary.annual`; Paywall currently auto-opens | Add explicit Visionary introduction; store UI opens only on its CTA. Preserve restore/manage. |
| Advertising | Existing native account slot and `admob-account-adapter.ts`; `/api/ads/visibility` already suppresses placements | Reuse policy, no new placement API. Do not pass live adapter for redesigned Library. |
| Desktop | `desktop/islands/Catalogue.tsx`, `ShareFlow.tsx`, `desktop/lib/{catalogue,share,tauri,theme}.ts` | Adapt local catalogue truth; do not present local folders as publicly shared galleries. |
| Fonts | Bricolage variable already in `public/fonts`; shared CSS still imports external fonts and uses `Bricolate` aliases | Standardize to Bricolage Grotesque; remove remote font request when migrated; preserve required assets until all consumers move. |
| Assets | Both native and desktop Vite configs use `../public` | One bundled font/logo asset source, not three copies. |
| Release side effects | `deploy.yml` deploys and applies remote migrations on main push; desktop release responds to tags; iOS workflow archives/uploads | Integration branch and explicit release handover are essential for coordinated release. |

Supporting files inspected include `README.md`, `TECH-SPEC.md`, `VERIFICATION.md`, `docs/manorama-operations.md`, `docs/native-launch-plan.md`, the design brief/memo/map, `package.json`, Vite configs, representative unit/browser tests, and CI workflows.

Research limits: source inspection is complete enough to specify the changes, but no current baseline is asserted green. Prototype behavior was inspected in source, not claimed visually matched in a running browser. DEV research and Engram writes were attempted but refused by planning-mode tool restrictions; no community claims are used as design evidence.

## 5. Product and interaction contract

### 5.1 Shared visual language

- Dark owner palette: ground `#0a0a0a`, surface `#161616`, raised `#262626`, ink `#f3f0e8`, secondary `#b8b4ab`, meta `#98948c`.
- Light owner palette proposal for implementation: ground `#f3f0e8`, surface `#e9e5dc`, raised `#ddd8cd`, ink `#171715`, secondary `#49473f`, meta `#5a574f`. Verify contrast on actual adjacent surfaces before visual acceptance.
- Keep data pink `#fc0fc0` for progress and selected/moved photographs. On light surfaces use an ink outline/track and explicit text/shape as well; pink alone must not communicate state or carry small text. Theme-appropriate red is reserved for destructive actions.
- Primary action is neutral inversion: cream-on-dark or ink-on-light, full pill. No pink navigation/actions.
- Bricolage Grotesque variable only for application typography; titles 28/700, sections 17/650, body 16, metadata 13, tabular figures. Native system purchase/auth UI is an external exception.
- Panels 14px, sheets 22px, photographs square. No panel shadows; shadows are confined to modal surfaces.
- Shared logo box 140×47 CSS px inside a 52px bar, horizontally centered relative to the active content pane. Derive vertical position from real safe area, not the prototype's fake status bar or hardcoded y=16.5.
- Welcome uses the same logo asset and 140×47 box positioned as the opening focal point, resolving the documents' “large logo” versus fixed-size conflict in favor of the explicit decisions record.
- All actionable targets at least 44×44; rows nominally 56px but expand for large text. Visible numeric badges may be smaller while the button hit area remains 44px.
- Owner theme remains independent of viewer Canvas. The viewer retains its selected Black/Dark/Light treatment and neutral readable chrome.
- Preserve existing theme persistence on web/desktop (`manorama:theme`); expose a Theme row in Settings. Native uses the same `manorama:theme` localStorage key (amended in P1: Capacitor Preferences is async and cannot apply the class before first paint; a theme is not sensitive). Pre-paint application uses a same-origin `public/theme-init.js` because production CSP forbids inline scripts. Viewer appearance (doodle ink, canvas) must follow the viewer Canvas, never `html.light`. Do not add account-side theme storage or persist web gallery/library data.

### 5.2 Responsive layouts

- Compact, below 720px: one Library column, 20px gutters, full-width rails; sheets dock to bottom safe area.
- Medium, 720–1199px: two Library columns when each has at least 320px; Details/Settings use a centered reading column up to 720px. Layout responds to available pane width, not device-name checks.
- Wide, 1200px and above: Library max-width 1440px, two equal `minmax(0,1fr)` columns with 40px gaps; settings/details max-width 800px. No tiny phone mockup inside the desktop application.
- Rails remain horizontal and bounded by the card (`min-width:0`). Library page scroll is vertical; a rail must not capture a vertical swipe before horizontal intent is established.
- Rail image band: `clamp(88px,16dvh,180px)`, zero gaps, aspect-true frame widths. An original smaller than the pixel budget stays centered within its aspect-true slot without upscaling.
- Native picker/Global View retains its existing viewport-relative equal-height vertical matrix and pink selection; native Reorder has its separate 56–248px size slider, default 88px.
- Web Reorder stays one non-wrapping row, sideways scrolling within its screen/card, same aspect integrity and visible selection. Do not reuse the native matrix CSS accidentally.
- Fine-pointer desktop uses keyboard and wheel as well as drag. Preserve Tauri titlebar drag regions; interactive controls are not draggable regions.
- Fold-aware layout uses existing segment geometry. Do not allow a modal, logo, control target, or photograph to straddle a physical hinge.
- Short landscape/keyboard views use available visual viewport height. Add's nominal half-height may grow within that available height for accessibility; internal content scrolls and the CTA stays reachable.

### 5.3 Viewer and curtain

- New entry through Library or a public link shows the curtain over the actual target photograph. Rail entry uses the selected image's stable identity, including when it is the last frame.
- Curtain text opacity takes 350ms; veil/blur dissolution takes 1100ms, starting with dismissal. Content fades faster within the same dissolve; no unnecessary sequential 1450ms delay. Reduced motion uses the decision record's 200ms opacity-only curtain fade.
- Decode the revealed target before showing it sharply; keep a bounded loading/error fallback if decoding fails. Do not leave the curtain stuck on image failure.
- Chrome appears when the curtain completes and on deliberate taps, then hides after three seconds. A drag, wheel gesture, magnifier gesture, video action, or ad click is not a chrome toggle.
- Top: owner Library action and position. Bottom: Display, Info, owner-only Details. No share action, logo pill, plan, or storage controls in the viewer.
- A signed-in non-owner may return to their own Library, but never receives Details for someone else's gallery. A signed-out public-link visitor gets neither Library nor Details.
- Auto-hide pauses while a sheet is open, while focus is within chrome, or while assistive interaction requires controls. Hidden controls are unfocusable and noninteractive; resuming interaction starts a fresh timer.
- Small position count remains the picker affordance at rest. This and the temporary overlay are explicit exceptions to the handoff's blanket no-overlay wording.
- Arrows reserve 64px plus the bottom safe-area inset below the stage. Their bar never overlaps image bounds. Scroll arrows stack at bottom-right. Default pointer/mode behavior is preserved.
- ResizeObserver/stage measurement must use the resulting content rectangle. An arrow toggle preserves current photograph and relative position; do not change strip navigation physics to compensate.
- Preserve `advanceStripByViewport`: current/pending destination, max one stage width, early frame docking, wide-image chunks, back-wrap at start, runtime ad/end frames. Normalize the first-frame dock to zero for Dark/Light without introducing a dead back press.
- Single mode retains existing density-aware contain math. Replace the directional sweep with 90ms fade out and 160ms fade in after decode. Request generation cancels stale decode/animation completions; rapid navigation commits only the latest target. Reduced motion swaps immediately.
- Rewind has a dedicated 750ms ease-in-out animation in Strip/Scroll, instant under reduced motion; single resets to first image. Do not globally replace `settleTo` timing used by ordinary navigation.
- End card is reachable in all three layouts and has Rewind plus Library only when that destination exists. Ad plates are never the last content item and do not affect the position count.
- Display: Strip/Scroll/One by one, Black/Dark/Light, Arrows, web-only Fullscreen, fine-pointer shortcut help. Labels map to current persisted enum values (`strip/vertical/single`, `none/dark/light`); no preference migration required.
- Info: genuine position, filename, dimensions, available caption/EXIF, per-image C2PA. Missing camera/signing data is omitted or explicitly unavailable.
- C2PA checks are lazy, client-side and serialized to one photograph; opening Info on a flagged unchecked still starts it. Deduplicate repeated opens, cancel or discard stale results on navigation, free readers in `finally`, and preserve retry/unavailable behavior. No batch verification or upload.
- Keep `I`, Shift+I, `G`, magnifier `M`, and relevant Escape/arrow/Home/End behavior. Shift+I retains video/non-HTTP fallback and does not expose local asset paths externally.
- Video playback and controls remain their existing distinct contract: active-only player, muted-loop default, reduced-motion explicit Play, pause/rewind when leaving. Suspend playback when Details obscures the viewer.
- Blur fallback: feature-detect support, honor reduced motion first, and measure visible-frame cost on older devices. Existing `fps-probe.ts` only reports frame rate; it is not an adaptive rendering policy. Do not wait for a 60-frame probe before opening. If blur misses the acceptance budget, use an opacity-only scrim on the affected runtime/build; any adaptive heuristic must use visible-page samples and have deterministic tests.

### 5.4 Library, Add, Details, Share

- Newest-first Library, stable tie-break, title + Add, no account workbench. Each card has rail, name, actual item/source count, caption if present, real download status, and one menu.
- Menu order: Share link, Gallery details, Reorder photographs, Read the folder again, Remove gallery. Disable or omit inapplicable operations with explanation; pipeline galleries cannot be edited/refreshed/reordered.
- Rail drag threshold 6px; suppress click after an actual drag. Each thumbnail opens its target; title/background opens first. Menu and inner controls must never bubble into gallery opening.
- Progress is based on actual completed writes; distinguish saving, complete, streamed, unavailable, over-cap and failed. Mixed video galleries are not falsely marked kept: current offline store skips video-containing galleries.
- Account list/network error must not appear as an empty account. Vault-first Library can show cached entries while list refresh is pending, with clear freshness state. No background gallery download is started merely by listing a card.
- House-sponsored panel follows known account eligibility and master suppression. Use real house creative, not invented advertiser content. Preserve 24px separation below the Library heading/status block and 40px above the galleries.
- Add: URL, Paste, optional Name, one pinned Add gallery CTA. No iPhone local pickers. Scan/create starts on explicit submission, preserving existing direct-create behavior; no double scan or fabricated streaming scan progress.
- Optional title is sent in the create request and validated with the same length/smart-quote rules as title edits. Quick-add retains random naming and its zero-click behavior. Blank optional name falls back to provider title.
- Preserve duplicate 409 reopen, all provider errors, iCloud Drive-to-Shared-Album guidance, free overflow disclosure, paid cap rejection before scan, network retry without duplicate creation.
- Details reuses the Library header without its menu; actions grouped as Open/Share, metadata/Reorder, device/rescan, Remove.
- Keep a copy is a positive view of `!streamOnly`; retain the stored negative key and queued-write rollback behavior. Turning off future downloads does not delete existing copies. Purge remains a separate explicit device action.
- Details from viewer returns via Back to the same live viewer without curtain. Details from Library returns via Library, restoring list and rail offsets. Rename/reorder/refresh remap by stable media identity, falling back to nearest surviving frame when necessary.
- Preserve existing web slug-edit capability in an Address edit row in Details; explain that changing address changes the public link. Keep gallery title and slug independent.
- Rescan success displays “Read just now” or the actual session timestamp. Historical unknown dates are omitted. No new D1 column solely for this subtitle.
- Share payload is title, caption and public gallery URL only. Capacitor Share on mobile; Web Share where supported; otherwise fallback address plus Copy link, WhatsApp, Messages, Email. User cancellation is quiet; refusal/unsupported is fallback. Preserve user activation; encode links; never share original bytes.
- Desktop local gallery without a published URL uses its existing explicit ShareFlow and upload confirmation. Do not pretend it can use Share link before publishing.
- Remove requires a named confirmation; success only after server/local-store acknowledgement. Provider-neutral copy says originals remain at their source; never hardcode Dropbox for iCloud/Drive/MEGA/local galleries.

### 5.5 Reorder, Settings, Visionary, Privacy

- Reorder is a local draft until Save; Cancel discards. Save disabled until order differs. Preserve server read-back validation and error recovery.
- Tap-pick/tap-place plus keyboard equivalent; picked outline and moved positions in data pink; announce moves in a visually hidden live region, not a visible “Moved…” sentence.
- Slider is labeled, keyboard-operable, session-scoped; 56–248px native matrix sizing. Preserve image aspect ratios, zero gaps, and vertical page scroll.
- Settings: Account, Plan, This device (where supported), Appearance, About, Sign out, Delete account.
- Account Name is read-only, Address editable; retain sign-in identity linking/unlinking and last-identity guard where currently supported. No cosmetic removal of existing account recovery tools.
- Vault usage uses actual bytes and enforced cap, with 64/128/256 MiB free choices and existing paid choices/unlimited. Preserve purge-one/forget-all confirmations. A downgrade does not silently delete cached originals.
- Photo picker setting controls expanded native scope, not whether the current-gallery selector is accessible.
- Visionary intro shows verified benefits: 3→99 retained editable galleries, larger configurable device vault where supported, promotion of unexpired temporary galleries. Clarify 30 days concerns overflow gallery retention, not cache duration.
- Keep `pro` and `will_pay` internally; rename only user-facing Pro copy to Visionary.
- Store handoff happens on explicit CTA. iOS says App Store, Android uses actual configured store wording; web uses existing Stripe payment-link/fallback behavior; desktop must not claim an App Store purchase flow it does not implement.
- Preserve subscription management/restoration/legal links and cancellation advice before account deletion. Tier changes still enter through existing verified server paths and `setUserTier`.
- Privacy content becomes platform-free structured data in `packages/core/privacy-policy.ts`; render with Hono components in web/native/desktop. Do not copy the prototype's dated policy snapshot.
- Preserve current policy wording initially except approved terminology/capability corrections; separately review any discovered contradictions such as original-byte offline storage. Update source date only when content changes, not for a visual restyle.
- Privacy Back returns to its origin; web supports a direct `/privacy` visit; print remains legible. Contact/EULA/external links use platform-safe openers.

## 6. Implementation architecture

### 6.1 Shared UI and platform adapters

Use `app/components/` for Hono JSX UI shared by all three bundles; keep DOM hooks/utilities in `app/lib/` where current shared browser utilities already live. Do not put DOM or JSX components in `packages/core`.

Proposed files (names are implementation targets, not claims they exist):

- `app/components/ui/{TopBar,Sheet,ActionRow,Button,Meter,Switch,Segmented,Toast}.tsx`
- `app/components/{GalleryCard,GalleryRail,GalleryDetailsView,ReorderView,WelcomeView,SettingsView,VisionaryView,PrivacyDocument}.tsx`
- `app/lib/{owner-theme,gallery-share,gallery-rail-loader}.ts`
- `packages/core/{owner-navigation,gallery-presentation,privacy-policy}.ts`
- `native/lib/{library-media,owner-commands}.ts`
- `native/islands/{GalleryDetails,Settings}.tsx`
- `app/islands/GalleryExperience.tsx` for web owner-aware viewer/Details orchestration.

Keep components small and introduced when first consumed. Do not create a general design-system package, generic global store, or second data-fetch framework.

Platform seams:

```ts
type GalleryIdentity =
  | { kind: 'published'; owner: string; slug: string }
  | { kind: 'local'; galleryId: string };

type GalleryCapabilities = {
  open: boolean;
  editMetadata: boolean;
  editAddress: boolean;
  reorder: boolean;
  refresh: boolean;
  shareLink: boolean;
  publish: boolean;
  keepOffline: boolean;
  remove: boolean;
};

type ShareResult = 'shared' | 'cancelled' | 'fallback';
type GallerySharePayload = { title: string; caption: string; url: string };
```

Capabilities describe the UI, never replace authorization. Server endpoints remain authoritative; local adapters never receive cloud-delete commands. All render inputs are safe text; do not port prototype `innerHTML` construction.

### 6.2 Navigation and resource ownership

Define a platform-free discriminated screen state:

```ts
type OwnerScreen =
  | { kind: 'welcome' }
  | { kind: 'library' }
  | { kind: 'viewer'; gallery: GalleryIdentity }
  | { kind: 'details'; gallery: GalleryIdentity; from: 'library' | 'viewer' }
  | { kind: 'reorder'; gallery: GalleryIdentity; from: 'library' | 'details' }
  | { kind: 'settings' }
  | { kind: 'privacy'; from: 'welcome' | 'settings' | 'visionary' }
  | { kind: 'visionary'; from: 'library' | 'settings' };
```

- Use a small reducer plus Hono state in each shell, not prototype hash routing.
- Native `GalleryList` remains the lifecycle controller initially; extract views first, then move coherent resource operations to native helpers.
- Retain the live viewer DOM/lease when opening Details; mark it inert and visually hidden without collapsing its stage measurement, and pass `suspended=true` to stop input, video and ad actionability. Details closes back to the same instance.
- Only a new gallery, explicit picker jump that requires it, or session disposal remounts/replaces the viewer. Do not use the Details open/close event as a `frameKick` increment.
- Keep storage fill ownership above visible screens. Navigating to Details must not restart a fill; navigating away/signing out cancels appropriately. Refresh/removal/purge invalidate related rail leases.
- Native Android Back order: close sheet → cancel/confirm dirty edit → return to origin screen → Library → existing app-exit behavior. Deep links do not overwrite unsaved edits silently.
- Web dashboard keeps `/{owner}` and uses `history.state` for in-document management navigation; reload returns to Library. No new route collisions with `/{owner}/{slug}` or provider catch-all.
- Web gallery route uses new `GalleryExperience` island for owner Details in place. It passes only serializable initial data; callbacks are created within the client island.
- For rail entry into the existing new-tab web gallery behavior, use a validated transient `?photo=<media-id>` intent, mapped against the manifest. Consume and remove it with `replaceState` after hydration; ordinary navigation and subsequent reload remain clean and start at first image. Shared canonical URLs omit it. Invalid IDs start at first.
- Owner permission is derived by `resolveManoramaSession` in the public route and gated private fetches. A logged-in viewer of another owner's gallery cannot edit it.

Viewer prop additions:

```ts
type ViewerPosition = { imageId: string; index: number };
// Extend existing Props without serializing callbacks across an SSR island boundary:
onOpenDetails?: (position: ViewerPosition) => void;
onPositionChange?: (position: ViewerPosition) => void;
suspended?: boolean;
```

`GalleryShell` additionally accepts an explicit curtain-enabled state and media count. Retain existing `initialIndex`, fold callbacks, and return/picker callbacks. Remove `deviceControls` only after native Details has taken over its functionality.

### 6.3 Library media flow and memory bounds

Online summaries already expose the rail's data. Do not fetch every full manifest to render Library.

1. Read native cached catalog metadata first; paint known saved galleries without waiting for network. Start account summary refresh separately.
2. Merge by owner+slug, never title. Label cached-only/offline state; reconcile server deletion/expiry/permission failures rather than resurrecting invalid galleries.
3. For each visible rail, choose saved bytes first when available, otherwise a provider preview/poster. Offscreen rails do not start media requests.
4. Maintain aspect-sized placeholders for all cells, but materialize image elements only in the visible horizontal window plus one viewport of overscan on either side.
5. Share one Library load queue, maximum four concurrent loads. Bound active native object URLs to 24 total and decrypted source blobs to a 64 MiB cache budget; pin currently displayed leases and queue further work when the budget is exhausted. A single source larger than the budget is shown alone and released on leaving its window.
6. Use per-cell acquire/release ownership; revoke after consumers detach, not underneath visible images. Cancel queued jobs and discard late completions on unmount, purge, gallery revision, sign-out or account change. Zero plaintext temporary byte arrays in `finally`.
7. Current offline progress only reports counts. Extend the cache callback with an optional per-item-ready descriptor (`id`, `entryId`, `mimeType`, `index`), emitted after successful vault write. Existing consumers remain compatible.
8. Publish these descriptors to an in-memory native Library cache-fill registry so visible rail cells can switch to saved bytes as they land. Do not write a partial metadata v1 completeness record.
9. On complete fill, metadata remains the final commit after survival checks. On over-cap/error/cancel, mark partial progress honestly and invalidate in-flight preview handles. Preserve existing old complete copies where the storage operation currently guarantees them.
10. Read stored placeholder as data, not trusted markup. Optional average-color computation uses already decoded preview bytes on the client, never extra original fetches or re-encoding. Cache only in memory for web; native may add an optional color map to encrypted metadata. Old metadata without it remains valid.
11. A first streamed view may use a neutral placeholder until genuine color is known. Do not claim the current SVG represents an average color or fetch media merely to manufacture one.
12. No persisted web gallery index, IndexedDB, service-worker media cache or native imports in web code. Existing display preferences remain.

This adds no required D1 schema migration. The original thumbnail codec pipeline is not invoked to manufacture new derivatives for the redesign.

## 7. Delivery plan: PRs, dependencies, files, and gates

Use `feat/iphone-redesign` as the integration branch, superseding the older document's `redesign/true-black` suggestion. Each implementation issue gets one `feat/redesign-*` or `fix/redesign-*` branch and one PR targeting integration. Stacked work branches from its reviewed dependency; do not merge incomplete UI into production `main`.

Before creating issues/PRs, inspect live issue ownership and the repository PR template. Never assume the old issue lane map is current. Creating tracker messages is a separate authorized collaboration action; planning alone does not post them.

### P0 — Contract reconciliation and reproducible baseline (M)

**Dependencies:** none. **Owns:** design docs, `TECH-SPEC.md`, test inventory, verification workflow configuration.

- Record all owner decisions from section 2 and the corrections from section 4 in the design documents.
- Inventory every old locator/behavior that changes; map each to a replacement test instead of deleting coverage.
- Record clean starting commits, existing test failures, missing env inputs and fixture availability. Use provisioned secrets without printing values.
- Establish deterministic account/gallery fixtures for empty, free, paid, pipeline, mixed video, original-byte cached, partial fill, offline, C2PA and local desktop states.
- Make verification run for PRs targeting integration as well as main; keep production deploy trigger unchanged. Use typecheck, unit mirror and all bundle builds in the verification path. Browser jobs need the native fixture too.
- Inspect any Vendo sync step for external writes before using it on redesign PRs; contract drift verification remains local/read-only in intent. Do not silently publish docs from a design PR.
- Capture prototype reference states at 390×844 and 375×812 before implementing; use screenshots only as reference, not as evidence of the real app.

**Exit:** decisions and baseline recorded, fixtures reproducible, all failures categorized, no pending product decision from sections 2–5.

### P1 — Tokens, typography, themes, and accessible primitives (M)

**Dependencies:** P0. **Owns:** `app/styles.css`, new UI components, `app/lib/owner-theme.ts`, `desktop/lib/theme.ts`, native theme adapter, asset references.

- Add scoped semantic tokens and dark/light sets; retain `--admin-*` compatibility aliases until final migration.
- Use the existing variable Bricolage file and one logo asset with explicit dimensions. Remove misspelled Bricolate family references as screens migrate.
- TopBar uses fixed center slot and flexible left/right slots without collisions at large text sizes.
- Sheet uses semantic dialog behavior: named heading, focus trap, initial focus, background inertness, Escape/dismiss rules, return focus, safe-area padding, scroll containment and VisualViewport handling. Do not auto-focus the Add text field solely to force the keyboard open.
- Reuse one overlay controller so action menus, edit sheets, share fallback and confirmations cannot create conflicting focus traps.
- Theme preference is applied before visible owner content to avoid flashes, while SSR and hydration remain consistent; preserve existing key semantics.
- Provide a development-only component specimen surface for both themes; no public production route or sample data leak.

**Tests:** theme persistence, sheet focus/keyboard lifecycle, 44px targets, real text contrast and safe-area layout. No tests that merely snapshot token constants.

**Exit:** both themes visually reviewed at compact/wide widths; shared primitives usable by all bundles; existing screens still function during migration.

### P2 — Navigation and viewer lifecycle seam (L)

**Dependencies:** P1. **Owns:** `owner-navigation.ts`, native GalleryList orchestration, GalleryShell props, Viewer lifecycle props, web GalleryExperience seam, desktop viewer wrapper.

- Implement screen/return reducer, suspended viewer support, Details callbacks, stable position reporting, curtain-enabled state.
- Add web owner/visitor context server-side while preserving noindex, private caching and authorization.
- Implement transient web rail-entry intent and consume it to a clean URL.
- Preserve native auth/deep-link listeners, billing instance, vault leases and progress subscriptions across screen transitions.
- Leave old presentation functional while these seams are introduced; no new blank controls.

**Tests:** rail→selected curtain; viewer→Details→Back preserves frame/offset and no curtain; browser/Android Back; owner versus non-owner versus signed-out access; suspended video/ad/input; latest of two rapid gallery intents wins.

**Exit:** complete navigation paths work before visual replacement.

### P3 — Viewer chrome, curtain, Display and Info (L)

**Dependencies:** P2. **Owns:** Viewer, GalleryShell, viewer CSS, relevant `qa` tests.

- Replace pill with temporary word controls and persistent count/picker affordance.
- Implement three-second hide with focus/modal exceptions and correct gesture disambiguation.
- Move native device controls out once Details is wired in P7; until then keep them in their existing working location, never remove functionality before replacement exists.
- Implement curtain dissolve, actual target staging, reduced motion and fallback.
- Reuse accessible Sheet for Display and Info; keep C2PA lazy boundary and genuine EXIF.
- Harden per-image verification lifecycle to avoid duplicate/concurrent work and reader leaks introduced by auto-check-on-open.

**Tests:** replace pill/bob/lift assertions with reveal/hide/gesture tests; Info auto-check for flagged stills only; no preload/batch; retry and stale-result discard; `I`/Shift+I fallbacks; keyboard focus remains usable.

**Exit:** all viewer chrome states reviewed on both owner themes and three canvas backgrounds; visitor has no owner controls.

### P4 — Viewer arrows, transitions, end card and plate dressing (L)

**Dependencies:** P3. **Owns:** Viewer geometry/transition sections, stage CSS, image-staging tests where needed, ads/qa/video/fold specs.

- Reserve arrow bar in stage geometry; preserve low-resolution honest size and scroll/strip behavior.
- Add fixed-duration Rewind without changing regular glide physics.
- Replace single-image sweep with guarded fade/decode sequence; ensure end-card path in single mode.
- Fix Dark/Light dock-to-zero only where required by a reproducing test.
- Style real house plates with portrait creative area fit/contain; preserve policy, centered/rest-only CTA, count, and seeded placement.
- Retain video size caps, HEIC display fallback, source-byte C2PA behavior, magnifier and fold rendering.

**Tests:** every navigation edge in section 5.3, long/wide/tiny/portrait sources, rapid tap retargets, resize while gliding, ad/end frames, all layouts, reduced motion, video and fold matrix.

**Exit:** full viewer Playwright matrix green, including ad actionability. Intentional arrow-induced resize is measured separately from unexpected loading CLS.

### P5 — Library data and bounded preview loading (L)

**Dependencies:** P1; integrates with P2 before UI adoption. **Owns:** Library loaders, offline store callback seam/tests, gallery presentation helpers.

- Implement the pipeline in section 6.3 using existing summaries and encrypted metadata.
- Add byte-aware visible-cell leases, request queue cancellation and progressive cache-fill registry.
- Keep average-color enhancement optional and additive; no server media work.
- Separate cached status, requested keep policy, actual complete copy, and in-flight progress.

**Tests:** no offscreen media requests, four-job ceiling, release/cancel/late-read cleanup, byte-budget behavior, no network before cached Library paint, incomplete metadata never advertised ready, mixed-video skip, eviction, sign-out and account isolation.

**Exit:** 500/1,000-frame rails render without loading all images; cached state and original bytes remain intact.

### P6 — Library and house-sponsored placement (M)

**Dependencies:** P1, P2, P5. **Owns:** GalleryCard/Rail, native Library view, house slot styles/controller.

- Implement cards, menus, source/count/caption, progress, empty/error/offline/pipeline states and plan footline.
- Native Library shows cached content immediately and refreshes the account list independently.
- Use real house frame and existing visibility/tier eligibility; never call the live account adapter. Retire any previously mounted native ad on transition.
- Preserve gallery menu actions and all-device catalogue metadata without presenting inaccessible desktop-only photos as downloadable.

**Tests:** six-pixel drag threshold, wheel/touch/mouse/keyboard, vertical page scroll, menu event isolation, owner/temporary states, actual retained count, unknown billing eligibility, suppression and stale ad resolutions.

**Exit:** real Library matches approved compact composition and responsive proposals; no overflow or eager network fan-out.

### P7 — Add, Details and sharing (L)

**Dependencies:** P2, P5, P6. **Owns:** native Details, shared Details/Add/share surfaces, platform commands, narrowly scoped API creation change.

- Add validated optional ordinary-create title to the existing request; quick-add naming stays unchanged. Persist title during create, not a second PATCH that fails for new pipeline galleries.
- Build keyboard-safe Add with explicit create, supported-provider errors and duplicate reopen.
- Implement Details actions, metadata edit sheets, web gallery Address edit, read-only/pipeline behavior, actual source-specific deletion copy.
- Move positive keep switch and progress into Details; retain stored preference and explicit purge separation.
- Wire Share wrappers and fallback; preserve desktop publishing distinction.
- Complete viewer return/suspension behavior and invalidation after rename/reorder/refresh/remove.

**Tests:** 409/422/403/create limits, custom name including overflow gallery, quick-add unchanged, title/caption validation, share cancel/refusal, failed clipboard, provider-safe deletion, positive switch inversion, stale writes and offline action feedback.

**Exit:** complete iPhone flow Welcome→Library→Add→Viewer→Details→Back works with real APIs; shared commands are ready for web.

### P8 — Reorder and gallery-bound correction (M)

**Dependencies:** P7. **Owns:** GalleryEditor, ReorderView, Admin reorder adapter, PATCH order validation, matching tests.

- Native pinned Cancel/Reorder/Save, matrix, slider, pick/place/live region.
- Web horizontal row with explicit draft Save/Cancel; preserve pointer/keyboard operations and card bounds.
- Share order-key mapping and immutable draft operations; do not use UI IDs as server order keys.
- Replace arbitrary 500-entry PATCH truncation with validation/bounding consistent with `MAX_GALLERY_ITEMS`; retain duplicate/unknown-key behavior and payload protection.
- Keep read-back verification; refresh edits remap current frame by identity. Avoid a new conflict/versioning protocol in this redesign.

**Tests:** no-op save disabled, cancel, failed save leaves draft, read-back mismatch, mixed video order, duplicate filenames with distinct refs, 1,000 entries and a move beyond index 500, slider extremes, web row containment, screen-reader announcements.

**Exit:** no silent partial order saves, no crop/stretch, all editing remains source-safe.

### P9 — Welcome, Settings, Visionary and shared Privacy (L)

**Dependencies:** P1, P2, P7. **Owns:** shared views, Paywall, VaultSettings integration, signin presentation, privacy data/renderers, platform settings.

- Use one clear Welcome sentence and truthful provider-link copy; full-width Apple/Google/Dropbox buttons with Apple first.
- Preserve quick-add sign-in return flow, returning-user logic, errors, identity linking and desktop handoff behavior.
- Settings moves existing account/device controls rather than recreating their state. Add both-theme appearance control.
- Visionary introduction opens store only on CTA; retain restore/customer center and Terms/Privacy.
- Render one shared policy on all platforms, preserve print and external-link behavior.
- Replace visible Pro terminology without renaming internal tier contracts.

**Tests:** auth route/render regression, native account tests, billing cancellation/restore/error/entitlement refresh, last-identity unlink protection, deletion failure/success, vault cap/purge controls, privacy parity and origin Back.

**Exit:** settings contains every retained capability; no placeholder entitlement/storage figures or fake edit affordances.

### P10 — Web public and owner integration (L)

**Dependencies:** P3–P9. **Owns:** `Admin.tsx`, owner/public routes, landing/catch-all/404/privacy/opman surfaces, web adapters/tests.

- Adopt shared Library/Details/Add/Settings components through cookie-authenticated commands; preserve SSR owner gating and noindex.
- Finish owner in-viewer Details and new-tab rail entry; browser Back behaves predictably.
- Keep web-only fullscreen, no offline controls, no persistent gallery data. Preserve existing display/theme preference behavior.
- Update public Welcome, quick-add interstitial, errors, privacy, and operations typography; no new marketing content.
- Preserve Stripe account-reference encoding and payment-link production safeguards.

**Tests:** owner/non-owner access, all provider quick-add links including fragments, title/caption/slug update, read-only pipeline, no extra persistence, new-tab links, theme persistence, horizontal reorder, wide/mobile accessibility.

**Exit:** 375×812, 1440×900, 2560×1440 web matrix plus 390×844 parity green in both themes; no missing management capability.

### P11 — Desktop and remaining native adaptations (L)

**Dependencies:** P3–P10 shared contracts; development may overlap P10 once shared interfaces stabilize. **Owns:** Catalogue, ShareFlow presentation, desktop styles/theme, native platform labels and shell adaptations.

- Desktop Library/Details uses real local records, availability and root permissions. Retain folder/card pick, manual rescan, rename, removal, sync status and explicit publishing.
- Local Details actions say what they do: Open, Publish/Share, Read folder again, Remove from Library. No “Keep a copy,” provider-only metadata edits, or invented public address.
- Reuse ShareFlow upload/connect/confirm/error state machine; restyle without changing upload authorization or byte handling.
- Preserve local gallery ordering only where supported; do not introduce a new persistent desktop editor just to mimic cloud controls.
- Remove separate always-visible desktop viewer close overlay in favor of shared Library behavior when equivalent functionality is wired.
- Finish iPad, landscape, fold and Android Back/keyboard/status-bar behavior. Device wording becomes “this iPhone,” “this iPad,” “this device,” or the local desktop wording.
- Light theme works in all owner screens, including sign-in and confirmations; native store UI follows the platform.

**Tests:** desktop bridge/workbench/auth tests, disconnected/remounted folder, local path non-disclosure, upload only after confirmation, provider failure, native deep links/cold start, Android keyboard/Back and HTTPS localhost CORS, iPad safe areas/fold.

**Exit:** fresh iOS/iPad/Android/macOS builds exercised; Windows/Linux desktop package and smoke evidence prepared on appropriate runners. Unsupported hardware access is a release blocker, not an implied pass.

### P12 — Accessibility, performance, cleanup and coordinated RC (L)

**Dependencies:** all prior stages. **Owns:** cross-platform verification, evidence, release docs, final dead-code removal.

- Complete matrix in section 8; fix defects in the phase that owns each file.
- Remove obsolete pill/sweep styles, retired font assets only after checking references, compatibility token aliases with no remaining users, and unreachable presentation code.
- Correct stale README/TECH-SPEC/todo descriptions; update submission/01, 02, 03 as needed, and 06 with new names and review paths.
- Recapture six-state evidence after presentation milestones and on final bundles; add Details/Add/Reorder/Settings/Visionary/error/theme evidence for redesign review.
- Build all release candidates from a recorded integration commit and record artifact hashes/build numbers. Keep production/store publication separate.
- Reconcile main drift without force-pushing shared branches; rerun affected gates after resolution.

**Exit:** section 9 completion checklist satisfied; one coordinated release packet ready for owner action.

### Dependency and ownership rules

```text
P0 → P1 → P2 → P3 → P4
       └────→ P5 → P6 → P7 → P8
              P2 ───────┘ └→ P9
P3–P9 → P10 → P11 → P12
```

P5 can proceed after foundation while the viewer work runs. P9 privacy content extraction can proceed independently after P1, but its screen wiring waits for navigation. P10/P11 adapters can overlap once shared interfaces are stable.

Only one active lane edits Viewer/GalleryShell geometry. Only one edits GalleryList orchestration. Shared stylesheet/token changes land before dependent screen work. API title/order changes are one small, reviewed lane with no unrelated scanner/billing/security changes. Do not treat the old plan's “mostly different files” claim as permission for concurrent edits to these monoliths.

Effort labels express relative size, not promised dates. The critical path is navigation → viewer lifecycle → Library data → Details integration → platform verification.

## 8. Verification strategy and exact gates

### 8.1 Test setup and commands

At implementation start, inspect/reuse running dev servers; do not start duplicate servers on occupied ports. The web seed requires authorized `MANORAMA_DEV_SOURCE_*` variables in `.env.local`. Never print their values.

Separate long-running terminals:

```sh
bun run dev
```

```sh
VITE_API_BASE=http://127.0.0.1:5174 bunx vite --config vite.config.native-fixture.ts --host 127.0.0.1 --port 5174
```

```sh
bun run dev:desktop
```

Every implementation PR must meet repository gates:

```sh
bunx tsc --noEmit
bun run test:unit
```

During iteration use the narrowest affected existing tests, for example:

```sh
bun run test:unit -- ./native/lib/offline-gallery.test.ts ./native/lib/global-view.test.ts
bun run test:unit -- ./native/islands/GalleryList.test.tsx ./native/islands/GalleryList.account.test.tsx
bun run test:unit -- ./native/islands/Paywall.test.tsx ./native/islands/VaultSettings.test.tsx
```

Viewer changes require the browser matrix, with all required fixtures configured:

```sh
GALLERY_URL=http://localhost:5173 GALLERY_VIDEO_SLUG=mixed-album NATIVE_GALLERY_URL=http://127.0.0.1:5174 DESKTOP_URL=http://127.0.0.1:5175 bunx playwright test
```

Targeted iteration examples:

```sh
GALLERY_URL=http://localhost:5173 NATIVE_GALLERY_URL=http://127.0.0.1:5174 bunx playwright test qa.playwright.ts native/ads.playwright.ts native/global-view.playwright.ts fold.playwright.ts
GALLERY_URL=http://localhost:5173 DESKTOP_URL=http://127.0.0.1:5175 bunx playwright test theme-persistence.playwright.ts viewer-preferences.playwright.ts
```

At affected bundle boundaries and the final RC:

```sh
bun run build
bun run build:native
bun run build:desktop
bun run vendo:check
```

The Vendo contract check may regenerate tracked files; inspect any diff and never retain unrelated generation churn. It was not run during planning.

`playwright.config.ts` excludes evidence tests by default. Run the relevant evidence spec with `PW_EVIDENCE=1` and its configured `CAPTURE_URL` after preparing the fresh capture bundle. A green default suite does not mean captures were regenerated. Native ad specs fail if `NATIVE_GALLERY_URL` is missing; fold tests can skip, so check the actual executed cases.

For native/desktop packaging, follow existing scripts/workflows. iOS builds use `ios/App/App.xcodeproj`, scheme App, SPM; never a nonexistent workspace or a `DEVELOPMENT_TEAM` override. Android uses the documented Android Studio JBR. Keep package building separate from workflow steps that upload/publish.

### 8.2 Test homes and contract replacements

| Existing home | Preserve / replace / add |
|---|---|
| `qa.playwright.ts` | Replace brand-pill, bob, curtain-lift, inline-edit and sweep assertions with new chrome, dissolve, Details edit and fade behavior; keep proportions, navigation, C2PA, accessibility, magnifier and provider flows. |
| `viewer-preferences.playwright.ts` | Preserve clean URL/reload-first and web new-tab behavior; add transient selected-frame entry. |
| `theme-persistence.playwright.ts` | Preserve storage key, reload behavior and origin separation; change old drawer locators to Settings. |
| `video-playback.playwright.ts`, `video-size-cap.playwright.ts` | Playback, reduced motion, active-only stream, suspension during Details and stage-height changes. |
| `fold.playwright.ts`, `admin-fold.playwright.ts` | Segment alignment, no hinge overlap, input accumulation, owner-screen/modal layout. |
| `native/ads.playwright.ts` | All existing policy/actionability checks unchanged; new styling must pass them. |
| `native/global-view.playwright.ts` | Count/G entry, current frame, rapid intent, entitlement and preference scope. |
| `native/islands/GalleryList*.test.tsx` | Account, deep-link, visibility/billing races, screen return and device policy. |
| `native/lib/offline-gallery.test.ts`, `global-view.test.ts`, `vault-settings.test.ts` | Original bytes, complete commit record, progress seam, lease cleanup, cap and policy semantics. |
| `native/islands/GalleryEditor.test.tsx` | Draft/Save/Cancel, stable order keys, read-back, slider and announcements. Verify the file exists before extending; otherwise add one focused companion. |
| `app/gallery-retention-api.test.ts`, existing API/server tests | Title override on create, paid cap before scan, temporary-gallery restrictions, 1,000-item reorder. |
| `desktop/islands/Catalogue.workbench.test.tsx`, desktop auth/browser specs | Local paths remain local, availability, theme, publish confirmation, titlebar and return. |
| `native-vault-controls.playwright.ts`, capture specs | Update current state mapping and collect fresh artifacts; not ordinary correctness-suite substitutes. |

Add one focused owner-navigation/shared-sheet unit test home only where existing files cannot cover new logic. Avoid a separate test file for every cosmetic component.

### 8.3 Acceptance matrix

- **Viewports:** 375×812, 390×844, small and large iPhone portrait/landscape; iPad portrait/landscape; web 1440×900 and 2560×1440; macOS native 1440×900; Windows/Linux native smoke; Android emulator/device; two-segment fold.
- **Themes/canvas:** both owner themes, all three viewer canvases, reduced motion on/off. Theme changes do not recolor source images or reset viewer canvas.
- **Identity:** signed out, owner free, owner paid, signed-in non-owner, unknown/failed entitlement, expired session, identity-link failure.
- **Content:** empty, one image, short/no-ad, long/ad-eligible, 500 and 1,000 items, mixed video, narrow/wide/panorama, tiny source, malformed/unavailable source, flagged/unflagged C2PA, iCloud.
- **Network/storage:** online, slow, offline complete, interrupted fill, corrupt metadata, over cap, stream-only with existing copy, stale remote deletion, account switch.
- **Actions:** Add, duplicate reopen, metadata edit, slug edit, reorder, rescan, share success/cancel/refusal, remove, purge, sign-out, delete account, purchase cancellation/restore/manage.
- **Accessibility:** VoiceOver and keyboard through every modal and screen; 200% text/zoom; no trap, missing name or unreachable footer; visible focus; real 4.5:1 text and 3:1 control-state contrast as applicable.
- **Performance:** no media fetches for offscreen rails, at most four concurrent preview jobs, bounded byte/URL leases, cleanup after repeated navigation, no image-loading layout shift (target CLS ≤0.01 in deterministic fixture), no full-gallery original fetch on Library paint.
- **Animation:** capture frame timing on an older supported iPhone; target at least 95% visible transition frames within 33.3ms at 60Hz, with no sustained freeze. If blur fails, use documented opacity fallback and remeasure. Do not treat a headless test as device performance proof.

### 8.4 Visual evidence

Capture from freshly built bundles after every native/desktop presentation milestone, per `AGENTS.md`, and again at final RC:

1. Opening/Welcome.
2. Gallery curtain.
3. First image with controls.
4. Display sheet.
5. Signed-in Library/account surface.
6. Native Global View or desktop filmstrip selector.

Paths: `demo-captures/{ios,ipad,macos}/`. Submission dimensions currently documented: iPhone 1284×2778, iPad landscape 2752×2064, macOS 1440×900. Verify current store/device requirements before capture; do not resize a wrong screenshot to pretend it was rendered at the required dimensions.

Add redesign parity pairs under `docs/redesign-parity/` for Add with keyboard, Details, Reorder min/default/max, Settings, Visionary, Privacy, key errors and both themes. Use authorized originals; never copy prototype crops or scale their declared dimensions. Record source commit, bundle, device, viewport/theme and capture date. Review actual images before committing them.

## 9. Release readiness, risks, and completion

### Highest-risk items

| Risk | Mitigation and stop condition |
|---|---|
| Monolithic viewer regression | Single file owner, staged PRs, preserve navigation helpers, full viewer/ad/video/fold gates. Stop on any source geometry or click-safety regression. |
| Details loses position or leaks resources | Live suspended viewer, stable IDs, explicit lease owner, Back/deep-link/rapid-intent tests. |
| Rails decode too many originals | Visible windows, bounded queue, byte-aware leases, real-device stress; no eager `store.open` per card. |
| Incomplete cache advertised as saved | Keep metadata commit-last and distinguish in-memory progress from complete persisted state. |
| Prototype claims unsupported behavior | Local imports deferred, account Name informational, historical rescan time omitted, real plan/storage numbers. |
| Live ads survive a redesign screen transition | House-only loader plus adapter retirement; no third-party load calls in redesigned Library. |
| All-platform expansion is treated as CSS-only | Separate native, web and local-desktop adapters and evidence; preserve actual capability differences. |
| Light mode loses brand or contrast | Explicit token set, neutral action inversion, ink-backed pink state, both-theme review at every owner surface. |
| Main merge accidentally publishes | Integration-only PRs, recorded final SHA, owner-controlled release; deployment trigger unchanged. |
| Tests silently skip native/fold cases | Require fixture URLs, record executed tests and skips, distinguish hardware gaps from passing checks. |

### Coordinated release packet

- One reviewed integration commit with clean required gates and no unexplained skips.
- Updated source documents and reviewer navigation instructions.
- Fresh web/native/desktop build artifacts tied to that commit; signing/store prerequisites listed without secrets.
- Owner-reviewed visual evidence in both themes and prescribed six-state matrices.
- Confirmation that no new D1 migration is required by this design; if implementation uncovers a genuine schema need, stop that dependent step and amend the plan before proposing a migration.
- Web, iOS/iPadOS, Android, macOS, Windows and Linux release readiness table with actual test/device evidence.
- Rollback instructions based on previous release artifacts and existing deployment procedures; local preferences and optional encrypted metadata remain backward-readable.
- No automatic release tag, main push, production migration, deployment or store submission. The owner performs/authorizes the documented final release actions. Store propagation cannot be simultaneous; “coordinated” means all artifacts are ready and publication is managed as one release window.

### Completion checklist

- [ ] Owner decisions reconciled into source docs; no stale conflicting instruction remains.
- [ ] Both themes, typography, assets and shared primitives approved.
- [ ] Viewer contracts complete: chrome, curtain, arrows, transitions, rewind, Info/C2PA, picker/fold/video/ad safety.
- [ ] Native Library paints cached metadata first and loads media within declared bounds.
- [ ] Add/Details/Reorder/share are integrated with real services and truthful errors.
- [ ] Account, vault, identity, subscription and deletion functionality preserved.
- [ ] Web dashboard and public routes complete; horizontal editor and stateless media behavior preserved.
- [ ] Desktop local-folder workflow complete without invented public links or uploads.
- [ ] iPad/Android/Windows/Linux verification complete as well as iPhone/macOS.
- [ ] All mandatory gates pass at the final commit; current evidence reviewed.
- [ ] Release packet prepared; coordinated publication remains a distinct owner action.

## 10. Implementation handoff

Start with P0 and P1 after plan approval. Do not begin by rewriting Viewer or copying the prototype wholesale. At each phase report: behavior delivered, files owned, verification performed, evidence reviewed, unresolved defects, and the next dependent PR. Keep the task list current one item at a time.

This megaplan replaces speculative Stage 0 discovery with the confirmed findings above, while retaining a real execution baseline as the first implementation gate. It provides no claim that the redesigned app is already built, tested, or ready to publish.
