# Prototype reference captures

Screenshots of `docs/redesign-prototype/` (the design prototype), captured
28 Oct 2026 for the P0 baseline. **These are reference images of the prototype
— not evidence of the real app.** The prototype's presentation frame, fake
status bar, sample accounts, simulated scans and synthetic content are not
application requirements (megaplan §1).

- `390x844/` and `375x812/` — one PNG per screen, `#app` element only (the
  proposal frame and side notes are excluded; at phone widths the device is
  full-screen anyway). Captured at deviceScaleFactor 2.
- Screens: welcome, library, add (sheet), viewer-curtain, viewer,
  viewer-chrome, display, info, details, reorder, settings, visionary
  (sheet), privacy.
- Driven via the prototype's own `data-go` / `data-open` buttons and hash
  navigation; chrome was woken by tapping the stage, sheets closed via the
  scrim.

Regenerate with `bun scripts/prototype-capture.mjs` (temporary P0 tool;
serves the folder on an ephemeral port and uses Playwright Chromium).
