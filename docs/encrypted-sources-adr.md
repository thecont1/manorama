# ADR: encrypted sources and original-media fidelity

Status: accepted for implementation
Date: 2026-11-03
Baseline: `main` @ `916f0f9` (code-identical to `b39e354`; the newer commit adds only the plan)
Owner: Mahesh Shantaram
Independent pre-code review: HO1-equivalent, approve-with-amendments; all amendments are incorporated below.

## Starting state

The server currently holds every MEGA share key. Create, dashboard scan, refresh, gallery media, and OG generation send keys to the Worker. `source_url` persists the fragment, item and preview URLs carry per-node `k=` keys, and a module-level cache holds decrypted previews. The goal is therefore a migration away from existing custody, not a claim that custody never existed.

## Invariants

1. Tier 1: no server cache of decrypted encrypted-source media or derivatives, including photographs, thumbnails, module maps, Cache API, CDN, and object storage.
2. Tier 2: remove server key custody surface by surface. Legacy key custody is a named, reversible migration exception until M7.
3. The native vault remains AES-GCM encrypted at rest. Plaintext exists only in bounded client memory and the encrypted vault.
4. Gallery routes contain no third-party scripts. Synthetic keys and fixture bytes are privacy canaries in CI.
5. No zero-knowledge or zero-cost claim. Anyone holding the full gallery link can open the provider share directly. Every encrypted-source gallery shares the static social preview image.

Unencrypted-provider OG composites remain the sole one-day edge-cache exception, with an owner decision due 2027-02-01. The owner opt-in server-assisted encrypted preview card is not shipped.

## Decisions

### D1 — Fragment carries handle and share/album key

A gallery fragment contains the complete provider source URL, encoded as one `source` fragment parameter. It therefore carries provider, handle, and secret without putting either in a backend request. The client re-lists on open and may cache the listing only in memory for the tab session. Per-node keys never appear in gallery item IDs or URLs.

### D2 — Immutable gallery identity and client key stores

A migration adds a random immutable gallery `id` and `manifest_version`. Client key stores are keyed by that id, never by reusable slug. Deletion clears the entry; export includes a lost-key warning.

Web keys live in `sessionStorage` only: they survive reload and same-tab library navigation, and disappear when the tab session ends. Pending quick-add secrets also move from `localStorage` to `sessionStorage`; OAuth `next` URLs exclude fragments. A keyless web open presents an unlock panel accepting the full Manorama or original provider link and never calls a server decryptor. Native stores use OS-backed secure storage and persist across launches.

### D3 — Client-driven encrypted refresh

Encrypted scans and refreshes run on the owner device. The server accepts only validated keyless manifests and retains the retained-gallery update guard. Pipeline galleries remain read-only.

### D4 — Static encrypted-source OG image

Encrypted-source gallery metadata points directly at `/og-image.png`, without `?i=`. The OG route short-circuits before source selection for encrypted providers. Metadata derives the PNG MIME type and always includes item count and provider label, plus date when set. `/api/og` remains for unencrypted providers; its MEGA decrypt reach is removed at M7.

### D5 — Direct ciphertext transport; relay only if required

The 2026-11-03 synthetic CORS spike demonstrated `Access-Control-Allow-Origin: *` on MEGA API and a live CDN preflight. Direct browser transport is therefore the first path. CSP is narrowly relaxed for MEGA API and `*.userstorage.mega.co.nz`. A real signed CDN GET remains a fixture gate. If direct transport fails, a relay must re-resolve by keyless node reference per request, accept no key or raw URL, restrict hosts/methods/redirects/sizes, stream ciphertext, and disable application/CDN caching and sensitive logging.

### D6 — Encrypted vault with plaintext materialization seam

Native cache fill calls `materialize(image)`, which returns plaintext bytes for both HTTP and encrypted references. Ciphertext and plaintext working buffers are wiped after encrypted writes. MIME comes from decrypted bytes or filename, not a ciphertext response header. Vault manifests hold keyless references; content-version markers gate byte reuse.

### D7 — Native fragment channel

Native gallery deep links accept a source fragment. Selection carries it through to manifest resolution; the native key store is consulted using immutable gallery id before online media resolution. Missing keys show a locked state, never a silent library fall-through or server-decrypt fallback. In-app browser bars, history, and Android recents may reveal fragments and are documented accordingly.

### D8 — No third-party gallery scripts

CI rejects third-party script origins and inline third-party snippets on gallery routes. Session storage is script-readable, so this is a load-bearing privacy boundary.

### D9 — Client scan and manifest submit

For encrypted providers, create/scan/refresh submit validated keyless manifests. Fragments are never POSTed. The server enforces item caps, lengths, provider-reference patterns, ownership, dimensions, content-version shape, and scheme/host allowlists for every server-fetchable field. Re-supplying a secret for known `(provider, handle)` updates the client key store; it does not update a server secret and does not produce a duplicate-source 409.

### D10 — Published layout dimensions and opaque content version

New encrypted manifests carry integer dimensions and a 64-hex-character SHA-256 content-version marker computed client-side from provider handle, size, timestamp, and related fields. Dimensions describe layout aspect, not original resolution. Bounds are 1–100,000 pixels per side and 1:10–10:1 aspect. Existing strip/fold geometry already constrains rendered frames independently; the clamp rejects pathological metadata such as 1×10000 before it reaches layout. Probe failure retains the 4:3 fallback. Dimensions are not a security boundary.

## Rollout gates

- M1–M4 establish identity, key stores, validated manifest create, client media resolution, and static OG.
- M5–M6 prove the MEGA client path and native fragment/vault path with a limited synthetic cohort while legacy records remain reversible.
- M7 removes server MEGA plaintext endpoints, decrypted-preview cache, server probes, and OG decrypt reach. The strict import-graph and no-backend-key canaries are end-state gates from M7 onward; before then, legacy key custody is explicitly transitional.
- M8 implements the hosted Ente public protocol independently. Upstream `ente/ente` @ `2eb6802727b1c096b0a616b0858b6c1821bf9808` is AGPL-3.0 and is used only as a protocol specification; no code is copied.
- M9 makes fidelity claims only from evidence. Apple documents legacy 2048px reduction and original resolution for newly shared items in upgraded albums, but anonymous byte identity, edited renders, HEIC originals, and C2PA preservation remain unverified until rights-cleared fixture hashes exist.

## Reversibility and failure behavior

Legacy MEGA records retain server-held keys until the owner verifies the converted gallery on two devices or explicitly opts out. Key deletion warns about irreversibility, logs/backups, and recommends share-link rotation. Rollback never silently re-enables server decryption; unsupported states fail visibly.

## External research record

- MEGA CORS: synthetic preflight/header evidence supports direct access; CDN host rotation is real. Actual media GET requires a rights-cleared share fixture.
- Ente: hosted link token is query data, album key is fragment data. Public album API supports wrapped collection/file keys, paginated diff, local password derivation, expiry/revocation/device limits, and separate media origins. `enable_download` hides UI but was not proven to be a server enforcement boundary; Manorama treats it as a UI control only.
- Apple: Shared Album limits and upgrade behavior are documented by Apple Support HT148868 and HT108916. Public CloudKit behavior remains undocumented and must not be equated with byte-identical original delivery without hashes.
