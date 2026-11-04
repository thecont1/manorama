# Encrypted-source validation report

Date: 2026-11-04 · Commit: `385f881` · Author: review follow-up

This report records what is verified, what is measured, and what remains open.
It replaces no synthetic coverage; it adds the live and deployment evidence the
review asked for, and states plainly what could not be run in this checkout.

## Deployment state (Task 6 evidence)

- **Production (`manorama.xyz`)**: `GET /api/mega/file` answers
  `410 {"code":"SERVER_DECRYPT_RETIRED"}` — `LEGACY_ENCRYPTED_DECRYPT` is **not**
  set in production. Direct Workers settings/services reads are denied to the
  available credential (HTTP 403), so the response code is the observable
  deployment state, not an enumerated var list. Checked 2026-11-04.
- **Staging**: declares no flag in `wrangler.toml`; the workers.dev hostname did
  not resolve for probing, so staging posture is configuration-evidenced only.
- **Repository**: the flag and both retired routes are removed (#172) — the
  endpoints answer 404 from the tree, and no environment variable can restore
  a server decrypt path. The 410 measurement above predates removal and is
  kept as the production record for that date.

## Live transport evidence

- A rights-configured 69-item share (`MANORAMA_DEV_SOURCE_MEGA`) completed a real
  CDN media GET in-browser: ciphertext fetch from
  `gfs*.userstorage.mega.co.nz`, AES-128-CTR decryption, and whole-file
  meta-MAC verification — verified by both the keyed Playwright spec and a
  direct `openMegaSession().materialize()` probe on 2026-11-04. A wrong MAC
  algorithm would reject every real file; none did.
- Limits: previews are ranged reads and deliberately unverified by the
  meta-MAC (the chain covers the complete file). Only the
  `*.userstorage.mega.co.nz` CDN family was exercised; other MEGA CDN hosts
  remain unverified.

## Browser measurements — live network

Script: `scripts/measure-encrypted-gallery.mjs` (committed). Fixture: the live
seeded share, 69 items. No deterministic local encrypted fixture exists, so
these numbers carry live-network variance and are informational, not a budget
gate. Chromium (Playwright), 3 cold + 2 warm opens per viewport. A cold run
navigates to the keyed `#source=` link; a warm run navigates to the bare
gallery URL in the same browser context, so opening depends on the stored
session key — not a reload of the keyed link.

Time to first `blob:` image (ms), post-#173 (media materializes off the
folder listing; the probe pass no longer gates first paint):

| Viewport | Cold median | Cold p95 | Warm median | Warm p95 |
|---|---|---|---|---|
| 375×812 | 4,853 | 5,407 | 2,822 | 3,339 |
| 1440×900 | 4,871 | 4,884 | 2,875 | 3,499 |
| 2560×1440 | 4,367 | 4,377 | 3,323 | 10,397 |

Pre-#173 baselines for comparison (5 cold + 3 warm, same fixture): cold
medians 14,908–16,400 ms, warm medians 11,355–11,858 ms — the probe pass
(serialized dimension discovery) gated the resolver entirely.

Observations:

- `workers: 22–28` constructions per open (was 79) — the first frame lands
  before most of the probe pass has even spun a Worker.
- One `blob:` image at first-frame settle — the resolver's bounded object-URL
  set holds; full-strip materialization proceeds in the background after the
  first frame.
- JS heap ~16–17 MB at settle.
- Warm opens (stored session key, fragment-less URL) save ~2 s — the stored
  key skips custody checks, but the folder is still re-listed every open;
  remaining latency is the listing + first materialize.

## Client-scan request profile (#171)

Measured 2026-11-04 by wrapping `openMegaSession`'s `fetchImpl` with a
per-command counter against the live 69-item collection share:

- 1 listing call (`a:aft` for collections; `a:f` for folders)
- 2 requests per probed item — `a:ufa` + CDN POST when the node carries an
  `fa` attribute (all 69 did); the `fa`-less fallback is `a:g` + ranged
  head GET, also 2 per item
- Total: 139 requests for 69 items → extrapolated ~601 for 300 items,
  ~2,001 at the `MAX_GALLERY_ITEMS` cap of 1,000

Consequence: the shared 950-subrequest budget — sized for Workers-era
server scans, still correct for Dropbox — would truncate a MEGA scan at
~475 items even though the gallery cap is 1,000. The MEGA probe pass now
runs under `MEGA_SCAN_REQUEST_BUDGET` (3× the item cap) as a fan-out
backstop, and a share over 1,000 items is refused at listing with the
count and the limit named — owners see the reason instead of a partial
scan or a generic offline error.

## Not runnable in this checkout

- **Native/vault measurements** — require a physical iOS device with the app
  built and signed (vault fill, airplane-mode reads, ciphertext-at-rest,
  memory pressure, cleanup after deletion/sign-out). No device was attached.
  Plan step preserved as open evidence work.
- **Rights-cleared Apple fixtures** — edited photo, HEIC original, and a
  shared-stream item with provider-export hashes. No fixture set exists in
  this checkout; iCloud fidelity rows remain evidence-limited as documented in
  `docs/original-media-fidelity.md`.
- **Ente** — explicitly deferred: no client, scanner, or network path ships.
  Protocol research is not live evidence.
- **Native six-state captures** — `demo:capture:native` does not exist as a
  script; the six-state matrix requires iOS/macOS bundles (`capture-screens.sh`
  drives simulators/devices). In-browser coverage substitutes only partially:
  `specs/native-vault-controls.playwright.ts` captures admin/editor/account
  states and `specs/encrypted-gallery.playwright.ts` covers locked and keyed
  open at the three viewports. No capture state was deleted.

## Unit/browser gate status at commit

- `bunx tsc --noEmit` clean
- `bun run test:unit` — 1629 pass / 0 fail / 140 files
- `bun run build` (client + worker) green
- `bunx playwright test specs/encrypted-gallery.playwright.ts` — 4/4 at
  375×812, 1440×900, 2560×1440 including the keyed on-device decrypt
