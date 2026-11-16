# Styled DMG packaging

The macOS download disk image is a designed object, not a bare folder: an
800×560pt Finder window on near-black (`#0a0a0a`) carrying the official
manorama wordmark and the homepage hero caption, with twenty-four nested
rectangular outlines converging toward a small aperture on the right —
the "Quiet Transfer" passage field, dark-adapted — a single pink
threshold segment, the Applications folder seated inside the innermost
frame, and the drag instruction at the bottom. Finder owns the icons and
their labels; the artwork deliberately contains no icon imagery.

Finder draws native filename labels in black even on a custom image
background, so two small warm-cream (`#f3f0e8`) backing strips sit behind
the label positions and keep the real labels legible — the strips are
artwork, the text stays native and accessible. Whether Finder shows the
`.app` extension is Finder's own decision; packaging does not change app
metadata to influence it. The whole composition is laid out inside the
roughly 435pt of window height that remains visible when Finder shows
its tab bar or path/status bars, so nothing meaningful is clipped.

`philosophy.md` is the original art-direction statement — its light
palette was the first artistic source; the shipped installer is the dark
adaptation the owner requested, not a rewrite of that manifesto. The
geometry lives in **points** (the Finder window is 800×560pt); the PNG
assets are pixels — `background.png` is 800×560px @72dpi and
`background@2x.png` is 1600×1120px @144dpi, the same physical size at 2×.
`background.tiff` packs both into one multi-representation file so Retina
Finders pick the sharp rep.

## Assets

All generated files are committed; nothing renders at release time.

- `background.png`, `background@2x.png` — rendered rasters
- `background.tiff` — HiDPI pair built with `tiffutil -cathidpicheck`
- `settings.py` — dmgbuild settings consumed by `scripts/build-dmg.sh`
- `render-background.py` — deterministic Pillow/fontTools generator
- `philosophy.md` — the original design statement

## Prerequisites

macOS with Xcode CLT (`hdiutil`, `tiffutil`, `SetFile`, `PlistBuddy`),
[`uv`](https://docs.astral.sh/uv/) on PATH. Python dependencies are
fetched ephemerally by `uv run`/`uvx` — nothing is installed into the repo.

## Regenerate the artwork

```sh
uv run --with 'pillow==13.0.0' --with 'fonttools==4.68.0' \
    python macos/dmg/render-background.py

tiffutil -cathidpicheck macos/dmg/background.png macos/dmg/background@2x.png \
    -out macos/dmg/background.tiff
```

The wordmark comes from `public/manorama-merged-logo.png`, composited at
its original aspect and only ever downscaled; the caption and instruction
use Manrope regular from `public/fonts`. No font or logo files are copied
here.

## Package a DMG locally

Requires an already-built `manorama.app` (e.g.
`macos/ManoramaMac/build/manorama.app` from `scripts/build-macos.sh`).

```sh
scripts/build-dmg.sh /abs/path/manorama.app /abs/path/out.dmg
```

The script validates the bundle and its `icon.icns`, refuses to overwrite
an existing output, reads `CFBundleShortVersionString` for the volume
name, and runs `dmgbuild==1.6.7` via `uvx`. It does **not** sign or
notarize — a locally built DMG is a design preview, not a release.

Two deliberate choices preserve the signed app: the `.app` extension is
not hidden (hiding it makes dmgbuild run `SetFile -a E`, which writes a
`com.apple.FinderInfo` xattr onto the signed bundle root and fails
`codesign --verify --deep --strict`), and `settings.py` carries a
`create_hook` that runs that strict verification against the packaged
copy inside the build, so CI fails closed if packaging ever damages the
signature.

## Release path

`.github/workflows/desktop-release.yml` calls the same
`scripts/build-dmg.sh` inside the SwiftUI build step, then runs the
existing `notarytool submit --wait` → `stapler staple` → `stapler
validate` sequence on the result. Manual dispatches of tags that predate
the styled DMG fall back to the previous plain `hdiutil` packaging.
