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
