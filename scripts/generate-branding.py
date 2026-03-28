#!/usr/bin/env python3
"""Generate in-app branding assets for Lamia Studio.

Produces:
  branding/welcome-dark.png       — welcome screen bg, dark theme
  branding/welcome-light.png      — welcome screen bg, light theme
  branding/welcome-dark-hc.png    — welcome screen bg, high-contrast dark
  branding/welcome-light-hc.png   — welcome screen bg, high-contrast light
  branding/code-icon.svg          — tab / window title icon
  branding/letterpress-dark.svg   — empty-editor watermark, dark
  branding/letterpress-light.svg  — empty-editor watermark, light
  branding/letterpress-hcDark.svg
  branding/letterpress-hcLight.svg
"""

import base64
import sys
from pathlib import Path

try:
    from PIL import Image, ImageDraw
except ImportError:
    sys.exit("Pillow is required: pip install Pillow")

ROOT = Path(__file__).resolve().parent.parent
BRANDING = ROOT / "branding"
ASSETS = ROOT.parent / "lamia" / "assets"

WELCOME_W, WELCOME_H = 874, 600


# ── helpers ───────────────────────────────────────────────────────────────────

def load_character() -> Image.Image:
    """Return the Lamia character on a transparent background."""
    path = ASSETS / "design" / "lamia_transparent.png"
    img = Image.open(path).convert("RGBA")
    # Trim fully-transparent rows/cols
    bbox = img.getbbox()
    return img.crop(bbox) if bbox else img


def place_character(bg: Image.Image, char: Image.Image, opacity: float = 0.35) -> Image.Image:
    """Composite the character onto the right side of bg at given opacity."""
    bw, bh = bg.size
    # Scale character to 70 % of background height, keep aspect
    scale = (bh * 0.70) / char.height
    new_h = int(char.height * scale)
    new_w = int(char.width * scale)
    char_r = char.resize((new_w, new_h), Image.LANCZOS)

    # Apply opacity
    r, g, b, a = char_r.split()
    a = a.point(lambda x: int(x * opacity))
    char_r = Image.merge("RGBA", (r, g, b, a))

    # Position: right-aligned, vertically centred, slight inset
    x = bw - new_w - int(bw * 0.04)
    y = (bh - new_h) // 2
    result = bg.copy()
    result.paste(char_r, (x, y), char_r)
    return result


def rounded_rect_bg(w: int, h: int, color: tuple, radius: int = 12) -> Image.Image:
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    draw.rounded_rectangle([0, 0, w - 1, h - 1], radius=radius, fill=color)
    return img


# ── welcome backgrounds ───────────────────────────────────────────────────────

def generate_welcome_backgrounds(char: Image.Image):
    themes = {
        "welcome-dark.png":    (30,  30,  30,  255),   # #1e1e1e
        "welcome-light.png":   (243, 243, 243, 255),   # #f3f3f3
        "welcome-dark-hc.png": (0,   0,   0,  255),   # #000000
        "welcome-light-hc.png":(255, 255, 255, 255),  # #ffffff
    }
    for name, color in themes.items():
        bg = rounded_rect_bg(WELCOME_W, WELCOME_H, color, radius=10)
        result = place_character(bg, char, opacity=0.30)
        out = BRANDING / name
        result.save(str(out), "PNG")
        print(f"  -> {out.relative_to(ROOT)}")


# ── SVG assets ────────────────────────────────────────────────────────────────

def png_to_data_uri(path: Path) -> str:
    data = path.read_bytes()
    b64 = base64.b64encode(data).decode()
    return f"data:image/png;base64,{b64}"


def generate_code_icon_svg(icon_path: Path):
    uri = png_to_data_uri(icon_path)
    svg = f'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1024" height="1024" viewBox="0 0 1024 1024"><image href="{uri}" width="1024" height="1024"/></svg>'
    out = BRANDING / "code-icon.svg"
    out.write_text(svg)
    print(f"  -> {out.relative_to(ROOT)}")


def generate_letterpress_svgs(icon_path: Path):
    """40×40 watermark SVGs at low opacity for each theme."""
    uri = png_to_data_uri(icon_path)
    themes = {
        "letterpress-dark.svg":    0.15,
        "letterpress-light.svg":   0.12,
        "letterpress-hcDark.svg":  0.20,
        "letterpress-hcLight.svg": 0.12,
    }
    for name, opacity in themes.items():
        svg = (
            f'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" '
            f'width="40" height="40" viewBox="0 0 40 40">'
            f'<image href="{uri}" width="40" height="40" opacity="{opacity}"/>'
            f'</svg>'
        )
        out = BRANDING / name
        out.write_text(svg)
        print(f"  -> {out.relative_to(ROOT)}")


# ── main ──────────────────────────────────────────────────────────────────────

def main():
    BRANDING.mkdir(parents=True, exist_ok=True)
    icon_path = BRANDING / "icons" / "icon-1024.png"

    if not icon_path.exists():
        sys.exit(f"Icon not found: {icon_path}\nRun scripts/generate-icons.py first.")
    if not ASSETS.exists():
        sys.exit(f"Assets directory not found: {ASSETS}")

    print("Generating in-app branding assets...")

    char = load_character()
    generate_welcome_backgrounds(char)
    generate_code_icon_svg(icon_path)
    generate_letterpress_svgs(icon_path)

    print("Done!")


if __name__ == "__main__":
    main()
