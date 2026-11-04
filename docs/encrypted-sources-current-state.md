# Encrypted-source current-state audit

Baseline inspected: `916f0f9`; branch later synced cleanly to `origin/main` @ `5a401d6`. The plan's `b39e354` code references had no drift at the initial review; independent review re-confirmed every V(ext) row.

## Key custody at baseline

1. Browser quick-add reconstructs the provider fragment and POSTs the complete URL. Dashboard scan does the same after a 700ms debounce (`app/quickadd.ts`, `app/islands/Admin.tsx`).
2. `canonicalMegaUrl()` persists the fragment in `galleries.source_url` (`app/lib/mega-public.ts`, `app/api.ts`).
3. MEGA item and preview proxy URLs contain per-node `k=` secrets. They are persisted in `images_json` and shipped in SSR island props (`app/lib/mega-public.ts`, `app/routes/[owner]/[slug].tsx`).
4. Refresh scans the stored keyed URL on the Worker (`app/api.ts`).
5. OG source selection reaches the MEGA file proxy, which buffers and decrypts originals up to 48 MiB (`app/lib/og-card.ts`, `app/lib/mega-public.ts`).
6. `previewCache` retains decrypted previews in a 200-entry / 64 MiB module map (`app/lib/mega-public.ts`).

## Media fidelity at baseline

- MEGA serves decrypted original bytes but skips MAC verification. `c2pa: true` is therefore not an integrity claim.
- MEGA dimensions describe the preview rendition for browser-renderable formats; HEIC may use the original head. Failure falls back to 4:3.
- iCloud has legacy shared-stream and newer CloudKit scanner paths. Original labels must remain evidence-based: resolution alone does not prove byte identity, and an edited full-resolution render is not an original.
- Native vault reuse compares only `src`, so replacement under a stable handle can retain stale bytes (`native/lib/offline-gallery.ts`).
- Native deep links reject gallery URLs with fragments (`native/lib/session.ts`).

## Resolved reference notes

- Gallery primary key is `(owner_id, slug)` and slugs are reusable after deletion. Immutable ids are required for safe client key custody.
- `created_at` has one-second resolution in the original schema and is not a suitable surrogate identity.
- Pipeline galleries are read-only and retained-only update guards already exist.
- `width` and `height` are already published in D1 and island props; publishing them in client manifests adds no new metadata class.
- `/og-image.png` is 1200×630. Current renderer incorrectly labels explicit per-gallery images as JPEG regardless of asset and emits path-only `og:url`.
- Gallery CSP currently has `connect-src 'self'`; no third-party scripts are required by the current gallery route.

## Implementation status after the baseline audit

- Foundation commit `6f180fd` adds immutable gallery ids, session-only web keys, validated keyless manifests, MEGA client scanning/decryption, bounded object-URL ownership, static encrypted OG metadata, and fragment-preserving navigation.
- Reversible migration records non-secret device ids. The first converted gallery keeps its legacy server key; a second distinct verified device or an explicit owner opt-out retires it and stores only the keyless source URL.
- The `LEGACY_ENCRYPTED_DECRYPT` cohort kill switch and the retired `/api/mega/file` + `/api/mega/preview` routes are removed (#172): there is no server-side MEGA decrypt path left in the tree — the endpoints answer 404 and the flag read is gone from `encryptedGalleryGate`, so no environment variable can resurrect it. Server-side MEGA scan dispatch remains rejected unconditionally. Measured before removal (2026-11-04): production answered `GET /api/mega/file` with `410 SERVER_DECRYPT_RETIRED` — the flag was never set in prod — and the production cohort was 2 key-bearing v1 MEGA galleries, neither migrated. Removal merges only after those two retire via the operator or two-device path.
- The single Worker decryptor is `app/lib/mega-client.ts`; the retired `mega-public` path is deleted, and an import-graph guard in `app/encrypted-architecture.test.ts` pins the allowed decryptor-module set so a second decrypt path cannot be reintroduced silently.
- Migrating a truncated client scan is refused with `PARTIAL_SCAN` (HTTP 422): a partial manifest would silently drop gallery tail items once the server key is retired.
- Encrypted create, refresh, and migrate bodies are bounded at 8 MiB, and the repository write boundary rejects serialized manifests past the D1 row limit with `MANIFEST_TOO_LARGE` (HTTP 422) instead of letting D1 fail the write.
- iCloud CloudKit now selects `resOriginalRes`, including HEIC, whenever present and labels derivative fallback separately. See `docs/original-media-fidelity.md` for evidence limits.
- Visitor-facing client gates never receive the stored capability: the island's `sourceUrl` prop is always the keyless form and legacy `k=` item srcs are stripped from SSR props unless the viewer is the owner, who needs them for the migration call.
- The shipped privacy policy (`packages/core/privacy-policy.ts`, mirrored in `docs/privacy-policy.md` with a parity test) makes the unqualified claim that the server never receives an encrypted-source key, followed by an explicit exception paragraph covering legacy galleries whose owners have not yet migrated or opted out.
- The web resolver evicts rejected fetch entries so a transient failure can be retried, and a failed key-store write (quota, private mode) no longer swallows a successful gallery create — the fragment link still navigates.
- The locked gallery panel dismisses the entry curtain itself: the curtain's handlers live in the `Viewer` island that the locked state replaces, so without this it dead-ended keyless visitors. `specs/encrypted-gallery.playwright.ts` covers the locked path at 375×812, 1440×900, and 2560×1440 — static OG card, no `k=` or `#source=` material in the document, no `/api/mega/*` calls, announced locked panel, paste-to-unlock fragment custody, and stored aspect ratio on SSR frames.
- `app/encrypted-privacy-canary.test.ts` is the declared privacy-canary gate (`bun run test:unit -- app/encrypted-privacy-canary.test.ts`); a failure is a privacy regression, not a flake.
- Native scans and decrypts on-device through the same client modules the web uses: full-link opens adopt the keyed source into the Keychain/Keystore gallery key store by immutable gallery id, and the vault fill materializes version-2 media references through the client session rather than the HTTP fetcher. Only a legacy manifest (encrypted source, server-mediated refs) or a locked gallery with no key and no vault copy delegates to `Browser.open`, where the web's unlock flow can help. A gallery vaulted before migration still renders offline from stored bytes.
- A reviewable SQL migration path exists for the small production cohort: `scripts/migrate-encrypted-sources.ts` scans keyed MEGA sources locally with the client scanner and emits SQL that preserves order/hidden flags by matching stored and scanned items on `ref`/`filename`, rewrites items to keyless encrypted media refs, sets `manifest_version = 2`, and strips the fragment from `source_url` only under the chosen retirement policy. The operator applies it through the approved deployment process — the script never writes production directly. Requires migrations `0013`/`0014` applied first.

## Ente public albums — spike record and adapter status

Spike findings for §G of the fidelity plan, recorded 2026-11-04. Upstream
reference: `ente-io/ente` @ `main` (`web/packages/base/crypto/libsodium.ts`,
`web/packages/base/http.ts`, `web/apps/embed/src/services/public-collection.ts`,
`web/packages/media/{collection,file,file-type,file-metadata}.ts`). Upstream is
**AGPL-3.0** — `app/lib/ente-client.ts` is a clean-room implementation against
the documented wire format; no upstream code is copied or vendored.

- **Link formats.** `albums.ente.io/{accessToken}#{albumKey}` (current) and
  `albums.ente.io/?t={accessToken}#{albumKey}` (legacy); `albums.ente.com` is
  the same host family. The fragment is a base58-encoded 32-byte album key
  (hex on some older links) — client-side only, never sent upstream. Custom
  domains exist (`?t=` only) but are out of scope per §G (hosted only).
- **API.** `api.ente.io`: `GET /public-collection/info` (collection record,
  publicURL flags, KDF params; reachable pre-password-unlock), `GET
  /public-collection/diff?sinceTime=` (paginated file records, `hasMore`),
  `POST /public-collection/verify-password` (`{passHash}` → `{jwtToken}`).
  Auth header is `X-Auth-Access-Token`; password links add
  `X-Auth-Access-Token-JWT`; device-limited links issue `X-Link-Device-Token`
  on info/diff responses which the client echoes back as
  `X-Auth-Link-Device-Token`.
- **Media.** `public-albums.ente.com/download/?fileID=` (originals) and
  `/preview/?fileID=` (thumbnails), ciphertext, CORS `*` for GET. Verified
  2026-11-04: `api.ente.io` answers a preflighted GET from
  `https://manorama.xyz` including the auth/device headers and `Range`;
  `public-albums.ente.com` allows any origin for GET.
- **Crypto (libsodium).** File keys and the album name are
  `crypto_secretbox` (XSalsa20-Poly1305) under the album key; metadata and
  public magic metadata are single-chunk secretstream blobs; file and
  thumbnail bytes are `crypto_secretstream_xchacha20poly1305` in 4 MiB
  chunks (+17B per-chunk overhead). Password links derive a 32-byte
  verifier with `crypto_pwhash` (Argon2id, server-supplied ops/mem limits).
- **Sharing controls.** `validTill`/disabled tokens 410 server-side;
  `passwordEnabled` advertises `nonce`/`opsLimit`/`memLimit` for the local
  KDF; `deviceLimit` drives the device-token handshake; `enableDownload:
  false` is a UI affordance in ente's own app — bytes still flow for
  display, and manorama exposes no download control to disable.

Adapter status: `openEnteSession` mirrors the MEGA session contract — the
session returns before the diff resolves, file keys land per diff entry
through a notifying map, `materialize` decrypts previews and originals via
secretstream, and `dispose` zeroes album and file keys. Dimensions come from
`pubMagicMetadata` `w`/`h` with a ranged first-chunk probe fallback. Video
and Live Photos are filtered out at listing. Password-protected links fail
visibly with `EntePasswordRequired` carrying the KDF parameters, and
`verifyEntePassword` implements the verifier exchange — the prompt UI is a
deliberate follow-up since there is no password seam in quick-add yet.

## Transition exceptions

Legacy server-held MEGA keys remain the sole named exception until reversible migration and native readiness complete. The module-level decrypted-preview cache named in earlier audits no longer exists — nothing decrypted is persisted, but "streams through" overstates it: whole-file handling buffers the fetched ciphertext and its decrypted plaintext in memory (bounded by `MAX_FILE_BYTES`) while the response is constructed, and ranged reads buffer their aligned window the same way. With the kill switch and routes removed, server-held keys persist only as the two cohort rows' stored `source_url` fragments — the storage-side exception the cohort close retires, not a decrypt path the server can still run.
