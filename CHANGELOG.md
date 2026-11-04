# Changelog

## 0.3.1 — 2026-11-04
- Frames no longer paint over the words that fell past them: particles are drawn by depth (text in front,
  loose sand behind it, shapes, then frames) instead of by home pixel. The context now has a depth buffer.
- A word inside a frame takes every pixel of its ink, anti-aliased halo included, and the frame draws its
  ground colour as a quad behind its particles, so no ghost of the text is left where the words were.
- Ink inside a frame that belongs to no word pours as sand, and the frame's obstacle is hollow like its body,
  so that sand settles on the frame's floor instead of being pushed out through its ceiling.
- Glyph rects are slid onto the captured ink line by line (`alignCharsToInk`; `scene.align = false` to skip):
  html2canvas draws some fonts up to ten pixels off their DOM rects, which left descenders behind.

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
