# Verification appendix

Commit: `b0e70ee72fa437ff9098ce929970aa365a87f782` (see README for the pinning history —
the review began at `ffdcd86` and the three intervening commits touch no audited file).

## Environment

```
macOS            27.2.1 (arm64)
Xcode CLT        /Applications/Xcode.app/Contents/Developer, swift 6.4, SDK target macosx27.2.0
bun              1.4.4
worktree         /Users/home/DEV/tools/manorama (primary tree, branch main)
```

`~/.wrangler` was writable; the two miniflare-backed suites and the login-CSRF PoC bind a
loopback port, as `VERIFICATION.md` requires.

## Provenance

```
$ git rev-parse origin/main
b0e70ee72fa437ff9098ce929970aa365a87f782
$ git log -1 --format='%H %ci %s' origin/main
b0e70ee… 2026-11-12 00:48:33 +0530 docs(agents): the unit mirror sweeps in untracked files
$ git status --porcelain
 M tsconfig.json
?? security-audit/
(plus, before cleanup, the scratch dir used while building the probe)
$ git diff --name-only ffdcd86..b0e70ee
AGENTS.md
app/components/home/Figure.tsx
app/components/home/home-manifest.ts
native/islands/GalleryList.nav.test.tsx
```

None of those four is in scope for any finding.

## Commands and results

### Static

```
$ bunx tsc --noEmit
(no output)                                                            exit 0   TSC-CLEAN
```

### Audit PoCs (all findings fixes' regression basis)

```
$ bun run test:unit -- security-audit
security-audit/poc/owner-slug-reuse.test.ts:
(pass) F-04 … a shared gallery link silently starts serving a different account after a rename
(pass) F-04 … deleting an account frees its slug immediately, with all galleries gone
(pass) F-04 … two accounts may hold the same gallery slug; only the owner segment separates them
security-audit/poc/guards.test.ts:
(pass) guard: hidden items and the owner-only includeHidden escape …
(pass) guard: API CORS reflection stays local > the native-shell origins and loopback …
(pass) guard: API CORS reflection stays local > an unrelated https origin gets no allow-origin
(pass) guard: API CORS reflection stays local > a lookalike hostname is not accepted
(pass) guard: a session only reaches its own galleries > another owner's slug 404s
(pass) guard: a session only reaches its own galleries > another owner cannot edit/delete/pin
security-audit/poc/login-csrf.test.ts:
(pass) F-03 … a callback URL opened by a cookie-less victim installs the attacker's account
(pass) F-03 … an existing session in the victim's browser is replaced, not preserved
(pass) F-03 … the first-sign-in confirm step also needs no cookie from the requester
security-audit/poc/key-vault-clobber.test.ts:
(pass) F-05 … two devices that both see "no vault" overwrite each other and orphan every wrapped key
(pass) F-05 … a wrapped gallery key is not bound to its gallery — a swap unwraps to the wrong source

 14 pass
 0 fail
 54 expect() calls
Ran 14 tests across 4 files. [1.67s]
```

### Whole unit suite (collateral check — nothing existing was broken)

```
$ bun run test:unit
 1884 pass
 0 fail
 23270 expect() calls
Ran 1884 tests across 161 files. [26.91s]
```

1884 includes the 14 audit tests; the same suite without them is 1884 − 14 = 1870, i.e. the
count moved by exactly the new files.

### macOS bridge probe (F-01, F-02)

```
$ security-audit/poc/macos-bridge-origin/run.sh
built: /var/folders/…/manorama-bridge-probe.lXu1EB/probe
STEP1 on bundled page — handler present: Optional("true")  title=bundled
STEP2a after target=_blank click: manorama://localhost/index.html
STEP2b after window.open: manorama://localhost/index.html
STEP2 navigated to http://localhost:62605/evil.html
STEP3 remote page says: RESULT: origin=http://localhost:62605 | handler=true |
      directFetch=BLOCKED | bridgeReply={"id":7,"ok":true,"value":"{\"token\":\"AUDIT-CANARY-SESSION-TOKEN\",\"ownerSlug\":\"audit\"}"}
VERDICT: BRIDGE-LEAKED-SESSION-TOKEN
```

Run three times over the session (compiled twice from `.audit-tmp`, once from the shipped
location); verdict identical each time.

### Not run, and why

| Check | Why |
| --- | --- |
| `bunx playwright test` (acceptance matrix) | Needs a seeded dev server: `.env.local` carries the `MANORAMA_DEV_SOURCE_*` credentials and the suite wants `GALLERY_URL`/`GALLERY_VIDEO_SLUG`. Not run, so viewer/ad plate *rendering* is unverified here even though the ad policy code was read. |
| `xcodebuild` for iOS | No simulator/physical device was used; the iOS findings are source-level. iOS signing also needs the owner's team setup. |
| `scripts/build-macos.sh` (full `.app`) | Would `codesign` with the owner's Developer ID identity and rebuild the desktop bundle into the working tree. The probe links the identical Swift sources instead, at the cost of not exercising the real bundle, entitlements or signature. |
| `macos/BoundaryTests` | Read, not compiled. Its cases overlap the containment reasoning recorded in the coverage matrix. |
| `cargo build` / `tauri build` | Rust toolchain and a long first build; Tauri was read only (capability file, `lib.rs`, `private_store.rs`). |
| Dependency CVE scan (`bun audit`, osv) | Time-boxed out. The lockfile, workflow permissions and install scripts were read instead; no vulnerability claim in this report rests on a dependency. |

## Reproducibility caveats

- **F-05's race window** is modelled by a stale read in the fetch stub, not by real latency.
  The code shape (fetch → create → PUT with no version) is what makes it real; the duration
  of the window is unmeasured.
- **F-03** simulates the provider (locally signed id_token, local JWKS, injected fetch).
  Everything else is the shipped route code and a real D1 schema.
- **F-01/F-02** use a one-anchor HTML page rather than the built desktop bundle, and a
  loopback responder instead of a real remote site. The property under test — that the
  message handler is webview-scoped and unchecked — does not depend on bundle content, but
  the exact link inventory does, and was taken from source (`Catalogue.tsx`,
  `ShareFlow.tsx`) rather than from a render.
- The probe requires arm64 macOS 13+ and Xcode CLT; it does no network I/O beyond
  127.0.0.1 and writes only under `$TMPDIR`.

## Fixture hygiene

- Every PoC uses in-memory repositories or miniflare with `persist: false`.
- The probe's config dir, bundle dir and remote-root dir are `mktemp` paths under `$TMPDIR`;
  the real `~/Library/Application Support/in.thecontrarian.manorama.desktop` and the login
  Keychain were not touched (no `vault_key_*` command is issued, and no `keychainSet` runs).
- No production host, credential, gallery or account was used.
