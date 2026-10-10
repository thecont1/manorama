# Admin top quadrants and macOS sign-in — 11 October 2026

## Current localhost

The development server is running at **http://localhost:5173/**, with strict port selection. Final checks returned HTTP 200 for `/` and HTTP 302 for `/.dev-seed/login`.

The seeded login is a **development fixture**, not real account authentication. Its display name is `thecontrarian`, its tier is Pro, and its four retained galleries are fixtures. The visible name/tier/quota welcome sentence comes from current account data; it is not hard-coded to Mahesh, Free, or one gallery.

Local provider OAuth remains separate: the identity repository requires D1, and development's in-memory gallery seed is not a substitute for the real identity store. No production migrations, secrets, OAuth registrations, or deployments were changed.

## Header layout

- Wide screens: **left top quadrant** contains the fitted original logo, subtitle, and welcome/name/tier/quota note. **Right top quadrant** contains gallery import heading, quota explanation, URL textbox, submit button, and privacy note.
- **Your galleries** sits below both quadrants and above the existing gallery cards.
- Phone widths: those blocks stack in reading order, without horizontal overflow. The import textbox remains visible and usable.
- The left-edge Account tab and slide-out menu remain. Theme and sign-out actions remain in that menu.
- Light-mode pane colors, action hover/focus colors, secondary text, and original-logo treatment remain theme-safe. Branding uses constrained aspect-true image boxes; the original logo pixels were not edited.
- The photographic editor rails remain unchanged: a single gapless horizontal row, source-proportioned widths, and horizontal scrolling.
- At ordinary wide test widths the welcome block ends left of the physical centre and the import block begins right of it. A CSS viewport-segment rule is included for two exposed segments; **real Duo pose/hinge acceptance has not been performed**. Desktop width is not proof of native Duo support.

The welcome copy reads from the account: “Hello, {name}. Welcome to manorama.xyz. You are a {Free/Pro} User. You have used {count} of your {limit} gallery limit.”

## Verification

| Check | Result |
| --- | --- |
| TypeScript `bunx tsc --noEmit` | Clean |
| Web client + Worker production build | Passed |
| Desktop embedded frontend + Rust `.app` build | Passed |
| Fresh Mac test bundle signature | Ad-hoc signed and `codesign --verify --deep --strict` passed |
| Mac ZIP and screenshot ZIP integrity | Passed |
| Affected admin/auth unit tests | **20 passed, 0 failed** |
| Chromium admin appearance matrix | **8 passed**: phone, iPad-sized, desktop, wide; normal/reduced motion; both themes |
| WebKit admin appearance matrix | **4 passed**: the same sizes with reduced motion, both themes |
| Screenshot matrix | **16 refreshed files**: workbench/pane × dark/light × four sizes |
| `git diff --check` | Clean |

Browser assertions cover quadrant placement, stacked phone ordering, Your galleries below both blocks, no clipped logos, edge-tab position/hit area, ARIA state, modal focus and dismissal, sampled pane text contrast ≥4.5:1, no page/pane horizontal overflow, a single editor row, and reset-to-closed state with a clean URL after reload. Native account/cloud-drive authentication was not represented by a fake successful exchange in this evidence.

Reviewed fresh Light-mode phone workbench and pane, desktop workbench, and iPad-sized workbench. The browser iPad captures are 2752×2064; **they are not iPad Simulator screenshots**.

The full unit suite is **not green**. The first run recorded 1062 passes, 1 failure and 1 error in D1 retained-gallery allocation. A retry with a documented 15-second test budget recorded 1062 passes, 2 failures and 1 error in the legacy-database migration startup/cleanup. No assertions were weakened or skipped to hide these results. The viewer's full acceptance matrix and native six-state evidence were not regenerated in this admin/auth change. Source work remains uncommitted pending those broader gates.

## macOS login investigation

Confirmed facts:

1. The production desktop exchange endpoint exists and answers an invalid test token with HTTP 401. Its response includes the correct `tauri://localhost` CORS header. This invalid-token probe is **not** a successful user login.
2. The Mac bundle targets the production service, not localhost.
3. LaunchServices contains numerous old builds, mounted-DMG builds, a Downloads copy, and a translocated Downloads copy claiming the same callback scheme.
4. The currently running process was the **translocated Downloads app**. Merely rebuilding another path does not update that running process.
5. The original completion function clears its in-memory PKCE verifier, so a duplicate delivery after success can throw the generic error and overwrite a successful UI state. Rust cold-launch event delivery can also precede the hydrated JavaScript listener.

Implemented and tested:

- Concurrent and repeated handoffs share one completion, exchange, and disk write; a small session-local replay window prevents a successful duplicate from becoming an error.
- Persistence completes before consuming the pending verifier; a disk failure retains the ability to retry.
- Completing an older request cannot consume a newer request's verifier.
- Deep-link handling ignores unrelated URLs, deduplicates deliveries, and reads the plugin's current launch URLs after listeners are installed.
- Rejected/expired/mismatched links, missing app-initiated flows, server unavailability, and failure to open the system browser have actionable messages rather than one generic message.
- The PKCE verifier remains memory-only. No tokens/verifiers are logged or added to URLs beyond the existing server handoff protocol.

**Multiple registered copies are a plausible routing cause, not a proven diagnosis of Mahesh's exact failed request.** No real callback token, secret, account session, or provider credential was inspected. End-to-end account login still needs a real retry in the rebuilt app. Native observation requested macOS authorization and stopped at that boundary; no fallback bypass was attempted.

### Real account retry

1. Quit the running manorama copy normally.
2. Extract `manorama-macos-auth-fixed.zip` and open that exact rebuilt `manorama.app` rather than the old Downloads copy.
3. Start provider sign-in from the rebuilt app and return to that same window without restarting it midway.
4. If macOS opens a different copy, stop there and identify the callback target; do not keep retrying among multiple instances.
5. If sign-in still fails, report the new exact message. Do not share the callback URL, handoff token, provider credentials, or bearer token.

This is a diagnostic retry checklist for the local test build, not an undocumented production recovery procedure. The operational manual does not currently document cleanup of duplicate LaunchServices registrations. None were deleted or reassigned.

The ZIP is **a local ad-hoc-signed test build, not notarized**. It contains the existing desktop local-first catalogue; this web quadrant layout is not a port of the browser admin into the native catalogue.

## Local capture reliability

Local live seeding can take time after a HonoX restart. A seed interrupted by source edits can hit “Vite module runner has been closed.” The login door now has a bounded wait, returns an honest 503 with Retry-After while unavailable, and preserves seed failure rather than silently treating it as ready. Browser tests poll that readiness with a bounded budget and wait for actual hydration. Output/build directories remain excluded from the web watcher. Final login and root probes succeeded on port 5173.
