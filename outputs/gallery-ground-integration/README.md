# Optical Marginalia — stronger 256px app canvas

21 November 2026. **Implemented locally; not merge-ready or deployed.** Branch: `feat/viewer-optical-ground`, based on `3aff26acab7250cfee18bc07f7b79d4dc8f49040`. No integration commit, push, PR, remote migration or deployment was performed.

**Subsequent revision:** [Translucent UI backings and current Library previews](translucent-surfaces/README.md). That follow-up supersedes the app-surface screenshots and verification counts below. The approved texture, palette and source geometry remain current and unchanged.

## Latest revision — Blank retired; the strip always lives on the canvas (2026-11-21)

Supersedes the "Blank is still the default" description in *Current scope* below. Per the owner: the Canvas field now offers **Dark/Light only**, **Dark is the gallery default** (a legacy stored Blank preference migrates to Dark), and **every strip image is separated by the 10px canvas gutters** — the spacing that used to belong to Dark/Light is now universal gallery behaviour. The public marketing home demo keeps its bare edge-to-edge stage: the embedded Viewer remains the only internal 'none' caller.

Changed (worktree, uncommitted): `app/lib/background-preference.ts(+test)`, `app/islands/Viewer.tsx`, `app/components/viewer/SettingsSheet.tsx`, `app/styles.css`, `specs/qa.playwright.ts`, `specs/endcap-webkit.playwright.ts`, `specs/doodle-background.playwright.ts`, `specs/light-gallery.playwright.ts`, Viewer margin-redock/spread/video-frame-width unit tests, `README.md`, `docs/gallery-ground.md`. One app-side bug surfaced during acceptance and was fixed: the keyboard path (registered while the canvas is still the SSR 'none' stage) could read a stale margin in `getBounds()` and let `End` park the endcard one gutter inside the stage; the margin is now mirrored in a ref. Invariants held: gutters are CSS margin boxes and staging slack only — no source bytes stretched, upscaled or re-encoded; the home demo is excluded; ad plates, tier logic, pinning and provider boundaries are untouched.

Verification (final): `bunx tsc --noEmit` clean; `bun run test:unit` **2421 pass / 0 fail**; production builds pass. The full viewer acceptance suite (`specs/qa.playwright.ts`) on the spaced tree: **130 passed / 31 failed / 17 skipped (26.7 min)** — every remaining failure is baseline-attributed: it either reproduces identically at pure HEAD (stash-baseline runs recorded in `.work/gallery-ground-integration/qa-baseline-attribution*.log`) or is a stale selector/copy drift against committed app text untouched by this change (e.g. the shipped drill row reads *Gallery Settings* while the spec still waits for *Gallery settings*; marketing/privacy/quick-add copy; the parallel-worker decode-wait cluster; the keyboard `#`-URL signature). Every test the retirement actually touches passes, including four that were rewritten to measure the real gutters from the DOM instead of the old abutting numbers — no threshold was weakened. Targeted five-spec matrices (doodle-background, app-canvas, translucent-surfaces, light-gallery, endcap-webkit) are green on phone/desktop/wide.

Running record with rounds 1–7 and all logs: `.work/gallery-ground-integration/blank-retirement-progress.md`.

## Current scope

Following the owner's instruction, **“Use the texture across app surfaces, but keep Blank as the gallery default,”** the approved camera/photography vectors now form the app walls on web, native-web and desktop-web: opening/loading screens, Library/dashboard, account drawers, Settings, sheets, curtain, picker, Global View and editor. The public marketing homepage and its embedded viewer remain excluded.

App walls follow the account theme. Gallery Canvas choices remain independent: **Blank is still the default** *(superseded — see the revision above: Dark default, Blank retired)*, and its stage stays opaque and texture-free. Dark/Light retain their existing 10px photo margins. Dark viewer sheets, curtains and picker retain their dark presentation. No decorative background is assigned to photographs, controls, cards, ad plates or endcards. No photograph bytes, intrinsic sizing, staging or ad behavior were changed.

The fixed repeat remains **256 CSS pixels**, using one uniform `scale(0.25)` group around the approved 1024-unit paths. Effective strokes are 0.75 CSS pixels. The stronger inks are Dark **`#484848`** and Light **`#aaa59b`**, replacing `#292929` and `#c9c5bc`. Gallery grounds remain `#101010` and `#e9e5dc`; app walls retain their existing background colors.

## Frozen source and implementation

The uploaded JSON and retained `assets/gallery-ground/approved.project.json` remain byte-identical, SHA-256 `16c19ef3be3c830d7ef5a8f8d0fb27c670c1995a765d96667e4cbec9f072565d`. Seed 1843, 80 accepted placements, 92 wrapped groups, 258 exact paths, 24 motifs and source 3-unit strokes are unchanged. Ten requested-but-unplaced motifs remain unplaced; nothing was repacked or regenerated.

`app/lib/app-canvas.ts` deterministically serializes the exact approved tile. `bun scripts/export-app-canvas.ts` produces the two public SVGs copied into all three bundles. `app/styles/canvas.css` adds scoped CSS backgrounds, with no DOM layer, pointer interception or accessibility element. No new application dependency, provider-media persistence, core platform dependency or web persistence feature was introduced.

## Current previews

The reviewed [Dark texture PNG](app-canvas-contrast/texture-dark-contrast.png) and [Light texture PNG](app-canvas-contrast/texture-light-contrast.png) each show sixteen 256px repeats in a 1024×1024 field. Editable counterparts are [Dark SVG](app-canvas-contrast/texture-dark-contrast.svg) and [Light SVG](app-canvas-contrast/texture-light-contrast.svg). These contain no photographs.

Reviewed actual app-bundle browser previews include [web Library Dark](app-canvas-contrast/browser-previews/web-library-dark.png) and [web Library Light](app-canvas-contrast/browser-previews/web-library-light.png), [native-web opening Dark](app-canvas-contrast/browser-previews/native-opening-dark.png) and [Light](app-canvas-contrast/browser-previews/native-opening-light.png), [native-web Privacy Dark](app-canvas-contrast/browser-previews/native-privacy-dark.png) and [Light](app-canvas-contrast/browser-previews/native-privacy-light.png), and [desktop-web opening Dark](app-canvas-contrast/browser-previews/desktop-opening-dark.png) and [Light](app-canvas-contrast/browser-previews/desktop-opening-light.png). They are **browser renders, not iPhone, iPad or macOS native-shell evidence**. Source screenshots were copied without cropping, resizing, annotation or re-encoding. The Light Library review was refreshed after waiting for its CSS image to decode; the initial immediate theme-toggle screenshot was not valid paint evidence.

## Current verification

| Check | Result |
| --- | --- |
| Root TypeScript typecheck | Pass |
| Complete mirrored root unit suite, including privacy canaries | **2,419 pass; 0 fail; 33,530 assertions; 196 files** |
| Web/Worker production build | Pass |
| Native-web and desktop-web production bundles | Pass |
| Gallery/app-canvas contracts, phone 375×812 touch/DPR3, desktop 1440×900, wide 2560×1440 | **42/42 pass**, fresh-server rerun, 1.7 minutes |
| Independent original-path reference at the stronger inks and selected density | **0 changed pixels and 0 maximum channel difference in both palettes**, 1024×1024 |
| Uploaded JSON versus retained checksum | Exact match |
| Public SVG versus web/native-web/desktop-web packaged assets | Both palettes byte-identical in all three bundles |
| Patch whitespace check | Pass |

The tests retain Blank defaults, photo margins, fixed geometry, resize/reload stability, gallery-theme independence, input safety and decorative accessibility. Dashboard exclusion was deliberately replaced with the authorized, independently themed app-wall contract; homepage exclusion remains mandatory. No unrelated QA/video/picker/preferences/ad/fold/Duo assertion was relaxed or skipped.

The first app-surface run exposed a real Light-theme shorthand collision. The shared selector was corrected to match those existing rules' specificity. A later 42-case run still reported **36 pass / 6 fail** because the ignored-worktree dev server served the old direct CSS while its JavaScript-form CSS response and freshly built bundles contained the correction. CSSOM inspection proved the stale selector. Only the task-local dev server was restarted; its current direct CSS and all four provider seeds were verified. The same 42-case matrix then passed without changing assertions. Neither failed diagnostic is represented as a pass.

The independent pixel comparison is like-for-like at the chosen density and inks; it does not establish cross-device or cross-renderer pixel equivalence. Browser review also found faint native-web Light opening footer text. Complete foreground contrast/accessibility certification is **not** claimed; this existing text styling needs review separately from the decorative-path proof.

## Remaining release gates

**Fresh six-state iPhone, landscape iPad and macOS captures from freshly built stronger-contrast/app-wide shells are still required before commit.** Web-bundle builds, synthetic real-stylesheet fixtures and headless bundle screenshots do not replace this gate.

The **full viewer acceptance suite remains red/incomplete** from earlier broad verification. Baseline checks reproduced obsolete Settings labels/hierarchy, decode-wait/video-size-helper problems and two URL cleanup failures leaving a trailing `#`. Two native Duo Library failures reproduced on unchanged main: waiting for a textbox before choosing cloud-link entry and the obsolete `.native-account-ad-slot` structure. Other failures from the interrupted broad run are not all independently classified. These are not silently waived by an artwork-specific pass.

The historical native-only ad/fold/Duo run completed 36 pass / 2 fail / 0 skipped across 38 cases; all 14 ad-safety and 13 fold checks passed. Those results do not certify the current complete viewer matrix. The earlier 51-case diagnostic was interrupted and its recovery stopped at seed readiness; neither is a completed pass.

Before merge, refresh native-shell evidence, review Light footer readability, resolve the broader baseline/fixture blockers and rerun the complete viewer matrix. No commit or deployment is made while mandatory gates remain incomplete.

## Historical previews and native evidence

`density-256/` retains the earlier lower-contrast, gallery-only 256px previews. The 36 Dark/Light native six-state captures in `demo-captures/{ios,ipad,macos}/` and the older top-level iPad/Mac preview PNGs show the **superseded 1024px presentation**. They are historical only, not certification of this revision. No old screenshot was altered to simulate the current density or contrast.

The earlier isolated evidence app is stopped and whole-screen control was released. The owner removed its temporary copied session, and absence was verified. The installed application, original session/catalogue and source photographs were not modified. This pass did not recreate the protected credential fixture or resume GUI takeover.

Source provenance and contracts are recorded in `docs/gallery-ground.md`. The earlier plain-local procedural illustrator, installed skills and source/export deliverables remain preserved separately.
