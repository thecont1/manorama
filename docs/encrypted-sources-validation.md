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
gate. Chromium (Playwright), 5 cold + 3 warm opens per viewport.

Time to first `blob:` image (ms):

| Viewport | Cold median | Cold p95 | Warm median | Warm p95 |
|---|---|---|---|---|
| 375×812 | 14,944 | 16,392 | 11,858 | 17,914 |
| 1440×900 | 15,407 | 15,892 | 11,849 | 20,403 |
| 2560×1440 | 15,418 | 17,436 | 11,355 | 13,355 |

Observations:

- `workers: 79` constructions per open — decryption runs in the crypto Worker,
  never the main thread.
- One `blob:` image at first-frame settle — the resolver's bounded object-URL
  set holds; full-strip materialization proceeds in the background after the
  first frame (issue #173 tracks thumbnail-first loading).
- JS heap ~22–23 MB at settle.
- Warm opens (stored session key) save ~3–4 s — the stored key skips custody
  checks, but the folder is re-listed every open. The remaining latency is the
  MEGA listing + per-item probe, matching the #173 follow-up.

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
