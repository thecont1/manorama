# AGENTS.md

Instructions for coding agents working in this repository. Read this fully before your
first edit. If a task contradicts anything in "Invariants", stop and say so rather than
implementing it.

Companion documents:

- `README.md` — the system as it exists today. Authoritative on architecture.
- `docs/native-launch-plan.md` — the native/Shipaton plan. Authoritative on what we are building this week.
- `docs/manorama-operations.md` — gallery lifecycle, source-link rules, destructive-action policy.
- `VERIFICATION.md` — how to prove a change works.
- `docs/owner-setup-runbook.md` — Apple, RevenueCat, AdMob and Mac setup. Owner-only; agents cannot action it.

Issue tracker: GitHub issues #12–#43, tracked in #44.

---

## 1. What manorama is

A photography-first gallery publishing experience. Owners sign in with Dropbox and get
`manorama.xyz/{owner}/{gallery}`, fed by public Dropbox / Google Drive / iCloud / MEGA
share links. HonoX on a Cloudflare Worker, D1 for metadata, TypeScript throughout.

The product thesis, which explains most of the invariants below: **the viewing experience
is the product.** Not the dashboard, not the feed, not the social graph. Someone opened a
link to look at photographs. Everything else is in service of that, or it is out.

We are now taking it native — Capacitor for iOS, Tauri for desktop later — because a local
client can do things the web cannot: an encrypted on-device thumbnail vault, true offline
viewing, honest colour and refresh rate, peer-to-peer sharing.

---

## 2. Invariants

These are not preferences. A change that violates one is wrong regardless of how well it
works, and will be reverted.

1. **No image bytes or thumbnails are ever persisted server-side.** D1 holds metadata and
   ordered manifests. Provider media is proxied transiently through `/api/{provider}/*` and
   never written to D1, R2, KV, or the cache API as durable storage. Thumbnails exist only
   on the user's own device, encrypted.
2. **Never upscale, recompress, crop, stretch, or re-encode a source image.** A source short
   on pixels floats smaller and centred at its honest size. ICC profiles and C2PA manifests
   pass through as part of the image bytes. This is the reason the project exists; treat it
   as load-bearing.
3. **Ads obey the ten plate rules** in `docs/native-launch-plan.md` §B and issue #19,
   enforced by tests in #23 — one per gallery, at the midpoint, never first or last,
   suppressed below 8 items, never written into `imagesJson`, never counted in the position
   readout, never stretched or cropped, never tappable while the strip is in motion, never
   present for pro. The click-safety rule is a policy and account-suspension risk, not
   polish.
4. **No private Apple APIs.** Any WebKit `_features` frame-rate trick is an automatic App
   Store rejection. The supported lever is `CADisableMinimumFrameDurationOnPhone` in
   `Info.plist`.
5. **Tier changes go through `setUserTier`.** It writes the tier *and* promotes every
   unexpired pipeline gallery in one idempotent batch. A bare `tier` UPDATE leaves a paying
   account with locked galleries.
6. **No ambient surfaces.** No screensaver, widget, Lock Screen, StandBy, Apple TV, or
   Vision Pro work. manorama is a place people come to with the intent to look at
   photographs. Permanently out of scope unless the owner says otherwise.
7. **The web app receives no feature that requires persistence.** It is the portable
   version, and its forgetfulness is deliberate. Vault, offline, global view and P2P are
   native-only by design.
8. **`packages/core` stays platform-free.** No Worker bindings, no `window`, no Node
   built-ins, no Capacitor imports. Platform code belongs in `app/lib` (Worker) or
   `native/lib` (device).
9. **Deletion never touches the provider.** Removing a gallery removes a D1 row. Nothing at
   Dropbox, Drive, iCloud or MEGA is ever modified or deleted.
10. **Never invent procedures.** If `docs/manorama-operations.md` does not cover something,
    say so plainly.

---

## 3. Repository map

```
packages/core/       platform-free heart: ImageSource, GalleryMediaItem, BundledSource,
                     image-dims, image-staging (effectiveImageDpr + imageStageSize),
                     gallery-settings. Runs in Worker, web bundle, and native shells.
app/routes/          HonoX routes — landing, dashboard, gallery, quick-add catch-all, auth
app/islands/         Viewer.tsx (the stage), Admin.tsx (dashboard), VideoSlide.tsx
app/lib/             Worker-side: provider scanners, OAuth, session, repositories, OG cards.
                     Also thin re-export shims for everything moved to packages/core.
app/api.ts           Session-gated API surface
native/              (being built) client-only SPA entry, Capacitor shells, vault, billing, ads
migrations/          D1 migrations
*.playwright.ts      acceptance specs
```

Full table in `README.md` § Project layout.

---

## 4. Commands

```sh
bun install
bun run dev                  # vite dev server with the dev-seed plugin, port 5173
bunx tsc --noEmit            # typecheck — must be clean
bun test                     # unit tests — 449 passing at time of writing
bun run build                # client + worker production build
bunx playwright test         # acceptance suite; needs a seeded dev server
bun run vendo:check          # contract drift
```

Playwright needs the dev seed, which needs `MANORAMA_DEV_SOURCE_*` vars in `.env.local`:

```sh
GALLERY_URL=http://localhost:5173 GALLERY_VIDEO_SLUG=mixed-album bunx playwright test
```

The matrix is 375×812 touch, 1440×900 desktop, 2560×1440 wide. Fold work (#34) adds a
2-segment viewport.

**Definition of done for any change:** `bunx tsc --noEmit` clean, `bun test` green, and the
Playwright matrix green for anything touching the viewer. No exceptions during a deadline
week — a red suite on Friday is how a submission gets missed.

---

## 5. Model routing

We run two Sakana Fugu models. They share one OpenAI-compatible endpoint and differ by a
parameter, so switching is a one-line change.

| | `fugu-max` | `fugu-ultra-v2.0` |
|---|---|---|
| Use for | the default; most tickets | the short list below |
| Strengths | Terminal Bench 2.1, AutomationBench — shell, tooling, config, scaffolding | DeepSWE 74.3, Toolathon, Chartography 48.3 — deep multi-step reasoning, visual/structured data |
| Latency | faster | slower by design |
| Cost per 1M | $2 in / $6 out | $5 in / $30 out ($10/$45 over 272K context) |

**Default to `fugu-max`.** Most of this week is mechanical: Capacitor scaffolding, plugin
installs, plist edits, CSS, store metadata, spec writing. Paying 5× the output rate and
waiting longer for `npx cap sync` is the wrong trade.

**Use `fugu-ultra-v2.0` for these issues only:**

| Issue | Why it needs Ultra |
|---|---|
| #24, #25 | Vault crypto — AES-256-GCM, Keychain/Keystore handling, proving no plaintext temp file survives. Mistakes here are silent. |
| #19 | The plate composer touches `BundledSource` and needs the inert-while-moving state machine exactly right. Getting it wrong risks an AdMob suspension. |
| #13 | Lifting stage geometry out of `Viewer.tsx`, the largest island, with no behaviour change. |
| #33, #35 | Diptych and Duo geometry — sustained reasoning over visual and structured layout. |
| #20 | The `setUserTier` webhook seam, where an idempotency bug corrupts paying accounts. |

**Escalation rule.** If a `fugu-max` run fails the same ticket twice, stop and re-run it on
`fugu-ultra-v2.0` rather than attempting a third time. If Ultra also fails twice, open a
comment on the issue describing what was tried and stop — do not keep burning tokens on a
task that needs a human decision.

**Operational notes.**

- Use the pay-as-you-go **Token Plan**, not a monthly subscription. Consumption tokens are
  served at higher priority than monthly-plan tokens, and being deprioritised the night
  before submission would be self-inflicted.
- `fugu-ultra-v2.0` has a training cutoff of **2026-08-28**. It does not know about iPhone
  Duo, the Duo HIG (published 2026-09-09), or Xcode 27.1. **Paste the relevant guidance into
  context** for #33/#34/#35 — the citations are in `docs/native-launch-plan.md` §E.
- Ignore SWEFish when choosing between them. It is Sakana's internal benchmark and both
  models are claimed to top it against different peer groups.
- Neither Max nor Ultra lets you restrict which underlying models see your prompt; only base
  `fugu` allows opting models out. Do not paste production secrets, `HOST_API_JWT_SECRET`,
  provider keys, or real user gallery data into a prompt.

---

## 6. Working agreement

**One issue, one branch, one PR.** Branch from `main` as
`feat/<area>-<slug>` or `fix/<area>-<slug>`. Reference the issue number in the PR body.

**Lane discipline.** Each issue names the files it owns. Do not edit files owned by another
open issue — if you need a change there, say so in a comment instead of reaching across.
Concurrent agents editing `Viewer.tsx` is the most likely way this week goes wrong.

**Commits** follow the existing convention: `type(scope): imperative summary`, e.g.
`feat(viewer): add strip-mode decoded window`, `refactor(core): extract packages/core`.
Body explains why, not what. No agent attribution or tool signatures in commit messages.

**Scope.** Implement the issue and nothing else. No drive-by refactors, no dependency
upgrades, no reformatting, no "while I was in here". If you spot a real problem outside
scope, open an issue.

**Tests.** New behaviour ships with a test. Ad behaviour in particular is enforced by tests,
not convention (#23). Do not weaken or skip an existing test to make a change pass — if a
test is genuinely wrong, say so explicitly in the PR and explain why.

**Dependencies.** Prefer first-party Capacitor plugins, then actively maintained community
ones. Note that `@capacitor-community/admob` does **not** support native advanced ads; the
`AdFrame` interface in `packages/core/adframe.ts` exists so that gap can be filled later
without touching the viewer. Do not add a second Google Mobile Ads dependency — the plugin
already ships the SDK.

**Secrets.** Never commit them. Server-side secrets live in Worker bindings:
`HOST_API_JWT_SECRET`, `DROPBOX_APP_KEY`/`SECRET`, `GOOGLE_DRIVE_API_KEY`. Native builds
carry RevenueCat and AdMob public app IDs only.

**Comments** explain why a non-obvious decision was made. The existing codebase does this
well — match its voice: plain, specific, no cheerleading.

**Destructive actions.** Never run a remote D1 migration, a `wrangler deploy`, a force-push,
or a branch deletion. Prepare it and hand it over.

---

## 7. Deadline context

Submission target **Sat Sep 26 2026**; the app must be *released* before **Wed Sep 30,
11:45 PM PDT**. iOS is the only real target this week. Android is generated but unpolished,
purely so Galaxy Store stays available as break-glass.

Cut list, in order, if Friday arrives and the build is not submittable:
#35 → #21 → #27 → #31 → #28 → #32.

#22 (house fallback plate) was promoted out of the cut list on Sep 22: AdMob will not serve
normally until the app is published and store-linked, so without a house plate the slot is empty
in front of a reviewer, and Shipaton eligibility rests on the IAP (#18) rather than on ads.

Never cut: #14 #15 (shell) · #16 #18 #19 #23 (Shipaton eligibility and ad safety) ·
#22 (house plate) · #24 #25 #26 (vault and offline — the Guideline 4.2 defence) · #29 ·
#36 #37 #38 #40 (submission).

If you are ever unsure whether something belongs in this week's scope, it does not.
