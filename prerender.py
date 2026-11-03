#!/usr/bin/env python3
"""Pre-render physical-web captures for a static site at build time.

For each page and viewport width, renders the FULL page (viewport height = document height,
capped) twice (with and without text) and extracts glyph/shape rects with the library's
own extractor, then writes a manifest the client reads via PhysicalWeb.captureStatic().

  uv run prerender.py --base http://localhost:8080 --out ../pekelman.com/physics \
      --pages /index.htm /poemes.htm --widths 1280 1440 1512 1680 1920

At runtime the static backend is only used when window.innerWidth matches one of the widths
exactly (layout depends on width); otherwise the library falls back to client-side DOM capture.
"""
import argparse
import json
import re
from pathlib import Path

from playwright.sync_api import sync_playwright

from server import HIDE_TEXT_CSS

HERE = Path(__file__).parent
LIB = HERE / "lib" / "physical-web.js"
FREEZE_CSS = "*, *::before, *::after { animation-play-state: paused !important; transition: none !important; }"


def slug(path: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", path.lower()).strip("-")
    return s or "index"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True, help="site base URL, e.g. http://localhost:8080")
    ap.add_argument("--out", required=True, help="output directory (served under the site, e.g. ./physics)")
    ap.add_argument("--pages", nargs="+", required=True, help="page paths, e.g. /index.htm")
    ap.add_argument("--widths", nargs="+", type=int, default=[1280, 1440, 1512, 1680, 1920])
    ap.add_argument("--max-height", type=int, default=6000)
    args = ap.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    manifest = {"version": 1, "pages": {}}
    lib_src = LIB.read_text()
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        for path in args.pages:
            manifest["pages"][path] = {}
            for w in args.widths:
                ctx = browser.new_context(viewport={"width": w, "height": 900}, device_scale_factor=1, reduced_motion="reduce")
                page = ctx.new_page()
                page.goto(args.base.rstrip("/") + path, wait_until="load", timeout=60000)
                try:
                    page.wait_for_load_state("networkidle", timeout=6000)
                except Exception:
                    pass
                h = min(args.max_height, int(page.evaluate("document.documentElement.scrollHeight")))
                page.set_viewport_size({"width": w, "height": h})
                page.add_style_tag(content=FREEZE_CSS)
                page.add_script_tag(content=lib_src)
                page.wait_for_timeout(300)
                rects = page.evaluate("PhysicalWeb.extractRects(document)")
                base = f"{slug(path)}-{w}"
                page.screenshot(path=str(out / f"{base}.shot.png"))
                page.add_style_tag(content=HIDE_TEXT_CSS)
                page.wait_for_timeout(150)
                page.screenshot(path=str(out / f"{base}.notext.png"))
                (out / f"{base}.rects.json").write_text(json.dumps({"chars": rects["chars"], "shapes": rects["shapes"]}))
                manifest["pages"][path][str(w)] = {"w": w, "h": h, "shot": f"{base}.shot.png", "notext": f"{base}.notext.png", "rects": f"{base}.rects.json"}
                print(f"{path} @ {w}: {h}px tall, {len(rects['chars'])} glyphs, {len(rects['shapes'])} shapes", flush=True)
                ctx.close()
        browser.close()
    (out / "manifest.json").write_text(json.dumps(manifest, indent=1))
    print(f"wrote {out / 'manifest.json'}")


if __name__ == "__main__":
    main()
