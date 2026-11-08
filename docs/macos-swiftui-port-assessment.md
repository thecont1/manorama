# macOS: why the Tauri build feels like a web page, and what a SwiftUI port costs

Status: investigation · Owner: Mahesh · Date: 2026-11-08
Companion: `docs/macos-ui-parity-plan.md` (the plan to make Tauri *look* like the web).
This document asks a different question: whether the Tauri shell should be replaced,
rather than polished.

---

## 1. The short answer

The Tauri app is not "an inferior copy of the web app." It **is** the web app —
`app/islands/Viewer.tsx`, `app/styles.css`, `app/components/ui/*` — rendered in a
WKWebView, with ~375 lines of Rust around it. Nothing about the interior was
rebuilt for the Mac; only the edges were.

That is why it feels wrong, and it is a structural fact rather than a styling
bug. You cannot reach "feels like a Mac application" by writing more CSS. The
things that make a Mac app feel like a Mac app — a real menu bar with a real
app menu, ⌘-key equivalents, a sidebar that behaves like a sidebar, Finder
drag-and-drop, a real `NSOpenPanel`, native focus rings, native scroll physics,
a native window that participates in Mission Control and Spaces — are all
*below* the webview boundary. The webview cannot produce them, and CSS
overlays on top of a webview cannot produce them either.

**Recommendation: do not port the viewer to SwiftUI. Port the *shell*.**

---

## 2. What is actually there today

### 2.1 The Rust is a thin edge, and that is fine

`src-tauri/` is small and well-factored:

| File | Lines | Role |
|---|---|---|
| `src/lib.rs` | 245 | picker, OAuth loopback, deep-link, plugin wiring |
| `src/private_store.rs` | 124 | allowlisted 0600 JSON writes under the app config dir |
| `src/main.rs` | 6 | entry point |

Its safety model is sound and worth preserving in any port: the renderer never
supplies a path, so a filesystem scope can only ever cover what the user picked
via `NSOpenPanel`; the provenance list is append-only and lives in Rust, not in
the renderer-writable catalogue. `desktop/lib/tauri.ts` is the only module that
touches plugin imports, which is why the TypeScript tests run in a plain
`happy-dom` environment with no Tauri runtime.

### 2.2 The interior is the web app, verbatim

`desktop/islands/Catalogue.tsx` imports and renders the shared web interior:

```
app/islands/Viewer.tsx          3,105 lines   ← the entire viewer
app/components/viewer/*.tsx     ~1,300 lines   ← picker, settings, info, chrome
app/components/ui/*.tsx           ~570 lines   ← Sheet, TopBar, Segmented, Switch…
app/styles.css                  2,269 lines   ← @imported wholesale by desktop/styles.css
packages/core/*.ts              3,051 lines   ← platform-free, shared with Worker + web
```

`desktop/styles.css` line 1 is literally `@import '../app/styles.css';`. The
Mac app inherits the entire web design system, including the web's own fonts
(`DM Mono`, `Playfair`, `Bricolage Grotesque`, `Manrope` — loaded via
`@font-face`, not system fonts).

This is why the parity plan (`docs/macos-ui-parity-plan.md`) is a treadmill. It
lists ten gaps and closes them one at a time, and each closure is a CSS
override on top of a layout that was designed for a browser. Phase 2 of that
plan — adopting `libraryLayout` — is the right instinct and the correct fix,
but it is one row of a long table.

### 2.3 What the desktop shell has *no* native equivalent of

Confirmed by search — none of these exist anywhere in `src-tauri/` or
`desktop/`:

| Native Mac affordance | Present? | Note |
|---|---|---|
| App menu (File/Edit/View/Window/Help) | **No** | Tauri would auto-install a default macOS menu (`enable_macos_default_menu: true` by default, `tauri-2.12.0/src/app.rs:2410`), but it is the *stock* About/Services/Hide/Quit skeleton — no app-specific items, no "Open Folder", no "Rescan", no gallery navigation |
| Keyboard shortcuts (⌘O, ⌘N, ⌘1–9, ⌘W) | **No** | Only `Escape` is handled (`Catalogue.tsx:427`). The shared Viewer handles arrows/space, but the Mac shell adds nothing |
| Finder drag-and-drop of folders | **No** | `dragDropEnabled` is not configured; no `DragDropEvent` handler |
| Native folder picker | **Partial** | Tauri dialog plugin wraps `NSOpenPanel`, so the *dialog* is native — but everything after it is web |
| Native sidebar (`NSOutlineView` semantics) | **No** | The rail is a web `<aside>` with CSS; the account pane is a `position: fixed` drawer with a CSS keyframe animation (`desktop/styles.css:219-287`) |
| Native list/table rows, context menus | **No** | No `contextmenu` handler anywhere in `app/` or `desktop/` — right-click gives the browser default |
| Native focus rings, scroll physics, text selection | **No** | Web behaviour; `scrollbar-width: none` on the rail (`app/styles.css:1774`) hides the system scrollbar entirely |
| Vibrancy / material background | **No** | `window-vibrancy` is compiled into the Tauri dependency tree but unused; `window_effects` is available in `tauri-utils` config and unset |
| Quick Look, Spotlight, Services, Share extension | **No** | Nothing |
| Native per-window tabs / multi-window | **No** | Single window, `titleBarStyle: Overlay`, `hiddenTitle: true` |
| Keychain for tokens | **No** | `session.json` at mode 0600 in the app config dir — `docs/desktop-local-viewer.md:95-101` already names the keyring plugin as the upgrade path |

### 2.4 The captured evidence agrees

`demo-captures/macos/06-folder-grid.png` is a screenshot of a web admin page:
a rounded web card, web pill buttons ("Hide photos", "Rescan", "Share…",
"Remove"), a web sign-out link in a web header. `01-opening-screen.png` is a
web landing page in a small window. These are not Mac captures of a Mac app;
they are captures of `app/` in a `WKWebView`.

The one thing that *does* look right is the photograph itself — `03-first-image-hover.png`
is a full-bleed image with correct aspect handling and no chrome. The image
pipeline is correct. The *application* around it is a web page.

### 2.5 The installed build is also stale

Per `docs/macos-ui-parity-plan.md` §0.1, `/Applications/manorama.app` reports
a build tag read as `0balb5e` — not a valid revision (it contains a non-hex
character and no matching object exists in this repository's history). The
tag is treated as unreliable, so the staleness conclusion rests on the
build's observed symptoms instead: empty cloud thumbnails (the CSP fix is
`9ba1b5e`), a non-draggable window and no build tag (both `e901d75`), and
account galleries opening in a browser tab. All three postdate it, so the
installed app **does** predate `9ba1b5e` and `e901d75`. Some of the
"inferior" feeling may be this, not the architecture — but the architecture
gap is real and separate.

---

## 3. The three options, honestly costed

### Option A — Polish the Tauri shell (stay webview)

Add a real macOS menu via `tauri::menu`, ⌘-shortcuts, `window_effects`
vibrancy, drag-and-drop via `DragDropEvent`, keep the system scrollbar.

- **Effort:** days. The Tauri APIs all exist and are already in the dependency
  tree.
- **Result:** a Mac app with a Mac menu bar that is still a web page underneath.
  Resolves "the app bar is wrong," not "this doesn't feel like a Mac app."
- **Ceiling:** the interior stays web. Every gap in §2.3 that depends on
  AppKit behaviour (sidebar semantics, drag-and-drop *into* the gallery
  list, focus, scroll) remains unreachable — context menus are the exception:
  Tauri 2.12's `Menu.popup()` can answer a webview `contextmenu` event with a
  real AppKit menu, so right-click is wired, not missing.

### Option B — Native shell, web viewer (SwiftUI + WKWebView)  ← recommended

Write the macOS app in SwiftUI. It owns the window, the menu bar, the sidebar,
the toolbar, the folder picker, drag-and-drop, Keychain, and all native
services. The *viewer* — the thing AGENTS.md §1 calls "the product" — stays
the shared `app/islands/Viewer.tsx`, hosted in a `WKWebView` inside the native
chrome, talking to Swift over a small `WKScriptMessageHandler` bridge.

- **Effort:** weeks, not months. The viewer (the expensive part, 3,105 lines of
  layout, plate rules, C2PA, fold geometry, video) is **not rewritten** — it is
  reused verbatim from `app/`, which is exactly what makes the web app good.
- **Result:** a genuinely native Mac application. Native sidebar that behaves
  like a sidebar, real menus, real shortcuts, Finder drop, Keychain, proper
  window participation. The photograph — the product — is untouched and
  pixel-identical to the web.
- **Invariant check:** satisfies AGENTS.md §2.1 (no bytes persisted server-side),
  §2.2 (no re-encode — the same web viewer runs), §2.8 (`packages/core` stays
  platform-free; Swift never imports it), §2.9 (deletion never touches the
  provider). §2.7 is arguably *strengthened*: the native shell can host the
  vault and global view, which are native-only by design and are currently
  missing from the Mac build entirely.
- **Bonus:** it finally makes the desktop shell eligible for the features that
  are currently iOS-only — the encrypted vault, offline viewing, Global View
  (see §4).

### Option C — Full SwiftUI rewrite

Rewrite the viewer too. Native image pipeline (`CGImageSource`, `NSImage`),
SwiftUI gallery list, native picker editor.

- **Effort:** months, and it re-implements the most valuable, most subtle code
  in the repository.
- **Costs that do not go away:**
  - The plate rules (AGENTS.md §2.3) are enforced by the browser suite and
    depend on `packages/core/adframe.ts` and the viewer's cadence logic. A
    Swift re-implementation forks that policy — and a fork of an ad-cadence
    policy is exactly the account-suspension risk §2.3 warns about.
  - The "never upscale, recompress, crop, stretch, or re-encode" rule
    (§2.2) is enforced today by a *shared* viewer with one implementation.
    Two implementations means two chances to violate a load-bearing invariant.
  - The web app is, by your own assessment, perfect. Option C does not reuse
    the perfect thing; it re-implements it, and the re-implementation starts
    behind.
  - `packages/core` (3,051 lines, 20 modules) is the platform-free heart. It
    stays TypeScript; Swift cannot import it. Either the logic is duplicated
    in Swift (drift) or a JS bridge is reintroduced (and you are back to a
    webview with extra steps).

**Option C is the one to refuse.** It is the classic "rewrite it to feel
native" move, and it trades a working, invariant-guarded product for an
unproven one.

---

## 4. What a native shell unlocks that the Mac build lacks today

The desktop shell has **none** of these — they exist only under `native/`
(the iOS Capacitor shell):

| Feature | iOS | macOS today | Notes |
|---|---|---|---|
| Encrypted thumbnail vault | ✅ `native/lib/vault.ts` (651 lines) | ❌ | AES-GCM, Keychain-backed via `@aparajita/capacitor-secure-storage` |
| Offline viewing | ✅ `native/lib/offline-gallery.ts` | ❌ | |
| Global View | ✅ `native/islands/GlobalView.tsx` | ❌ | AGENTS.md §4 notes the Tauri shell "does not mount the native encrypted-vault GlobalView island" |
| Vault settings / repair | ✅ `native/islands/VaultSettings.tsx` | ❌ | |
| Paywall / billing | ✅ `native/islands/Paywall.tsx` | ❌ | RevenueCat's `purchases-ios` supports **macOS 10.15+** and universal purchases across iOS/macOS — so a native Mac target *can* sell |
| AdMob | ✅ `@capacitor-community/admob` | ❌ | no native macOS equivalent for the community plugin; house plates work fine |

This is the strongest argument for Option B that is not aesthetic. AGENTS.md §2.7
says vault, offline, global view and P2P are **native-only by design**. The
Mac app is currently a native-only feature set with *zero* native-only
features. A Swift shell is where the Mac build would finally be able to host
them — the same argument the iOS build has.

Note the constraint: `@capacitor-community/admob` does not support native
advanced ads (§ Dependencies). On macOS the `AdFrame` seam in
`packages/core/adframe.ts` is what lets house plates render without a second
Google Mobile Ads dependency — that stays true in Swift.

---

## 5. Recommended plan

### Phase 0 — Establish the baseline (do this first, it is cheap)

1. Rebuild the Tauri app and reinstall it. The installed build is at a commit
   not in this repo's history, so the current "it feels wrong" impression is
   partly a stale-binary artefact. Capture the six-state matrix from the
   fresh bundle.
2. Measure the delta between "stale Tauri build" and "rebuilt Tauri build".
   **If the rebuilt build already feels acceptable, Option A plus the parity
   plan may be enough, and this whole port is unnecessary.** This is a
   genuinely open question today, and it is cheap to answer.

### Phase 1 — Native shell skeleton (SwiftUI, macOS 14+)

New target `macos/ManoramaMac/`, separate from the Capacitor iOS project.

- `Window` + `NavigationSplitView`: native sidebar (Gallery list) + detail.
- Real menu bar: **Manorama** (About, Settings, Hide, Quit), **File** (Open
  Folder…, Rescan, Share…), **View** (Toggle Filmstrip, Toggle Info),
  **Window**, **Help**. ⌘O / ⌘R / ⌘1–9 / ⌘W wired to the same actions.
- `WKWebView` hosting the existing `desktop/dist` bundle, in a
  `NSVisualEffectView`-backed container for vibrancy.
- The bridge has two distinct halves — they are not the same mechanism:
  - web → native: `WKScriptMessageHandler` messages posted by the bundle —
    the replacements for Tauri's `invoke` calls: catalogue read/write
    (`read_private_file`/`write_private_file` → App Support JSON under the
    sandbox), `pick_gallery_root` (→ `NSOpenPanel` + security-scoped
    bookmark), `readDirEntries`/`pathExists` (→ `FileManager` inside granted
    roots), keychain read/write, reveal in Finder.
  - native → web: `callAsyncJavaScript` (or `evaluateJavaScript`) pushes
    commands into the loaded page — open gallery, rescan, share, set theme —
    delivered through a small dispatch seam the bundle exposes on `window`,
    the same shape the deep-link events use today.
  - local media: `asset:`/`convertFileSrc` URLs are replaced by a
    `WKURLSchemeHandler` on a custom scheme (`manorama-local:`) that serves
    bytes from the security-scoped roots — the same role Tauri's `asset`
    protocol fills now.
  If any of these proves disproportionate for Phase 1, the honest fallback
  is a viewer-only entrypoint (signed-in account galleries, no Local
  section) that skips the Tauri-dependent flows entirely rather than a
  bridge that half-works.
- Keychain for `session.json` contents (replaces the 0600 JSON; the upgrade
  path is already named in `docs/desktop-local-viewer.md:100`).
- `NSOpenPanel` + **security-scoped bookmarks** (`com.apple.security.files.bookmarks.app-scope`),
  so granted roots survive relaunch under the App Sandbox. This is a real
  upgrade over the current runtime-scope re-grant.

### Phase 2 — Move the shell's responsibilities into Swift

- The native sidebar becomes the source of truth for the gallery list; the web
  interior handles only the viewing surface. The `libraryLayout` split (pinned
  strips vs compact cards) is decided in Swift, reading the same
  platform-free data.
- Local scan (`desktop/lib/local-scan.ts`) and catalogue persistence move to
  Swift; the metadata-only sync projection (`packages/core/device-gallery.ts`)
  keeps enforcing its no-path-material rule.
- The existing `desktop/lib/session.ts` OAuth exchange moves to
  `ASWebAuthenticationSession` — a native replacement for the hand-rolled
  loopback listener in `src-tauri/src/lib.rs:64-196`.

### Phase 3 — Native-only features (the actual payoff)

- Vault, offline, Global View, Paywall on macOS, per AGENTS.md §2.7.
- RevenueCat `purchases-ios` for macOS, universal purchases with iOS.

### Phase 4 — Retire Tauri

Once the Swift app covers the same surface, `src-tauri/` and `desktop/` can be
removed. Keep `packages/core` untouched throughout — it stays the
platform-free heart, and the web app stays exactly as good as it is today.

---

## 6. What to keep, and what to stop

**Keep, unchanged:** everything in `packages/core/` (3,051 lines). It is the
whole point — one implementation of image staging, gallery settings, plate
cadence, folder layout, device-gallery projection.

**Keep:** `app/islands/Viewer.tsx` and `app/components/viewer/*`. This is the
product. Do not rewrite it.

**Keep:** the web app, exactly as it is. It is the reference implementation and
the fallback; `docs/macos-ui-parity-plan.md` §0.4 lists what is already aligned
— do not regress it.

**Stop:** adding CSS overrides to `desktop/styles.css` that simulate native
behaviour. Each one is a small lie that makes the next native port harder to
land, because the web interior will have accreted desktop-specific assumptions.

**Reconsider:** `docs/macos-ui-parity-plan.md` itself. It is a good-faith plan
for making Tauri look like the web. If Option B is chosen, its Phases 3–5
(the rail parity work) become moot — the sidebar is native. Its Phase 0
(rebuild and reinstall) remains valid and should happen regardless.

---

## 7. Open questions for the owner

1. **Is the Mac app's primary audience the Mac App Store, or direct download?**
   SwiftUI is the natural path to the Mac App Store; the current Developer ID +
   notarisation flow (`docs/desktop-local-viewer.md:40-84`) works and can
   continue in Swift too. This changes the App Sandbox / entitlement work in
   Phase 1 materially.
2. **Does the Mac build need to sell?** If yes, RevenueCat on macOS is
   supported and the paywall becomes in scope for the native target. If no,
   Phase 3 can ship without billing.
3. **Is the vault in scope for macOS in the near term?** It is the strongest
   non-aesthetic reason to do this port, and it is the largest single chunk of
   work in Phase 3.
4. **Windows?** Tauri is cross-platform and Swift is not. If Windows is a
   near-term goal, that is an argument for keeping a Tauri target alive in
   parallel — the two shells can coexist, sharing `packages/core` and the
   viewer.
