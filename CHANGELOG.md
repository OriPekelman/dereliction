# Changelog

## 0.3.0 — 2026-11-03
- New author role `--physics: frame`: the element is a hollow rigid block (compound body of four edges); the
  words inside are their own bodies and fall within it, the block's background rides with the block (#1).
- Word bodies are padded 3 px so underlines travel with their word; in rigid mode, ink that belongs to no body
  pours as sand instead of staying pinned (both upstreamed from the pekelman.com vendored copy).

## 0.2.0 — 2026-11-03
- Library: `PhysicalWeb.attach()` overlays a live page after idle and plays a preset; exits on scroll/wheel/key.
- Capture backends: client-only (html2canvas), prerendered static manifest (`prerender.py`), server (`server.py`).
- Endless pouring (`recycle`) with a spout; presets Endless pour and Hourglass.
- Reduced-motion and WebGL2 checks; `minWidth` option.

## 0.1.0 — 2026-11-03
- Prototype: Playwright capture server + WebGL2 GPGPU particle sim, matter.js rigid bodies (lines/words/letters),
  obstacle map so sand piles on letters, CSS `--physics` roles.
