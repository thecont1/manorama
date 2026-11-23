# Executive summary

**Target:** `c7d8002c7ee1c6f446e619e85bd09dee543611c6` (`main`), audited from a
detached worktree of that SHA.
**Method:** source trace plus runnable probes; no production traffic, no live
provider, no real account.
**Verdict:** no exploitable vulnerability was demonstrated within the tested
scope. One shipped behaviour was broken; all four findings are now fixed and
re-verified on `feat/local-gallery-report-fixes`.

## Overall assessment

The boundaries that carry the most risk held under hostile input, and the
mechanisms are the ones the code claims rather than accidental ones:

- **Object-level authorisation** is enforced in SQL scoped by `owner_id`, not in
  the UI. Eight mutation routes addressed with a stranger's valid session
  changed nothing on the owner's row (`probe-web.test.ts`, 14 tests).
- **The public manifest** omits hidden items for everyone but the owner
  (`?includeHidden=1` is answered only to the owning session) and never carries
  the provider share URL — the gallery's only capability — except in its keyless
  form for encrypted sources.
- **Server-side fetching** is host-canonicalised before any request: a lookalike
  Dropbox host, a userinfo trick, a Drive lookalike and every non-lh3 rendition
  URL are refused before `fetch` is called (`probe-sources.test.ts`, 10 tests).
- **Escaping** holds at the two places it is easiest to lose: the document head
  (title/OG metadata) and the curtain's `dangerouslySetInnerHTML`. A title of
  `</script><img src=x onerror=…>` survives as text with no early element close
  (`probe-ssr.test.ts`).
- **The macOS renderer boundary** is the shipped Swift, compiled and executed:
  the media resolver refuses traversal, symlink escape, prefix siblings and
  revoked grants; the bridge answers only the main frame of a committed bundle
  document; the opener and native-HTTP allowlists reject lookalike hosts
  (`run-boundary.sh`, `ALL PASS`).
- **Billing** verifies an HMAC over `timestamp.body` for both providers, with a
  freshness window and an ordering watermark in the same batch as the tier
  write; both fail closed without their secret.
- **Vault crypto** binds each record's gallery identity as AES-GCM additional
  data over a header that carries the length, so a swapped or truncated record
  fails the tag rather than decrypting to a plausible wrong answer.

The weaknesses clustered at the edges of those disciplines: one copy path that
forgot a field the render gate depends on, one class of response that declared
no cache policy, and privacy text that had drifted behind the code. All three
are closed.

## Findings

| # | Finding | Class | Severity | Status |
| --- | --- | --- | --- | --- |
| R3-01 | Adopting an encrypted gallery stored the copy as manifest version 1, so the render gate picked the legacy viewer: every frame carried an empty `src` and a visitor saw placeholders forever. | Verified defect (functional) | Medium | **Fixed at `e5385cab`, verified** |
| R3-02 | Owner-private JSON (`/api/galleries`, `/api/library`, `/api/account`, `/api/galleries/:slug`) carried no `Cache-Control` and only `Vary: Origin`, so a browser cache was free to reuse one account's library for the next. | Hardening opportunity | Low | **Fixed at `626dd2fb`, verified** |
| R3-03 | The privacy policy said the desktop app has no encrypted vault and that video galleries are not cached offline; both were untrue. | Product/privacy-policy discrepancy | Informational | **Fixed at `1aefd3da`** |
| R3-04 | `/api/auth/native/exchange` (unauthenticated) and `/api/galleries/scan` buffered an unbounded request body while sibling routes bound theirs. | Hardening opportunity | Low | **Fixed at `626dd2fb`, verified** |

R3-01 needed no attacker: a member tapped "Add to Library" on a shared encrypted
gallery and got a gallery nobody could view without pasting the original link
again — and visitors could never view it at all. `e5385cab` copies
`manifestVersion` through the adopt create and makes `encryptedGalleryGate`
consult the row's items as well, so a row that lost its version still renders
through the client path. No backfill is required: the item check covers rows
adopted before the fix.

## Release-blocking

Nothing in this pass is a release blocker for the web app. All four findings
are closed; R3-01 was worth fixing before the next native build because it was
a silent dead end in an advertised flow, not because it was dangerous.

## What was not tested, and the uncertainty that matters

- **No live provider round-trip.** Dropbox, Google Drive, iCloud, Google Photos,
  MEGA, Ente and Proton were exercised through their modules with injected
  fetches. Anything that depends on a provider's live answer — redirects, quota
  responses, CloudKit token expiry, Proton's password verifier — remains a
  hypothesis.
- **No browser.** The island serialisation (`data-serialized-props`) is compiled
  into the built bundle and escaped by hono/jsx attribute escaping, but under
  `bun test` the islands render as plain components, so the exact runtime markup
  was not exercised. The document head and curtain — the two DOM-injection
  surfaces that are server-rendered — were.
- **No iOS or Android build run.** The Capacitor code was read, not launched;
  Keychain/Keystore behaviour and the WebView's own storage are unverified.
- **No Tauri binary run.** The Rust command surface and `capabilities/default.json`
  were read. The Tauri-specific claim that an empty scope still confines the fs
  plugin rests on the plugin's own semantics, not on an execution here.
- **No real D1 for most probes.** The object-authorisation matrix ran on the
  in-memory repositories; the SQL that ships was read and is covered by the
  repository's own D1 tests, which pass, but this pass did not re-derive them.
- **No cryptography review beyond structure.** Nonce generation, AAD binding and
  record parsing were traced; no timing analysis, no fuzzing of the pack/unpack
  path, no Keychain accessibility probing.

## Is this build ready for broader distribution?

On this evidence, the web app is. The native shells are in the same shape the
second pass left them: the macOS renderer boundary is genuinely closed and
tested, and the vault's structure is sound, but the shells were not launched
here. All four findings are closed as of `d5ee928e`.
