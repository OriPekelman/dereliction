# Changelog

## 0.2.0 — 2026-11-03
- Library: `PhysicalWeb.attach()` overlays a live page after idle and plays a preset; exits on scroll/wheel/key.
- Capture backends: client-only (html2canvas), prerendered static manifest (`prerender.py`), server (`server.py`).
- Endless pouring (`recycle`) with a spout; presets Endless pour and Hourglass.
- Reduced-motion and WebGL2 checks; `minWidth` option.

## 0.1.0 — 2026-11-03
- Prototype: Playwright capture server + WebGL2 GPGPU particle sim, matter.js rigid bodies (lines/words/letters),
  obstacle map so sand piles on letters, CSS `--physics` roles.
