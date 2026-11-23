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
                        pick/register gallery roots, commit/discard dropped
                        roots, share_post, read/write/delete_private_file,
                        device_*)
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
  lib/local-scan.ts     pure scan: image extensions, folder root only, sort, cap
  lib/folder-drop.ts    drop-side scan/classify/select/record logic, injected readDir
  lib/catalogue.ts      local catalogue model + the metadata-only sync projection
  lib/session.ts        PKCE, desktop auth URL, deep-link parse, exchange, token store
  lib/sync.ts           PUT /api/device-galleries/:id per record; quiet failures
  lib/share.ts          explicit-share orchestration: confirm gate → provider
                        upload → POST /api/galleries {url} → device link
  lib/providers/        UploadProvider interface + Dropbox/Drive OAuth+upload
                        (see docs/desktop-uploads.md)
  lib/tauri.ts          the only module with plugin imports — the UI's adapter
  islands/Catalogue.tsx pick → grid → shared Viewer; owns the drop events,
                        veil and review sheet
  islands/DropFoldersSheet.tsx  the multi-folder review sheet + DropVeil
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

A distinct bundle id does **not** isolate storage: without a redirect the app
still reads and writes the installed copy's Application Support directory.
Launch the capture app with `--config <dir>` — that moves the private
documents (`session.json`, `catalogue.json`, `providers.json`) and, just as
importantly, makes the API bridge answer writes locally instead of letting a
throwaway run mutate the real account (`isIsolatedTestConfig` in
`LocalSchemeHandler.swift`). Add `--store <dir>` to move the remembered-folder
bookmarks too, and `--bundle-id <id>` is honoured only when both redirects
are present.

## Signing

`build-macos.sh` codesigns the bundle with the Developer ID identity
(`MACOS_SIGN_IDENTITY` overridable, `--options runtime --timestamp`) and
passes `macos/ManoramaMac/ManoramaMac.entitlements`. The signature matters
beyond Gatekeeper: key custody lives in two tiers. Profiled builds (the
App Store entitlements, or a future Developer ID provisioning profile)
carry `keychain-access-groups` and use the data-protection keychain under
the shared group `373K7W3LKU.manorama.shared` — every team-signed build
reads the same items with no prompt. This direct build is sandboxed and
carries no profile, so the group cannot be validated — AMFI refuses the
restricted entitlement at exec — and custody falls to the file-based
login keychain, where each item trusts only the signature that wrote it:
a foreign-signature item prompts once on first read, and "Always Allow"
settles it for that signature permanently. `NativeBridge`'s get/set/remove
degrade between the stores on their own — `keychainGet` reads the shared
store first, then legacy; a legacy hit rewrites itself into whichever
store answers; deletes sweep both.

Notarisation is not wired yet. When it lands it submits
`macos/ManoramaMac/build/manorama.app` to `xcrun notarytool` and staples the
ticket — the same notarytool/stapler/spctl flow the Tauri runbook below
spells out.

**App Sandbox is on.** The entitlements file enables
`com.apple.security.app-sandbox` plus the grants the app needs:
`network.client` (API + provider calls), `network.server` (the OAuth
loopback), `files.user-selected.read-write` (the NSOpenPanel pick),
`files.bookmarks.app-scope` — which is exactly why `FolderStore` persists
picks as security-scoped bookmarks rather than plain paths.
`keychain-access-groups` is deliberately NOT in this file: restricted
entitlements on a sandboxed profile-less signature fail AMFI at exec —
it lives in `ManoramaMac-AppStore.entitlements`, where the provisioning
profile validates it, and graduates here only when a Developer ID
profile carrying the group is embedded. Adding an entitlement is a
real capability decision, not a flag flip: no JIT, no unsigned dylibs,
no DYLD means nothing else belongs in the file.

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
Keychain that already holds the vault keys can replace `session.json`
later without touching the catalogue or the exchange flow.

## Sign-in

`/auth/{provider}?native=desktop&code_challenge=` opens in the SYSTEM
browser (`plugin:opener|open_url` — in-webview OAuth is forbidden). The
callback redirects to `in.thecontrarian.manorama.desktop://auth/callback?handoff=…`,
which the app exchanges at `/api/auth/desktop/exchange` with its in-memory
PKCE verifier. The generated `Info.plist` registers the scheme, and links
reach the page by two routes: a URL that arrives before the page is
listening is buffered by the shell and drained when the page calls
`plugin:deep-link|get_current` at startup, while a URL that arrives after
listeners are installed is pushed straight into them — the bridge emits
`deep-link://new-url` and `manorama://deep-link` through
`__manoramaShellEmit`. `installDesktopAuth` in `desktop/lib/session.ts`
wires both: the cold-start drain and the live listener land on the same
handler.

**Dev-build limitation:** a build that is not a bundled `.app` — the vite
dev server, a fixture — cannot receive the deep link: LaunchServices has no
registered handler to route the custom scheme to. The build shows a
paste-the-link field as the supported fallback: finish sign-in in the
browser, copy the `in.thecontrarian.manorama.desktop://` URL it redirects
to, and paste it into the app. Because the verifier lives in memory, a
link pasted into a *restarted* app fails the exchange — start a fresh
sign-in and re-paste.

## Drag-and-drop add

Dropping folders onto the Library window adds them as local galleries —
the same scan, record and sync path the folder picker uses, with the
security grant split in two so a cancelled review never becomes a
permanent permission.

`DropAwareWebView` (a `WKWebView` subclass in `ViewerWebView.swift`)
claims `.fileURL` drags before WebKit can turn them into a navigation:
loose files and packages are ignored, directories are counted for the
hover veil. The shell then runs a two-phase grant:

- **Pending** — `receiveDrop` scopes each directory
  (`startAccessingSecurityScopedResource`, or an ephemeral in-memory
  bookmark for paths with no drag promise, e.g. `--seed-drop`) and holds
  it in `NativeBridge.pendingDrops`, *not* `FolderStore`. Pending roots
  join `grantedRoots` through `rebuildGrantedRoots`, so `readDir` and the
  sheet's cover thumbnails work while the review is open. The set expires
  on its own after ten minutes.
- **Committed** — the page's `commit_dropped_roots {paths}` runs
  `folderStore.add` + `recordGalleryRoot` for each still-pending path,
  exactly like `pickGalleryRoot`, and returns the paths actually
  committed. `discard_dropped_roots {paths?}` stops the pending scopes
  and never touches roots already in `FolderStore`.

Three events carry the flow to the page, all through
`__manoramaShellEmit`: `manorama://folder-drag-enter` (`{folders, files}`)
shows the veil, `manorama://folder-drag-leave` clears it, and
`manorama://folders-dropped` (`{paths, files}`) starts the add — one
folder commits immediately through the same pipeline as `addFolder`,
several open `DropFoldersSheet` for per-folder deselection. Page-supplied
paths are lookup keys only; a path that is not pending grants nothing.

`--seed-drop <a,b,c>` replays the whole pipeline once the page is ready —
every step except the AppKit drag callbacks — for capture runs.

The Tauri shell now implements the same contract in Rust (see the final
section) — pending-grant at drop, commit/discard, and `read_file_range` —
but it is untested on real Windows. On iPad drops remain absent: the
events and commands simply never fire there.

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
- No real-Windows verification — `src-tauri/` now implements the drop
  surface in Rust (`handle_folder_drag`, the pending set, commit/discard,
  `read_file_range`), checked with `cargo check` on macOS but never run
  under Windows itself; deep-link single-instance delivery and path
  handling still differ there, so revisit when the second platform lands.

## The Tauri path (dormant)

`src-tauri/` is a Tauri v2 shell for the same `desktop/` bundle —
identifier `in.thecontrarian.manorama.desktop`, `frontendDist` pointing at
`desktop/dist` (the `vite.config.desktop.ts` build, which is why
`build:desktop` still exists). It is still buildable and keeps its macOS
signing config, but it is **not** the macOS shell — it remains for the
second platform.

```
src-tauri/
  src/lib.rs            pick/register gallery roots, drag-drop → pending →
                        commit/discard, read_file_range, OAuth loopback
                        commands, plugin wiring
  src/private_store.rs  allowlisted JSON writes under the app config dir (0600)
  capabilities/         read-only fs (listing + file bytes in picked roots),
                        dialog open, deep-link, opener
```

Under Tauri the filesystem grant is a runtime scope instead of a bookmark:
`pick_gallery_root` grants the picked root to the fs-plugin scope (for
`readDir`/`exists`) and to the asset protocol scope (for `convertFileSrc`).
Neither scope ever contains `**`, and the granted set resets every launch,
so the catalogue re-registers every saved root on start — the behaviour
`FolderStore` mirrors with bookmarks.

Folder drop is wired too: `window.on_webview_event` matches
`WebviewEvent::DragDrop` and re-emits the page's three
`manorama://folder-*` events (Tauri's own `tauri://drag-*` emits keep
firing in parallel — the page ignores them). A drop grants both scopes to
each directory immediately — the review sheet's scan must not race its
grant — and records the set in a managed `PendingDrops` state.
`commit_dropped_roots` re-runs `allow_root` and appends each still-pending
path to `roots.json`; `discard_dropped_roots` removes pending entries and
never touches `roots.json`. The pending scope itself is not revoked on
discard: Tauri scopes have no un-grant, `forbid_directory` is a permanent
veto that would block a later re-drop or pick of the same folder, and the
grant dies with the process anyway. `read_file_range` returns up to 4 MiB
of one file's bytes over raw IPC, gated by `fs_scope().is_allowed` — the
same pattern the fs plugin itself consults, so pending and committed
roots both pass and anything merely named rejects. This surface compiles
on macOS (`cargo check` clean) but has not been exercised on real
Windows.

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
