# Optical Marginalia — manorama gallery ground

An original low-contrast photographic field: cameras, optical diagrams, film ribbons, contact sheets and darkroom objects, interspersed with small glints, grains and focus marks. The 24 hand-authored motifs are a creative departure from the supplied general-doodle reference. No drawing was traced and no photograph was edited.

**Dark and Light share identical placements and path coordinates.** Only background and stroke colors change. Both SVG tiles repeat seamlessly on all four edges. The PNGs are sampled directly from the SVG, not upscaled from a smaller raster.

## Included files

| File | Purpose |
|---|---|
| `gallery-ground-dark.svg`, `gallery-ground-light.svg` | Standalone exports — editable, resolution-independent repeating tiles; preferred for gallery use |
| `gallery-ground-dark.png`, `gallery-ground-light.png` | Standalone exports — 2048 × 2048 raster tiles |
| `gallery-ground-dark.project.json`, `gallery-ground-light.project.json` | Standalone exports — complete exact configurations, motif library, placements, diagnostics and engine version; import into the companion **Gallery ground** tool to reopen the composition |
| `gallery-ground-dark-repeat.png`, `gallery-ground-light-repeat.png` | 4096 × 4096 previews of a 3 × 3 repeat, not the production tile |
| `dark-light-preview.png` | Dark-left / Light-right comparison, downsampled from the generated tiles |
| `motif-library.json` | All 24 original normalized vector motifs and their briefs/envelopes; reusable with new seeds |
| `contact-sheet.svg`, `contact-sheet.png` | All motifs with readable names, IDs and tiers |
| `quality-report.json`, `optimisation-report.json` | Final hard-constraint status and deterministic before/after heuristic metrics |
| `release-validation.json`, `profile-report.json` | Exact exported-file checks and nine measured seed/density runs |
| `verification.md` | Test outcomes, visual review and outstanding external acceptance |
| `checksums.sha256` | SHA-256 hashes of bundle files, excluding this checksum file itself |

App maintainers: `docs/gallery-ground.md` records the approved app artwork, its frozen source, and how the baked export is configured inside manorama — consult it before touching `app/assets/gallery-ground.ts` or the canvas tiles.

## Exact recipe

| Setting | Value |
|---|---|
| Theme | Camera and photography — optical marginalia |
| Engine | 0.1.0 |
| Seed | 1843 |
| Logical tile | 1024 × 1024 |
| Density | Medium; 60 of 60 placements |
| Motifs | 6 large, 12 medium, 6 small |
| Stroke | 2px, round caps and joins |
| Scale range | 0.85–1.15 |
| Minimum gap | 10px plus stroke clearance |
| Attempts | At most 200 per requested placement; 12,000 total |
| Optimisation | At most 120 steps; 35 valid improving changes accepted |
| Dark | Background `#101010`, stroke `#292929` |
| Light | Background `#e9e5dc`, stroke `#c9c5bc` |
| Provenance | Original hand-authored vectors, 0 live model outputs |

Exact geometry checks report zero overlaps, including periodic neighbors and each motif’s self-copies. The optimizer’s largest-empty-distance estimate moved from 288 to 224 logical pixels; occupied-density variance from 0.0390 to 0.0259. These are coarse grid diagnostics, not aesthetic guarantees or exact ink coverage. The 4096px repeat previews distribute three tiles over a non-integer cell width; the **native-resolution** 3 × 3 test separately proves all nine raster cells are pixel-identical to the tile.

Use the SVG for resolution-independent gallery backgrounds. If using the PNG, do not render it above its intrinsic dimensions, including the display’s device-pixel ratio. The intended logical repeat size is 1024px; changing that size deliberately changes the apparent motif scale. This guide prepares assets only: no manorama integration/deployment procedure is asserted or actioned. Owner review behind actual photographs remains the final release gate.

## Plain-local tool

The separate `gallery-ground-tool-source.zip` contains a self-contained Bun/React/TypeScript package, locked dependencies, source, tests, configuration example, design notes and README. It is distributed outside this repository — it was delivered with the export bundle's handoff directory and is not checked in anywhere here. It excludes keys, private transcripts/cache, installed dependencies, build products and browser working files.

Extract it, then:

```sh
cd procedural-illustrator
bun install --frozen-lockfile
bun run dev
```

Open `http://127.0.0.1:5188`. The photographic preset, seeded layout, diagnostics, palettes, undo, imports and all exports need no provider key. Import either exact `.project.json` to reopen this composition without repacking. The UI’s PNG field sets the longest edge; SVG and JSON exports always represent the tile even while a repeat/diagnostic is selected.

To regenerate the paired set from the default recipe:

```sh
bun run generate -- --seed 1843 --density medium --resolution 2048 --out exports
```

CLI resolution specifies PNG width. For exact saved input, add `--project /path/to/gallery-ground-dark.project.json` without overriding the recipe. The source README documents model configuration, strict schemas, local cache/records, repair budgets and all commands.

## Honest AI boundary

AI-directed brief/geometry generation, contact-sheet vision review and one typed layout-review/repair cycle are implemented and covered with explicit fake-provider contract tests. Live execution could not be validated: the available Manus desktop runtime rejected images, then text generation with “LLM hard budget enforcement is unavailable.” No runtime restriction was bypassed; no fake output is presented as live AI art. The completed photographic library is hand-authored. Optional live AI needs a working, explicit reasoning/vision-provider key and model in the tool’s `.env.local`.

All ten requested third-party skills were installed separately. Their verified archives, original source revisions, checksum manifest and the two metadata-only frontmatter adaptations remain in the adjacent `skills/` delivery directory. They are not runtime dependencies of this companion.

No viewer/native/core/root dependency changed. No commit, push, provider-folder mutation, remote migration or deployment was performed.
