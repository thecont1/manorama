# manorama — repository instructions

Read `AGENTS.md` first; its invariants override everything below.

## Design Context

### Users

Two audiences with strictly different needs, and the product keeps them in separate layers:

- **Owners** — photographers who already share a folder on Dropbox, Google Drive, iCloud, or MEGA. They sign in, paste the link, and get `manorama.xyz/{owner}/{gallery}`. They manage (reorder, caption, refresh, share, delete, plan, vault) on the Galleries and Upkeep surfaces. Their context is purposeful maintenance — they arrived to do a job.
- **Visitors** — people who received a link and want to look at photographs. They may be signed out entirely. They get only the Looking layer: no Library, no Details, no plan or storage UI, ever. Their context is unhurried viewing, often on a phone, often once.

The product thesis, which outranks every styling preference: **the viewing experience is the product.** Someone opened a link to look at photographs. The app recedes while the pictures do their work; chrome appears on intent and hides after three idle seconds.

### Brand Personality

**Quiet, honest, photographic** (owner-confirmed). The interface behaves like a gallery wall — it does not perform, sell, or explain itself while a person is looking at pictures.

- Emotional goals: calm and unhurried on the Looking layer; confident and explicit on the Upkeep layer. Never urgency, never delight for its own sake.
- Honesty is structural, not tonal: images are never cropped, stretched, upscaled, recompressed, or rounded — a source short on pixels floats smaller and centred at its honest size. The strip "ends honestly" with a "The End." card. Progress bars are indeterminate rather than fake percentages. Copy names the real consequence of an action.
- Voice: one-word viewer chrome labels (`Display`, `Info`, `Details`); factual, quiet prose elsewhere; canonical labels in `docs/copy-labels.md`; no marketing voice inside the app — even on Welcome the pitch is one sentence.
- References (owner-confirmed): the **physical gallery / museum** is the true reference — art is sacred, walls are silent, labels are small and temporary. Secondary: **native platform apps** — quiet platform-native utility, correct safe areas, OS share sheets instead of bespoke ones.

### Aesthetic Direction

"True-black flat" visual system — elevation by lightness alone, no borders or shadows at rest (only sheets and dialogs cast shadows), no gradients, no hairlines, no floating cards.

- **Dark owner palette:** ground `#0a0a0a`, surface `#161616`, raised `#262626`, active `#303030`, rule `#1d1d1d`; ink `#f3f0e8` (warm cream), secondary `#b8b4ab`, meta `#98948c`; destructive `#f0687a`.
- **Light owner theme** (`html.light`): ground `#f3f0e8`, surface `#e9e5dc`, raised `#ddd8cd`; ink `#171715`; destructive `#b3261e`. Both owner themes ship; the viewer never follows `html.light` — viewer chrome and sheets stay dark via `.m-dark`, and the viewer's own Canvas (Black / Dark / Light) governs the stage.
- **One data hue:** `#fc0fc0` (shocking pink) — progress, plan/storage meters, the picked-up photograph in Reorder, the picker matrix highlight. Never on buttons, tabs, navigation, or as the sole carrier of state (light mode pairs it with an ink outline). Theme-red is reserved for destructive actions only.
- **Type:** Bricolage Grotesque (application), Manrope (marketing/legacy base), DM Mono (metadata voice), Playfair (editorial/legal). All bundled in `public/fonts` — no remote font requests. Titles 28/700, sections 17/650, body 16, meta 13; tabular figures; `font-synthesis: none`.
- **Shape:** buttons and segmented controls are full pills (`--m-pill: 999px`); panels 14px, sheets 22px; photographs keep square corners always. Primary action is neutral inversion — cream pill with black text (dark) — one per screen.
- **Motion:** feedback only — press states, sheet rise, chrome fade (`--m-ease: cubic-bezier(.22,1,.36,1)`). No entrances, no scroll reveals, no decorative animation. `prefers-reduced-motion` collapses to opacity-only or instant swaps. The approved exceptions: the curtain dissolve (350ms text fade + 1100ms blur veil), the 750ms Rewind glide, and crossfades that hide image decode.
- **Tokens:** shared `--m-*` custom properties in `app/styles.css` scoped behind `.m-owner` / `.m-dark`; 44px minimum touch targets (`--m-touch`), 56px action rows, 52px top bar, logo 140×47px centred in that bar everywhere it appears.
- **Anti-references (owner-confirmed):** social feeds, asset managers, and generic photo grids (documented) plus **SaaS dashboards** (no metric tiles, no sales chrome), **portfolio site builders** (not Squarespace/Format template pages), and **stock photo sites** (no infinite masonry discovery).

### Design Principles

1. **Photographs are the only content that matters.** No control may sit on a photograph; arrows get their own reserved bar, chrome overlays are temporary and few, and a pixel-short source floats at its honest size rather than stretching. Square corners, no rounding, no shadow, no crop, never upscale — anywhere in the app, thumbnails included.
2. **Three layers, kept apart.** Looking is sacred (photographs and nothing else — no brand, plan, storage, or editing). Galleries is one task per screen. Upkeep is explicit and confident, reached on purpose, never shown in passing. Owner tools never appear inside the viewer apart from the one `Details` word.
3. **Restraint through subtraction.** Fewer elements per screen; hierarchy by scale, spacing and typography rather than decoration. One primary action per screen, one ··· menu per card, one canonical label per job. Empty states get one sentence and the same action — no illustrations, no feature tours.
4. **Feedback, not performance.** Motion acknowledges input or hides a transition; it never announces the interface itself. Reduced-motion support is part of the definition of done, not a fallback.
5. **Accessibility as AA baseline (owner-confirmed).** Every text tier passes 4.5:1 on its actual surface; pink never carries state alone; every interactive target reaches 44×44 in touch contexts; focus rings, SR-only text and live-region announcements ship with the feature.

## Working notes

- **Source of truth:** `AGENTS.md` invariants override everything; `docs/manorama-redesign-megaplan.md` is the owner-approved plan of record; `docs/manorama-redesign-decisions.md` and `docs/manorama-taste-review.md` hold the settled design decisions and known drift tickets.
- **Copy:** check `docs/copy-labels.md` before writing any label — one canonical label per job across web, native, and macOS; anything not listed as an exception is a bug.
- **Scope discipline:** no drive-by restyles. If a surface visibly violates this context but is outside the current issue, file it rather than fixing it in passing.
