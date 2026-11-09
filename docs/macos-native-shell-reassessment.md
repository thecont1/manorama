# The macOS desktop, reassessed — and a native shell

**Status:** assessment and prototype. The prototype's shell code is on `main` (PR #196); this branch
carries the assessment, the live boundary suite, and the behaviours `main` does not yet have.
**Worktree:** `.worktrees/macos-shell`, branch `feat/macos-native-shell`, based on `main` at `2ddd7a8`.

---

## 1. Reference points

Two things were used as the yardstick:

- `404394` — `fix(desktop): hoist openAccountGallery above the viewer early return`, the tip of
  `main` when the first assessment was written.
- `1e4c0e5` — the tip of `feat/desktop-encrypted-vault` when the installed
  `/Applications/manorama.app` was rebuilt from for this assessment.

The desktop work has since landed: `feat/desktop-encrypted-vault` merged into `main` as PR #196,
which carried the native shell prototype with it. This branch is based on `main` at `2ddd7a8`, so
what follows describes the code as it stands *now* — with the prototype's shell code taken from
`main` rather than from an earlier private copy of it.

The installed Tauri build was **rebuilt from the current tip, re-signed and reinstalled** before
anything was measured, so what follows describes the code as it stands. The earlier complaint that
"the installed app is out of date" is **closed**.

`main` has since moved again (`3620932`, "a saved gallery opens from the vault"). This branch has
**not** been rebased onto it: the two touch `desktop/islands/Catalogue.tsx` and `desktop/styles.css`,
and `main` is carrying another agent's uncommitted work in the shared checkout. Rebasing is a merge
decision for the owner, not something to do underneath a moving target.

## 2. What changed since `404394`, and what the first assessment got wrong

The desktop gained a great deal. Diff since `404394`: 9 files, 622 insertions.

- an encrypted vault on the device (`desktop/lib/vault.ts`, reusing `native/lib/vault.ts`),
- Keychain-backed keys through the Rust `keyring` crate,
- an offline gallery and vault settings,
- `tauri-plugin-http` for provider traffic,
- the Phase 2/3 parity work: a sidebar, pinned galleries as strips, compact cards, a tier line, a
  vault tracker and an ad slot.

**The first assessment's claim that "the Mac shell had zero native-only features" is stale and is
withdrawn.** The shell is no longer a web page with a Rust stub; it has a vault, a Keychain, an
offline path. Whatever else is wrong with it, that is not it.

## 3. The remaining complaints, classified

The instruction was to separate shell behaviour from viewer behaviour, because they are different
problems with different owners. Here they are.

### 3.1 Deliberate decisions, not defects

Two things that look like complaints are the product working as intended. The native shell now
matches both.

| # | Decision | Evidence | Where it lives |
|---|---|---|---|
| **S1** | The app opens **fullscreen, in its own Space**: no traffic lights, the user's menu bar hidden until the pointer reaches the top of the screen. **This is a deliberate kiosk choice** — the photographs are the product, and they get the whole screen with no window chrome competing for attention. | `src-tauri/tauri.conf.json` → `"fullscreen": true` (added in `c664780`); `.window-state.json` persists it across launches. The native shell now opens the same way, and the View menu still offers a way back to a window. | Tauri window config |
| **V2** | A gallery opens **behind the web curtain** — the veil with the mark, the title and *"Tap to open"*. **Deliberate**: the curtain is the moment before the photographs, and it is kept in the native shell. The curtain is the shared viewer's own, so the veil is whole wherever it is mounted. | `app/islands/Viewer.tsx` (`[data-curtain]`), mounted by `desktop/islands/Catalogue.tsx` | web surface |

### 3.2 Shell — the chrome the app is made of

The rest of these are not bugs in the viewer. Each is something the app's *frame* does, and each
is fixed by making the frame native.

| # | Complaint | Evidence | Lives in |
|---|---|---|---|
| **S2** | The menu bar is Tauri's **stock skeleton**: Apple, manorama, File, Edit, View, Window, Help — where File holds only *Close Window / Close All* and View only *Toggle Full Screen*. No ⌘O, no ⌘R, no gallery navigation, no ⌘1–⌘9. | AX menu dump of the installed build: `File → Close Window ⌘W, Close All ⇧⌘W`; `View → Toggle Full Screen ⌃⌘F`; `Help` empty. | Tauri default menu |
| **S3** | Folder access is a **remembered path, not a grant**. The app writes down a path and later re-asks the OS for access to it — which only works because the app is unsandboxed. There is a live desync: `roots.json` holds a real root while `catalogue.json` holds `galleries: []`, so the app knows about a folder it has not catalogued. | `~/Library/Application Support/in.thecontrarian.manorama.desktop/` | `src-tauri/src/private_store.rs` + the picker |
| **S4** | The library is a **web grid, not a source list**. No native selection, no per-row context menu, no *Reveal in Finder*, no drag-a-folder-onto-the-window, no Recent Folders. | `desktop/islands/Catalogue.tsx` (2,208 lines) | web chrome |
| **S5** | Everything — chrome, menus, focus — is **HTML inside one web view**, so VoiceOver, the key-view loop and fullscreen behave like a web page rather than like an app. | structural | — |
| **S6** | **Nothing tells the user when the photographs have gone.** If the folder is unmounted, emptied or deleted while a gallery is open, the page sees a 404 and silently retries; the shell keeps reporting a position for images it can no longer read. Measured in the prototype before it was fixed: empty black frames, a cheerful "Ready" status bar, and a sidebar still claiming "55 photographs". | see §5 | shell error surface |
| **S7** | **A native shell can silently kill the viewer's keyboard.** A `WKWebView` only forwards key events to the page when the page holds DOM focus. If the shell opens a gallery without giving it the keyboard, the retained viewer's own shortcuts — `g` for the information sheet and the picker, `m` for the magnifier — never fire, and the native menu ends up owning every key the user presses. Nothing errors; the app just quietly stops responding to `g`. | measured in the prototype; fixed by focusing the stage on mount | shell focus handoff |

### 3.3 Viewer — the retained web surface, unchanged

| # | Behaviour | Verdict |
|---|---|---|
| **V1** | Arrow keys page **by viewport, not by one photograph** (measured: 0 → 1 → 2 → 4 in a 5-image strip). | **Not a defect.** `advanceStripByViewport` (`app/islands/Viewer.tsx`) is the viewer's deliberate gesture semantics; the right arrow on the web does exactly the same. It behaves identically inside the native shell, which is the point of retaining it. |
| **V3** | The viewer's own chrome (Info, Settings, "Show controls") sits inside the native window. | A **chrome** question for the shell, not a viewer defect. |

## 4. The prototype: the Library, not a sidebar

A SwiftUI shell in `macos/`, and it hosts **the app's own Library** — the same `desktop/` bundle the
Tauri build ships, unchanged.

**The native sidebar was removed.** The first prototype put a `NavigationSplitView` list of folders
beside the viewer. That was the wrong first screen: the Library is where the account, the tier, the
vault meter, the pinned strips, the house advertisement and the local catalogue all live, and a
second, native list of folders beside it delivered none of them while hiding the ones that do. The
Library *is* the app's front door, and it is the front door here too.

What the shell therefore is:

- **The Library, served from the app's own resources** over `manorama://localhost/…`. The origin is
  a real origin, which is what lets the page's API calls stay same-origin.
- **One implementation of the app.** The bundle is written against Tauri's runtime API, and Tauri's
  JavaScript surface is deliberately thin: `window.__TAURI_INTERNALS__.invoke` and
  `window.__TAURI_INTERNALS__.convertFileSrc`. `desktop-shell/bridge.ts` implements exactly those
  two over the shell's own channel, so the *same* bundle runs in the SwiftUI shell with no fork of
  the app's code and no second implementation of the Library.
- **The shell is the network boundary.** The page's API calls to `manorama.xyz` are proxied
  same-origin through `manorama://localhost/api/…`, so the shell's origin needs nothing deployed and
  the bearer token travels with the request exactly as the browser sent it.
- **The machine's answers.** `macos/ManoramaMac/NativeBridge.swift` answers what the Library asks
  of the machine: the folder picker, the private documents, the filesystem plugin (restricted to
  granted roots), the vault's bytes and the Keychain.
- **Folder access through the system's own grant.** `NSOpenPanel` → security-scoped bookmark →
  `startAccessingSecurityScopedResource()`. The renderer never learns a path it did not already
  have from the catalogue, and only picker-approved roots are reachable.
- **Native chrome.** A real menu bar (Gallery ▸ Next / Previous / Close, File ▸ Open Folder…, View
  ▸ Refresh, ⌥-arrow equivalents), a real Space, a real status bar, a real alert.

The shared `app/islands/Viewer.tsx` is mounted **verbatim**. No fork, no reimplementation.

## 5. What the boundary tests showed

The headless harness (`macos/BoundaryTests/`) asserts **32/32** on the security-critical paths
without a web view: bookmark create/resolve, survival across a fresh store, scope acquisition,
traversal refused outside the root, an ungranted token refused, a missing file, a released token
stopping the resolution, a dead folder reporting unavailable and building no gallery, the proxy
answering a live task, a stopped task never being answered — and the **absolute-path form** the
shell actually serves: inside a granted root resolves, outside every granted root is refused,
traversal is refused, an escaping symlink is refused, and a missing file resolves to nothing.

The live suite (`scripts/test-macos-focus.sh`) drives the app through AX and synthesised input —
the way a person would, not through the app's internals — against the real ETHIOPIA originals
(55 JPEGs at 2267×1700). **19 pass, 0 fail.**

The suite runs against an **isolated copy of the app's state** (`--store`, `--config`): a test run
that wrote the owner's catalogue would be a test run that changes the owner's library. The account
is borrowed, because local galleries are a Visionary feature and a signed-out shell has no local
gallery to open.

| Boundary | Result |
|---|---|
| The landing screen | **PASS.** The shell comes up on the Library — *Add Gallery*, *Settings*, the local gallery cards — with no native sidebar in front of it. |
| The add flow | **PASS.** The folder is added through the app's own flow: the shell hands the picker a path, the page scans and records it, and the catalogue holds exactly one gallery. |
| Persistent folder access | **PASS.** A security-scoped bookmark survives a relaunch and re-resolves to the same path. A bookmark minted by a *different* binary is refused (`NSCocoaErrorDomain 259`) — the grant is bound to the code identity, which is the point. |
| Relaunch | **PASS.** After a kill and relaunch the folder is listed again and still opens (1 of 55). |
| Local media | **PASS.** The shared web Viewer renders the user's originals inside the native window, served straight from disk. Nothing is copied, re-encoded or uploaded, and **no photograph failed to load** — the trace records zero failed reads and zero refused paths across the whole run. |
| The kiosk launch | **PASS.** The window opens in its own Space (`fullscreen=true`) — the deliberate kiosk decision, matching the Tauri build. *Exit Full Screen* brings the window back and *Enter Full Screen* puts it back. |
| The curtain | **PASS.** The gallery opens behind the veil, the way the web does; dismissing it puts the page into `gallery-entered`, which is what the viewer's keyboard handling waits for. |
| Keyboard focus handoff | **PASS.** Tab follows the page's own focus ring — the same thing the web does, and the same thing a `WKWebView` does with no browser chrome to fall through to. The native commands are reached by their key equivalents instead: ⌥→ moves the viewer. |
| Arrow keys drive the viewer | **PASS.** With the web view focused, Right moves the viewer (2 of 55 → 3 of 55). |
| Native menu drives the viewer | **PASS.** *Gallery ▸ Next Photograph* moves it, one photograph at a time (4 → 5 → 6 → 7 of 55). |
| Escape leaves the gallery | **PASS.** The page reports the key, the shell closes the gallery, and the status bar goes with it. |
| Error recovery | **PASS.** Deleting the folder under an open gallery surfaces a native alert and an honest status bar instead of empty frames and "Ready". |
| The viewer's own keyboard | **PASS after a fix.** `g` opens the viewer's information sheet inside the native window — once the page is given the keyboard. Before the fix it did nothing at all (S7). |
| Jump to an arbitrary photograph | **PASS.** Asking for photograph 30 lands on index 30. See §6. |

### The error path, before and after

The first live run of the error test produced this:

- four empty black frames, no image, no message,
- the status bar reading **"Ready"**,
- the sidebar still claiming "55 photographs",
- and no error anywhere, because the bridge declares an `error` message that **nothing ever posts**
  and the shell's `errorMessage` was never wired to any view.

The fix is shell-side and small: the scheme handler already knows when a granted file could not be
read (`LocalSchemeHandler`), so it now tells the shell, and the shell raises a native alert and
changes the status line:

> **Something went wrong** — *MS201112-AddisAbaba0036.jpg is no longer in the folder. It may have
> been moved, renamed or deleted since the gallery was catalogued.*
>
> status bar: **Some photographs are missing**

### What the alert could not tell you

The first version of that alert said one thing about two different facts:

> *MS201112-AddisAbaba0036.jpg could not be read. The folder may have been moved, emptied, or
> unmounted.*

The photograph was on disk. The shell simply could not open it, and then told the user their
storage had failed — which is a thing a person will act on (they will move the folder, or empty it,
or blame the drive). The message was a guess wearing the clothes of a fact.

So the shell now tells the two apart, because it is the only party that can:

| The file… | The alert says |
|---|---|
| is no longer on disk | *… is no longer in the folder. It may have been moved, renamed or deleted since the gallery was catalogued.* |
| is still on disk and could not be opened | *… is still in the folder, but the app could not open it: \<the reason\>.* |

Three things changed with it:

1. **The reason is kept, not swallowed.** The read was `try? Data(contentsOf:)`, which threw the
   evidence away. It is now a `do/catch`, and the path and the error go to the trace
   (`media read failed: <path> — <reason>`). A 404 that cannot be explained is a bug report waiting
   to happen.
2. **A refused path is traced too.** A 403 — a file outside every granted root — was a silent blank
   frame. It now says `media refused: <path>`.
3. **One report per photograph.** The Viewer retries a frame; the shell must not answer the same
   alert again and again.

### The keyboard, before and after

The first live run of the focus test found the opposite of what was expected. The gallery opened,
the photographs rendered, and the native menu's own commands worked — but the viewer's own
shortcuts did nothing. Pressing `g` did nothing at all: no sheet, no picker, no error.

The cause is S7. A `WKWebView` forwards key events to the page only when the page holds DOM focus.
Nothing in the shell was giving it that focus, so every key the page would have handled fell on
the floor — and the native menu's bare-arrow and bare-Escape key equivalents shadowed the rest.

The fix has two halves:

1. The page focuses its own stage on mount, so the viewer is alive the moment a gallery opens.
2. The native menu's arrow items became **⌥← and ⌥→** rather than bare arrows, so they no longer
   compete with the viewer's own arrow handling — which is a viewport gesture on the web and stays
   that way.

After that, `g` opens the viewer's information sheet, inside the native window, over the real
photograph:

> **Photograph 1 of 55** — File: `MS201112-AddisAbaba0014.jpg` — Content Credentials: **C2PA**

and the arrow keys page the strip the way the web does.

## 6. Did the prototype expose a limitation in the retained web surface?

**Yes — exactly one. And it is additive, not a rewrite.**

The Viewer owns its index and offers no imperative way to set it. `goTo` is an internal closure;
the props expose `initialIndex` (mount-time only) and `onPositionChange` (outbound only). The
prop's own comment is explicit:

> Mount-time frame entry — the global grid lands the stage on the tapped frame instead of the
> first photograph. **Applied once; later navigation belongs to the viewer.**

A native shell needs to drive the stage from its own menu (Gallery ▸ Next / Previous
Photograph) and to show a position readout. The first version of the prototype asked for a target
by synthesising the keys a person would press: `Home`, then N × `ArrowRight`.

**That landed on the wrong photograph.** Asking for photograph 30:

```
asked for photograph 30, landed on index 54
```

The cause is V1: in strip mode `ArrowRight` is `advanceStripByViewport` — a viewport gesture, not
a single step. So *"Home, then N × ArrowRight"* walks N viewports forward and stops wherever the
strip's bounds put it.

### The seam

The Viewer now takes an optional **handle** on its own navigation. The shell asks the Viewer to
move; it never sets the index. The web never passes one, so the web is untouched.

```ts
/** A native shell's handle on the stage: it asks the Viewer to move, it
 *  never sets the index. Under Tauri — and on the web — nothing passes it
 *  and the viewer behaves exactly as it always has. */
navigationRef?: { current: { goTo(index: number): void } | null }
```

It has to be a handle, and not a request carried in a prop. That is not a preference — it is how
the renderer works:

- `hono/jsx/dom`'s `render()` calls `container.replaceChildren(...)`. It **replaces** the container's
  children; it does not diff them.
- So a prop can only be delivered by a re-rendering, and a re-render **destroys the Viewer** and
  mounts a new one.
- A fresh viewer starts at its first frame with an unmeasured strip, and the strip's scroll then
  settles on the last frame rather than the one that was asked for.

Measured, on `main`'s first attempt at this seam (`navigationRequest`, a request carried in a prop):
the position trace showed `index=30` and then drifted to 35 and then to 54 — the same landing as
the synthesised keys, for the same reason one level deeper. A marker attribute set on the stage was
gone after the jump, which is the signature of a remount rather than a move.

So the request prop became a handle. Twelve lines, and the page keeps it current:

```tsx
// The shell's handle on the mounted viewer. It is refreshed on every
// render and cleared only on unmount, so the shell always moves the
// viewer that is on screen.
useEffect(() => {
  if (!navigationRef) return
  navigationRef.current = { goTo: (index: number) => goTo(index, true) }
  return () => { navigationRef.current = null }
})
```

and the shell's `goTo` is now that handle:

```
asked for photograph 30, landed on index 30
```

Everything that matters stays where it was: the plate cadence, the no-re-encode invariant, the
*"The End."* card and its rules, the single-image mode's fade sequence, the viewport paging of
the arrow keys. **Nothing here argues for reimplementing the viewer**, and the prototype does not
reimplement it — it adds one optional prop and a dozen lines.

`app/islands/Viewer.navigation.test.tsx` covers the seam: a request lands on the photograph it
names, a repeated index lands again, a viewer with no handle behaves exactly as the web always has.

### What the prototype did *not* need

Worth stating, because it is the reason the port is affordable:

- The retained Viewer rendered the user's originals, at their honest size, inside the native
  window, with no change to its rendering path.
- Its keyboard handling worked inside the WKWebView once the web view held the keyboard.
- Its strip paging, its end card, its chrome and its position reporting all carried over.
- The native shell needed **one** thing from the viewer that it did not have: a way to say
  "go to photograph N".

## 7. What a real port would look like

1. **The shell, natively.** `NSWindow` with traffic lights, a real menu bar (File ▸ Open Folder…
   ⌘O, View ▸ Refresh ⌘R, Gallery ▸ Next/Previous/Close), a status bar. **The window opens in its
   own Space** — the deliberate kiosk decision — with the View menu offering a way back to a
   window.
2. **Folder access through the system's own grant.** `NSOpenPanel` → security-scoped bookmark →
   `startAccessingSecurityScopedResource()`. The renderer never sees a path; the scheme handler
   serves only granted roots and refuses traversal.
3. **The viewer, retained.** The same `Viewer.tsx`, mounted **behind the curtain** the way the
   web is, with the curtain's assets shipped in the bundle, and with `allowFullscreen={false}` so
   the native window owns fullscreen.
4. **One additive seam** on the viewer — the navigation handle. **Done**, with a unit test at
   `app/islands/Viewer.navigation.test.tsx`.
5. **An error surface that is actually wired, and that tells the truth.** The scheme handler
   reports a photograph it could not serve, and says *which* kind of failure it was. This is S6,
   and it is the difference between an app and a screenshot.
6. **The web surface stays portable.** The web app gets no feature that requires persistence
   (invariant 7); the vault, offline, global view and P2P remain native-only.

## 8. Artefacts

| Path | What |
|---|---|
| `macos/ManoramaMac/` | The SwiftUI shell: `AppModel`, `ContentView`, `FolderStore`, `LocalGallery`, `LocalSchemeHandler`, `NativeBridge`, `ViewerWebView`, `ManoramaMacApp`, `Trace` |
| `desktop-shell/bridge.ts` | The page-side Tauri shim: `invoke`, `convertFileSrc` and the same-origin fetch wrapper, over the shell's channel |
| `desktop/lib/shell.ts` | The Library's side of that channel: the handles the shell drives the mounted viewer through |
| `vite.config.desktop-shell.ts` | The build root for the Library bundle the shell serves |
| `macos/BoundaryTests/` | The headless boundary harness (32 assertions) |
| `macos/Probes/` | `AXProbe.swift` and `WindowList.swift` — the Accessibility and screen-capture tools the live suite drives the app with |
| `scripts/build-macos.sh` | Builds the bundle, compiles the shell, assembles the `.app` |
| `scripts/test-macos-focus.sh` | The live boundary suite: one script, every boundary |

`desktop-viewer/` and `vite.config.viewer.ts` — the viewer-only bundle the first prototype shipped —
are **gone**. The shell hosts the Library now, and a second bundle that mounts the Viewer alone is
exactly the fork this work set out to avoid.

Run it:

```sh
bash scripts/build-macos.sh
bash scripts/test-macos-focus.sh            # the ETHIOPIA originals
bash scripts/test-macos-focus.sh /some/folder /tmp/a-copy-to-delete
```

The second argument is the folder the suite deletes to test error recovery. **It is deleted** —
never point it at anything you want to keep.

The headless harness on its own:

```sh
swiftc -O macos/ManoramaMac/LocalGallery.swift macos/ManoramaMac/FolderStore.swift \
  macos/ManoramaMac/LocalSchemeHandler.swift macos/ManoramaMac/Trace.swift \
  macos/BoundaryTests/BoundaryTests.swift macos/BoundaryTests/main.swift \
  -framework AppKit -framework WebKit -o /tmp/manorama-boundary && /tmp/manorama-boundary
```

Screenshots of the prototype are in `/tmp/manorama-mac-shots/`.

## 9. Open questions for the owner

- **Who owns `app/islands/Viewer.tsx`?** The additive seam is in place on this branch, but the
  file is large and shared. It needs a second pair of eyes, and it needs to land on a branch that
  the other desktop work can take without a conflict.
- **`main` has moved.** This branch is based on `2ddd7a8`; `main` is at `3620932` and carries
  another agent's uncommitted work in the shared checkout. The rebase is deliberately not done
  here.
- The fullscreen Space and the curtain are now the product's decisions, and the native shell
  matches both. The remaining shell work is the chrome: the real menu bar, the source list, the
  file picker, and the error surface — none of which touches the viewer.
