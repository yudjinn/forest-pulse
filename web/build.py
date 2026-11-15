"""Prepare the dashboard files and shared brand assets for Cloudflare Workers."""

from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parent
BRAND = ROOT.parent / "shared" / "assets" / "forest-pulse"
# Teaching runs the sensors' own model file in the browser, with ONNX Runtime's WebAssembly build, both served
# from the site itself at /model/.
SENSOR_MODEL = ROOT.parent / "sensor-sdk" / "forestpulse_sensor" / "data" / "mn10_as.onnx"
ORT = ROOT / "node_modules" / "onnxruntime-web" / "dist"
ORT_FILES = ("ort.wasm.min.mjs", "ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.wasm")
DIST = ROOT / "dist"


def main():
    if DIST.exists():
        shutil.rmtree(DIST)
    (DIST / "brand").mkdir(parents=True)
    shutil.copy2(ROOT / "_headers", DIST / "_headers")
    shutil.copytree(ROOT / "dashboard", DIST / "dashboard", ignore=shutil.ignore_patterns("tsconfig.json", "*.md"))
    for file in BRAND.glob("*.svg"):
        if file.name != "preview.svg":
            shutil.copy2(file, DIST / "brand" / file.name)
    for name in ("icons", "social"):
        shutil.copytree(BRAND / name, DIST / "brand" / name)
    shutil.copy2(BRAND / "site.webmanifest", DIST / "brand" / "site.webmanifest")
    shutil.copy2(BRAND / "icons" / "favicon.ico", DIST / "favicon.ico")
    (DIST / "model").mkdir()
    shutil.copy2(SENSOR_MODEL, DIST / "model" / SENSOR_MODEL.name)
    for name in ORT_FILES:
        shutil.copy2(ORT / name, DIST / "model" / name)
    print(f"Built the site in {DIST}")


if __name__ == "__main__":
    main()
