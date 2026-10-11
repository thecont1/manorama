# macOS Catalogue parity — review evidence

The macOS catalogue rebuilt on the shared web/iOS admin workbench: one photographic
list across the page, the account behind a single labelled tab on the left edge that
opens a slide-out pane, and the dark/light switch inside that pane.

## These are browser captures, not native screenshots

They come from `bunx playwright test` driving the desktop SPA in a browser, with the
Tauri IPC stubbed (`desktop-admin-fixture.ts`) so the real island runs its real launch
path. They are **not** captures of a built `manorama.app`, and they are deliberately not
stored under `demo-captures/macos/`, which is reserved for evidence from freshly built
bundles. Use these to review layout and behaviour; use the native matrix before a
submission.

`webkit` is the engine the macOS webview ships (WKWebView); `chromium` is a second
opinion. WebKit is given all three window sizes, Chromium the app's own window.

## The matrix

| File | Window | Theme | State |
|---|---|---|---|
| `webkit-window-1280x840-{dark,light}-catalogue.png` | 1280×840 (the app's window) | dark, light | workbench, pane shut |
| `webkit-window-1280x840-{dark,light}-pane.png` | 1280×840 | dark, light | account pane open |
| `webkit-window-1280x840-light-stage.png` | 1280×840 | chosen light, stage dark | a photograph open behind the curtain |
| `webkit-wide-1440x900-{dark,light}-{catalogue,pane}.png` | 1440×900 | dark, light | as above |
| `webkit-minimum-760x620-{dark,light}-{catalogue,pane}.png` | 760×620 (the app's floor) | dark, light | headers stacked |
| `chromium-window-1280x840-{dark,light}-{catalogue,pane}.png`, `…-light-stage.png` | 1280×840 | dark, light | second engine |

## How to reproduce

```sh
# in the checkout, with deps installed
bunx vite --config vite.config.desktop.ts --port 5176 --strictPort --host 127.0.0.1
DESKTOP_URL=http://127.0.0.1:5176 bunx playwright test desktop-catalogue.playwright.ts
```

`theme-persistence.playwright.ts` additionally drives the **web dashboard**, so it needs
the web dev server and its seed as well:

```sh
bun run dev                                                  # 5173, needs .env.local
GALLERY_URL=http://127.0.0.1:5173 DESKTOP_URL=http://127.0.0.1:5176 \
  bunx playwright test theme-persistence.playwright.ts
```

Run these from a normal checkout. From a git worktree you must also pass a run config
(`-c <config>`), because the repository's `playwright.config.ts` ignores
`**/.worktrees/**` so a nested checkout's runner is never collected twice.

The fixture is the owner's own photographs under `/Users/home/Pictures`, read from disk
and served to the browser through a route interception — never copied, resized or
re-encoded, so the measurements below are taken against the real files. (The albums under
Dropbox `CloudStorage` are dataless placeholders on this machine: 0 bytes on disk, `sips`
reports `<nil>`.) The gallery title is the one `galleryTitleForRoot` derives from that
folder. A second, synthetic gallery on a memory card covers the card source.

## What the suite asserts

- **Shell readiness** — `[data-admin-ready="true"]` appears only once the private
  catalogue and session files have been read.
- **Workbench arrangement** — welcome copy and the local-source picker as the two halves
  of the top row (or stacked below 820px), `Your galleries` beneath both.
- **The rail** — the originals in one row: one height (`clamp(96px, 16dvh, 208px)`), width
  from each source's own aspect ratio (within 2%), zero gaps (within 1.5px), the first
  frame outlined `3px rgb(252, 15, 192)`, a genuinely scrollable horizontal travel, and no
  page-level horizontal overflow.
- **The account surface's vocabulary** — `Welcome to manorama.xyz.`, `You are a Pro User.`
  and `N galleries on this Mac.`, the same sentences the web dashboard and iOS panes use,
  plus the sync state and the fact that the launch really called the account's seam.
- **The tab** — left edge (x ≤ 1), vertically centred, at least 44px wide, `aria-expanded`
  tracking the pane.
- **The pane** — opens from the tab, focus lands inside and loops under Tab, Escape and a
  backdrop click close it and return the caret to the tab, text contrast ≥ 4.5:1 in both
  themes, and no horizontal overflow inside the panel.
- **Theme** — the switch flips `html.light` and writes `manorama:theme`; a stored `light`
  is applied at launch; the stage is held dark while a photograph is open and the choice
  returns on the way back.
- **Across the two bundles** (`theme-persistence.playwright.ts`) — the web dashboard and
  the Mac shell persist their own choice through a reload, answer to the identical key,
  class and label, and do not leak a theme from one origin to the other.
- No page errors.

## Related sources

- Approved web admin: `app/islands/Admin.tsx`, `app/styles.css` (`.admin-page--selector`,
  `.admin-overview`, `.admin-edge-tab`, `.admin-drawer*`), evidence in
  `demo-captures/web/admin-appearance/`.
- Approved iOS admin: `native/islands/GalleryList.tsx`, `demo-captures/ios/05-account-admin.png`.
- Plan: `outputs/duo-and-macos-plan-2026-10-11.md` — "Bring the desktop catalogue's account
  controls into the same visual family: theme-aware material, fitted branding, and the
  optional left-edge pane."