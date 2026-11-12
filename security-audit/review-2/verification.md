# Verification

Pinned `14e74a8bfc74264ccd07465d41341e0c69a0f3a5` (`origin/main`). Tree identity with the
working tree verified (`git diff a91b534 origin/main` → empty).

```
macOS 27.2.1 arm64 · bun 1.4.4 · Xcode CLT (swift 6.4, macosx27.2 SDK)
```

## Commands

```
$ git rev-parse origin/main
14e74a8bfc74264ccd07465d41341e0c69a0f3a5
$ git diff --stat a91b534 origin/main
(empty)
$ git status --porcelain
?? security-audit/review-2/
?? security-audit/poc/review-2-edges.test.ts
```

### Static

```
$ bunx tsc --noEmit
(no output)                                                             exit 0
```

### Boundary probe (F-01, F-02)

```
$ security-audit/poc/macos-bridge-origin/run.sh
STEP1 on bundled page — handler present: Optional("true")  title=bundled
STEP1a trusted document bridge reply: REPLY
STEP2a click aimed at ad screen=32,405
STEP2a after target=_blank click: url=manorama://localhost/index.html clicks=2 gesture=true opened=["http://localhost:55244/evil.html"]
STEP2b after window.open: url=manorama://localhost/index.html opened=["http://localhost:55244/evil.html", "http://localhost:55244/evil.html"]
STEP2c after location.assign: url=manorama://localhost/index.html opened=[… three …]
STEP2 summary: stayedBundled=true blankClicks=2 gesture=true blankOpens=1 windowOpenRouted=true assignRouted=true
STEP3 child frame report: FR-RESULT: null
STEP4 untrusted document url=about:blank title=PROGRESS: origin=null | handler=true | directFetch=BLOCKED | post=SENT
STEP4 remote page says: RESULT: title=PROGRESS: origin=null | handler=true | directFetch=BLOCKED | post=SENT | bridgeReply=null
VERDICT: BRIDGE-NOT-REACHABLE
```

`clicks=2` with `blankOpens=1` is the dedupe working: the probe delivers the click three ways
(NSEvent, `postToPid`, HID), the DOM saw two, and only one tab was requested.

### Audit suite — prior PoCs re-pointed, guards, review-2 edges

```
$ bun run test:unit -- security-audit
(pass) F-04 … a stranger cannot claim the slug a rename just freed
(pass) F-04 … deleting an account reserves its slug permanently
(pass) F-04 … the original owner may reclaim the slug it released
(pass) F-04 … a new account is never derived onto a released slug
(pass) F-04 … two accounts may hold the same gallery slug; only the owner segment separates them
(pass) guard: hidden items and the owner-only includeHidden escape …
(pass) guard: API CORS reflection stays local … (3)
(pass) guard: a session only reaches its own galleries … (2)
(pass) F-03 … a callback URL opened by a cookie-less victim dies before the provider call
(pass) F-03 … a verifier minted for a different flow fails just like a missing one
(pass) F-03 … an existing session in the victim's browser is never replaced
(pass) F-03 … the honest same-browser round-trip still signs in
(pass) F-03 … a forwarded confirm POST without the verifier creates no account
(pass) F-03 … the same browser posting its own confirm still creates the account
(pass) F-05 … two devices that both see "no vault" now converge on one vault
(pass) F-05 … a wrapped gallery key is bound to its gallery — a swap fails authentication
(pass) F-03 edges … a mismatched callback sweeps the verifier cookie, a matched one keeps it
(pass) F-03 edges … a first-time pause keeps the verifier so the confirm step can re-check it
(pass) F-03 edges … Apple uses SameSite=None over https and rejects loopback http
(pass) F-05 edges … the CAS token is mandatory — an old client that omits it is refused
(pass) F-05 edges … a replace must name the stamp it read
(pass) F-05 edges … gallery keys have their own create-only guard and a 409 carries the survivor

 25 pass
 0 fail
Ran 25 tests across 5 files.
```

### Whole unit suite

```
$ bun run test:unit
 1901 pass
 0 fail
 23386 expect() calls
Ran 1901 tests across 161 files. [25.95s]
```

1901 is the branch's own suite (1884 before this PR) plus the 23 audit tests present before
this pass plus 6 new. No existing test was broken by the fixes and none was skipped.

## Platform fact checked out of tree

`Directory.LibraryNoCloud` on Android was resolved through the plugin's native dependency
rather than trusted from the new test, which only compares the rule path to `VAULT_ROOT`:

```
$ unzip -p ionfilesystem-android-1.1.0.aar classes.jar > classes.jar && …
$ javap -c …/IONFILEFolderType.class | grep String
  INTERNAL_FILES alternateNames: DATA, LIBRARY, FILES, LIBRARY_NO_CLOUD
$ javap -c …/IONFILEUriHelper.class | grep getFilesDir
  getfield internalFilesDir  ← assigned from Context.getFilesDir()
```

So `domain="file" path="manorama-vault-v1"` lands on `filesDir/manorama-vault-v1`: the rule
is correct.

## Environment assumptions and limits

- The probe's STEP4 stand-in is `about:blank` (no remote document can commit after the fix).
  It proves an untrusted origin cannot reach the bridge; it does not isolate which half of the
  gate refuses.
- Still not run, unchanged from the first audit: the Playwright matrix, an iOS build/run, a
  Tauri build, `macos/BoundaryTests`, and a dependency CVE scan. F-06/F-07 are therefore still
  code-level.
- Live Safari `SameSite=None` behaviour for Apple's `form_post` is untested (F-03's
  residual in `findings.md`).
- `environment: production` only bites if the repo has protection rules on that environment;
  the settings are outside the tree.
- Fixtures remain `$TMPDIR`-only; no Keychain write, no production traffic.
