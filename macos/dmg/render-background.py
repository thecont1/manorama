#!/usr/bin/env python3
"""Render the styled Finder background for the manorama DMG.

Dark adaptation of the approved "Quiet Transfer" artwork: passage made
visible — nested rectangular outlines converge toward a small aperture on
the right where the Applications folder sits, a single pink segment marks
the threshold, and Finder owns the icons and their labels. The wordmark is
the official manorama-merged-logo.png composited unmodified (aspect kept,
never upscaled); the caption lines quote the homepage hero. All geometry is
in window points (800x560); rendering happens at 4x and is Lanczos-
downsampled to the 1x and @2x targets.

Regenerate with:

    uv run --with 'pillow==13.0.0' --with 'fonttools==4.68.0' \
        python macos/dmg/render-background.py

Outputs (committed; releases never render):
    macos/dmg/background.png      800x560  @72dpi
    macos/dmg/background@2x.png  1600x1120 @144dpi

The multi-representation background.tiff is built from those PNGs with:

    tiffutil -cathidpicheck macos/dmg/background.png macos/dmg/background@2x.png \
        -out macos/dmg/background.tiff
"""

from pathlib import Path
import math
import tempfile

from PIL import Image, ImageDraw, ImageFont
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

ROOT = Path(__file__).resolve().parents[2]
FONTS = ROOT / "public" / "fonts"
LOGO = ROOT / "public" / "manorama-merged-logo.png"
OUT_DIR = Path(__file__).resolve().parent

S = 4  # supersample factor
WIN_W, WIN_H = 800, 560  # Finder window, in points

BG = (0x0A, 0x0A, 0x0A)    # near-black field
INK = (0xF3, 0xF0, 0xE8)   # warm mineral white — lines and lettering
PINK = (0xFC, 0x0F, 0xC0)  # the single chromatic signal

# Wordmark logical box: (60,55) to (280,129.68) — 220pt wide, source aspect.
LOGO_BOX = (60.0, 55.0, 280.0, 129.68)

# BG patches that pause the frame lines where native Finder content lands:
# behind the app icon + its label, and under the arrow shaft.
APP_PATCH = (130.0, 194.0, 250.0, 334.0)
ARROW_PATCH = (350.0, 240.0, 418.0, 260.0)

# Cream backing strips behind the native Finder labels. Custom image
# backgrounds keep filename text black regardless of system appearance, so
# the labels need a light pad to stay legible on the dark field.
LABEL_BACKINGS = [
    (120.0, 307.0, 260.0, 333.0),  # under manorama.app
    (530.0, 307.0, 670.0, 333.0),  # under Applications, inside inner frame
]


def instantiate(src_name, out_name, loc, tmp):
    """Pin a static instance of a repo variable font into a temp file."""
    dst = Path(tmp) / out_name
    if not dst.exists():
        f = TTFont(FONTS / src_name)
        instantiateVariableFont(f, loc, inplace=True)
        f.save(dst)
    return str(dst)


def main():
    with tempfile.TemporaryDirectory() as tmp:
        manrope = instantiate(
            "Manrope-variable.ttf", "Manrope-Regular.ttf", {"wght": 400.0}, tmp
        )

        def font(path, size_pt):
            return ImageFont.truetype(path, int(round(size_pt * S)))

        sans_15 = font(manrope, 15)

        img = Image.new("RGB", (WIN_W * S, WIN_H * S), BG)
        d = ImageDraw.Draw(img)

        # ------------------------------------------------------- wordmark
        # Official logo, alpha-composited at 4x. Target is smaller than the
        # 2027x688 source, so this only ever downscales.
        logo = Image.open(LOGO).convert("RGBA")
        lw = int(round((LOGO_BOX[2] - LOGO_BOX[0]) * S))
        lh = int(round((LOGO_BOX[3] - LOGO_BOX[1]) * S))
        logo = logo.resize((lw, lh), Image.LANCZOS)
        img.paste(
            logo.convert("RGB"),
            (int(LOGO_BOX[0] * S), int(LOGO_BOX[1] * S)),
            logo.getchannel("A"),
        )

        # ---------------------------------------------------------- caption
        # The homepage hero lines, right-aligned into the top margin.
        d.text(
            (740 * S, 89 * S),
            "Your photographic life.",
            font=sans_15,
            fill=INK,
            anchor="rs",
        )
        d.text(
            (740 * S, 113 * S),
            "One beautiful Library.",
            font=sans_15,
            fill=INK,
            anchor="rs",
        )

        # ------------------------------------------------ nested outlines
        # 24 rectangles, linear progression, converging toward a small
        # aperture on the right — the "passage" field around the icons.
        STROKE = 0.6
        E = STROKE / 2.0

        def rect_bars(l, t, r, b, split_right_at=None):
            bars = [
                (l - E, t - E, r + E, t + E),  # top
                (l - E, b - E, r + E, b + E),  # bottom
                (l - E, t - E, l + E, b + E),  # left
            ]
            if split_right_at is None:
                bars.append((r - E, t - E, r + E, b + E))
            else:
                y0, y1 = split_right_at
                bars.append((r - E, t - E, r + E, y0))
                bars.append((r - E, y1, r + E, b + E))
            return bars

        ink_bars = []
        pink_bars = []
        for i in range(24):
            t = i / 23.0
            l = 60 + 440 * t
            r = 740 - 40 * t
            tp = 148 + 30 * t
            bt = 388 - 30 * t
            if i == 23:
                # innermost: right edge carries the pink threshold segment
                ink_bars.extend(rect_bars(l, tp, r, bt, split_right_at=(229.0, 271.0)))
                pink_bars.append((r - 1.0, 229.0, r + 1.0, 271.0))
            else:
                ink_bars.extend(rect_bars(l, tp, r, bt))

        for x0, y0, x1, y1 in ink_bars:
            d.rectangle([x0 * S, y0 * S, x1 * S, y1 * S], fill=INK)
        for x0, y0, x1, y1 in pink_bars:
            d.rectangle([x0 * S, y0 * S, x1 * S, y1 * S], fill=PINK)

        # ------------------------------------------- clear zones for content
        # Finder draws the app icon + label and the Applications icon natively
        # on top of this artwork; pause the frame lines behind them so they do
        # not strike through the lettering.
        for x0, y0, x1, y1 in (ARROW_PATCH, APP_PATCH):
            d.rectangle(
                [x0 * S, y0 * S, x1 * S, y1 * S], fill=BG
            )

        # Cream pads where Finder will draw its native (black) filename
        # labels — drawn after the frame field so no line crosses the text.
        for x0, y0, x1, y1 in LABEL_BACKINGS:
            d.rectangle(
                [x0 * S, y0 * S, x1 * S, y1 * S], fill=INK
            )

        # ------------------------------------------------------------ arrow
        # Short cue in the gap between the icons, pointing toward the inner
        # aperture where Applications sits: shaft x358..410 at y250, two
        # 6px head segments at +/-30 degrees.
        ARROW_W = 1.1
        TIP = (410.0, 250.0)
        HEAD_LEN = 6.0

        def thick_seg(p1, p2, w):
            (x1, y1), (x2, y2) = p1, p2
            dx, dy = x2 - x1, y2 - y1
            ln = math.hypot(dx, dy)
            nx, ny = -dy / ln * w / 2.0, dx / ln * w / 2.0
            d.polygon(
                [
                    ((x1 + nx) * S, (y1 + ny) * S),
                    ((x2 + nx) * S, (y2 + ny) * S),
                    ((x2 - nx) * S, (y2 - ny) * S),
                    ((x1 - nx) * S, (y1 - ny) * S),
                ],
                fill=INK,
            )

        thick_seg((358.0, 250.0), TIP, ARROW_W)
        for sgn in (-1.0, 1.0):
            hx = TIP[0] - HEAD_LEN * math.cos(math.radians(30))
            hy = TIP[1] + sgn * HEAD_LEN * math.sin(math.radians(30))
            thick_seg(TIP, (hx, hy), ARROW_W)

        # ------------------------------------------------------------ text
        # Finder owns the icon labels; the only lettering is the caption
        # block and the drag instruction.
        d.text(
            (400 * S, 418 * S),
            "Drag manorama to Applications.",
            font=sans_15,
            fill=INK,
            anchor="ms",
        )

        # ------------------------------------------------------- outputs
        targets = [
            (OUT_DIR / "background.png", (WIN_W, WIN_H), (72, 72)),
            (OUT_DIR / "background@2x.png", (WIN_W * 2, WIN_H * 2), (144, 144)),
        ]
        for path, size, dpi in targets:
            out = img.resize(size, Image.LANCZOS)
            out.save(path, dpi=dpi)
            print(f"wrote {path} {size[0]}x{size[1]} @{dpi[0]}dpi")


if __name__ == "__main__":
    main()
