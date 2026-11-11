# Remediation sequence

Ordered by "what unlocks the most safety per unit of work". Fixes are scoped narrowly and
each names the test that must exist before the fix is considered done.

## 1. Now — before any wider macOS distribution

**1.1 F-01, the renderer boundary.** One delegate method, one guard.
`webView(_:decidePolicyFor:decisionHandler:)` allows `manorama://localhost/*` and hands
everything else to the opener (or cancels); `didReceive` requires
`message.frameInfo.isMainFrame` **and** a committed `manorama://localhost` document.
Cache the origin decision in `didCommit`/`didFinish`, not per message.
*Test:* the existing probe gains an "untrusted" variant asserting
`VERDICT: BRIDGE-NOT-REACHABLE`, plus a child-frame case.

**1.2 F-02, the dead links.** `WKUIDelegate.webView(_:createWebViewWith:...)` routing
`_blank` to the system browser. Ship with 1.1 — they touch the same file and the same
user story, and fixing 1.2 alone *increases* F-01's exposure by making remote pages
reachable in place.
*Test:* probe `STEP2a`/`STEP2b` must record an opener call and leave `webView.url`
unchanged.

**1.3 Do not merge 1.1 without 1.2 or vice versa.** Either order is fine; a gap between
them means links work and the bridge is open, or links are dead and the boundary is safe
for the wrong reason.

**1.4 F-03, login CSRF.** One state cookie (random verifier, `HttpOnly`, `Secure`,
`SameSite=Lax`, path `/auth`) + hash stored with the flow + match at the callback.
*Test:* the three PoC cases plus a wrong-browser case that must land on `/?error=1`.

## 2. Next train

**2.1 F-05a, vault key versioning.** Conditional PUT (`If-Match` on `updatedAt`, or a
monotonic `vaultVersion`), 409 on mismatch, and a client path that adopts the local key
rather than overwriting a vault it cannot open.
*Test:* concurrent-PUT rejection, then retry with the fresh version.

**2.2 F-05b, binding.** `additionalData` over a record-type tag + gallery id (and
`owner-vault` for the vault record), with a version bump so existing rows still open.
Depends on 2.1 shipping first: binding alone does not stop the orphan.
*Test:* a swapped record must throw.

**2.3 F-04, slug reservations.** A `owner_slug_reservations` table consulted by both the
mint and the rename path. Decide the reclaim policy explicitly (first-come after N days is
the least surprising); write the policy into `docs/manorama-operations.md` in the same PR,
since invariant 10 says invented procedures do not exist.
*Test:* rename → claim by another → old link resolves to the new owner, and reclaim
blocked during the reservation window.

**2.4 F-06, read caps.** Chunked `read_file` with a ceiling and a clear over-cap error;
`plugin:http` returns a reader or caps at the largest real object.

## 3. Longer term

- **F-07:** port `desktop-auth`'s PKCE shape to the iOS handoff and add a `jti`. The
  desktop path is the reference; do not invent a third pattern.
- **F-08:** `dataExtractionRules` excluding the vault, or narrow the policy sentence.
- **F-10:** `production` environment with required reviewers; SHA-pinned actions; a
  `permissions:` block on deploy.
- **F-11:** drop sampling to 0.1; log provider ids rather than paths.
- **F-12 / F-09:** one-line each, whenever the file is next touched.

## Dependencies and ordering constraints

```
1.1 ─┬─> 1.2 (same file; ship together)
     └─> any future in-webview navigation feature
2.1 ───> 2.2 (binding without CAS still orphans)
2.3 independent, but the policy text must land with the code
```

## What not to do

- Do not "fix" F-01 by allowing every `https://` origin in `decidePolicyFor` *without*
  the origin check — that turns every https page the user reaches into a bridge holder.
- Do not fix F-05 with a server-side merge/repair routine. The server cannot tell which
  wrapped vault key is right; only a client that can open one can decide.
- Do not weaken the `private` cache policy on media to make the OG card cheaper; the OG
  card is already the only `public` response and it is a composite, not provider bytes.
