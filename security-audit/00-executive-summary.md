# Executive summary

**Target:** `b0e70ee72fa437ff9098ce929970aa365a87f782` (`origin/main` at delivery; review began at
`ffdcd86`, which the intervening commits do not diverge from in any audited file).
**Method:** source trace plus runnable PoCs; no production traffic.
**Verdict:** no exploitable vulnerability was demonstrated in the parts users trust with
the most: gallery authorisation, provider proxying and billing verification. Five real
weaknesses were demonstrated elsewhere — chiefly in the macOS shell's renderer boundary
and in two identity/namespace seams.

## Overall assessment

The web API is in better shape than most code of its age. The things that usually break
here hold up under attack:

- Object-level authorisation is enforced at the repository layer, not the UI: every
  gallery mutation scopes its SQL to `owner_id`, and a stranger's session gets 404 both
  for reads and for edits (`poc/guards.test.ts`).
- Provider URLs are canonicalised through an allowlist before any fetch; response
  `Content-Type` is pinned by magic-byte sniffing with an octet-stream fallback, so a
  shared `.html` cannot become same-origin script.
- Both billing webhooks verify an HMAC over `timestamp.body` in constant time, require
  the secret before buffering, and order events through a stored watermark so a replay
  cannot move a tier backwards.
- Session revocation is centralised in `resolveManoramaSession`, so a suspension kills
  every live token without each surface remembering to check.

The weaknesses that remain cluster where a *native* shell or an *identity seam* sits
outside that discipline, plus one namespace design decision with user-visible
consequences.

## Most consequential findings

| # | Finding | Class | Severity |
| --- | --- | --- | --- |
| F-01 | The macOS shell's webview has no navigation policy and its native bridge performs no origin or frame check. A page that ends up in that webview gets the bearer session token, every granted folder, the vault's keychain keys and the vault itself. Demonstrated. | Verified vulnerability | High |
| F-02 | The shell sets no `WKUIDelegate`, so the Library's `target="_blank"` and `window.open()` links do nothing at all. Demonstrated. | Verified vulnerability (functional) | Medium |
| F-03 | OAuth `state` is a bearer value with no browser binding: a callback URL captured by an attacker signs a victim into the attacker's account (login CSRF). Demonstrated. | Verified vulnerability | Medium |
| F-04 | An owner slug is released on rename or account deletion and nothing reserves it, so an old shared link starts serving a different account's gallery. Demonstrated. | Verified vulnerability | Medium |
| F-05 | The escrowed vault key is written last-write-wins with no compare-and-swap, and a wrapped gallery key carries no gallery identity (no AAD). Two devices can orphan every escrowed key; a swapped record unwraps to the wrong answer silently. Demonstrated. | Verified vulnerability | Medium |

F-01 is the one to fix before a wider distribution. It is not reachable today by a plain
link click — because of F-02 — but it is reachable the moment any in-webview navigation
exists, which on this build means any renderer script that calls `location.assign`, or
the next fix that makes external links work in place. The PoC shows the whole chain in
one run: the remote page keeps `window.webkit.messageHandlers.manorama`, and
`read_private_file('session.json')` returns the account's bearer token.

## Release-blocking

Only F-01 is a release blocker for the macOS build, and only if the macOS shell is
distributed as it stands. F-02 should land with it: as shipped, an ad CTA and the
share-flow provider link are dead, which is a store-review quality problem in its own
right.

F-03 and F-04 are not blockers but they are cheap to fix and both have already-shipped
blast radius (F-04 affects any link ever shared under an owner slug that later changes).

## What was not tested, and the uncertainty that matters

- **No live provider round-trip.** Dropbox, Google, Apple, iCloud, MEGA, Ente and Proton
  were exercised through their modules and mocks, never against the real services. Any
  behaviour that depends on a provider's live answer (redirect following, quota
  responses, CloudKit token expiry) is a hypothesis.
- **No iOS build run.** The iOS app was read, not launched; F-07 rests on code
  inspection.
- **No real D1 or production cache.** D1 behaviour was exercised through miniflare, which
  shares the SQL surface but not the edge runtime's cache or isolate lifecycle.
- **Ad plate rules were reviewed as code, not as rendered output.** Invariant 3 is
  enforced by the Playwright suite; that suite was not run (it needs a seeded dev
  server and the `.env.local` provider variables).
- **Tauri/Windows** was read only. Its capability file is properly narrow, but it is a
  second implementation of the same bridge and deserves its own pass if it ships.
- The `feat/web-homepage` sibling worktree was not audited.

## Is this build ready for broader distribution?

The web app: yes, on this evidence, with F-03/F-04 in the next train. The macOS shell:
not yet — ship F-01 and F-02 together, then re-run `poc/macos-bridge-origin/run.sh` and
assert the remote page can *only* reach the bridge after passing an origin check.
