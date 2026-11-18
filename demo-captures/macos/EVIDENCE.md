# macOS evidence notes

Six-state matrix (`01`–`06`) predates the G3 desktop-frost pass. The four
captures below are the interactive evidence for the `.desktop-paste` selector
change in this branch: the form frosted as a standalone card, and flat when it
lives inside the share sheet — in the normal state and again with macOS
"Reduce transparency" on (Tier 0).

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
