#!/usr/bin/env python3
"""dereliction capture server.

Serves the repo (playground at /web/, library at /lib/) and exposes
GET /capture?url=...&w=1280&h=800&y=0 which:
  1. loads the page in headless Chromium at the given viewport,
  2. extracts per-glyph rects (text) and shape rects (img/svg/video/canvas, plus any element
     marked with CSS `--physics: rigid|solid` or data-physics),
  3. screenshots the page as-is,
  4. makes all text transparent and screenshots again.
The client diffs the two screenshots to get a pixel-exact "ink" mask.

Run:  uv run server.py [port]      (first time: uv run playwright install chromium)
Env:  DERELICTION_ALLOW=https://example.com/,https://www.example.com/   restrict capturable URLs (prefixes; default: any)
      DERELICTION_CACHE=/path/to/dir                                      cache captures by url+size (static sites)
      DERELICTION_BIND=0.0.0.0                                            bind address (default 127.0.0.1)
"""
import base64
import hashlib
import json
import os
import queue
import sys
import threading
import traceback
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import sync_playwright

HERE = Path(__file__).parent
ROOT = HERE                       # static root: /web/index.html, /lib/dereliction.js
LIB = HERE / "lib" / "dereliction.js"
PORT = int(sys.argv[1]) if len(sys.argv) > 1 and sys.argv[1].isdigit() else int(os.environ.get("PORT", "8008"))
BIND = os.environ.get("DERELICTION_BIND", "127.0.0.1")
ALLOW = [a.strip() for a in os.environ.get("DERELICTION_ALLOW", "").split(",") if a.strip()]
CACHE = Path(os.environ["DERELICTION_CACHE"]) if os.environ.get("DERELICTION_CACHE") else None
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36")

FREEZE_CSS = """
*, *::before, *::after { animation-play-state: paused !important; transition: none !important; }
html { scroll-behavior: auto !important; }
"""

HIDE_TEXT_CSS = """
*, *::before, *::after {
  color: transparent !important;
  -webkit-text-fill-color: transparent !important;
  text-shadow: none !important;
  caret-color: transparent !important;
  text-decoration-color: transparent !important;
}
::placeholder { color: transparent !important; }
svg text, svg tspan { fill: transparent !important; stroke: transparent !important; }
"""

# Glyph/shape extraction lives in the library (single source of truth); it is injected into the page.
LIB_SRC = LIB.read_text()


class Capturer:
    """Owns Playwright on one dedicated thread; HTTP handler threads queue jobs and wait."""

    def __init__(self):
        self.jobs: queue.Queue = queue.Queue()
        self.ready = threading.Event()
        threading.Thread(target=self._run, daemon=True).start()
        self.ready.wait()

    def _run(self):
        self.pw = sync_playwright().start()
        self.browser = self.pw.chromium.launch(headless=True)
        self.ready.set()
        while True:
            args, done, out = self.jobs.get()
            try:
                out["result"] = self._capture(*args)
            except Exception:
                out["error"] = traceback.format_exc()
            done.set()

    def capture(self, url: str, w: int, h: int, y: int) -> dict:
        done, out = threading.Event(), {}
        self.jobs.put(((url, w, h, y), done, out))
        done.wait()
        if "error" in out:
            raise RuntimeError(out["error"])
        return out["result"]

    def _capture(self, url: str, w: int, h: int, y: int) -> dict:
        ctx = self.browser.new_context(
            viewport={"width": w, "height": h},
            device_scale_factor=1,
            user_agent=UA,
            reduced_motion="reduce",
        )
        page = ctx.new_page()
        try:
            page.goto(url, wait_until="load", timeout=45000)
            try:
                page.wait_for_load_state("networkidle", timeout=6000)
            except Exception:
                pass
            if y:
                page.evaluate("y => window.scrollTo(0, y)", y)
                page.wait_for_timeout(400)
            page.add_style_tag(content=FREEZE_CSS)
            page.add_script_tag(content=LIB_SRC)
            page.wait_for_timeout(250)
            rects = page.evaluate("Dereliction.extractRects(document)")
            shot = page.screenshot(type="png")
            page.add_style_tag(content=HIDE_TEXT_CSS)
            page.wait_for_timeout(150)
            notext = page.screenshot(type="png")
            title = page.title()
        finally:
            ctx.close()
        b64 = lambda b: "data:image/png;base64," + base64.b64encode(b).decode()
        return {"url": url, "title": title, "w": rects["w"], "h": rects["h"],
                "chars": rects["chars"], "shapes": rects["shapes"],
                "shot": b64(shot), "notext": b64(notext)}


CAP: Capturer | None = None


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=str(ROOT), **k)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        super().end_headers()

    def _json(self, code: int, payload):
        body = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json" if code == 200 else "text/plain")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = urlparse(self.path)
        if u.path == "/":
            self.send_response(302); self.send_header("Location", "/web/"); self.end_headers(); return
        if u.path == "/health":
            return self._json(200, {"ok": True, "allow": ALLOW, "cache": str(CACHE) if CACHE else None})
        if u.path != "/capture":
            if u.path.startswith("/.") or "/.venv" in u.path:
                return self._json(404, b"not found")
            return super().do_GET()
        q = parse_qs(u.query)
        url = (q.get("url") or [""])[0].strip()
        if not url:
            return self._json(400, b"missing url")
        if "://" not in url:
            url = "https://" + url
        w = max(200, min(4096, int((q.get("w") or ["1280"])[0])))
        h = max(200, min(4096, int((q.get("h") or ["800"])[0])))
        y = max(0, int((q.get("y") or ["0"])[0]))
        if ALLOW and not any(url.startswith(a) for a in ALLOW):
            return self._json(403, b"url not in DERELICTION_ALLOW")
        key = hashlib.sha1(f"{url}|{w}|{h}|{y}".encode()).hexdigest()
        if CACHE and (CACHE / f"{key}.json").exists():
            return self._json(200, (CACHE / f"{key}.json").read_bytes())
        print(f"capture {url} {w}x{h} y={y}", flush=True)
        try:
            data = CAP.capture(url, w, h, y)
            print(f"  -> {len(data['chars'])} glyphs, {len(data['shapes'])} shapes", flush=True)
            body = json.dumps(data).encode()
            if CACHE:
                CACHE.mkdir(parents=True, exist_ok=True)
                (CACHE / f"{key}.json").write_bytes(body)
            self._json(200, body)
        except Exception as e:
            tb = str(e) if isinstance(e, RuntimeError) else traceback.format_exc()
            print(tb, flush=True)
            self._json(500, tb.encode())

    def log_message(self, fmt, *args):  # quieter static logs
        if "/capture" in str(args[0]) if args else False:
            super().log_message(fmt, *args)


if __name__ == "__main__":
    CAP = Capturer()
    srv = ThreadingHTTPServer((BIND, PORT), Handler)
    print(f"dereliction  http://localhost:{PORT}/web/   allow={ALLOW or 'any'} cache={CACHE}", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
