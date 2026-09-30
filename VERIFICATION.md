# manorama v1 verification report

## Deployment

| Item | Result |
| --- | --- |
| Public gallery | https://manorama-italy-2018.thecontrarian.workers.dev/italy-2018 |
| Worker | `manorama-italy-2018` |
| Cloudflare version | `4c63335d-63ff-4812-93b1-3ef8c605edae` |
| GitHub repository | https://github.com/thecont1/manorama |
| Final commit | `bf24d06` |
| Valid gallery path | `/italy-2018` |
| Root and unknown paths | 404 |
| Privacy | `X-Robots-Tag: noindex, nofollow, noarchive`; robots disallows crawling |

## Local acceptance matrix

The supplied acceptance spec was extended with explicit alternate-mode and credentialed-reader checks. The complete local run passed **27/27** tests against a sandbox-local Vite server at 375×812 touch, 1440×900 desktop, and 2560×1440 wide viewports.

The passing checks cover curtain dismissal, the one-visible-control rule, hash deep-links, keyboard navigation, pointer drag, modal contents and focus restoration, default-hidden arrows and modal toggling, low CLS, axe accessibility, unsigned-image credentials state, vertical and one-at-a-time mode switching with position preservation, and end-to-end C2PA validation.

## C2PA and image integrity

The supplied `MS201810-Italy0100.jpg` is the credentialed test image. The build pipeline copies it byte-for-byte into the deployed public asset tree. The local browser fetched that served file, initialized `@contentauth/c2pa-web` with the separately served official Wasm binary, read `manifestStore()`, and displayed the `cai-manifest-summary` component from `c2pa-wc`. The panel reported `Content Credentials verified in this browser.`

The public smoke check confirmed one `c2pa: true` manifest entry and found the `c2pa` marker in the bounded download of the deployed credentialed JPEG. The pipeline report contains `PASS` for the credentialed byte-copy check and for all non-credentialed dimension/ICC checks.

## Public smoke checks

The deployed public route returned HTTP 200 with `Cache-Control: no-cache` and the expected noindex header. `/` and `/other` returned HTTP 404. `/robots.txt` returned `User-agent: *` and `Disallow: /`. The public HTML contained the server-rendered curtain and loaded the gallery route successfully in the connected browser.

The full browser matrix was run locally because the isolated public-network Playwright runner exceeded its 30-second navigation timeout against the Workers.dev hostname. Public HTTP and asset checks passed independently, and the deployed page was visually opened in the connected browser.

## Build checks

`bunx tsc --noEmit`, `bun run gallery`, and `bun run build` all passed. The client manifest keeps both `@contentauth/c2pa-web` and `c2pa-wc` in dynamic imports; the initial hydration entry remains separate from the 8 MB Wasm asset and the provenance component chunk. Generated gallery assets and the integrity report are committed, while `dist/`, `node_modules/`, `.wrangler/`, and test artifacts remain ignored.

## References

[1]: https://github.com/thecont1/thecontrarian-in-website "Reference carousel implementation"
[2]: https://opensource.contentauthenticity.org/docs/sdk-repos/c2pa-js/packages/c2pa-web/ "Official c2pa-web documentation"
[3]: https://github.com/honojs/honox "HonoX source repository"
## Running the unit suite

**Use `bun run test:unit`.** A bare `bun test` at the repository root does not work in this
checkout:

```
error: EMFILE reading ".../test/hono-jsx-dom.ts"
error: Cannot read directory ".../app": EMFILE
```

The git worktrees live inside the repository at `.worktrees/`, and each carries its own
`node_modules`. That puts about **1,048,000 files under bun's scan root**, so the runner
exhausts its file-descriptor budget before it can load the `preload` from `bunfig.toml`.
The per-process limit is not the problem — a bun process here can open 122,876 descriptors.

`scripts/test-mirror.sh` mirrors the working tree into a scratch root that holds no
worktrees and no build output, symlinks the one `node_modules`, and runs `bun test` from
there. The checkout itself is only read. Extra arguments pass straight through:

```sh
bun run test:unit                                  # whole suite
bun run test:unit -- ./native/islands              # one directory
bun run test:unit -- -t 'account slot entitlement' # one test name
MANORAMA_TEST_ROOT=/tmp/mirror bun run test:unit   # keep the mirror somewhere else
```

### Running it from a subdirectory is not equivalent

The DOM renderer that `test/hono-jsx-dom.ts` preloads is order-sensitive, and starting the
scan inside a subdirectory changes which specs share a process. Measured on one commit:

| Invocation | Result |
| --- | --- |
| `bun test ./app/server.test.ts` from the repository root | **30 pass / 0 fail** |
| `cd app && bun test ./server.test.ts` | **25 pass / 5 fail** |
| `cd app && bun test` | 569 pass / 62 fail, 45 files |
| `bun run test:unit` | **1050 pass / 0 fail**, 82 files |

Only the repository-root invocation is authoritative, which is exactly the one that needs
the mirror.

### Two files need more than the sandbox grants

`app/lib/gallery-retention.test.ts` (the `(d1)` variants and the `0002` migration) and
`app/account-deletion-api.test.ts` stand up a local miniflare server through wrangler. They
need two things that a restricted execution sandbox refuses: a **writable `~/.wrangler`**
(for wrangler's log file — otherwise `EPERM`) and permission to **bind a loopback port**
(otherwise `EADDRINUSE: Failed to start server. Is port 0 in use?`). When either is denied
the suite reports 24 failures and several cascading `(unnamed)` unhandled errors from the
`dispose()` calls in those files' `afterAll`. With both granted, the whole suite is green,
and the total test count rises from 964 to 1050 because those describes no longer abort
partway.

If you see those `EADDRINUSE` / `EPERM` failures, you are looking at the sandbox, not at a
regression. Do not "fix" the tests.