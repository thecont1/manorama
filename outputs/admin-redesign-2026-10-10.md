# Admin redesign, evidence refresh, and repo tidy-up

10 October 2026 · branch `fix/native-capture-admin-parity`

## 1. The terminal connection

The failure was a closed socket, not a broken machine: `/tmp/manus-native-*/socket`, owned by
Manus Studio (`im.manus.desktop`), which was running with zero windows. Rebinding the
workspace and a Sandbox round-trip both failed to recreate it. **Restarting Manus Studio
restored terminal execution**, and every command since has run normally.

## 2. What changed

### iOS account screen

The old header was one run-on paragraph that mixed the greeting, the membership and a
sign-out button. It now reads:

> Hello, **Mahesh Shantaram**. Welcome to manorama.xyz.
> You are a Free User. You have used 1 of your 3 gallery limit.

The wordmark and a 44px hamburger share one row. The account actions live in a drawer with a
focus trap, Esc dismissal, backdrop dismissal and focus restored to the trigger. Tier and
counts stay dynamic (`Pro User` for paid), and the greeting no longer invents a count while
the account list is still loading.

Gallery rows now wear the web dashboard's type: the brand face for the title at 24px (22px on
a phone), the subtitle on its own line, and only the public address truncating — a long title
wraps instead of losing words.

### Web dashboard

The standing left column is gone. The dashboard is one column: a quiet top bar carries the
wordmark, "Your galleries" and the account button; the account — greeting, editable address,
sign-in methods, deletion, theme action and Sign out — waits in a labelled slide-out pane.
The pane **ships in the server-rendered HTML and is hidden rather than absent**, so the
dashboard still works without JavaScript. The floating sunglasses toggle is replaced by a
labelled action inside the pane.

With the full width available, the **web Photo Editor is one horizontal row per gallery**, as
you approved: the frame scrolls sideways, and the pan math, wheel handler and reorder drop
target were changed to follow the column rather than the row. The Photo Picker and Global View
remain vertical matrices, and the scoped exception is recorded in `AGENTS.md`.

## 3. Verification

| Check | Result |
| --- | --- |
| `bunx tsc --noEmit` | clean |
| `bun run test:unit` | **1057 pass / 0 fail**, 83 files |
| iPhone matrix | rebuilt from fresh bundles, 6 states, 1284×2778 |
| iPad matrix | rebuilt from fresh bundles, 6 states |
| Web dashboard in a browser | **not verified this run** — see below |

Four tests moved with the redesign rather than being weakened: the two greeting assertions now
expect the approved wording, the two sign-out tests open the menu before finding Sign out, and
the theme-control test asserts the labelled pane instead of the removed floating toggle. A new
guard asserts the account menu exists and the drawer is closed until asked for.

## 4. Open items

**Web admin browser evidence.** The web capture script timed out partway (`goto` at
`/.dev-seed/login`) and produced only partial iPhone-width Chromium frames in
`demo-captures/web/`; those are uncommitted and should not be treated as evidence. The
dashboard is covered by the server-rendered tests above, but it has not been photographed in a
browser at 1440×900 or 2560×1440.

**iPad canvas.** The new iPad screenshots carry correct landscape app pixels inside the
simulator's **portrait** canvas (2064×2752). The staged orientation lock did not take effect in
this run, so the committed 2752×2064 evidence still needs to be reproduced.

**macOS.** No native macOS build exists to capture: the Tauri shell was removed from the repo.
The desktop surface remains a web build (`desktop/`, `vite.config.desktop.ts`), so the macOS
row of the six-state matrix could not be produced.

## 5. Commits

| Commit | Contents |
| --- | --- |
| `9da19a2` | `fix(capture)` — reliable harness: readiness signals, stale-report rejection, bounded provider fetches, owned server and restored config |
| `87b74e2` | `feat(native)` — account menu, approved greeting, web-matched gallery type |
| `5e8495a` | `feat(admin)` — slide-out account pane, single-row Photo Editor, `AGENTS.md` exception |
| `b9718cd` | `docs(captures)` — refreshed iPhone and iPad matrices |
| `245549e` | `chore` — ignore the local MCP result cache |

Left untracked on purpose: `outputs/` (task deliverables), `demo-captures/web/` (partial,
unverified), and three one-off `.work/` scripts used for the edits.