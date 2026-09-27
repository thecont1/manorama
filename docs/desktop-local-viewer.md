# Desktop local viewer (Tauri, macOS)

First increment of the macOS shell. The contract it implements is in
`docs/native-launch-plan.md` §I: a user-picked folder or mounted memory card
becomes a gallery that references the originals in place. Nothing is copied,
moved, re-encoded, or uploaded; deletion never touches the filesystem; a
removed card leaves its catalogue entry marked "unavailable" until the
source returns.

## Layout

```
src-tauri/              Tauri v2 shell. identifier in.thecontrarian.manorama.desktop
  src/lib.rs            register_gallery_root command + plugin wiring
  src/private_store.rs  allowlisted JSON writes under the app config dir (0600)
  capabilities/         read-only fs listing, dialog open, deep-link, opener
desktop/                vite SPA root (mirrors native/)
  lib/local-scan.ts     pure scan: image extensions, one subdir level, sort, cap
  lib/catalogue.ts      local catalogue model + the metadata-only sync projection
  lib/session.ts        PKCE, desktop auth URL, deep-link parse, exchange, token store
  lib/sync.ts           PUT /api/device-galleries/:id per record; quiet failures
  lib/tauri.ts          the only module with plugin imports — the UI's adapter
  islands/Catalogue.tsx pick → grid → shared Viewer
vite.config.desktop.ts  standalone client build (dist → src-tauri frontendDist)
```

## Commands

```sh
bun run build:desktop       # desktop/dist only
bunx tauri dev              # vite dev server + unbundled app
bunx tauri build --debug    # unsigned .app + .dmg under src-tauri/target/debug/bundle
```

## Scopes and storage

Both filesystem scopes are runtime-only: `register_gallery_root` grants the
picked root to the fs-plugin scope (for `readDir`/`exists`) and to the asset
protocol scope (for `convertFileSrc`). Neither scope ever contains `**`, and
the granted set resets every launch, so the catalogue re-registers every
saved root on start.

`session.json` and `catalogue.json` live under the app config dir, written
through the `write_private_file` command at mode 0600. The command allowlist
is fixed inside Rust, so the fs plugin — which is read-only — cannot be
turned into a writer. **Upgrade path:** a maintained OS-keychain plugin
(e.g. a v2-compatible keyring plugin) can replace `session.json` later
without touching the catalogue or the exchange flow.

## Sign-in

`/auth/{provider}?native=desktop&code_challenge=` opens in the SYSTEM
browser (opener plugin — in-webview OAuth is forbidden). The callback
redirects to `in.thecontrarian.manorama.desktop://auth/callback?handoff=…`,
which the app exchanges at `/api/auth/desktop/exchange` with its in-memory
PKCE verifier.

**Dev-build limitation:** `tauri dev` produces no `.app` bundle, so macOS
LaunchServices cannot route the custom scheme to it — the deep link never
arrives. The build shows a paste-the-link field as the supported fallback:
finish sign-in in the browser, copy the `in.thecontrarian.manorama.desktop://`
URL it redirects to, and paste it into the app. A bundled `.app` (even the
debug build) registers `CFBundleURLTypes` and receives links normally.
Because the verifier lives in memory, a link pasted into a *restarted* app
fails the exchange — start a fresh sign-in and re-paste.

## Deliberately absent

- No upload or sharing code paths — `publicGallerySlug` is never sent.
- No watch folders or background monitoring — manual rescan only.
- No server-side file lists — the PUT body is title, sourceKind, itemCount,
  deviceId, deviceLabel. `packages/core/device-gallery.ts` rejects anything
  else, and `desktop/lib/catalogue.test.ts` asserts no path material leaves.
- No Windows work — deep-link single-instance delivery and path handling
  differ there; revisit when the second platform lands.
