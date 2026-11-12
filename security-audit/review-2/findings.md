# Findings — second review

Pinned: `14e74a8bfc74264ccd07465d41341e0c69a0f3a5` (`origin/main`; local tree `a91b534` has an
identical tree).

Part 1 answers "did the fix work" for every prior finding. Part 2 lists what this pass found
in the new code.

Severity here is re-assigned against the *fixed* state; nothing inherits a severity because
its predecessor had one.

---

# Part 1 — status of the first audit

| # | First-audit severity | Verdict | Basis |
| --- | --- | --- | --- |
| F-01 | High | **Closed** | Code + probe executed; `BRIDGE-NOT-REACHABLE` |
| F-02 | Medium | **Closed, one scheme gap** (R-04) | Code + probe: gestured click routed exactly once |
| F-03 | Medium | **Closed** | 6 tests, attack and honest path both asserted |
| F-04 | Medium | **Closed** | Reservations + CAS; 5 tests incl. reclaim and derive-past |
| F-05 | Medium | **Closed for new records**; pre-AAD residual (R-03) | CAS at repository, route and client; AAD test |
| F-06 | Low | **Open** (planned "longer term") | Unchanged `readFile`/`data(for:)` |
| F-07 | Low | **Open** (planned "longer term") | `native/exchange` still token-only |
| F-08 | Low | **Closed** | Rules added; platform mapping verified independently |
| F-09 | Info | **Closed** | NUL-separated runtime key |
| F-10 | Info | **Improved, limit documented** | Env, SHA pins, `permissions: read`; no reviewers |
| F-11 | Info | **Closed** | `head_sampling_rate = 0.1` |
| F-12 | Info | **Closed** | Google-fonts sentence removed |

## F-01 — bridge is scoped to the bundle origin: CLOSED

`ViewerWebView.swift:12,65-68,151-204`: `decidePolicyFor` allows only
`manorama://localhost` (plus `about:blank`), everything else is cancelled and handed to the
system browser; `didReceive` requires main frame **and** a committed bundle document **and**
`frameInfo.securityOrigin` scheme+host; `trustedDocument` is cached at `didCommit`/`didFinish`
from the committed URL, not re-derived per message; `createWebViewWith` never spawns a
second bridge-bearing view.

Probe (`security-audit/poc/macos-bridge-origin/run.sh`), verbatim:

```
STEP1a trusted document bridge reply: REPLY
STEP2a after target=_blank click: url=manorama://localhost/index.html clicks=2 gesture=true opened=["http://localhost:55244/evil.html"]
STEP2 summary: stayedBundled=true blankClicks=2 gesture=true blankOpens=1 windowOpenRouted=true assignRouted=true
STEP3 child frame report: FR-RESULT: null
STEP4 remote page says: RESULT: title=PROGRESS: origin=null | handler=true | directFetch=BLOCKED | post=SENT | bridgeReply=null
VERDICT: BRIDGE-NOT-REACHABLE
```

The verdict is only reachable when the trusted reply arrived, the frame script posted and the
untrusted document posted — so silence cannot fake a pass. `bridgeReply=null` with
`handler=true` is the exact shape of the fix: the object is still visible, the answer is not.

Residuals, none of them holes today:
- STEP4's "untrusted document" is `about:blank` (`loadHTMLString`, `baseURL: nil`), because
  after this fix a remote URL can no longer commit at all. The gate's two halves
  (`trustedDocument`, origin) therefore only ever fail *together* in the probe; removing
  either alone would still pass. Worth a same-origin-but-uncommitted case if one is ever
  buildable.
- `decidePolicyFor` runs for subframes too, so a remote iframe that navigates is cancelled
  **and** opened in the browser while staying blank (see R-04).
- Any future "show remote content in place" feature needs a deliberate policy; `https://*`
  inside the view would reopen F-01 wholesale.

## F-02 — external links work: CLOSED, except non-http(s) schemes

`ViewerWebView.swift:162-174,194-204` route cancelled navigations and new-window requests to
`openExternal`, with a 2-second URL dedupe so one click cannot open two tabs. The probe's
gestured click produced exactly one open with the URL unchanged, and `window.open` /
`location.assign` each routed independently (separate counters, so one cannot cover for
another).

Gap: the default `openExternal` (`:27-30`) forwards only `http`/`https`. `mailto:` anchors
that are not intercepted stay dead — `desktop/islands/Catalogue.tsx:2321` ("Upgrade to
Visionary?" when no Stripe link is configured), and every `upgradeHref` fallback at
`app/islands/Admin.tsx:802,838,1073`. See R-04.

## F-03 — state bound to the browser: CLOSED

`oauth-flow.ts:44-83,162-205,403-418` plant a random verifier in an `HttpOnly` cookie named
for the state, store only its SHA-256 on the row, and demand it back before the provider
call. The cookie is compared in constant time, swept on mismatch, and *kept* on success
because the first-time interstitial still owes the same binding — the pending token carries
`state` + hash (`session.ts:113-140`) and `confirmPendingAccount` re-checks
(`oauth-flow.ts:360-371`). Apple gets `SameSite=None` (its `form_post` is cross-site); the
GET providers get `Lax`.

`poc/login-csrf.test.ts`, 6/6: cookie-less callback dies before any provider call
(`providerCalls === 0`), a foreign verifier fails identically, an existing victim session is
not replaced, the honest round trip still signs in, a forwarded confirm mints nothing, the
same browser's confirm still does.

Residuals: R-02 (cookie not swept on success), and one untested browser behaviour — Apple's
`SameSite=None` cookie is third-party storage, so Safari ITP is the place this fix could fail
*open* in a real browser. If it did, the flow fails closed to `/?error=1` rather than to the
old behaviour, so the blast radius is a broken sign-in, not a login CSRF.

## F-04 — released slugs stay reserved: CLOSED

`migrations/0019` + `user-repository.ts:126-160,176-220,564-590,597-625`: a rename and a
deletion both write a reservation in the same batch; the signup INSERT gates on
`NOT EXISTS (reservation)`; the rename UPDATE is a compare-and-swap that also demands the
target be unclaimed and unreserved; only the releasing account may reclaim. Same-account
reclaim, delete, derive-past and the stranger refusal are all tested
(`poc/owner-slug-reuse.test.ts`, 5/5), and the real D1 CAS is covered in
`app/lib/user-repository.test.ts` / `app/account-deletion-api.test.ts`.

The pre-0019 window is honestly documented in both the migration and
`docs/manorama-operations.md:45` — releases before the table existed are not covered, and the
users table is correctly stated as unusable for backfill.

## F-05 — escrow cannot be clobbered, keys are bound: CLOSED for new records

`key-vault-repository.ts:63-99,112-146` are now create-only (`ON CONFLICT DO NOTHING`) or
replace-if-same-stamp, returning `null` on a guard miss; the routes turn that into 409 with
the surviving record (`api.ts:518-547,562-583`); `ensureVaultKey` adopts the survivor and
opens it (`key-vault.ts:207-224`). Gallery keys carry the gallery id as AAD
(`key-vault.ts:91-125`), so a swapped record fails the tag.

Verified at three levels: repository CAS + prefix purge (`key-vault-repository.test.ts`),
route CAS/409 (`poc/review-2-edges.test.ts`, 3 tests), client adoption and AAD
(`poc/key-vault-clobber.test.ts`, 2 tests — the survivor is compared against a pre-race
snapshot, not against itself).

Residual: R-03 (pre-AAD records) and the millisecond grain of `updatedAt` (two writes inside
the same millisecond both match).

## F-08 — Android backup exclusion: CLOSED, and the mapping checked

Not content to trust the new test (which only compares the rule path to `VAULT_ROOT`), the
platform mapping was resolved independently: `@capacitor/filesystem` `Directory.LibraryNoCloud`
maps to `INTERNAL_FILES` on Android, whose alternate names include `LIBRARY_NO_CLOUD`
(`IONFILEFolderType` in `ionfilesystem-android-1.1.0.aar`), and `INTERNAL_FILES` resolves to
`Context.getFilesDir()`. The `domain="file"` rules therefore point at `filesDir/manorama-vault-v1`
— the vault's real location.

## F-10 — deploy hardening: improved, with a stated limit

`deploy.yml` now carries `environment: production`, `permissions: contents: read` and
SHA-pinned actions (checkout, setup-bun, wrangler-action). The second commit removes the
overclaim: the environment scopes refs but the repo plan has **no required reviewers**, so a
push to `main` still migrates and deploys unattended. That is accurate; the reviewer gate
remains an external settings task.

---

# Part 2 — new findings

## R-01 — The key-vault API change is not backward compatible, and the stale-client error is misleading

**Class:** Verified vulnerability (deployment compatibility) · **Severity:** Low · **CWE-1059**

**Paths:** `app/api.ts:521-524,565-568` (`expectedUpdatedAt` is mandatory: `undefined !== null`
and `typeof !== 'string'` → 400), `app/lib/key-vault.ts` (`putVaultRecord`/`putGalleryKey`
send it), client surfaces `app/islands/EncryptedGallery.tsx:112,132,142`.

**Prerequisite:** an installed iOS/macOS build from before the merge, i.e. one whose bundle
predates the field.

**Impact.** Every escrow write from such a build is refused with `400 That key vault payload
is not valid`. Behind `syncHeldKey` the failure is swallowed (best effort) and escrow silently
stops; behind `submitKeySync` it surfaces as **"That passphrase did not unlock the vault."** —
which is wrong: the passphrase was fine and the vault was already open. A user on the previous
build is told to re-check a correct secret, and no amount of retrying helps.

Verified: `poc/review-2-edges.test.ts` → *"the CAS token is mandatory — an old client that
omits it is refused"* (400 without the field, 200 with `null`).

**Fix.** One of: (a) treat a missing field as `null` for owners with no stored vault and as
"read-then-write" for owners with one — a bootstrap window, then tighten; or (b) add the field
to a versioned path (`?cas=1`) and keep the old semantics on the bare path; or (c) accept the
break but map 400 to a distinct client message ("Update Manorama to sync keys"). Whichever,
the error text should not blame the passphrase.

**Regression test.** Extend the R-01 test: an old-shape PUT must either succeed or return a
code the client can explain.

**Confidence:** high (executed). **Assumption:** old bundles really are in the field; the
desktop shell ships with the app, so this is primarily iOS and macOS.

## R-02 — The verifier cookie survives a successful sign-in

**Class:** Hardening opportunity · **Severity:** Informational

`stateCookieMatches(c, …, keepVerified = true)` is called from the callback for **every**
flow (`oauth-flow.ts:417`), so on a direct sign-in (`completeSignIn`) the cookie is never
deleted — it lives out its 15-minute `maxAge`. Only the mismatch path sweeps it, and only the
confirm path legitimately needs it kept.

Impact is hygiene, not access: the row is consumed, the name is unique per state and the value
grants nothing alone. But "kept only for the pause" is the comment's claim and only the pause
needs it.

**Fix.** Delete the cookie in `completeSignIn` (after a session is minted) and in the link-return
paths; alternatively pass `keepVerified` only when `pendingAccountPage` is about to render,
which means deciding after the identity lookup rather than before the provider call.

**Test.** `poc/review-2-edges.test.ts` already asserts the keep-on-pause behaviour; add the
inverse for a sign-in that completes directly.

## R-03 — Pre-AAD escrow records still swap silently on the cached-key path

**Class:** High-confidence weakness · **Severity:** Low · **CWE-345**

`unwrapSourceForVault` tries the AAD first and falls back to unauthenticated decrypt
(`key-vault.ts:105-125`) — correct, because a pre-AAD record fails both. But there is no
record-version marker, so the client cannot tell "old record" from "swapped record", and the
only backstop is an album comparison that runs on the passphrase path
(`EncryptedGallery.tsx:156-158`) and **not** on the cached-vault-key path
(`:199-200`, `.catch(() => null)` then straight into use).

Impact: for a gallery escrowed before this deploy, a record served onto the wrong gallery
unwraps to a plausible wrong source and the frame set then fails to decrypt — the exact
symptom F-05 removed for new records. Bounded by the cohort of pre-merge escrows, and it
repairs itself when the owner re-syncs that gallery.

**Fix.** Cheapest: run the `keylessSourceUrl` comparison on the cached-key path too (it is two
lines and already imported), storing only on a match. Proper: add a record version/flag so an
AAD-required record can never fall back.

**Test.** Seed a no-AAD record for gallery A, place it on gallery B, and assert the cached
path rejects it.

## R-04 — `mailto:` links are still dead, and remote subframe navigations spawn tabs

**Class:** Verified vulnerability (functional) · **Severity:** Low · **CWE-1050**

`ViewerWebView.swift:27-30` forwards only `http`/`https`; `:151-174` cancels everything else
before reaching it. So the "Upgrade to Visionary?" anchor when no Stripe link is configured
(`Catalogue.tsx:2321`, `Admin.tsx:802` → `:838`/`:1073`, `GalleryDetailsView`/`WebSettings`
`ActionRow`) now cancels and opens nothing — the exact pre-fix experience for those anchors,
while the fix reads as "external links work". `NativeBridge`'s opener already allows `mailto:`,
so the capability exists one layer down.

Second half: `decidePolicyFor` also runs for subframe navigations, so a remote iframe is
cancelled *and* handed to `openExternal` — one browser tab per such navigation, with the frame
left blank. Inert today (the bundle has no iframes) and it becomes visible the moment one is
added, e.g. a provider embed.

**Fix.** Route `mailto:` (and `sms:` if wanted) through `openExternal` — either widen the
default closure to a scheme allowlist matching `NativeCapabilities.isAllowedOpenerURL`, or
reuse that function. For frames, decide by `navigationAction.targetFrame?.isMainFrame`: allow
a remote subframe to load in place (the message gate already drops its posts) or cancel
without opening a tab.

**Test.** Extend the probe bundle with a `mailto:` anchor and an iframe; assert the first
routes to the recorder and the second produces at most one open with the frame blank.

## R-05 — The in-repo report is pre-fix

**Class:** Documentation · **Severity:** Informational

`security-audit/00…05` are unchanged since the audit: the executive summary still calls F-01
release-blocking, the findings file has no status column, and the coverage matrix still
describes the unfixed boundary. Anyone reading the repo's own audit trail after this merge is
told eleven things are wrong that are now fixed. Part 1 above is the correction; adding a
status column or a pointer from `security-audit/README.md` would stop the next reader
re-litigating.

---

## Not re-litigated

The boundary probe was strengthened honestly (per-idiom counters, a completion requirement
before `NOT-REACHABLE`, a pre-race snapshot in the clobber PoC, an explicit
`INCONCLUSIVE` verdict). The Apple-on-http behaviour is a pre-existing dev limitation, not a
regression: `appleAuthorizeUrl` rejects a loopback `http` redirect before the cookie question
arises, so the `Lax` fallback branch is currently unreachable for Apple — the comment implies
it would help, and it would not until the redirect URI is accepted.
