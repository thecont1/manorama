# Coverage matrix

Legend: **Tested** = exercised by a probe or suite in this pass, with the
evidence named. **Reviewed** = read and traced, no execution. **N/A** = the
surface does not exist at this SHA. **Not tested** = exists, not covered here.

| Area | Status | Evidence and limits |
| --- | --- | --- |
| **A. Authentication, ownership, sessions** | | |
| OAuth start/callback for Apple, Google, Dropbox | Tested | `app/routes/auth/oauth-routes.test.ts` passes at this SHA (single-use state, browser-bound verifier cookie, provider mismatch, missing secret, native/desktop handoffs) |
| `state` as a bearer value (login CSRF) | Tested | Same suite: "a callback from the wrong browser fails before the provider call" |
| PKCE for Google; desktop handoff bound to a verifier | Reviewed | `oauth-flow.ts:162-215`, `desktop-auth.ts:23-43`. No probe here; the route suite covers the wiring |
| Native handoff (60 s, purpose-bound) | Tested | `app/gallery-api.test.ts` asserts a normal session token is refused |
| Desktop handoff replay within 60 s | Reviewed | No single-use store; the PKCE verifier is the binding. Not replayed in a probe |
| Account linking (`?link=1`, `?link={token}`) | Tested | Route suite: web link needs the session, client link binds by token; conflict path reviewed |
| Linking CSRF (a forwarded client link token) | Needs validation | A 60-second token forwarded to a second person makes *their* provider identity link to the first account. No probe; impact depends on product intent |
| Session revocation / suspension | Tested | `app/lib/session.test.ts` (in the passing suite); `resolveManoramaSession` fails closed, `<=1 s` ambiguity documented |
| Cookie flags | Reviewed | `HttpOnly`, `Secure` when https, `SameSite=Lax`, `Domain` only with `SIGNIN_HOST`; deletion mirrors the domain |
| Logout | Reviewed | POST-only; GET `/auth/logout` 404s through the catch-all (cosmetic) |
| Token in URLs / deep links | Reviewed | Only 60 s handoff tokens ride the custom scheme; the session token stays in the secure store |
| **B. Object-level authorisation and gallery lifecycle** | | |
| Cross-owner read/write on galleries | Tested | `probe-web.test.ts`: 8 mutation routes with a stranger's session, row unchanged afterwards |
| Hidden items | Tested | Same file: visitor and stranger get the visible set, owner gets all with `includeHidden=1` |
| Public manifest capability leak | Tested | Same file: no `sourceUrl` in the public manifest |
| Pipeline read-only / expiry | Tested | Same file: 403 `GALLERY_READ_ONLY`, public 404 once expired, owner delete still works |
| Creation limits and duplicate-source | Reviewed | `createGalleryWithinLimit` is one atomic `INSERT … SELECT`; the route suite covers the 403/409 shapes |
| Slug rename / namespace | Reviewed | `updateGallerySlug` is owner-scoped + UNIQUE; reservations from migration 0019 |
| Adopt | Tested | `probe-adopt.test.ts` — and R3-01 |
| Device galleries (tier gate, owner scope) | Tested | `app/device-gallery-api.test.ts` (real schema via miniflare) passes |
| Master / ops console | Reviewed | Server-rendered gate in `opman.tsx`, API gate `requireMasterSession`; no probe |
| Ad suppression | Reviewed | Master-gated writes; visibility read is public and region comes from `cf`, never stored |
| **C. SSRF and provider trust** | | |
| Dropbox / Drive URL canonicalisation | Tested | `probe-sources.test.ts`: lookalikes and userinfo refused before fetch; only the API host is contacted |
| Google Photos `?u=` fetcher | Tested | Same file: strict lh3 host, query/hash stripped, rendition allowlisted |
| iCloud / MEGA / Ente / Proton adapters | Reviewed | Fixed hosts and regex-validated tokens; no injected-fetch probe for these |
| Redirect handling | Reviewed | Workers `fetch` follows redirects by default; no allowlist is re-applied to a followed hop. Not exercised |
| Size / timeout / budget bounds | Reviewed | Per-request 20 s, per-scan 90 s, subrequest budget (`scan-budget.ts`), 48 MB OG cap |
| **D. XSS, untrusted content, navigation** | | |
| Stored/reflected injection in title, caption, alt | Tested | `probe-ssr.test.ts`: `</script><img onerror>` and quote payloads survive as text |
| Curtain `dangerouslySetInnerHTML` | Tested | Same file: value is escaped before the sink |
| Quick-add path | Tested | Same file: only the constant provider label reaches markup |
| EXIF/IPTC/XMP rendering | Reviewed | Rendered as text in the info sheet; no HTML sink found |
| External links / schemes | Reviewed | Islands open links through the shell's opener capability (`native/islands/GalleryList.tsx:249`), whose allowlist the Swift suite tests directly |
| CSP and headers | Reviewed | `security-headers.ts`: `default-src 'self'`, `object-src 'none'`, `frame-ancestors 'none'`, `form-action 'self'`, HSTS, `nosniff`. No CSP violation probing |
| Island props serialisation | Reviewed | `data-serialized-props` is `JSON.stringify` inside an attribute escaped by hono/jsx; compiled into `dist/index.js`. Not exercised at runtime under `bun test` |
| **E. macOS / webview privilege boundary** | | |
| Message gate (main frame + committed document + origin) | Tested | `run-boundary.sh` — trusted reply, child-frame drop, untrusted-document drop |
| Navigation policy, popups, external links | Tested | Swift suite (opener allowlist; `_blank`/`window.open` routing is in `security-audit/poc/macos-bridge-origin`) |
| Command allowlist and argument checks | Reviewed | `NativeBridge.run` switch; private files allowlist; vault prefix; granted-root checks |
| Reply routing / ids | Tested | Swift suite: nil reply carries `value: null` |
| Debug hooks in release | Reviewed | No `isInspectable` set; `developerExtrasEnabled` false |
| Tauri compatibility layer | Reviewed | `capabilities/default.json` (no fs write, no shell, scoped http/opener), `private_store.rs` allowlist, `vault_entry_path` prefix + segment checks. **Not executed** |
| **F. Local filesystem grants and media protocol** | | |
| Traversal / encoded traversal / `%` names | Tested | Swift suite (component-wise containment, decode-once comment verified by the resolver tests) |
| Symlink escape, prefix siblings, revoked tokens | Tested | Swift suite |
| Bookmark round-trip, stale roots, deleted folder | Tested | Swift suite (0700/0600 checks, `roots.json`, missing folder) |
| Vault path validation and permissions | Tested | Swift suite (vault log mode + rotation; `vault_*` commands exercised) |
| Finder reveal / open-source | Tested | Swift suite (`reveal_gallery_root` gated by granted roots) |
| Renderer-writable catalogue as a grant source | Reviewed | `roots.json` is written only by the picker on both shells |
| **G. API / media proxy correctness** | | |
| Content-Type pinning + nosniff + opaque CSP | Tested | `app/media-proxy-hardening.test.ts` in the passing suite |
| Range / 206 forwarding and seeking | Tested | `app/media-proxy-range.test.ts` passes |
| Query preservation through the shell proxy | Tested | `desktop-shell/bridge.test.ts` (percent-encoded path + query) |
| Cancellation / stopped `WKURLSchemeTask` | Tested | Swift suite: a stopped task is never answered |
| Cache partitioning of authenticated JSON | Tested | `probe-cache.test.ts` — and R3-02 |
| Cross-user cache leakage of provider bytes | Reviewed | Thumbnails `private, max-age=300`, originals `private, no-store`; the isolate-level `coalesce` key is the full URL |
| Oversized bodies | Tested | `probe-body.test.ts` — and R3-04 |
| **H. Vault, offline data, cryptography** | | |
| AES-GCM nonce per record, AAD = header + `galleryId\0entryId` | Reviewed | `native/lib/vault.ts:163-183`; record length checked against the authenticated header |
| Swap / truncation / oversized record | Reviewed | Covered by `native/lib/vault.test.ts` in the passing suite; not re-derived here |
| Key custody (Keychain / Keystore / 0600 files) | Reviewed | `SecureStorage` `whenUnlockedThisDeviceOnly`; atomic 0600 writer on both shells |
| Deletion verification | Tested | Swift suite (keychain remove verified by probe; vault log rotation); `gallery-key-store` remove/get-back |
| Cross-account vault after sign-out | Reviewed | Documented: copies persist on the device until purged (`docs/privacy-policy.md:41`) |
| Vault-after-account-deletion | Reviewed | Same sentence; `clearAllEncryptedSources()` purges gallery keys, the vault is purged separately |
| MEGA/Ente/Proton key custody | Reviewed | Key rides the fragment and never reaches the Worker (keyless manifests validated server-side) |
| **I. Billing and entitlements** | | |
| Stripe signature, freshness, settled-session rule | Tested | `app/billing-webhook.test.ts` passes; the `setUserTier` batch is the same call the admin route uses |
| RevenueCat HMAC + static auth + ordering | Tested | Same suite |
| Replay / out-of-order / duplicate | Tested | Same suite (watermark); the ORDER BY-less pre-check is duplicated in SQL |
| Tier → pipeline promotion / device-row delete | Reviewed | `setUserTier` batch; D1 semantics not re-executed here |
| Client-side tier display (RevenueCat) | Reviewed | Client value only affects UI; the server gates the writes it protects |
| Offer wording vs enforcement | Reviewed | 3 + 96 / 99 / local-is-Visionary all match `gallery-policy.ts` and the device gate |
| **J. Privacy and data minimisation** | | |
| Originals not persisted server-side | Tested | Proxy tests + `Cache-Control` inspection; OG cards are declared derivatives |
| Deletion never touches the provider | Reviewed | No provider write in any delete path |
| Device sync excludes paths/names | Reviewed | `device_galleries` columns carry title/kind/count only; `device_label` is local-only |
| Logs and traces | Reviewed | `head_sampling_rate = 0.1`; failure log redacts `rlkey`/`k`/`resourcekey`; iOS `Trace.log` records media *paths* locally |
| "noindex" treated as authorisation | Reviewed | Public galleries are genuinely public; nothing gates on the meta tag |
| Policy text vs implementation | Tested | R3-03 (`docs/privacy-policy.md:39,43`; `packages/core/privacy-policy.ts:163-185`) |
| **K. Supply chain, builds, release** | | |
| Lockfile / overrides / scripts | Reviewed | `package.json` overrides pin the known-vulnerable transitives; `bun.lock` present |
| GitHub Actions permissions and pins | Reviewed | `permissions: contents: read`, SHA-pinned actions, `environment: production` |
| Signing / entitlements | Reviewed | `hardenedRuntime`, sandbox entitlements, no `DEVELOPMENT_TEAM` override |
| Debug capability in release | Reviewed | No inspectable webview; no dev-only route outside `bun run dev` |
| Source maps published | Reviewed | The build emits `dist/index.js.map` (~9.5 MB); served as a static asset if requested. No secret is inlined |
| Deprecated distribution paths | Reviewed | Downloads redirects to the latest release only; older installers hidden (documented) |
