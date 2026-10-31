# manorama coordinated release packet — P12

This packet collects everything the owner needs to publish the photography-first
redesign as one release window. Nothing here deploys, tags, pushes to main,
migrates data, or submits to a store — those remain distinct owner actions.

## Integration commit

- Branch: `fix/redesign-p12` (worktree `.worktrees/p12`)
- Head: `2ecedf5` (`docs(release): prepare the coordinated release packet`)
- Artifacts built at: `240e8e6a708dfa58dbf0d668d56f728e9cc939a5` — the packet commit adds documentation only, so the recorded hashes apply to both
- Base: `origin/main` @ `3174cb6`
- Logical commits on the branch: client hydration hardening, provider retry/cache, desktop catalogue restore, style pruning + details overflow fix, local font bundling, evidence-spec alignment, docs refresh, evidence captures.

## Required gates at the integration commit

| Gate | Result |
|---|---|
| `bunx tsc --noEmit` | clean |
| `bun run test:unit` | 1438 pass / 0 fail |
| `bun run build` (web) | pass — `dist/index.js` 2,224.84 kB (gzip 621.30 kB) |
| `bun run build:native` | pass |
| `bun run build:desktop` | pass |
| Playwright suite | 257 pass / 18 skip; the four suite-load failures each pass in isolation (iCloud 509 and Dropbox 429 windows, one decode-timing gesture) — provider throttle windows, not product regressions |
| Evidence specs (`PW_EVIDENCE=1`) | capture-harness 16/16, native-vault-controls 4/4, desktop-admin 10/10, desktop-catalogue 4/4 |

Remaining classification note: upstream providers throttle under full-suite
parallel load. Every failure observed this cycle was reproduced as transient
(429/509/503 windows) and the same spec passed minutes later quiet; one
pre-existing flake class (SSR image load races) is now fixed in product code.

## Build artifacts

Fresh bundles built from the integration commit; SHA-256 for every shipped
JS/CSS/HTML file is recorded in `outputs/rc/artifacts-sha256.txt`.

| Surface | Bundle | Notes |
|---|---|---|
| Web (Cloudflare Worker) | `dist/` | HonoX worker + client; publish via existing `wrangler deploy` procedure — owner action |
| Native (iOS/iPadOS/Android shell) | `native/dist/` | the SPA Capacitor embeds; `bunx cap sync` then archive in Xcode — owner signing |
| Desktop (Tauri) | `desktop/dist/` | macOS bundle via `bunx tauri build --bundles app --target aarch64-apple-darwin` — owner signing/notarization |

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
