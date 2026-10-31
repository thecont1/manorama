# manorama coordinated release packet — P12

This packet collects everything the owner needs to publish the photography-first
redesign as one release window. Nothing here deploys, tags, pushes to main,
migrates data, or submits to a store — those remain distinct owner actions.

## Integration commit

- Branch: `fix/redesign-p12` (worktree `.worktrees/p12`)
- Head: `89848ef735f6d9f52b5efb2b7b74b61c1e7de554` (`docs(release): correct App Store wording and the RC packet record`) — the integration commit recorded in `outputs/rc/artifacts-sha256.txt`; the commit carrying this packet record and refreshed hashes follows it and changes no shipped code
- Base: `origin/main` @ `3174cb6`
- Logical commits on the branch: client hydration hardening, provider retry/cache, desktop catalogue restore, style pruning + details overflow fix, local font bundling, evidence-spec alignment, docs refresh, evidence captures, review corrections (Retry-After budget, swipe/buffer replay, spec fixes, submission wording).

## Required gates at the integration commit

| Gate | Result |
|---|---|
| `bunx tsc --noEmit` | clean |
| `bun run test:unit` | 1438 pass / 0 fail |
| `bun run build` (web) | pass — `dist/index.js` 2,224.84 kB (gzip 621.30 kB) |
| `bun run build:native` | pass |
| `bun run build:desktop` | pass |
| Playwright suite | 270 pass / 9 skip / 0 fail — a clean full-suite run inside the worktree after fixing testIgnore swallowing the linked checkout's own specs |
| Evidence specs (`PW_EVIDENCE=1`) | 44/44 — capture-harness 16/16, native-vault-controls 4/4, desktop-admin 10/10, desktop-catalogue 4/4, admin-appearance 10/10 |

## Build artifacts

Fresh bundles built from the integration commit; SHA-256 for every shipped
JS/CSS/HTML file is recorded in `outputs/rc/artifacts-sha256.txt`.

The generated output directories are git-ignored, so they must be produced or
handed over explicitly — never assumed present. Before any deploy step, build
the target output (`bun run build`, `bun run build:native`, or
`bun run build:desktop`) at the integration commit and verify the produced
files against `outputs/rc/artifacts-sha256.txt`, or hand the owner the exact
`dist/`, `native/dist/`, or `desktop/dist/` directory this packet's hashes
describe. A stale local build of the same name must not be used.

| Surface | Bundle | Handoff |
|---|---|---|
| Web (Cloudflare Worker) | `dist/` | HonoX worker + client; verify hashes, then publish via existing `wrangler deploy` procedure — owner action |
| Native (iOS/iPadOS/Android shell) | `native/dist/` | the SPA Capacitor embeds; verify hashes, then `bunx cap sync` and archive in Xcode — owner signing |
| Desktop (Tauri) | `desktop/dist/` | verify hashes, then macOS bundle via `bunx tauri build --bundles app --target aarch64-apple-darwin` — owner signing/notarization |

Signing/store prerequisites (no secrets in repo): App Store Connect record per
`submission/06`, provisioning on team `373K7W3LKU` (already in `project.pbxproj`),
RevenueCat/AdMob public app IDs already bundled. `HOST_API_JWT_SECRET` and
provider keys live only in Worker bindings.

## Evidence

Regenerated this cycle and committed:

- iPhone six-state matrix — `demo-captures/ios/` (1284x2778, fresh builds)
- iPad landscape six-state matrix — `demo-captures/ipad/` (2752x2064)
- Native parity pairs — `docs/redesign-parity/native-*` (add, details, visionary, privacy, settings, viewer-details at 375/1376/1440, dark + light)
- Desktop admin + catalogue parity — `demo-captures/desktop-admin/`, `outputs/desktop-catalogue-parity/` (both themes, all widths)
- Admin gallery focus — `demo-captures/admin-gallery-focus/native-*` (account, admin, editor)

macOS six-state captures are not refreshed: driving the Tauri window needs an
interactive desktop session, a documented owner-side step. The same surfaces
are evidenced by the desktop parity captures above.

## Schema / migrations

No new D1 migration is required by this design. No file under `migrations/` was
touched on this branch; local preferences and optional encrypted metadata stay
backward-readable.

## Readiness table

| Surface | State | Evidence |
|---|---|---|
| Web | ready | production build + full suite + admin parity captures |
| iOS | ready | fresh Debug-iphonesimulator apps; six-state captures |
| iPadOS | ready | same apps on iPad Pro 13 landscape; six-state captures |
| Android | break-glass only | generated shell, unpolished by design |
| macOS | build-ready pending captures | desktop specs green; window-level captures are an owner GUI step |
| Windows/Linux | no evidence | documented absent before this phase |

## Product changes in this RC worth owner eyes

- Pre-hydration input (wheel/pointer/tap) is buffered and replayed onto the
  island once live; a bounded watchdog re-imports the client if hydration
  never stamps an island. The curtain dismisses on a pre-hydration tap.
- SSR images that finish loading before hydration now fire their deferred
  handlers — no more permanently invisible thumbnails/frames.
- iCloud asset URLs are cached ~45s per asset (production fetch only), ending
  the video range-request upstream stampede; iCloud and Dropbox transient
  429/5xx responses get one bounded retry; permanent failures are untouched.
- Admin strip thumbnails retry a failed fetch once (`mreload` convention).
- Desktop catalogue keeps its drawer anatomy and asymmetric page gutter;
  phone details groups can no longer overflow the viewport.
- Remaining typefaces are vendored locally; remote font hosts left the CSP.

## Rollback

Every surface can be rolled back independently:

- Web: redeploy the previous Worker build (prior release artifact) via the
  existing `wrangler deploy` procedure; no migration reversal is needed since
  no schema changed.
- Native/desktop: re-archive the previous signed build; the installed app is
  forward/backward compatible because nothing client-persisted changed shape.
- Git: `git revert` the integration range `3174cb6..240e8e6` restores base
  behaviour; the eight logical commits can also be reverted individually.

## Owner actions remaining

1. Review the evidence captures above (both themes, six-state matrices).
2. `wrangler deploy` the web bundle when satisfied.
3. Archive/submit the iOS build from App Store Connect; macOS window captures
   and any store-facing screenshots as documented in `submission/`.
4. Tag the release only after publication is confirmed in each channel.
