# Web evidence, iPad canvas, and the localhost sign-in failure

11 October 2026 · branch `fix/native-capture-admin-parity`

## 1. Why the capture hung for eighty minutes

Two unbounded awaits, and no diagnostics to show for it.

- `page.goto('/.dev-seed/login', { waitUntil: 'load' })`. That route answers only
  after the dev-seed scan finishes, so `load` can simply never fire.
- `await page.evaluate(() => document.fonts.ready)`. That promise **never
  settles** while a font request is in flight. There is no timeout on it.
- The report was written once, at the end — so the hang produced nothing to read.

A third cause sat outside the script: the dev server was started detached with
`nohup`, so it was **killed between commands**. Nothing was listening when the
script came back, which is why the first `goto` timed out and why `curl` showed
an empty port.

**Fixed.** Every await is bounded; the report is rewritten after every state; the
process carries its own budget because macOS has no `timeout(1)`; and the app now
runs as a resident service on port 5175.

Three further flakiness causes, each fixed:

| Cause | Fix |
| --- | --- |
| Server-rendered markup exists before the island hydrates, so a click lands on nothing | every interaction retries until it can see its own effect |
| Vite compiles a route's SSR graph on first request; a cold compile answers empty (`ERR_EMPTY_RESPONSE`) | routes are warmed once per engine, and the gallery navigation retries |
| The curtain is `role="button"` whose own content intercepts pointers | click its outer margin with `force`, in a retry loop |

One more was a genuine behavioural discovery: **pressing Enter on the curtain
dismisses it but never sets `gallery-entered`**, and the picker's `g` shortcut
checks exactly that class. Clicking sets it. That is why the picker opened for
one and not the other.

## 2. The web evidence matrix

`demo-captures/web/` — **20 of 24 states captured**, every file from a single run.
The authoritative account is `demo-captures/web/matrix-report.json`:

| State | phone | tablet | desktop |
| --- | --- | --- | --- |
| 01 landing | yes | yes | yes |
| 02 gallery curtain | yes | yes | yes |
| 03 first image | yes | yes | yes |
| 04 controls modal | yes | yes | yes |
| 05 account admin | yes | yes | yes |
| 05 account pane (open) | — | — | yes |
| 05 editor row (pane closed) | yes | yes | yes |
| 06 photo picker | — | — | yes |

Four states are missing, all of them a click that had not yet hydrated when it
was attempted: the pane at phone and tablet width, and the picker at phone and
tablet width. These are timing failures, not product failures — each of them
captured on another width in the same run.

WebKit is opt-in (`WEB_CAPTURE_ENGINES=webkit`): it hung on launch here and cost
the eighty minutes, so Chromium alone produces the matrix.

## 3. The iPad canvas cannot be landscape-locked on this runtime

The screenshots come out **2064×2752 portrait**, with the app rendered landscape
inside them. Measured: the app occupies a band **545 px tall and 2064 px wide** —
about 272 points — so the app is not rendering at 2752×2064 at all.

There is no command-line escape:

- `xcrun simctl ui` supports **appearance, contrast and the like — there is no
  orientation verb**, and the Simulator cannot be rotated from `simctl`.
- The staged `Info.plist` does set a landscape-only mask and
  `UIRequiresFullScreen`, but on **iPadOS 26/27 that key is ignored**, so the app
  runs in a resizable window instead of taking the screen.
- Only iOS 26.5, 27.0 and 27.1 runtimes are installed — there is no older
  runtime where the app would go full screen.

The committed 2752×2064 iPad evidence therefore cannot be reproduced on this
machine as it stands. The two honest routes are to **rotate the simulator by hand
in the Simulator GUI** before a run, or to **install an older iPadOS runtime**
where full-screen landscape still happens. I did not fake the canvas.

## 4. Why sign-in fails on localhost

**`bun run dev` provides no D1 database binding, and the identity table lives in
D1.**

Evidence, reproduced live:

- `/.dev-seed/login` → `302` with a valid `manorama_session` cookie.
- `GET /api/account/identities` with that cookie → **`{"error":"The sign-in
  methods are temporarily unavailable"}`** (`503`).
- `GET /auth/dropbox` → `302` to `https://www.dropbox.com/oauth2/authorize?...`
  — the flow starts perfectly well.

So the provider round-trip begins and then dies on the **callback**, where
`app/lib/identity-repository.ts` requires `env.DB`:

```ts
const requireDb = (env?: UserRepositoryEnv): D1Database => {
  if (!env?.DB) throw new IdentityStorageUnavailableError('Identity storage is not available')
```

`app/lib/oauth-flow.ts` catches exactly that and answers **“Sign-in is
temporarily unavailable”** (503).

**What to do:** locally, sign in through `http://localhost:5173/.dev-seed/login`,
which mints the same session without touching D1. A real OAuth round-trip needs a
runtime that has D1 — `wrangler dev` against a local database, or a deployed
environment. This is not a bug in the sign-in code.

## 5. Commits

| Commit | Contents |
| --- | --- |
| `82be1db` | `test(capture)` — the web matrix, and the bounds that stop it hanging |
| (this run) | `test(capture)` — curtain lift by click; 20 fresh shots, stale files deleted |