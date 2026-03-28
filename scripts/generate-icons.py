#!/usr/bin/env python3
"""Generate platform-specific icons from a source PNG with transparent background.

The source PNG should already have its background removed. Export from your
design tool as PNG with transparency, at least 1024x1024.

Usage:
    pip install Pillow
    python scripts/generate-icons.py [--source assets/design/lamia-ide-icon_cropped.png]

Produces:
    branding/icons/icon-1024.png   — master (1024x1024, transparent)
    branding/icons/lamia-256.png   — Linux
    branding/icons/lamia.ico       — Windows
    branding/icons/lamia.icns      — macOS (only when iconutil is available)
"""

import argparse
import os
import platform
import shutil
import subprocess
import sys
from pathlib import Path

try:
    from PIL import Image
except ImportError:
    sys.exit("Pillow is required: pip install Pillow")

ROOT = Path(__file__).resolve().parent.parent
ICONS_DIR = ROOT / "branding" / "icons"

ICNS_SIZES = [16, 32, 128, 256, 512]
ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]


def has_transparency(img: Image.Image) -> bool:
    """Check if image already has meaningful transparent pixels."""
    if img.mode != "RGBA":
        return False
    alpha = img.getchannel("A")
    return alpha.getextrema()[0] < 255


def clean_white_fringe(img: Image.Image, white_thresh: int = 220) -> Image.Image:
    """Remove semi-transparent white fringe left by background removal tools.

    Targets pixels that are both partially transparent (alpha < 255) AND
    near-white (RGB all above threshold). Fully opaque white pixels (like the
    S-gradient in the logo) are left untouched.
    """
    img = img.convert("RGBA")
    pixels = img.load()
    w, h = img.size
    cleaned = 0
    for y in range(h):
        for x in range(w):
            r, g, b, a = pixels[x, y]
            if a < 255 and r > white_thresh and g > white_thresh and b > white_thresh:
                pixels[x, y] = (r, g, b, 0)
                cleaned += 1
    if cleaned:
        print(f"  Cleaned {cleaned} white fringe pixels")
    return img


def trim_transparent(img: Image.Image) -> Image.Image:
    """Crop to the bounding box of non-transparent pixels."""
    bbox = img.getbbox()
    if bbox:
        return img.crop(bbox)
    return img


def make_square(img: Image.Image) -> Image.Image:
    """Pad to a square canvas, centered."""
    w, h = img.size
    size = max(w, h)
    square = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    square.paste(img, ((size - w) // 2, (size - h) // 2))
    return square


def apply_macos_squircle(img: Image.Image, padding: float = 0.08) -> Image.Image:
    """Apply macOS squircle mask with padding so the icon sits naturally in the dock.

    padding: fraction of canvas to leave transparent on each side (default 8%).
    Corner radius is ~22.5% of the squircle area, matching macOS conventions.
    """
    from PIL import ImageDraw
    canvas = img.size[0]
    img = img.convert("RGBA")
    pad = int(canvas * padding)
    inner = canvas - 2 * pad
    scaled = img.resize((inner, inner), Image.LANCZOS)
    result = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    result.paste(scaled, (pad, pad))
    mask = Image.new("L", (canvas, canvas), 0)
    draw = ImageDraw.Draw(mask)
    radius = int(inner * 0.225)
    draw.rounded_rectangle([pad, pad, pad + inner - 1, pad + inner - 1], radius=radius, fill=255)
    out = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    out.paste(result, mask=mask)
    return out


def generate_master(source: Path) -> Image.Image:
    print(f"Source: {source} ({os.path.getsize(source) // 1024} KB)")
    img = Image.open(source)
    img = img.convert("RGBA")
    if has_transparency(img):
        print("  Source has transparency, cleaning up fringe artifacts")
        img = clean_white_fringe(img)
    img = trim_transparent(img)
    img = make_square(img)
    if img.size[0] != 1024:
        img = img.resize((1024, 1024), Image.LANCZOS)
    img = apply_macos_squircle(img)
    print("  Applied macOS squircle mask")

    master = ICONS_DIR / "icon-1024.png"
    img.save(master, "PNG")
    print(f"  -> {master.relative_to(ROOT)}")
    return img


def generate_ico(master: Image.Image):
    sizes = [(s, s) for s in ICO_SIZES]
    ico_path = ICONS_DIR / "lamia.ico"
    master.save(ico_path, format="ICO", sizes=sizes)
    print(f"  -> {ico_path.relative_to(ROOT)}")


def generate_linux_png(master: Image.Image):
    png_path = ICONS_DIR / "lamia-256.png"
    resized = master.resize((256, 256), Image.LANCZOS)
    resized.save(png_path, "PNG")
    print(f"  -> {png_path.relative_to(ROOT)}")


def generate_icns(master: Image.Image):
    if shutil.which("iconutil") is None:
        print("  -- Skipping .icns (iconutil not available, macOS only)")
        return

    iconset = ICONS_DIR / "icon.iconset"
    iconset.mkdir(exist_ok=True)

    for size in ICNS_SIZES:
        img_1x = master.resize((size, size), Image.LANCZOS)
        img_2x = master.resize((size * 2, size * 2), Image.LANCZOS)
        img_1x.save(iconset / f"icon_{size}x{size}.png", "PNG")
        img_2x.save(iconset / f"icon_{size}x{size}@2x.png", "PNG")

    icns_path = ICONS_DIR / "lamia.icns"
    subprocess.run(
        ["iconutil", "-c", "icns", "-o", str(icns_path), str(iconset)],
        check=True,
    )
    shutil.rmtree(iconset)
    print(f"  -> {icns_path.relative_to(ROOT)}")


def main():
    parser = argparse.ArgumentParser(description="Generate app icons from source PNG")
    parser.add_argument(
        "--source",
        type=Path,
        default=ROOT / "assets" / "design" / "lamia_ide_icon_v2_cropped.png",
    )
    args = parser.parse_args()

    if not args.source.exists():
        sys.exit(f"Source not found: {args.source}")

    ICONS_DIR.mkdir(parents=True, exist_ok=True)

    print(f"Generating icons for {platform.system()}...")
    master = generate_master(args.source)
    generate_ico(master)
    generate_linux_png(master)
    generate_icns(master)
    print("Done!")


if __name__ == "__main__":
    main()
