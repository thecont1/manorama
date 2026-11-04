# Vault efficacy measurement plan

Executable design for §K of `docs/encrypted-sources-and-original-media-fidelity.md`.
Question under test: **does the encrypted vault measurably improve the viewing
experience compared with streaming, without unacceptable cost?**

Thresholds are fixed here, before any number is collected. A measurement that
misses its threshold is a finding, not a rounding problem — it goes into the
efficacy report exactly as measured.

## Test matrix

| Axis | Levels |
|---|---|
| Vault policy | `fill` (default) vs `stream` (no new fill; existing copies still open) |
| State | cold (app killed, vault untouched since last fill) vs warm (gallery opened once this session) |
| Network | fast Wi-Fi · throttled (~10 Mbps / 100 ms RTT via Network Link Conditioner or equivalent) · airplane mode |

- One device, one build, one gallery per run set. Reference device: the
  owner's daily iPhone (recorded per run in the report).
- Cell order randomized; ≥ 5 runs per cell; discard the first run after any
  build install (JIT/asset warm-up, not product behavior).
- All instrumentation is local-only: in-page `performance` marks and a debug
  overlay/console log. Nothing is sent anywhere — the vault's privacy
  properties apply to its measurements too.

Reference galleries (fixed for the whole study): **50-image** (~150 MB),
**200-image** (~600 MB), **1000-image** (~3 GB, exercises the item cap and
eviction). All encrypted-source (MEGA or Ente) so the vault fill does real
decrypt work.

## Metrics and how each is captured

| Metric | Capture | Threshold |
|---|---|---|
| **Time to first thumbnail** | `openGalleryNetworkFirst` entry → first rail `blob:` URL minted (fill path) or first network image `load` (stream path) | vault-warm ≤ 500 ms; vault-cold ≤ 1.5 s |
| **Time to full image** | tap → `materialize`/`vault.read` resolve + decode | vault ≤ 300 ms p50; streaming may be slower — the gap is the finding |
| **Swipe latency** | adjacent-image acquire p50/p95 per run | p50 ≤ 150 ms, p95 ≤ 400 ms vaulted; streaming measured for comparison |
| **`open()` wall time** | `EncryptedOfflineGalleryStore.open` duration at 50/200/1000 items | ≤ 1.5 s / ≤ 8 s / ≤ 30 s on the reference device |
| **Fill wall time** | `cacheFill` settle at each size | reported; no threshold — background |
| **Stream-policy behaviour** | cached copy opens under airplane mode while `loadPolicy === 'stream'`; no new fill appears in `usage()` | pass/fail |
| **Eviction survival** | a fill larger than the cap must not evict its own early entries; post-write verify in `cacheFill` | already unit-covered — confirm once on-device at 1000 |
| **Stale reuse** | replace a photo under the same handle; `contentVersion` mismatch refetches and serves new bytes | already unit-covered — confirm once on-device |
| **Storage** | `vault.usage()` after each fill | ≤ cap; overhead ≤ 5% over plaintext bytes (AES-GCM tag + index) |
| **Battery / CPU / peak memory** | Xcode Energy Log + `performance.memory` on the WebView during a 200-image fill + open | reported; peak JS heap ≤ 256 MB during `readMany` |
| **Correctness** | SHA-256 of each vaulted plaintext == fixture bytes after a decrypt round trip | exact match, every item (unit-covered; spot-check 10 items on-device) |

Report cold and warm separately throughout; never average across states.

## Instrumentation seam (to implement with the vault cluster)

- `EncryptedOfflineGalleryStore` gains an optional injected
  `metrics?: { mark(name: string, detail?: object): void }` — called at
  fill-start/fill-end (entries, bytes, decrypt ms), open-start/open-end
  (entries, bytes), and per-batch inside `readMany` if it helps attribute
  the open gap between storage reads and AES-GCM.
- `openGalleryNetworkFirst` marks `online-resolve` vs `offline-resolve` so
  cold-network and vault paths are distinguished in the same trace.
- The capture harness (`.work/capture-server.ts`) gets a `__vaultMetrics`
  flag alongside `__captureVaultPolicy` that dumps marks to
  `console.debug` / `window.__vaultMetrics` for a Playwright or manual run
  to read — the same flag pattern the offline spec already uses.
- No `Date.now()` sampling inside crypto loops on release paths; the seam
  is inert unless the flag is set.

## Already proven (unit suite — do not re-measure)

Stale-reuse invalidation (`contentVersion`), fill eviction post-write verify,
SHA-256 round-trip correctness, stream-policy listing, missing-entry fail-close,
URL revocation and buffer wiping. The on-device column above only confirms
these once under real conditions.

## Report format (deliverable under §N)

`docs/vault-efficacy-report.md`, one table per gallery size:

```
cell            | first-thumb | full-image | swipe p50 | swipe p95 | open() | fill | peak-heap
vault cold fast |             |            |           |           |        |      |
vault warm fast |             |            |           |           |        |      |
stream   fast   |             |            |           |           |        | n/a  |
... (throttled, airplane rows)
```

Verdict per invariant: improved / degraded / no-difference, with the raw runs
appended. Any threshold miss gets a named root cause before sign-off.
