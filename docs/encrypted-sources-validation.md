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
- **Repository default**: retired. The flag exists only as a deploy-time cohort
  switch documented in `wrangler.toml` and `.env.example`.

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
