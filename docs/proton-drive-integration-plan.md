# Proton Drive as an encrypted gallery source — integration plan

Status: planned, not started (2026-10). Companion to
`docs/encrypted-sources-and-original-media-fidelity.md`.

Proton Drive public links (`https://drive.proton.me/urls/{token}#{password}`) carry
their decryption secret in the URL fragment — the same custody model as MEGA's
`#key` and Ente's fragment. That makes Proton a third `EncryptedSourceProvider`
behind the existing seam: the client scans and decrypts on-device, the server
stores a keyless manifest, and `openEncryptedSource` gains one more provider
branch.

## Why it is feasible

`@protontech/drive-sdk` (npm, MIT, actively maintained — 0.23.0 as of Oct 2026)
exposes the anonymous public-link path the first-party web client uses:

| Need | SDK surface |
| --- | --- |
| Open a share link | `ProtonDriveClient.experimental.authURLAccess(url, customPassword?, isAnonymousContext?) → ProtonDrivePublicLinkClient` |
| URL → token + key | `getTokenAndPasswordFromUrl` — path token, `#` password |
| Folder listing | `getRootNode()` → `iterateFolderChildrenNodeUids` → `iterateNodes` (`mediaType` marks images/videos) |
| Decrypt original | `getFileDownloader(uid).downloadToStream(stream, onProgress?)` — decrypts + verifies blocks |
| Decrypt thumbnail | `iterateThumbnails(uids, ThumbnailType)` → `Uint8Array` |
| Dimension probe | `activeRevision.claimedAdditionalMetadata` (extended attrs hold photo EXIF/dims); fallback: `getSeekableStream()` = ranged reads, same trick as the MEGA head-probe |
| Progress (stretch) | `downloadToStream`'s `onProgress` + `getClaimedSizeInBytes()` — an honest determinate progress signal MEGA can't give |

## Constraints (decided)

- **Terms.** The SDK is sanctioned for personal/non-commercial use; third-party
  production use awaits GA. We build anyway and ship — the honest-identity rules
  still apply: `x-pm-appversion: external-drive-manorama@{version}-stable` on
  every request through our `ProtonDriveHTTPClient` impl, no Proton branding.
- **Crypto migration.** A breaking cryptographic-model change is targeted for
  end-2026/early-2027; SDK clients on the old model stop interoperating until
  upgraded. Pin the dependency and expect a bump + regression check then.
- **Zero-knowledge.** The `#password` never reaches the Worker. The manifest
  stores `https://drive.proton.me/urls/{token}` keyless; key custody rides the
  existing sessionStorage store (`webGalleryKeyStore`) unchanged.
- **Browser bundle.** The package is CJS-only (`"main": "dist/index.js"`, no
  `exports`/`module`). Vite pre-bundles it fine behind a dynamic `import()` —
  the same isolation the MEGA/Ente clients get. It must never appear in the
  Worker import graph (the architecture guard enforces this).

## URL model

`protonIdentityFromUrl` accepts `https://drive.proton.me/urls/{token}` —
token in path, secret in fragment. `keylessSourceUrl` needs no special case:
clearing `url.hash` keeps the path identity intact (unlike MEGA legacy `#F!`
links where the identity itself is in the fragment).
`encryptedSourceFromGalleryHash` already requires `url.hash` — satisfied.

## File-by-file change list

### `packages/core/encrypted-source.ts` (platform-free — no SDK imports)

- `EncryptedSourceProvider` → `'mega' | 'ente' | 'proton'`.
- `ProtonMediaReference`: `{ kind: 'encrypted', provider: 'proton',
  sourceKind: 'urls', sourceId: <share token>, nodeId: <nodeUid> }`.
  Proton nodeUids are `{volumeId}~{nodeId}`-style strings — confirm the exact
  alphabet during implementation and pick a matching validator in
  `mediaReferenceIsValid` (start permissive: `/^[0-9A-Za-z_~=-]{1,256}$/`).
- `protonIdentityFromUrl(input)` → `{ kind: 'urls', id: token } | null`;
  wire into `encryptedProviderForUrl`.
- `keylessSourceUrl`: no branch needed — falls through to `url.hash = ''`.
- `mediaReferenceIsValid`: add the `proton` case.

### `app/lib/encrypted-resolver.ts`

`provider: 'mega' | 'ente' | 'proton'` in the reference union it re-derives.

### `app/lib/encrypted-manifest.ts:71`

Provider union + identity check: add `'proton'` and
`protonIdentityFromUrl(sourceUrl)`.

### `app/lib/proton-client.ts` (new — the only SDK importer)

Mirror `openMegaSession`'s contract:

```ts
export type ProtonScan = { sourceUrl: string; title: string; images: GalleryImage[]; truncated?: number }
export type ProtonClientSession = {
  sourceUrl: string
  scan: Promise<ProtonScan>
  materialize(nodeUid: string, preview: boolean, signal?: AbortSignal): Promise<{ bytes: Uint8Array; mimeType: string }>
  dispose(): void
}
```

- `openProtonSession(input)`:
  1. Parse token/password via `protonIdentityFromUrl` + `url.hash`.
  2. `new ProtonDriveClient({ httpClient, account, openPGPCryptoModule,
     srpModule })` → `experimental.authURLAccess(url, undefined, true)`.
     - `httpClient`: ~40 lines implementing `ProtonDriveHTTPClient`
       (`fetchJson`/`fetchBlob`) over `fetch`, injecting
       `x-pm-appversion: external-drive-manorama@{pkg.version}-stable`.
     - `account`: `ProtonDriveAccount` stub — public-link sessions are
       anonymous; implement it to throw `Error('anonymous')` on every method
       and confirm at runtime the SDK never calls it. If it does, revisit.
     - `openPGPCryptoModule`: `new OpenPGPCryptoWithCryptoProxy(CryptoProxy)`
       — `CryptoProxy`/`CryptoApiInterface` comes from `@protontech/crypto`.
     - `srpModule`: SRPModule impl from `@protontech/crypto` — locate the
       exported SRP helper during implementation (`getSrp`/similar); it is an
       interface the SDK consumes, ~4 methods.
  3. `scan`: `getRootNode()` → `iterateFolderChildrenNodeUids` → batch
     `iterateNodes`; keep `NodeType.File` with image/video `mediaType`;
     title = decrypted root node name.
  4. `materialize(nodeUid, preview)`:
     - preview → `iterateThumbnails([uid])`, first ok result's bytes.
     - original → `getFileDownloader(uid).downloadToStream(writable)`;
       collect into `Uint8Array` (pipe through a manual `WritableStream`
       that buffers chunks — reuse the byte-collect pattern if one exists,
       else ~15 lines). Respect `signal` via `DownloadController`.
     - mimeType from the node's `mediaType`.
  5. `dispose()`: drop the client; zero any retained key material
     (follow the MEGA session's disposed-flag + waiter-drain shape if the
     scan races ahead of materialize).
- `EncryptedGallery`'s gate is provider-agnostic — no change expected.

### `app/lib/encrypted-client.ts`

Third branch: `provider === 'proton'` → dynamic `import('./proton-client')`
→ adapt to `EncryptedClientSession` (same wrapper shape as the MEGA branch).

### `app/lib/sources.ts`

- `SourceProvider` union + `providerForUrl`: `drive.proton.me` → `'proton'`.
- Scan dispatch: `case 'proton'` → `throw new Error('Proton Drive sources are
  scanned on your device, never by the server')` (architecture test expects
  the MEGA phrasing — match it).
- Source-hint copy (`'Paste a public Dropbox folder … or Ente album link'`)
  gains "or Proton Drive folder link" — also check `AddGallerySheet` /
  `WebSettings` hint strings for the same enumeration.

### `app/lib/source-label.ts` + `app/islands/Admin.tsx:99 sourceLabelFor`

`'Proton Drive'` label for the URL.

### `app/encrypted-architecture.test.ts`

`DECRYPTOR_MODULES += 'proton-client'` (SDK imports live only there).

### `app/api.ts` / `gallery-repository.ts` — check-only

The refresh path validates manifests through `encrypted-manifest.ts`; confirm
no other `provider` literal union needs widening (grep `'mega' \| 'ente'`
again at implementation time).

### Dependencies

- `bun add @protontech/drive-sdk` — pin a release ≥ 7 days old at install time.
- `bun add @protontech/crypto` — for `CryptoProxy`/`CryptoApiInterface` and the
  SRP implementation. Audit its dependency closure (openpgp.js, libsodium
  wrappers) before committing — it is the heavy part and rides inside the
  island dynamic-import chunk only.
- If the SRP impl lives elsewhere (`@protontech/srp`?), add it too — resolve
  during wiring.

## Dimension strategy

Order of preference, matching the MEGA fix's intent (reserve space for the
**original**):

1. `activeRevision.claimedAdditionalMetadata` — Proton stores photo dims in
   extended attributes; inspect its real shape on a live share first (the SDK
   ships `additionalNodeMetadata/exifParser` for its own use).
2. `getSeekableStream()` ranged head → `displayedImageDimensions` (reuse —
   already handles EXIF orientation swap).
3. Preview thumbnail dims → 4:3 guess, exactly like MEGA's fallback chain.

## Tests

- `encrypted-source` unit tests: `protonIdentityFromUrl` cases,
  `keylessSourceUrl` strips `#password`, `mediaReferenceIsValid` for the
  proton reference, `encryptedSourceFromGalleryHash` round-trip.
- `sources.ts`/`source-label` routing + label.
- `encrypted-manifest` accepts `provider: 'proton'` manifests.
- The architecture guard list itself is the enforcement test.
- No Playwright — same posture as Ente (no live share to seed).

## Rollout

No feature flag — the provider ships enabled like MEGA/Ente (owner-scale app,
dev-to-prod). Before the crypto-migration lands: pin the SDK, note the version
in `AGENTS.md`'s dependency notes, and re-run the full unit suite on bump.

## Open questions for the implementer

1. Exact `nodeUid` alphabet for the `mediaReferenceIsValid` regex — read a
   live public link's `iterateNodes` output.
2. Whether `account` can be a throwing stub (expected yes for
   `isAnonymousContext: true`) — verify the SDK never dereferences it on the
   public-link path.
3. Where `SRPModule`'s implementation is exported (`@protontech/crypto`
   helpers vs. a separate package).
4. `claimedAdditionalMetadata`'s real field names on a Proton photo node —
   log one node's xattrs during first integration.
5. Video handling: Proton video in one-by-one — does `getSeekableStream`
   serve it well enough for `<video>` playback, or do we materialize whole
   files like MEGA videos today?
6. Custom-password-protected shares (`customPassword` param): out of scope —
   reject with a clear message if `getURLAccessInfo.isCustomPasswordProtected`.
7. `isLegacy` public links (pre-token format): `authURLAccess` rejects them —
   surface "that link is no longer supported by Proton" rather than a generic
   failure.
