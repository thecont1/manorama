# macOS evidence notes

## Density revision — 21 November 2026

The owner selected a 256 CSS-pixel repeat of the unchanged 1024-unit vector
artwork. The matrix below shows the earlier 1024 CSS-pixel presentation and is
retained as historical evidence, not current proof of the denser texture.
Fresh six-state native captures are required for the 256px revision before commit.
No old screenshot is being resized or altered to simulate that revision.

## Historical gallery-ground matrix — 20 November 2026, 1024px repeat

The six-state `01`–`06` matrix has been refreshed from a freshly built native
macOS app, with the Dark set here and Light counterparts under `light/`.
All twelve PNGs are 2880×1800, captured from a 1440×900 logical window and
reviewed. They are actual native pixels, not browser mockups or reconstructed
layouts. Promotion and preview copies were checked byte-for-byte; no screenshot
or original photograph was cropped, resized, re-encoded or annotated.

| File | Current surface |
| --- | --- |
| `01-opening-screen.png` | Genuine Blank sign-in opening |
| `02-gallery-curtain.png` | Local Italy gallery curtain |
| `03-first-image-hover.png` | First photograph, native Library and position/Settings/Info controls visibly present |
| `04-controls-popover.png` | Gallery Settings with the matching Dark/Light Canvas radio selected |
| `05-account-admin.png` | Genuine signed-in Visionary account surface |
| `06-folder-grid.png` | Native picker: 28 originals, aspect-ratio matrix, fixed row height, zero gaps, shocking-pink active photograph |

Opening and account are independent of gallery palette; the same genuine
`01` and `05` captures are byte-copied into each set. Dark `03` comes from
`macos-resume-captures/03-first-image-hover.png`; Light `03` uses the first
full-window burst candidate, whose actual pixels show the native controls.
An earlier working note incorrectly marked those saved files control-less;
direct final file review supersedes that note. Later burst frames are not used.

The app is the distinct `in.thecontrarian.manorama.galleryground.resume`
bundle built through `scripts/build-macos.sh` into
`.work/gallery-ground-integration/macos-resume-build/` (SDK27.0, minimum macOS15).
It includes the working gallery-ground integration on base HEAD `3aff26ac`,
not only the committed tree. Both `--store` and `--config` point to isolated
container storage. Finder copied only the owner-authorized session fixture;
token contents were never read or displayed. The existing isolated-config
forwarding guard blocked non-GET/HEAD/OPTIONS API requests. The supported native
folder picker legitimately granted access to the owner's Italy originals;
no protected-file CLI cloning or shell workaround was used.

Capture used `screencapture -x -o -l <actual Library windowID>` while the native
window was active. The subsequent device restart interrupted further native UI
automation, but the twelve selected captures were already complete. The isolated
app is stopped, Computer Use control is released, and the owner removed the copied
session in Finder after macOS blocked CLI deletion; absence was checked. The
installed application, original session/catalogue and original photographs were
not modified by this task. Full viewer browser acceptance is still red/incomplete;
these native screenshots are visual evidence, not a substitute for that gate.

## Historical frost evidence

The four captures below are the earlier interactive evidence for the
`.desktop-paste` selector change: the form frosted as a standalone card, and flat
inside the share sheet — normally and with "Reduce transparency" on (Tier 0).

| File | Surface | Mode |
| --- | --- | --- |
| `07-paste-panel-normal.png` | standalone `.desktop-paste` (welcome sign-in fallback) | normal — frosted card, rim + shadow |
| `07-paste-panel-tier0.png` | same | Reduce transparency on — solid fill, edge line, no backdrop-filter |
| `08-share-connecting-normal.png` | `.desktop-share--sheet .desktop-paste` (publish connecting step) | normal — flat inner form inside the sheet card |
| `08-share-connecting-tier0.png` | same | Reduce transparency on — still flat, no double glass |

Window-mode evidence for the Phase 2 contract (windowed by default,
opt-in fullscreen via Settings, `Settings` as its own scene):

| File | Surface | Mode |
| --- | --- | --- |
| `09-settings-window.png` | `manorama Settings` scene | single "Open in full screen" toggle, off — the whole pane |
| `10-library-windowed.png` | Library window | `--windowed` launch — 1280×840 default frame, traffic lights, welcome |
| `11-library-fullscreen.png` | Library window | `openInFullScreen` on, launch without `--windowed` — own Space |

## Method

- A separate evidence app (`MANORAMA_MACOS_BUNDLE_ID=in.thecontrarian.manorama.evidence`,
  build dir `/tmp/manorama-evidence`) so the installed copy and its session
  were never touched. Re-signed ad hoc after each bundle swap; window captured
  on the active Space via cua-driver AX + screenshot.
- Standalone form: a `NODE_ENV=development` desktop-shell bundle — the sign-in
  paste fallback only renders when `import.meta.env.DEV` is true and there is
  no session. This is the form's only surface; the screen around it is the
  legacy welcome and is tracked separately (#248).
- Connecting form: `.work/evidence/` fixture — the production `ShareFlow`
  mounted inside a `Sheet` at `presentation="sheet"`, driven by the same
  Connect click a user would make, with the two upload providers aliased to an
  inert stub so `connect()` stays pending and no OAuth/network side effect
  fires. Same class of evidence the iOS capture harness uses for states the
  shell cannot reach unaided.
- Tier 0: real `Reduce transparency` system setting across three stores,
  saved and restored by original value — never a blanket `write 0`. Before
  capture, record each key's current value AND whether it exists (a missing
  key is a state too: `defaults read` exits non-zero on it):

    defaults read com.apple.universalaccess reduceTransparency
    defaults read com.apple.Accessibility ReduceTransparencyEnabled
    defaults -currentHost read com.apple.Accessibility ReduceTransparencyEnabled

  Write `true` to all three — the currentHost store is the one that
  actually propagates to the WKWebView media query — relaunch, capture.
  Afterwards, and on failure alike (wrap the capture in a `trap`), write
  each saved value back and `defaults delete` every key that did not exist.
  Verified by pixel diff: the earlier single-domain write produced
  byte-identical captures, which is exactly the class of false evidence the
  diff guards against.

- Window-mode set (`09`–`11`): evidence app
  `MANORAMA_MACOS_BUNDLE_ID=in.thecontrarian.manorama.desktop.evidence`,
  build dir `/tmp/mano-evidence-build`, launched as
  `open -n <app> --args --seed-folder <container>/seed-ETHIOPIA --store <container>/evidence-store/folders.json --config <container>/evidence-config [--windowed]`.
  The seed folder is an APFS clone *inside* the app's container — the
  sandbox grants no access to an arbitrary outside path. `--store` and
  `--config` together isolate session/catalogue state; a distinct bundle id
  alone does not. Fullscreen arm: `defaults write <bid> openInFullScreen -bool true`,
  then launch without `--windowed`; remove the key afterwards.
- Capturing a fullscreen Space headlessly: `screencapture` of the display
  shows whichever Space is frontmost, not necessarily the app's —
  `screencapture -l <windowID>` (id via the window list probe) captures the
  window regardless of which Space is active. The 1728×1084 content window
  plus its 1728×32 shell strip at y=33 is the fullscreen pair; a windowed
  launch at the saved default is 1280×840 with traffic lights.
- Note for the suite: a launch that had a prior fullscreen window record
  could still land on a Space once even under `--windowed` with the pref
  absent — the restoration correction raced the Space migration rather
  than blocking it. Reproduced once; tracked separately.
