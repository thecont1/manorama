# Findings

Audited commit: `b0e70ee72fa437ff9098ce929970aa365a87f782` (`origin/main` at delivery; the review began
at `ffdcd86`, and the three intervening commits touch no file audited here). Every finding
below is against the delivered snapshot and every PoC was re-run on it.

Order: Critical → High → Medium → Low → Informational. Classes are used exactly as the
brief defines them.

Summary table:

| ID | Title | Class | Severity | CWE |
| --- | --- | --- | --- | --- |
| F-01 | macOS bridge is not origin- or frame-scoped | Verified vulnerability | High | CWE-346, CWE-668 |
| F-02 | External links in the macOS Library are inert (no `WKUIDelegate`) | Verified vulnerability | Medium | CWE-1050 |
| F-03 | OAuth `state` is not bound to the browser (login CSRF) | Verified vulnerability | Medium | CWE-352 |
| F-04 | Released owner slugs are unclaimed and reusable | Verified vulnerability | Medium | CWE-706 |
| F-05 | Vault key escrow is last-write-wins and unbound | Verified vulnerability | Medium | CWE-362, CWE-345 |
| F-06 | Native file/HTTP reads are unbounded and buffered | High-confidence weakness | Low | CWE-400 |
| F-07 | iOS sign-in handoff has no PKCE and is not single-use | High-confidence weakness | Low | CWE-294 |
| F-08 | Privacy copy promises vault backup exclusion that Android does not implement | Product/privacy discrepancy | Low | CWE-1059 |
| F-09 | In-memory key-vault purge matches owner IDs by prefix | Verified (dev/test store only) | Informational | CWE-694 |
| F-10 | `main` auto-applies remote D1 migrations with a long-lived token | Hardening opportunity | Informational | CWE-1357 |
| F-11 | 100% log sampling with provider references, partial redaction | Hardening opportunity | Informational | CWE-532 |
| F-12 | Policy names a Google font host the CSP forbids | Product/privacy discrepancy | Informational | — |

---

## F-01 — The macOS native bridge answers any page in the webview

**Class:** Verified vulnerability · **Severity:** High · **CWE-346 / CWE-668**

**Surface:** macOS shell (`macos/ManoramaMac`), WKWebView ↔ native bridge.

**Paths:** `macos/ManoramaMac/ViewerWebView.swift:12` (conforms to `WKNavigationDelegate`
with no method bodies), `:33-72` (`userContentController(_:didReceive:)` — no
`message.frameInfo` check), `:126-138` (configuration: scheme handler + message handler,
no `uiDelegate`); `macos/ManoramaMac/NativeBridge.swift:214-240` (one `handle`/`reply`
pair for every command).

**Prerequisites:** any page other than `manorama://localhost/index.html` ends up in the
webview. Today that means renderer script (or the F-02 fix), not a plain click.

**Input → impact.** The bridge is registered on `WKUserContentController`, which is a
*webview-wide* facility: every document loaded in that view inherits
`window.webkit.messageHandlers.manorama`. Nothing checks who is asking. A remote page can
therefore run:

```
window.webkit.messageHandlers.manorama.postMessage({type:'invoke', id:1,
  cmd:'read_private_file', args:{name:'session.json'}})
```

and receive the account's **bearer session token** (7 days) through
`window.__manoramaShellSettle`. It can also `pick_gallery_root`,
`register_saved_gallery_roots`, then `plugin:fs|read_file` every granted photograph;
`vault_list`; `vault_read`/`vault_write`/`vault_remove` (corrupt or exfiltrate offline
copies); and `vault_key_get` for the vault's Keychain keys, which together with the
ciphertext is the whole offline library. `plugin:http|fetch` additionally turns the app
into a CORS-free fetcher for the MEGA/Proton host set.

`directFetch` from the foreign page is *blocked* — the shell proxy strips
`Access-Control-Allow-Origin` and the Worker only reflects shell origins — so the
message channel is the only path, which is exactly what makes the missing check
load-bearing rather than decorative.

**Reproduction.**

```sh
security-audit/poc/macos-bridge-origin/run.sh
```

The driver compiles the shipped Swift files, seeds a config dir whose `session.json`
contains `AUDIT-CANARY-SESSION-TOKEN`, loads the app's scheme, tries the bundle's own
link idioms, then `location.assign`es to a loopback page.

**Observed (verbatim):**

```
STEP1 on bundled page — handler present: Optional("true")  title=bundled
STEP2a after target=_blank click: manorama://localhost/index.html
STEP2b after window.open: manorama://localhost/index.html
STEP2 navigated to http://localhost:61736/evil.html
STEP3 remote page says: RESULT: origin=http://localhost:61736 | handler=true |
      directFetch=BLOCKED | bridgeReply={"value":"{\"token\":\"AUDIT-CANARY-SESSION-TOKEN\",\"ownerSlug\":\"audit\"}","ok":true,"id":7}
VERDICT: BRIDGE-LEAKED-SESSION-TOKEN
```

**Assets affected:** session token, granted local roots, vault ciphertext, vault keys.

**Fix.** Two layers, both cheap:

1. `ViewerCoordinator` implements `webView(_:decidePolicyFor:decisionHandler:)`: allow
   `manorama://localhost/*`; for anything else either cancel and hand the URL to
   `NativeBridge`'s opener, or allow it and treat it as untrusted.
2. In `didReceive`, gate on `message.frameInfo.isMainFrame` **and** on the committed
   document's origin (`webView.url?.scheme == "manorama" && host == "localhost"`), and
   ignore `invoke` from anywhere else. Cache the allowance on `didCommit`, not on every
   message.

If remote-in-place navigation is wanted, an explicit trust list of API origins is the
next step; `https://*` is too broad given the bridge's powers.

**Regression tests required.** (a) inspector/main-frame pass, cross-origin fail;
(b) a `manorama://` page in a child frame cannot invoke; (c) after navigation the
`read_private_file` round trip fails until the page is trusted again. This PoC is the
harness for all three — assert `VERDICT: BRIDGE-NOT-REACHABLE` for the untrusted variant.

**Confidence:** high — executed end to end against the shipped sources.
**Assumptions:** the real bundle behaves like the one-anchor page for navigation; the PoC
proves the handler is webview-scoped, which does not depend on bundle content.

---

## F-02 — External links in the macOS Library do nothing

**Class:** Verified vulnerability (functional) · **Severity:** Medium · **CWE-1050**

**Surface:** macOS shell link handling.

**Paths:** `desktop/islands/Catalogue.tsx:2347` and `:2360` (house-ad media and CTA
anchors: raw `<a target="_blank" rel="noopener">`, no `onClick` interception);
`desktop/islands/ShareFlow.tsx:270` and `:277` ("publicly linkable" provider link);
`desktop/islands/Catalogue.tsx:100-108` (`openExternal` only routes through the opener
plugin, so anything that bypasses it has no fallback).

**Prerequisites:** none — a user click.

**Input → impact.** With no `WKUIDelegate` (`ViewerWebView.swift:126-138`), WebKit has
nowhere to put a new window: `target="_blank"` and `window.open(..., '_blank')` are
dropped. The click does nothing and the page stays on `manorama://localhost/index.html`
(proof: `STEP2a`/`STEP2b` above). The account ad CTA and the share sheet's "publicly
linkable" link — both plain anchors without an intercepted click — are dead in the
shipped shell.

**Fix.** Same delegate as F-01, plus `WKUIDelegate.webView(_:createWebViewWith:...)` that
routes `_blank`/popup requests to the system browser (`NativeBridge` opener) rather than
opening an unchecked child webview. Alternatively intercept the clicks in the two
islands, but the delegate fix is what stops the next such anchor regressing.

**Regression test.** Extend the PoC: after the F-01 fix, `STEP2a` and `STEP2b` must show
the URL unchanged *and* a recorded opener call — the difference between "still dropped"
and "opened externally" is the whole finding.

**Confidence:** high — executed.
**Assumption:** house-ad CTAs point off-origin (they do: `cta.url` comes from the ad
payload).

---

## F-03 — OAuth `state` is not bound to the browser (login CSRF)

**Class:** Verified vulnerability · **Severity:** Medium · **CWE-352**

**Surface:** `/auth/{provider}` and `/auth/{provider}/callback`, `/auth/confirm-account`.

**Paths:** `app/lib/oauth-flow.ts:325-348` (`finishProviderAuth`: consumes `state`, and
re-checks a session **only** for `intent === 'link'`), `:182-222` (`completeSignIn` sets
the cookie unconditionally); `app/lib/auth-flows.ts:145-215` (state rows: provider,
nonce, verifier, `next` — no browser binding); `app/routes/auth/dropbox/callback.tsx`,
`google/callback.tsx`, `apple/callback.tsx` (pass `code`/`state` straight through).

**Prerequisites:** the attacker has an account; the victim opens one URL (or clicks one
button on the attacker's page for the first-sign-in variant).

**Input → impact.** The state row is single-use and server-side, which stops replay by the
*same* client — but it is a bearer value: no state cookie is set and the callback compares
nothing from the requester. An attacker starts a sign-in, completes the provider round
trip, and sends the resulting callback URL to the victim without spending it. The victim's
browser lands signed in as the attacker. Everything the victim does next — adding a
gallery, adopting a library, editing captions, saving to the vault — writes into the
attacker's account, which the attacker can read afterwards by signing in normally. The
flow's attacker-chosen `next` also controls the landing page (same-origin only, so not an
open redirect).

The `link` intent is already protected (`oauth-flow.ts:344-348` checks that the live
session matches `flow.accountId`). Only plain sign-in is affected, which is the common
path.

**Reproduction.**

```sh
bun run test:unit -- security-audit/poc/login-csrf.test.ts
```

The provider is the only simulated part (locally signed id_token + local JWKS). Three
cases: a cookie-less victim, a victim with an existing session, and the first-sign-in
confirm step.

**Observed:** `3 pass / 0 fail`, including
`a callback URL opened by a cookie-less victim installs the attacker's account` where the
asserted session subject is `acct_audit_attacker` and the redirect is `/audit-attacker`.

**Fix.** Mint a random state verifier, set it in a `SameSite=Lax`, `HttpOnly`, `Secure`,
path-scoped cookie when the flow opens, store its hash with the flow, and require a match
at the callback (delete the cookie on consumption). Keep the server-side row: the cookie
proves the browser, the row proves single use.

**Regression tests required.** The three PoC tests become the regression set; add a
mismatch case (correct state, wrong browser) that must land on `/?error=1`.

**Confidence:** high — executed against the real routes.
**Assumption:** no deployment-level mitigation exists (no WAF state-cookie rule was found
in `wrangler.toml`).

---

## F-04 — A released owner slug can be claimed by anyone

**Class:** Verified vulnerability · **Severity:** Medium · **CWE-706**

**Surface:** public gallery addressing, `PATCH /api/account`, account deletion.

**Paths:** `app/lib/user-repository.ts:520-550` (`updateOwnerSlug`: uniqueness is checked
only against the live `users` table; nothing is retained), `:561-584` (`deleteAccount`
removes the row and frees the slug); `app/routes/[owner]/[slug].tsx:24-34` (a public
gallery is resolved owner-first); `app/lib/gallery-repository.ts:197-211`.

**Prerequisites:** the victim has renamed their address or deleted their account; the
attacker registers the freed slug and creates the same gallery slug.

**Input → impact.** Public addresses are `/<owner_slug>/<gallery_slug>` and the owner
segment is the only account identity, so every previously shared link depends on it. Once
the slug is released, the next account to ask gets it — and gallery slugs are
per-account, so `field-notes` is free too. The old link then resolves to the attacker's
photographs with no signal that anything changed; the victim's gallery still exists, just
at a new address nobody has. The classic use is after a public rename (a photographer
moving from `@handle` to a real name) or after an account deletion the links outlive.

**Reproduction.**

```sh
bun run test:unit -- security-audit/poc/owner-slug-reuse.test.ts
```

**Observed:** `3 pass / 0 fail`. The first test walks the whole story: Alice publishes
`/alice/field-notes`, renames to `alice-photographs`, Bob claims `alice` and creates
`field-notes`, and `/alice/field-notes` now returns `"Bob, somewhere else"` while Alice's
gallery is intact at the new address. The second repeats it via account deletion.

**Fix.** Keep history: a `owner_slug_reservations (slug, released_at, account_id)` table,
checked by both `deriveOwnerSlug` and `updateOwnerSlug`. A first-come reclaim after N days
is a reasonable policy; the point is that "taken" must consider retired slugs, not only
live rows. Alternately (weaker) reserve the victim's old slug to their account id so only
they can reclaim it.

**Regression tests required.** The PoC file; add a reclaim-after-reservation-expiry case
once a policy exists.

**Confidence:** high — executed.
**Assumption:** `updateOwnerSlug`'s D1 branch behaves like the in-memory one (it does:
same check, same missing reservation).

---

## F-05 — Escrowed vault keys are clobbered by design, and unwrapped without identity

**Class:** Verified vulnerability · **Severity:** Medium · **CWE-362 / CWE-345**

**Surface:** `/api/account/key-vault`, `/api/galleries/:slug/key`, client key-vault module.

**Paths:** `app/lib/key-vault-repository.ts:60-74` (`putOwnerVault` is a bare
`INSERT … ON CONFLICT DO UPDATE`, no expected-value guard), `app/api.ts:514-531` (PUT
takes no version/`If-Match`), `app/lib/key-vault.ts:172-180` (`ensureVaultKey`:
fetch-then-write with a gap), `:91-103` (`wrapSourceForVault`/`unwrapSourceForVault` —
GCM with a random nonce and **no `additionalData`**).

**Prerequisites:** two devices with the same passphrase, reads racing (fresh account on
two devices, reinstall, or a second device signed in while the first is setting up). For
the binding half: any party able to write one gallery's key row (server, DB reader, or a
client bug).

**Input → impact.**

*Clobber.* Both devices read "no vault", both mint a vault key, both PUT. The second
write wins, and every gallery key wrapped under the losing vault key can never be
unwrapped again. Nothing warns the owner: the losing device still holds its key in memory,
so it keeps working until the next launch, when the surviving record opens to a different
vault key and each unwrap fails with a GCM error. Recovery is manual re-entry of every
source link — exactly the chore the vault exists to remove.

*No binding.* Because no AAD carries the gallery identity, a wrapped record moved to
another gallery (or copied during a bug) decrypts successfully to the **wrong source
URL**, with no error. Contrast the device vault, which seals `header + galleryId\0entryId`
(`native/lib/vault.ts:142-147`) and fails closed on a swap.

**Reproduction.**

```sh
bun run test:unit -- security-audit/poc/key-vault-clobber.test.ts
```

**Observed:** `2 pass / 0 fail`. Test 1 asserts the surviving record opens for device B,
that A's escrowed key throws, and that A's key still works locally (so nothing surfaces).
Test 2 asserts a swapped record unwraps to the other gallery's URL.

**Fix.** (a) Make the PUT conditional — send the client's `updatedAt` (or a
`vaultVersion`) and refuse with 409 when it no longer matches; on 409, re-read and, if the
record is still an unopenable vault, offer "adopt this device's key" rather than
overwriting. (b) Seal with `additionalData = utf8('manorama-key-vault-v1' + galleryId)`
for gallery keys and `+ 'owner-vault'` for the vault record; bump a record version so old
rows stay readable.

**Regression tests required.** Both PoC tests; add "concurrent PUT is rejected, then
retried with the fresh version" and "a record moved between galleries throws".

**Confidence:** high for both halves (executed); the race window length is a hypothesis
(seconds, not milliseconds, but not measured against real network latency).

---

## F-06 — Native file and HTTP reads are unbounded and fully buffered

**Class:** High-confidence weakness · **Severity:** Low · **CWE-400**

**Surface:** macOS bridge `plugin:fs|read_file`, `plugin:http|fetch*`; Tauri twins.

**Paths:** `macos/ManoramaMac/NativeBridge.swift:730-734` (`Data(contentsOf:)` then
`base64EncodedString()` — a 4/3 inflation across the JS bridge), `:429-467`
(`URLSession.data(for:)` buffers the whole response, then base64-chunks it),
`src-tauri/src/lib.rs:164-176` (same shape over raw IPC).

**Prerequisites:** a granted folder containing a very large file (a ProRes `.mov` in a
photo folder is normal), or a large provider object over `plugin:http`.

**Input → impact.** A 4 GB file becomes ~4 GB in memory, then ~5.4 GB as base64 in one JS
string. The web viewer path streams range requests instead, so this only bites the native
paths — but a mixed folder plus one click on a big clip is enough to swap or kill the
web process on a small machine. There is no cap and no progress.

**Fix.** Stream in chunks with an explicit ceiling (the vault already writes ciphertext in
pieces); for `plugin:http`, hand back a body reader instead of a materialised `Data`, or
cap at the largest real object and fail loudly above it.

**Regression test.** A 1 GB sparse file in a temp grant; assert peak RSS stays under a
bound and the base64 never materialises whole.

**Confidence:** high on the code shape; the memory numbers are arithmetic, not measured.

---

## F-07 — iOS handoff token has no PKCE and is not single-use

**Class:** High-confidence weakness · **Severity:** Low · **CWE-294**

**Surface:** `in.thecontrarian.manorama://auth/callback` and
`POST /api/auth/native/exchange`.

**Paths:** `app/lib/session.ts:82-93` (60 s `native-handoff` token, `sub` + `typ` only),
`app/lib/oauth-flow.ts:203-206` (handoff embedded in the custom-scheme redirect),
`app/api.ts:277-295` (exchange mints a 7-day session), `app/lib/desktop-auth.ts:23-43`
(the desktop twin, which *does* bind a PKCE challenge).

**Input → impact.** The deep link carries a bearer token that anyone holding it can redeem
for a 7-day session, repeatedly, for 60 seconds. The client de-dupes its own double-handling
via sessionStorage (`native/lib/session.ts:200`, `:277-299`) — per device, so it does not
stop a second party redeeming the same token. Custom schemes are claimable by any app on
the device, and the link is easy to leak (a copied message, a screen recording, another
app's history). The desktop path does not have this problem because redemption needs the
verifier.

**Fix.** Reuse `desktop-auth`'s shape for iOS: client generates a verifier, sends the
challenge with `?code_challenge=`, the callback embeds it, the exchange requires the
verifier. Add a `jti` row (or reuse `auth_flows`) so a second redemption is refused.

**Regression test.** Two exchanges with the same token: first 200, second 401. One
exchange with the wrong verifier: 401.

**Confidence:** medium-high — code-only, no device run.
**Assumption:** the iOS client is unchanged in this respect (grep of `native/lib` shows no
challenge on the handoff path).

---

## F-08 — "Excluded from cloud backup" is true on iOS, not on Android

**Class:** Product/privacy discrepancy · **Severity:** Low · **CWE-1059**

**Paths:** `docs/privacy-policy.md:37` ("its files are excluded from cloud backup"),
`native/lib/vault.ts:7` (`Directory.LibraryNoCloud`), `android/app/src/main/AndroidManifest.xml:4`
(`android:allowBackup="true"`, no `dataExtractionRules`, no `fullBackupContent`).

**Input → impact.** `LIBRARY_NO_CLOUD` means "no cloud backup" only on iOS. On Android the
plugin maps it to the app files directory, which Auto Backup includes by default. The vault
ciphertext is therefore eligible for Google's backup — no confidentiality loss (the keys
live in the Keystore and stay device-bound, so a restore produces undecryptable blobs), but
the stated guarantee is not the implemented behaviour, and a restored install silently
holds dead records.

**Fix.** Either add `android:dataExtractionRules` / `fullBackupContent` excluding the vault
directory, or scope the sentence in the policy to iOS.

**Regression test.** Not unit-testable; a manifest assertion (`allowBackup` rules mention
the vault path) is the cheap guard.

**Confidence:** high on the platform mapping (plugin README, `Directory.LibraryNoCloud`
"without cloud backup … used in iOS"); no device restore was performed.

---

## F-09 — In-memory key-vault purge matches owner IDs by prefix

**Class:** Verified (dev/test store only) · **Severity:** Informational · **CWE-694**

**Path:** `app/lib/key-vault-repository.ts:113-115` — in-memory branch of
`dropOwnerKeyVault` iterates `runtimeKeys` and deletes every key where
`key.startsWith(ownerId)`, while the key is built as `ownerId + galleryId` with no
separator (`:28`). Account IDs are `acct_<uuid>` and `dbid:<subject>`, so a `dbid:abc`
account shares a prefix with `dbid:abcd`.

**Impact.** In the non-D1 store only (vite dev, bun tests), deleting one account can drop a
neighbouring account's escrowed gallery keys. In production the D1 `WHERE owner_id = ?` is
exact, so this cannot happen there.

**Fix.** Separator in `runtimeKeyId` (`${ownerId}\u0000${galleryId}`) or delete by an
explicit filtered list. **Confidence:** high (read).

---

## F-10 — `main` auto-applies remote D1 migrations with a long-lived token

**Class:** Hardening opportunity · **Severity:** Informational · **CWE-1357**

**Path:** `.github/workflows/deploy.yml:1-30` — on every push to `main`: install, build,
`wrangler d1 migrations apply manorama --remote`, deploy, with `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID`. `verify.yml` is correctly `permissions: contents: read`; deploy
has no `permissions:` block and pins actions by major tag.

**Impact.** A merge (not a review, a merge) is enough to mutate the production schema, and
there is no environment approval step between build and migrate. Staging shares the
production database (`wrangler.toml`), so a staging-shaped change lands in prod by design.
Major-tag pinning of `actions/checkout` and `cloudflare/wrangler-action` leaves the usual
tag-repointing exposure.

**Fix.** Add a `production` environment with required reviewers on the deploy job; pin
third-party actions to commit SHAs; give deploy its own minimal `permissions:` block.

**Confidence:** high (read). Whether the repo has branch protection in front of `main` is
outside the tree and untested.

---

## F-11 — 100% log sampling with provider references

**Class:** Hardening opportunity · **Severity:** Informational · **CWE-532**

**Paths:** `wrangler.toml:20-23` (`[observability] enabled`, `head_sampling_rate = 1`),
`app/api.ts:115-127` (`proxyFailure` logs provider + `redactReference(reference)` + error),
`app/api.ts:1253` (`og card failure` logs the path).

**Impact.** `redactReference` masks `rlkey`, `k` and `resourcekey` — the capability-bearing
query values — and the iCloud album token is truncated to six characters. That is the right
set. What remains in logs is the rest of each share URL (host, path, other params) at 100%
sampling, plus slugs and account IDs in expiry counters. No session token, handoff token or
URL fragment is logged on any path reviewed.

**Fix.** Drop sampling to 0.1 once stable (the file's own comment says so), and consider
logging only the provider id rather than a path.

**Confidence:** high (read); no live log drain was inspected.

---

## F-12 — Policy names a Google font host the CSP forbids

**Class:** Product/privacy discrepancy · **Severity:** Informational

**Paths:** `docs/privacy-policy.md:59` ("may request fonts from Google"),
`app/lib/security-headers.ts:17-18` (`font-src 'self' data:`, "no remote font host").

**Impact.** Over-disclosure only; the implementation is the safer of the two. Drop the
sentence or add the host.

---

## Checked and sound (so they are not re-litigated)

- **Proxy content types.** Sniffed magic bytes win, upstream type only if allowlisted,
  else `application/octet-stream`; `nosniff` and `CSP: default-src 'none'; sandbox` on
  every media response (`app/api.ts:129-213`, pinned by `app/media-proxy-hardening.test.ts`).
- **Provider URL validation.** Dropbox host+path shape, Drive folder id, iCloud token
  alphabet, and a re-check of every CDN host the iCloud API returns
  (`dropbox-public.ts:24-29`, `gdrive-public.ts:36-45`, `icloud-shared.ts:286-303`,
  `:645-652`, `:864-868`).
- **Local media containment (dev).** `realpath` then component-prefix against scanned
  roots, extension allowlist, no SVG (`local-source.ts:274-292`).
- **macOS/Tauri filesystem grants.** Component-wise comparison on resolved symlinks, not
  string prefixes (`LocalSchemeHandler.swift:138-149`, `NativeBridge.swift:668-680`);
  vault paths reject `..`, `.`, empty segments and backslashes (`:742-765`).
- **Session revocation.** Centralised and fail-closed on `disabledAt` and
  `sessionsRevokedAt` (`session.ts:218-227`); the ambiguity window is documented and ≤1 s.
- **Webhook authentication.** Constant-time HMAC over `timestamp.body`, 5-minute
  tolerance, secret required before the body is read, `paid`/`no_payment_required` only,
  watermark ordering with an event-id tiebreak (`stripe-webhook.ts:39-136`,
  `revenuecat-webhook.ts:51-169`).
- **Offline vault record format.** Magic, version, algorithm, lengths, per-write random
  nonce, AAD over header + gallery/entry identity (`native/lib/vault.ts:150-183`).
- **Encrypted manifest validation.** Strict field allowlist, keyless-only `src`,
  provider/identity cross-checks, unique ids and refs (`encrypted-manifest.ts:75-97`).
- **Tauri capability file.** No shell, no fs write, read scopes granted only from the
  picker, `http` limited to MEGA/Proton hosts (`src-tauri/capabilities/default.json`).
