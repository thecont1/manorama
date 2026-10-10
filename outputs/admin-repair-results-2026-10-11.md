# Admin repairs and macOS test build — 11 October 2026

## What changed

- Replaced the web dashboard's hamburger with a labelled **Account** tab at the middle of the left edge. Opening it slides the account pane from the left.
- Kept gallery content full-width within a bounded workbench; the account pane is closed by default.
- Repaired Light-mode surfaces, action hover/focus colors, secondary-copy contrast, and the logo's theme treatment.
- Constrained the account logo to the pane's available width. The original logo file is unchanged.
- Added a real labelled close button, Escape and backdrop dismissal, focus trapping/restoration, scroll locking, a settled-animation check, and reduced-motion behavior.
- Removed repeated “Photo Editor” headings. Accessible per-gallery rail labels remain; web rails stay one horizontal row. Picker/Global View matrices and gallery image geometry were not redesigned in this change.
- Excluded generated screenshots, reports, working artifacts, and native build outputs from the Vite watcher. HonoX previously restarted on their file additions/removals, breaking in-flight captures and clearing its seeded SSR state.
- Restored `src-tauri` from the exact parent of the user-authored removal commit `2862ef7`. The existing desktop TypeScript catalogue and local-first adapters are reused.
- Compiled and packaged a fresh **macOS 0.2.1 debug test app**, with embedded frontend assets and an ad-hoc signature. No notarization, publication, provider upload, or external distribution was performed.

## Verified

| Check | Result |
| --- | --- |
| TypeScript, `bunx tsc --noEmit` | Clean |
| Production web client + Worker build | Passed |
| Desktop frontend build | Passed; pre-existing large-chunk/dynamic-import warnings remain |
| Locked, offline Rust compilation | Passed |
| Native `.app` packaging and `codesign --verify --deep --strict` | Passed; signature is ad-hoc, not Developer ID |
| macOS ZIP integrity | Passed |
| Chromium admin browser matrix | **8 passed**: 375×812, 1376×1032, 1440×900, 2560×1440; both themes, normal/reduced motion |
| WebKit admin browser checks | **4 passed** across the same widths, both themes, reduced motion |
| Affected web/native account unit tests | **39 passed, 0 failed** |
| Admin screenshots | **16 fresh files**: open pane and closed workbench in both themes at four sizes |
| Web iPad-sized screenshot dimensions | **2752×2064** at 1376×1032/DPR 2; these are browser captures, not native iPad Simulator evidence |
| `git diff --check` | Clean |

The browser contract checks edge-tab location and touch size, modal opening/closing, explicit ARIA state, focus trap/restoration, no horizontal overflow, fitted logo bounds, minimum 4.5:1 contrast for sampled account text, single-row rails, state through resize, and a closed pane/clean URL after refresh. Runtime page errors are also asserted absent.

Reviewed the fresh phone Light pane, desktop Light workbench and pane, dark phone workbench, dark desktop pane, and iPad-sized Light pane. The screenshot archive includes the full 16-image admin set.

## Not a whole-product sign-off

**The full unit suite remains red.** Runs using its default CLI timeout completed with 1057 passing tests and one failure in `app/vendo-sync.test.ts`, where `bunx vendo sync --strict --no-ai` exceeds the 5-second test budget. Runs with a 15-second global budget also exposed an existing 15-second D1 startup hook timeout in `app/lib/gallery-expiry.test.ts` (1038 pass/1 failed hook). No assertions were changed or skipped to make these green.

**The broader viewer run was interrupted after unrelated failures.** It recorded 23 passes, 2 failures, 1 interruption, 12 skips, and 138 not run. Failures were the phone picker drag test expecting `scrollLeft` to change and the phone “Display settings” logo-peek test not finding that control. The run is not a passing viewer matrix. A separate fold suite invocation reported 12 skips because it requires its native fixture environment; it is not evidence of fold acceptance.

**Native Mac visual acceptance is blocked.** Launch was dispatched through `open`, but native inspection stopped for macOS accessibility authorization. Therefore this report does not claim that the app's opening UI, folder picker, local-image viewer, account state, or six-state native evidence matrix was verified. The packaged app is a local test build only.

**Duo and native iPad are still release gates.** No Duo Device Hub pose matrix, real reserved-region bridge verification, or corrected native iPad landscape matrix was produced in this change. The browser's correctly sized iPad captures must not be substituted for native evidence. The separate Duo/macOS plan explains the next implementation and acceptance steps.

**The restored desktop catalogue is not the web dashboard.** Restoring the native shell produces the existing local-first catalogue app; it does not automatically port the new web Account tab into that catalogue. Unifying its account presentation is included in the plan.

## Deliverables

- `admin-evidence/admin-theme-matrix.zip` — the 16 fresh web admin captures.
- `macos/manorama-macos-test.zip` — local macOS test app; extract to obtain `manorama.app`.
- `duo-and-macos-plan-2026-10-11.md` — sourced design/implementation sequence, native fold handling, and desktop release gates.

The existing user localhost server on port 5173 answered the seeded-login route with HTTP 302 during the final checks. Acceptance tests used a separate resident server on port 5180 to avoid interfering with that user server. Reload the localhost dashboard to pick up the changed module/style graph; the test fixture's display name and Pro tier are fixtures, not a claim about a real account.
