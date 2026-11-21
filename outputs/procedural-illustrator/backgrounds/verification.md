# Verification — 20 November 2026

## Executed gates

| Gate | Outcome |
|---|---|
| Parent `bunx tsc --noEmit` | Clean |
| Parent `bun run test:unit` | 2,413 passed / 0 failed; includes encrypted privacy canaries |
| Companion `bun run typecheck` | Clean |
| Companion `bun run test` | 47 passed / 0 failed / 4,368 assertions across seven files |
| Companion `bun run build` | Vite production build succeeded |
| Companion desktop/mobile browser matrix | 20 passed / 0 failed: desktop Chromium 1440 × 900 and iPhone 13 WebKit |
| Clean extracted source ZIP | Frozen install, typecheck, 47 unit tests, build and byte-identical paired SVG/PNG/project CLI reexport passed |
| Resident local API `/health` and UI | HTTP success on loopback 5189 / 5188 |
| Desktop/mobile actual screenshots | Reviewed; no page errors or horizontal overflow; widths 1440 / 390 CSS px |
| Exact tiled raster seam test | Each native-resolution cell in a 3 × 3 raster is pixel-identical to the exported tile |
| Dark/Light invariant | Identical complete library, layouts, SVG path coordinates; only palette differs |
| Exact saved-project and exported-file checks | Strict geometry validation, deterministic seed rebuild, byte-identical SVG/PNG reexports and intrinsic sizes checked |
| Nine seed/density runtime samples | All have valid final geometry; sparse 21 placements, medium 60, dense 87–88; dense partial placement is reported rather than hidden |

The expanded browser matrix downloads real, unmocked files from the loopback export API. A rectangular 768 × 1024 project, with its repeat diagnostic selected, downloads a **tile** SVG with the correct viewBox and a **192 × 256 PNG** for a 256px longest edge. Both desktop and mobile exercise this path. Exact undo restores the preceding SVG content and palette, not a newly randomized approximation. Other cases cover stale worker replies, invalid numeric drafts/imports, exact imports, palette identity, responsive views, unavailable providers and retaining the last valid canvas on provider error.

The first matrix had six failures caused by two ambiguous test selectors: JSON also matched Import JSON, and status also matched numeric output elements. Those selectors were narrowed without skipping tests or relaxing behavior assertions; the corrected matrix passed, then four real-download/undo cases were added and also passed.

## Visual inspection

The final 24-motif labelled contact sheet, Light tile, Dark 3 × 3 field, paired comparison and actual desktop/mobile tool were inspected. The photographic subjects remain recognizable without dense interior detail; line widths and rounded endings are coherent, rotations vary, no gutters mark the repeat boundaries, and the palettes are deliberately subdued. Six large motifs anchor the field while optical/film marks provide small-scale texture. The final neighbor-spacing refinement reduced clustered repeats without turning the field into a uniform grid.

Human inspection is distinct from algorithmic scores. The coarse stroke-grid coverage estimate is not an exact ink-pixel percentage; occupancy/density measures filled conservative envelopes. These metrics guide packing and bounded optimization, not release taste.

## Outstanding external acceptance

Live provider generation, vision contact review and typed layout repair remain **unverified against a real provider account**. Contract tests use clearly identified fake providers. The available Manus desktop model runtime stopped before producing motifs, rejecting image input and then text requests with “LLM hard budget enforcement is unavailable.” No simulated output is claimed as a live result. The asset provenance is hand-authored; no live model calls contributed art.

Owner judgement behind actual gallery photographs remains the release gate before any integration. The live background was not replaced or deployed. No viewer or native code changed, so the live viewer Playwright matrix and native six-state capture requirements are not triggered by this isolated companion package. No remote operation, provider modification, commit or push occurred.

## Re-run

From the parent repository: `bunx tsc --noEmit` and `bun run test:unit`. From the standalone package: `bun install --frozen-lockfile`, `bun run typecheck`, `bun run test`, `bun run build`, and `bun run test:ui` with the local dev server started or the configured Playwright webServer. Browser binaries can be installed with `bunx playwright install chromium webkit`. `bun run profile` measures absolute runtimes on the current device; its JSON is not a cross-machine benchmark or a historical speedup claim.
