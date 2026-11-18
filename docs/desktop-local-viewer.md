# Desktop local viewer (macOS)

First increment of the macOS shell. The contract it implements is in
`docs/native-launch-plan.md` §I: a user-picked folder or mounted memory card
becomes a gallery that references the originals in place. Nothing is copied,
moved, re-encoded, or uploaded; deletion never touches the filesystem; a
removed card leaves its catalogue entry marked "unavailable" until the
source returns.

## Shells

The macOS shell is the SwiftUI app in `macos/ManoramaMac/`: a WKWebView
serving the desktop bundle over the `manorama://` scheme, plus a small
native edge — menu bar, window chrome, folder grants, deep links.

The bundle is written against Tauri's JavaScript surface —
`window.__TAURI_INTERNALS__` and the plugin command names — but no Tauri
runtime is involved on macOS. `desktop-shell/bridge.ts` implements that
surface over the shell's own channel, and `NativeBridge.swift` answers
every `invoke`; a command the shell has not implemented rejects loudly
rather than silently succeeding.

`src-tauri/` is the dormant Tauri path, kept for the second platform
(Windows). It still targets `all` and retains its macOS signing config,
and the macOS build still borrows its icon — but it is not the macOS
shell and `bunx tauri` is not the macOS dev flow. See the final section.

## Layout

```
macos/ManoramaMac/      SwiftUI shell — WKWebView + the native edge
  NativeBridge.swift    dispatches every invoke the bundle makes: the Tauri
                        command surface (plugin:fs|*, plugin:deep-link|*,
                        plugin:opener|*, plugin:http|*, plugin:event|*,
                        plugin:window|*, oauth_loopback_*, vault_*,
                        pick/register gallery roots, share_post,
                        read/write/delete_private_file, device_*)
  FolderStore.swift     one security-scoped bookmark per picked root;
                        folders.json under Application Support/<bundle id>, 0600
  LocalSchemeHandler.swift  serves the bundle and granted originals over
                        manorama://
  OAuthLoopback.swift   loopback listener for in-app provider OAuth
desktop-shell/bridge.ts the Tauri-API shim loaded ahead of the bundle
scripts/build-macos.sh  vite build → stage Resources/ViewerBundle → swiftc
                        → generated Info.plist (URL scheme + document types)
                        → Developer ID codesign
desktop/                vite SPA root (mirrors native/)
  lib/local-scan.ts     pure scan: image extensions, one subdir level, sort, cap
  lib/catalogue.ts      local catalogue model + the metadata-only sync projection
  lib/session.ts        PKCE, desktop auth URL, deep-link parse, exchange, token store
  lib/sync.ts           PUT /api/device-galleries/:id per record; quiet failures
  lib/share.ts          explicit-share orchestration: confirm gate → provider
                        upload → POST /api/galleries {url} → device link
  lib/providers/        UploadProvider interface + Dropbox/Drive OAuth+upload
                        (see docs/desktop-uploads.md)
  lib/tauri.ts          the only module with plugin imports — the UI's adapter
  islands/Catalogue.tsx pick → grid → shared Viewer
vite.config.desktop-shell.ts  Library bundle for the shell (dist → staged
                        into Resources/ViewerBundle)
vite.config.desktop.ts  standalone client build (dist → src-tauri frontendDist)
```

## Commands

```sh
bun run build:desktop          # standalone bundle (the Tauri path's frontendDist)
bun run dev:desktop            # vite dev server for the bundle alone, port 5175
scripts/build-macos.sh debug   # Library bundle + Swift app →
                               #   macos/ManoramaMac/build/manorama.app
scripts/build-macos.sh release
```

Test builds may set `MANORAMA_MACOS_BUNDLE_ID` and `MANORAMA_MACOS_BUILD_DIR` —
a capture app needs a real distinct `CFBundleIdentifier`, since AX probes and
`tell application id` resolve the bundle's own id, not a launch argument.

## Signing

`build-macos.sh` codesigns the bundle with the Developer ID identity
(`MACOS_SIGN_IDENTITY` overridable, `--options runtime --timestamp`). The
signature matters beyond Gatekeeper: an ad-hoc linker signature has no
stable identity, so the login-Keychain key the vault uses would be
inaccessible on the next launch.

Notarisation is not wired yet. When it lands it submits
`macos/ManoramaMac/build/manorama.app` to `xcrun notarytool` and staples the
ticket — the same notarytool/stapler/spctl flow the Tauri runbook below
spells out.

**No entitlements file, deliberately.** Nothing here needs a hardened-runtime
exception (no JIT, no unsigned dylibs, no DYLD). Folder access is granted
by real security-scoped bookmarks, which work without App Sandbox; turning
the sandbox on would be a separate piece of work, not a flag flip.

## Scopes and storage

Folder grants are real security-scoped bookmarks — one per picked root,
stored by `FolderStore` in `folders.json` under
`Application Support/<bundle id>/` at mode 0600. The shell re-resolves
every bookmark at launch (the same boundary the Tauri build enforced by
re-registering its runtime fs scope), so a removed card loses access until
the source returns. `plugin:fs|*` commands accept only paths inside a
granted root — `grantedPath` in `NativeBridge.swift` is that check, the
Swift counterpart of the fs-plugin scope.

`session.json`, `catalogue.json`, and `providers.json` live under the same
app-support directory, written atomically at mode 0600 by
`write_private_file` (`write0600` in `NativeBridge.swift`, matching
`src-tauri/src/private_store.rs`). `providers.json` holds the upload
lane's refresh tokens (docs/desktop-uploads.md). **Upgrade path:** the
login Keychain can replace `session.json` later without touching the
catalogue or the exchange flow.

## Sign-in

`/auth/{provider}?native=desktop&code_challenge=` opens in the SYSTEM
browser (`plugin:opener|open_url` — in-webview OAuth is forbidden). The
callback redirects to `in.thecontrarian.manorama.desktop://auth/callback?handoff=…`,
which the app exchanges at `/api/auth/desktop/exchange` with its in-memory
PKCE verifier. The generated `Info.plist` registers the scheme, so bundled
builds receive links through `plugin:deep-link|get_current`.

**Dev-build limitation:** a build that is not a bundled `.app` — the vite
dev server, a fixture — cannot receive the deep link: LaunchServices has no
registered handler to route the custom scheme to. The build shows a
paste-the-link field as the supported fallback: finish sign-in in the
browser, copy the `in.thecontrarian.manorama.desktop://` URL it redirects
to, and paste it into the app. Because the verifier lives in memory, a
link pasted into a *restarted* app fails the exchange — start a fresh
sign-in and re-paste.

## Deliberately absent

- No ambient upload paths — `publicGallerySlug` is sent only by the
  explicit share flow in `docs/desktop-uploads.md`; nothing uploads on
  open, rescan, or launch.
- No watch folders or background monitoring — manual rescan only.
- No server-side file lists — the PUT body is title, sourceKind, itemCount
  and deviceId. `packages/core/device-gallery.ts` rejects anything else, and
  `desktop/lib/catalogue.test.ts` asserts no path material leaves.
- No device names on the server — the machine's own name stays in the local
  catalogue. The account's device list (`PUT /api/devices/:id`) records a
  random id and the generic kind only, and a build that still sends
  `deviceLabel` has it discarded.
- No Windows work — `src-tauri/` remains for that path; deep-link
  single-instance delivery and path handling differ there, so revisit when
  the second platform lands.

## The Tauri path (dormant)

`src-tauri/` is a Tauri v2 shell for the same `desktop/` bundle —
identifier `in.thecontrarian.manorama.desktop`, `frontendDist` pointing at
`desktop/dist` (the `vite.config.desktop.ts` build, which is why
`build:desktop` still exists). It is still buildable and keeps its macOS
signing config, but it is **not** the macOS shell — it remains for the
second platform.

```
src-tauri/
  src/lib.rs            register_gallery_root, OAuth loopback commands, plugin wiring
  src/private_store.rs  allowlisted JSON writes under the app config dir (0600)
  capabilities/         read-only fs (listing + file bytes in picked roots),
                        dialog open, deep-link, opener
```

Under Tauri the filesystem grant is a runtime scope instead of a bookmark:
`register_gallery_root` grants the picked root to the fs-plugin scope (for
`readDir`/`exists`) and to the asset protocol scope (for `convertFileSrc`).
Neither scope ever contains `**`, and the granted set resets every launch,
so the catalogue re-registers every saved root on start — the behaviour
`FolderStore` mirrors with bookmarks.

```sh
bunx tauri dev              # vite dev server + unbundled app
bunx tauri build --debug    # unsigned .app + .dmg under src-tauri/target/debug/bundle
bunx tauri build            # sign + bundle; artifacts under src-tauri/target/release/bundle/

# verify before submitting
codesign --verify --deep --strict --verbose=2 \
  src-tauri/target/release/bundle/macos/manorama.app
codesign -dvvv src-tauri/target/release/bundle/macos/manorama.app
# expect: Authority=Developer ID Application: … (373K7W3LKU), runtime flag, Timestamp

# notarise the DMG (keychain profile "notarytool", one-time via
# `xcrun notarytool store-credentials`), wait for the verdict
xcrun notarytool submit \
  src-tauri/target/release/bundle/dmg/manorama_0.1.0_aarch64.dmg \
  --keychain-profile "notarytool" --wait
# on rejection: xcrun notarytool log <submission-id> --keychain-profile notarytool

# staple the ticket and confirm Gatekeeper accepts the image
xcrun stapler staple \
  src-tauri/target/release/bundle/dmg/manorama_0.1.0_aarch64.dmg
xcrun stapler validate \
  src-tauri/target/release/bundle/dmg/manorama_0.1.0_aarch64.dmg
spctl -a -t open --context context:primary-signature -vv \
  src-tauri/target/release/bundle/dmg/manorama_0.1.0_aarch64.dmg
# expect: accepted, source=Notarized Developer ID
```

The `.app` inside the DMG should also pass `spctl -a -t exec -vv` with
`source=Notarized Developer ID` once the ticket exists (the staple rides on
the DMG; the app is assessed against the notarisation record).
