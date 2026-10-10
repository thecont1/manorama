# manorama UI capture audit — 10 October 2026

## Status: fixes implemented; cross-platform acceptance incomplete

The missing native cloud-link textbox is fixed. A fresh six-state iPhone simulator matrix was built with Xcode, captured at **1284 × 2778**, and visually reviewed. The remaining iPad, web-admin, and macOS evidence cannot be claimed complete: the Desktop terminal transport failed and its running sessions were lost during verification.

The Desktop still reports online and file reading works, but fresh terminal calls fail with `terminal:read ... use of closed network connection`. Resource telemetry is unavailable; there is no evidence that CPU or memory overload caused this.

## Native admin bug and correction

The signed-in native screen did not contain the web dashboard's primary public-cloud-link import field. Its secondary “Open another gallery” path is a different owner/slug mechanism, not a substitute for pasting a cloud URL. The account document also inherited the web viewer's body-scroll lock.

Changes in `native/islands/GalleryList.tsx` and `native/styles.css`:

- Add an always-visible **Add a gallery** form above the published gallery list.
- Label it “Public Dropbox, Google Drive, iCloud, or MEGA link”.
- Use a URL input with 16px text, a minimum 44px height, and autocapitalization/autocorrection disabled.
- Reuse the existing authenticated quick-add API rather than create a second import implementation.
- Preserve MEGA URL fragments and trim only surrounding whitespace.
- Handle successful creation and the existing-gallery/409 path.
- Disable submission while pending, preserve rejected input for retry, and show one actionable error.
- Refresh the account list after an import attempt.
- Restore vertical scrolling on the native account document.

Regression tests cover new-gallery success, existing-gallery success, duplicate submission prevention, rejected-link retry state, and the independent owner/slug opening path.

**Evidence:** the fresh iPhone admin screenshot shows the URL textbox and “Manorama-fy it!” action on the initial viewport, followed by the gallery cover, title/count, caption and URL. This is fixture-authenticated UI evidence, not proof of a real owner's OAuth login or a production import.

## Curtain composition decision

The native portrait curtain used two equal-height rows. The logo sat separately in the upper quarter while the title and caption sat near the centre. That made one introduction read as two unrelated blocks.

Restore the web reference's compact centred group for portrait: logo, 36px separation, then title and caption. Keep the existing landscape two-column composition for now. The photograph remains at honest pixel size; it is not enlarged, blurred or used as a recompressed backdrop to fill vacant stage space.

The fresh phone curtain was visually reviewed and the logo/title relationship is corrected. Landscape and long-title fit still need current-device acceptance.

## Capture harness repairs

In `.work/capture-server.ts`:

- Await dimension-file text before JSON parsing.
- Resolve the fixture before starting the HTTP listener.
- Read dimensions from original bytes rather than hard-code the first image or trust the legacy 256 × 171 manifest metadata.
- Read local File Provider bytes before treating a placeholder as a usable photograph; fall back to the public original if the read fails or is incomplete.
- Bound fixture original-fetch concurrency to three and retry transient 5xx/429 responses.
- Seed session/fixture state before the application module, not at the end of the document.
- Make streaming the capture-only loading policy so capture does not fill the simulator's encrypted vault.
- Use the real modal visibility contract (`hidden` attribute), not a nonexistent `is-open` class.
- Require decoded first-image pixels, completed curtain dismissal, an actually visible settings panel, and an in-viewport admin URL input before reporting readiness.
- Add state-generation tags and reject stale generation-tagged reports.
- Return 404 for missing assets rather than misleading 200 HTML.
- Add a status endpoint and configurable capture port/photo directory.

In `.work/global-view-fixture.tsx`, readiness now requires decoded visible cells, not an arbitrary minimum of eight cells that cannot fit on every viewport. The fixture mounts the real GlobalView component with authorized photographs; it does not verify encrypted-vault persistence.

In `scripts/capture-screens.sh`:

- Use repository-local `demo-captures/{ios,ipad}` defaults.
- Accept an explicit simulator UDID.
- Use a unique staged app directory.
- Stop only the server process owned by the capture script.
- Check fixture-server readiness instead of assuming a three-second startup.
- Set a capture-only iPad landscape launch orientation.
- Keep production Capacitor configuration restoration on exit.

The production `capacitor.config.ts` was read after the successful iPhone run and confirmed restored: **no temporary `server.url` remains**.

A new `capture-harness.playwright.ts` covers phone/tablet/desktop capture states, cloud-link import, stale report rejection, and missing assets. `playwright.config.ts` now excludes `.worktrees` so test collection does not load several independent Playwright installations and fail before execution.

### Harness acceptance still pending

The first browser run passed curtain and strip states, then failed on the old nonexistent modal selector. That selector was corrected and the iPhone simulator subsequently captured settings successfully. The corrected browser rerun was lost with the terminal session; it is **not a green browser matrix**.

The screenshot driver succeeded through all six phone states once. That is useful evidence, not a claim that every failure/retry path is validated. In particular, the photo-serving fallback and preview/video choreography should receive a complete automated regression run before calling the harness production-reliable.

## Fresh iPhone evidence

All six files were opened and reviewed after the successful current Xcode build:

| State | Evidence |
| --- | --- |
| Opening screen | [01 opening](../demo-captures/ios/01-opening-screen.png) |
| Gallery curtain | [02 curtain](../demo-captures/ios/02-gallery-curtain.png) |
| First photograph and controls | [03 strip](../demo-captures/ios/03-first-image-hover.png) |
| Display settings | [04 settings](../demo-captures/ios/04-controls-popover.png) |
| Signed-in account/admin | [05 account](../demo-captures/ios/05-account-admin.png) |
| Global View/photo picker | [06 picker](../demo-captures/ios/06-global-view.png) |

## Verification actually completed

| Check | Result |
| --- | --- |
| `bunx tsc --noEmit` | Clean after the native form/style changes |
| `bun run test:unit` | **1,057 passed, 0 failed** |
| `bun run build:native` | Successful |
| Capture-server Bun syntax bundle | Successful before the final reliability refinements |
| Xcode plain and harness simulator builds | Successful |
| Six phone capture states | Successful, 1284 × 2778, visually reviewed |
| Production Capacitor config restoration | Confirmed by reading the final file |
| Full web viewer/admin Playwright | Not completed |
| Corrected capture-harness Playwright matrix | Not completed |
| Fresh iPad six-state matrix | Interrupted; existing files must not be called fresh |
| Fresh web admin screenshots | Not produced |
| Fresh macOS application matrix | Not produced |
| Current credentialed-image C2PA validation | Not completed this turn |

Initial build permission failures were resolved using the specific Xcode/SwiftPM cache paths reported by the execution policy. A provider 503 was followed by bounded fixture retries. Neither those corrections nor the successful phone screenshots erase the incomplete checks above.

## Resume checklist

1. Restore the Desktop terminal connection; retain the current source changes and captures. No cloud-device switch can substitute for Xcode and these local files.
2. Check `git status` and the current branch before committing. This turn's changes remain uncommitted; no push or deployment was performed.
3. Run the corrected capture matrix with one worker:

   ```sh
   CAPTURE_PORT=4182 bun .work/capture-server.ts
   CAPTURE_URL=http://localhost:4182 bunx playwright test capture-harness.playwright.ts --workers=1
   ```

4. Resume iPad capture with the freshly built simulator bundles and verify **2752 × 2064 landscape**, all six states, especially the visible import field:

   ```sh
   bash scripts/capture-screens.sh --device ipad \
     --udid FECE7C85-D2BD-4C4F-9E1E-FC8F23E68F5E --skip-build \
     --out /Users/home/DEV/tools/manorama/demo-captures/ipad
   ```

5. Start `bun run dev --port 5173`, wait for all dev-seed scans to complete, then run `.work/stocktake/capture-web-admin.ts`. It captures the real local authenticated HonoX admin in Chromium and WebKit at phone/tablet/desktop sizes. It edits the field without creating production data.
6. Run the complete project viewer QA and credentialed-image C2PA tests. The earlier initial QA attempt was blocked by linked-worktree collection; that discovery issue is corrected but needs a completed rerun.
7. Resolve which current macOS target is intended. Repository discovery showed the Tauri wrapper was removed on upstream main; do not silently resurrect it or relabel desktop-browser screenshots as native macOS application evidence.
8. Review the completed cross-platform matrix before batching commits. Keep capture tooling, native admin/curtain fixes, and refreshed evidence in logically separated commits according to repository instructions.

**Conclusion:** the reported iPhone textbox defect is fixed and demonstrated in a freshly built app. The phone curtain cosmetic decision is implemented and reviewed. Cross-platform acceptance and the requested complete evidence matrix remain open, not waived.
