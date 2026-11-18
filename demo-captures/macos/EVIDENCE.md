# macOS evidence notes

Six-state matrix (`01`–`06`) predates the G3 desktop-frost pass. The five
captures below are the interactive evidence for the `.desktop-paste` selector
change in this branch: the form frosted as a standalone card, and flat when it
lives inside the share sheet — in the normal state and again with macOS
"Reduce transparency" on (Tier 0).

| File | Surface | Mode |
| --- | --- | --- |
| `07-paste-panel-normal.png` | standalone `.desktop-paste` (welcome sign-in fallback) | normal — frosted card, rim + shadow |
| `07-paste-panel-tier0.png` | same | Reduce transparency on — solid fill, edge line, no backdrop-filter |
| `08-share-connecting-collapsed-normal.png` | `.desktop-share--sheet` connecting step | normal — shipping default: the paste fallback collapsed behind its disclosure |
| `08-share-connecting-normal.png` | `.desktop-share--sheet .desktop-paste` | normal — disclosure open: flat inner form inside the sheet card |
| `08-share-connecting-tier0.png` | same | Reduce transparency on — still flat, no double glass |

## Method

- A separate evidence app (`MANORAMA_MACOS_BUNDLE_ID=in.thecontrarian.manorama.evidence`,
  build dir `/tmp/manorama-evidence`) so the installed copy and its session
  were never touched. Re-signed ad hoc after each bundle swap; window captured
  on the active Space via cua-driver AX + `screencapture -l`.
- Standalone form: a `NODE_ENV=development` desktop-shell bundle — the sign-in
  paste fallback only renders when `import.meta.env.DEV` is true and there is
  no session. The welcome now carries the same full-width labelled provider
  buttons the native door uses (the retired three-icon row is gone).
- Connecting form: `.work/evidence/` fixture — the production `ShareFlow`
  mounted inside a `Sheet` at `presentation="sheet"`, driven by the same
  Connect click a user would make, with the two upload providers aliased to an
  inert stub so `connect()` stays pending and no OAuth/network side effect
  fires. Same class of evidence the iOS capture harness uses for states the
  shell cannot reach unaided.
- The collapsed shot is a production-mode build, which is how the connecting
  step ships — the disclosure stays closed and the sheet only says the result
  arrives automatically. The expanded shots are a dev build (`import.meta.env.DEV`
  keeps the disclosure open at render); opening it is the one gesture needed
  where the redirect cannot arrive.
- Tier 0: real `Reduce transparency` system setting — three domains must flip
  for WKWebView's media query to see it: `com.apple.universalaccess
  reduceTransparency`, `com.apple.Accessibility ReduceTransparencyEnabled`,
  and the same key in the ByHost domain (`defaults -currentHost write`). All
  restored to 0 after capture. Verified by pixel diff (welcome 12.29, sheet
  8.76 mean abs) — the earlier global-domain-only write produced
  byte-identical captures, the false evidence the diff exists to catch.
