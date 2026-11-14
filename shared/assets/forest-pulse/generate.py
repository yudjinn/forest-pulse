#!/usr/bin/env python3
"""Rebuild shared web assets from the approved vector mark and outlined wordmark."""

import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parent
GREEN = "#0B4827"
IVORY = "#FBF7EF"
NS = "{http://www.w3.org/2000/svg}"


def write(name, content):
    (ROOT / name).write_text(content + "\n")


def svg(width, height, content, title):
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" '
        f'viewBox="0 0 {width} {height}" role="img" aria-label="{title}">'
        f"{content}</svg>"
    )


def render(source, destination, size=None):
    args = ["rsvg-convert", str(ROOT / source), "-o", str(ROOT / destination)]
    if size:
        args += ["--width", str(size), "--height", str(size)]
    subprocess.run(args, check=True)


def main():
    for tool in ("rsvg-convert", "magick"):
        if not shutil.which(tool):
            raise SystemExit(f"Missing {tool}. See README.md for prerequisites.")

    mark_root = ET.parse(ROOT / "mark.svg").getroot()
    leaf = mark_root.find(f".//{NS}path").attrib["d"]
    logo_root = ET.parse(ROOT / "logo.svg").getroot()
    wordmark = logo_root.findall(f"{NS}g")[1]
    word_paths = "".join(
        f'<path d="{path.attrib["d"]}"/>' for path in wordmark
    )

    def mark(color, width, center_x, center_y):
        # Native leaf bounds: x=450..1075, y=180..675.
        scale = width / 625
        return (
            f'<g transform="translate({center_x} {center_y}) scale({scale}) '
            f'translate(-762.5 -427.5)"><path fill="{color}" d="{leaf}"/></g>'
        )

    for source in ("mark", "logo"):
        write(f"{source}-inverse.svg", (ROOT / f"{source}.svg").read_text().replace(GREEN, IVORY).rstrip())

    for suffix, color in (("", GREEN), ("-inverse", IVORY)):
        horizontal = mark(color, 165, 112.5, 95)
        horizontal += f'<g fill="{color}" transform="translate(240 133) scale(.65)">{word_paths}</g>'
        write(f"logo-horizontal{suffix}.svg", svg(840, 190, horizontal, "Forest Pulse"))

    def tile(fraction):
        return svg(
            1024, 1024,
            f'<rect width="1024" height="1024" fill="{IVORY}"/>'
            + mark(GREEN, 1024 * fraction, 512, 512),
            "Forest Pulse",
        )

    write("icons/favicon.svg", tile(.84))
    for size in (16, 32, 48):
        render("icons/favicon.svg", f"icons/favicon-{size}.png", size)
    subprocess.run(
        ["magick", *(str(ROOT / f"icons/favicon-{size}.png") for size in (16, 32, 48)),
         str(ROOT / "icons/favicon.ico")], check=True,
    )
    with tempfile.TemporaryDirectory(prefix="forest-pulse-assets-") as work:
        tile_path = Path(work) / "tile.svg"
        for fraction, exports in (
            (.76, [("apple-touch-icon.png", 180), ("icon-192.png", 192), ("icon-512.png", 512)]),
            (.60, [("maskable-192.png", 192), ("maskable-512.png", 512)]),
        ):
            tile_path.write_text(tile(fraction))
            for filename, size in exports:
                render(tile_path, f"icons/{filename}", size)

    social = f'<rect width="1200" height="630" fill="{IVORY}"/>'
    social += mark(GREEN, 400, 600, 245)
    social += f'<g fill="{GREEN}" transform="translate(249.728 532) scale(.8)">{word_paths}</g>'
    write("social/og-image.svg", svg(1200, 630, social, "Forest Pulse"))
    render("social/og-image.svg", "social/og-image.png")

    manifest = {
        "name": "Forest Pulse", "short_name": "Forest Pulse", "lang": "en",
        "id": "/", "start_url": "/", "scope": "/", "display": "standalone",
        "theme_color": GREEN, "background_color": IVORY,
        "icons": [
            {"src": f"icons/{prefix}-{size}.png", "sizes": f"{size}x{size}",
             "type": "image/png", "purpose": purpose}
            for prefix, purpose in (("icon", "any"), ("maskable", "maskable"))
            for size in (192, 512)
        ],
    }
    write("site.webmanifest", json.dumps(manifest, indent=2))

    # A compact contact sheet makes small icons and both colour variants reviewable.
    preview = f'<rect width="1200" height="740" fill="{IVORY}"/>'
    preview += f'<rect x="600" width="600" height="380" fill="{GREEN}"/>'
    for x, color in ((0, GREEN), (600, IVORY)):
        preview += mark(color, 250, x + 300, 150)
        preview += f'<g fill="{color}" transform="translate({x + 80.88} 325) scale(.5)">{word_paths}</g>'
    for size, x in ((16, 60), (32, 110), (48, 180), (180, 280), (192, 520)):
        preview += f'<rect x="{x}" y="430" width="{size}" height="{size}" fill="{IVORY}" stroke="#D6DDD6"/>'
        fraction = .84 if size <= 48 else .76
        preview += mark(GREEN, size * fraction, x + size / 2, 430 + size / 2)
    preview += f'<circle cx="940" cy="526" r="96" fill="{IVORY}" stroke="#D6DDD6"/>'
    preview += mark(GREEN, 192 * .60, 940, 526)
    write("preview.svg", svg(1200, 740, preview, "Forest Pulse web assets"))
    render("preview.svg", "preview.png")
    print("Rebuilt Forest Pulse web assets.")


if __name__ == "__main__":
    main()
