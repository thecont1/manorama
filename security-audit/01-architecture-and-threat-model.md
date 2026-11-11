# Architecture, assets and trust boundaries

Everything below is drawn from the pinned tree, not from `TECH-SPEC.md` or the plans.
Where a document and the code disagree, the code is described and the disagreement noted.

## 1. What actually ships

| Surface | Location | Distributed as | Notes |
| --- | --- | --- | --- |
| Public marketing page | `app/routes/index.tsx`, `app/components/home/*` | manorama.xyz | Only indexable route; no auth, no data |
| Gallery viewer (SSR + island) | `app/routes/[owner]/[slug].tsx`, `app/islands/Viewer.tsx` | manorama.xyz | Public; `noindex` header is a hint, not authorisation |
| Dashboard | `app/routes/[owner].tsx`, `app/islands/Admin.tsx` | manorama.xyz | Session-gated in the handler, owner-only |
| Ops console | `app/routes/opman.tsx`, `app/islands/AdminOps.tsx` | manorama.xyz | Requires a master session |
| API | `app/api.ts`, `app/device-gallery-api.ts`, `app/routes/api/*` | manorama.xyz | Mixed public/session/master; CSRF-relevant CORS |
| Cloudflare Worker | `app/server.ts`, `wrangler.toml` | `manorama.xyz` custom domain | D1 binding, daily cron, 100% log sampling |
| iOS / Android app | `native/`, `ios/App`, `android/` | Capacitor 8, App Store / Play | Bundle from `native/dist`; `capacitor://localhost` / `https://localhost` origin |
| macOS app | `macos/ManoramaMac/*.swift` | plain `.app`, Developer ID signed | WKWebView over a private `manorama://` scheme; `swiftc` build, no Xcode project |
| Windows/Linux/desktop (Tauri) | `src-tauri/`, `desktop/` | `desktop-release.yml` (draft) | Second implementation of the same bridge; capability-scoped |
| Static assets | `public/`, `dist/` via `[assets]` binding | same host | `404-page` fallback |

Deprecated-but-present: `.work/`, `outputs/`, `dist/` and `ios/build*` are artefacts;
`submission/` and `docs/` are records. None is loaded at runtime.

## 2. Assets, ranked by what an attacker gains

| Asset | Where it lives | Who can read it today |
| --- | --- | --- |
| Session bearer token (7 days) | `manorama_session` cookie (HttpOnly, SameSite=Lax) or `session.json` in app-private storage | Browser cookie jar; any script in the app webview; **any page that lands in the macOS webview (F-01)** |
| Gallery keys / vault keys | iOS Keychain, macOS login Keychain (`in.thecontrarian.manorama.vault`), Android Keystore | The app binary; the renderer via the bridge (`vault_key_get`) |
| Vault ciphertext | `Library/NoCloud/manorama-vault-v1` (iOS), app-support (macOS) | App; Auto Backup on Android (F-08) |
| Escrowed key blobs (wrapped vault key, wrapped source links) | D1 `owner_key_vault`, `gallery_keys` | Server process and anyone who can read D1; unopenable without the passphrase |
| Provider share links, incl. MEGA/Ente/Proton fragments | D1 `galleries.source_url` (keyless for encrypted sources) + the URL fragment the server never sees | Server; fragment only in the client link |
| Gallery metadata, tags, captions | D1 `galleries.images_json` | Server; public for any published gallery |
| Account PII (name, email, country, colo, activity) | D1 `users` | Server; `listUsersForAdmin` for masters |
| Local folder grants | macOS security-scoped bookmarks (`folders.json`), `roots.json` provenance | App binary |

## 3. Trust boundaries actually present

1. **Browser ↔ Worker.** Session cookie (ambient) and `Authorization: Bearer` (explicit,
   used by the shells). CORS reflects only `capacitor://localhost`, `tauri://localhost`,
   `manorama://localhost`, `https://localhost` and `http://localhost:<port>`, and sets no
   `Access-Control-Allow-Credentials` — so cross-origin cookie auth is impossible and the
   reflection is low risk (`app/api.ts:225-272`).
2. **Provider ↔ Worker.** Share links are attacker-supplied; each adapter validates the
   host and path shape before fetching, and iCloud re-validates any CDN host the API
   returns (`APPLE_ASSET_HOST`, `assetLocationUrl`). Redirects are followed by the
   platform's `fetch`, but only to hosts the provider itself names.
3. **Renderer ↔ Native (macOS).** One `WKScriptMessageHandler` named `manorama`
   registered on the configuration, dispatching commands with no `frameInfo` and no
   origin check (`ViewerWebView.swift:126-138`, `:33-72`). This is boundary 1's
   counterpart and the weakest one.
4. **Renderer ↔ Native (iOS/Tauri).** Capacitor plugin surface, plus Tauri
   `invoke` with a narrow capability list (`src-tauri/capabilities/default.json`).
5. **Native ↔ filesystem.** Two root sets: picker-granted local-photo roots (bookmarks →
   `GrantedRoots`) and the app's private vault root. Both compare resolved path
   components, not string prefixes.
6. **Provider ↔ billing.** Stripe and RevenueCat webhooks, HMAC-verified with a
   5-minute tolerance and a stored ordering watermark.
7. **Public ↔ owner.** `requireSession` gates the management group; individual handlers
   further scope to `owner_id`.

## 4. Attacker models used

- **A. Anonymous web attacker** — can craft any URL, query and body; can obtain any
  public gallery link; can host arbitrary pages and providers.
- **B. Malicious authenticated owner** — full control of their own account, gallery
  metadata, manifest bodies and provider responses they can serve.
- **C. Compromised renderer** — script execution inside the app webview, no native code.
  This is the model F-01 must be judged against: the bridge is *the* privileged surface,
  and today it answers any caller in the webview.
- **D. Malicious local file tree** — symlinks, `..`, odd Unicode, `%` in names, huge
  files, hostile dimensions.
- **E. Replay/race** — captured callbacks, webhook re-delivery, concurrent creates,
  cancels, device restarts, tier changes mid-flow.

Excluded by the brief: a local process already running as the user (so a renderer that
can rewrite `roots.json` is not itself an escalation), production probing, DoS, and any
provider account.

## 5. Paths by which bytes or metadata can leave a device

- Web viewer → `img`/`video` `src` → `/api/{dropbox,drive,icloud}/*` → provider. Provider
  bytes are proxied, never stored (invariant 1 holds on this tree: no `put` of media to
  D1/R2/KV/cache API; the only in-ISOLATE caches are the thumbnail coalescer and the
  iCloud URL maps, both memory-only).
- macOS shell → `manorama://media/local/<abs path>` for originals (read-only), and
  `manorama://localhost/api/*` proxied to `https://manorama.xyz` with an overridden
  `Origin` (`LocalSchemeHandler.swift:317-338`).
- Native upload lane (explicit *Share*) → provider APIs; the Worker receives only the
  resulting link.
- OG compositor → `cf.image` / jimp fetch of the gallery's first `src`.
- Logs → Worker `console.*` to Cloudflare observability (F-11).

## 6. Where this map is thinner than the documentation implies

- `README.md` and `docs/native-launch-plan.md` describe the macOS shell as done. The
  navigation boundary is not implemented at all; "the renderer cannot forge an entry in
  `roots.json`" is true, but "the renderer" is currently trusted wholesale.
- `AGENTS.md` §5 routes vault crypto to the stronger model because "mistakes here are
  silent". The offline vault record format is indeed careful (AAD, magic, length,
  per-write random nonce). The *account key vault* — the escrow that makes keys portable
  — is the weaker half of the same feature (F-05).
