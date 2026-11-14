"""Prepare the landing page, the dashboard files and shared brand assets for Cloudflare Workers."""

from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parent
BRAND = ROOT.parent / "shared" / "assets" / "forest-pulse"
DIST = ROOT / "dist"


def main():
    if DIST.exists():
        shutil.rmtree(DIST)
    (DIST / "brand").mkdir(parents=True)
    for name in ("index.html", "styles.css", "_headers"):
        shutil.copy2(ROOT / name, DIST / name)
    shutil.copytree(ROOT / "dashboard", DIST / "dashboard", ignore=shutil.ignore_patterns("tsconfig.json"))
    for file in BRAND.glob("*.svg"):
        if file.name != "preview.svg":
            shutil.copy2(file, DIST / "brand" / file.name)
    for name in ("icons", "social"):
        shutil.copytree(BRAND / name, DIST / "brand" / name)
    shutil.copy2(BRAND / "site.webmanifest", DIST / "brand" / "site.webmanifest")
    shutil.copy2(BRAND / "icons" / "favicon.ico", DIST / "favicon.ico")
    print(f"Built landing page in {DIST}")


if __name__ == "__main__":
    main()
