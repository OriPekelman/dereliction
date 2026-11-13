# Dereliction

**Give the pixels of a web page mass.** Leave a page alone and it falls into dereliction.

Leave a page alone for a few seconds and it comes apart: every pixel becomes a particle,
every word a rigid body. Words tumble into a pile, the paper pours over them like sand and
settles on the letters. Scroll, and the page puts itself back together.

One script tag. No server, no build step. Runs on the GPU (WebGL2) with a million particles.

**Demo:** https://oripekelman.github.io/dereliction/ · **Playground:** https://oripekelman.github.io/dereliction/web/

## Install

The quickest way: one tag, zero configuration. The bundle includes its two dependencies
(matter-js for rigid bodies, html2canvas for capturing the page).

```html
<script src="https://cdn.jsdelivr.net/npm/dereliction@0.5.1/dist/dereliction.bundle.min.js" defer
        data-attach data-idle="8000" data-preset="Avalanche"></script>
```

Or download `dist/dereliction.bundle.min.js` and host it yourself. Every `attach()` option can
be given as a `data-` attribute (`data-once`, `data-min-width="700"`, `data-preset="Letter pile"`…).

With npm:

```sh
npm i dereliction
```
```js
import Dereliction from 'dereliction';     // or: const Dereliction = require('dereliction')
Dereliction.attach({ idle: 8000, preset: 'Avalanche' });
```

The unbundled build (`dist/dereliction.min.js`, 36 KB) loads matter-js and html2canvas on
demand from cdnjs the first time the effect starts, or uses the copies already on your page.
Point `matterUrl` / `html2canvasUrl` at your own copies to stay first-party.

## Tell it what holds and what falls

An inheriting CSS custom property, or a `data-physics` attribute, on any element:

```css
header   { --physics: solid; }   /* one static block: never moves, sand piles on it          */
.card    { --physics: rigid; }   /* the whole element is one rigid body, text included       */
.panel   { --physics: frame; }   /* a hollow block: falls as a box, its words fall inside it */
.fine    { --physics: sand;  }   /* its text is loose grains, never a body                   */
```

Defaults: words are bodies, `img/svg/video/canvas` are rigid shapes, everything else is sand.

## Behaviour

```js
const ctl = Dereliction.attach({
  idle: 8000,                 // ms without pointer/key/scroll activity before it starts
  preset: 'Avalanche',        // see presets below, or pass a params object
  exitOn: ['wheel', 'keydown', 'touchmove', 'scroll'],   // what brings the page back
  exitPreset: 'Reassemble',   // how it comes back (then the overlay is removed)
  once: false,                // true: one show per page load
  minWidth: 0,                // skip on narrow screens
  reducedMotion: 'respect',   // nothing happens under prefers-reduced-motion
  capture: 'auto',            // 'dom' (client-side), 'static' (prerendered manifest), 'server'
  onStart(sim) {}, onEnd() {}, onError(e) {},
});
ctl.play('Letter pile');  ctl.stop();  ctl.arm();  ctl.disarm();  ctl.sim;  ctl.active;
```

While it runs, dragging on the page pushes the sand around and grabs or throws bodies.
It does nothing on browsers without WebGL2, and nothing when the viewer prefers reduced motion.

### Presets

| Preset | What happens |
|---|---|
| **Avalanche** | words fall as rigid bodies while the paper pours over them as sand |
| **Letter pile** | every glyph is its own rigid body |
| **Collapse** | whole lines and images fall, with a little wind |
| **Sand pour** | the paper is thrown above the page and poured onto solid, pinned letters |
| **Endless pour** | same, but what leaves the bottom re-enters at the top, forever |
| **Hourglass** | endless pour through a narrow spout (`spoutX`, `spoutW`) |
| **Sandstorm** | wind on everything that is not text; lightness becomes depth, lifted grains brighten |
| **Ink falls** | only the dark pixels get gravity; the light ones are viscous |
| **Melt** | gravity on everything, drag by lightness |
| **Reassemble** | a critically damped spring back to the original page |

The pours enter from the top edge, so a `solid` element spanning the top of the viewport (a sticky header, say)
will catch the sand. Leave such elements unmarked, or mark them `frame`, on pages that use those presets.

Everything a preset sets is a parameter you can set yourself with `sim.set({...})`: gravity, wind
direction and turbulence, viscosity, spring, each gated by a selector (all / text / non-text /
dark / light), plus rigid-body granularity (lines, words, letters), solidity, pile depth, recycling,
backdrop colour, mouse force. The playground exposes all of them.

## Lower-level API

| | |
|---|---|
| `new Dereliction.Sim(canvas, {params, onStats})` | the simulation on your own canvas: `load(scene)`, `applyPreset(name|obj)`, `set(partial)`, `scatter(sel)`, `reset()`, `start()/stop()`, `fit()`, `dispose()` |
| `captureDom({resolution, ignore})` | client-side scene: renders the viewport twice with html2canvas (with and without text) and reads glyph boxes from the live DOM |
| `captureStatic({manifest})` | scene from prerendered full-page captures (see below), cropped to the scroll position |
| `captureServer({endpoint, url, width, height})` | scene from the optional capture service |
| `extractRects(document)` | per-glyph rects and shapes with roles |
| `PRESETS`, `DEFAULTS`, `SEL` | presets, parameter defaults, selector names |

A *scene* is `{ shot, notext, chars, shapes, w, h }`: two renders of the page (canvas or image),
glyph rects `[x, y, w, h, role]` and shape rects.

## Pixel-perfect captures (optional)

Client-side capture re-paints the page with html2canvas, which is faithful for most pages but not
for every CSS feature. Two optional ways to use the browser's own rendering instead:

- **Prerender at build time.** `prerender.py` renders your pages at a list of widths with
  headless Chromium and writes PNGs, glyph rects and a `manifest.json` into your site. The
  library uses them when the window width matches exactly and falls back to client-side otherwise.
  ```sh
  uv run prerender.py --base http://localhost:8080 --out ./public/physics --pages / /about/ --widths 1280 1440 1512 1680 1920
  ```
- **A capture service.** `server.py` renders any allowed URL on demand (`DERELICTION_ALLOW`, `DERELICTION_CACHE`);
  `deploy/docker/` has a Dockerfile and compose file. Use it with `capture: 'server'`.

## Development

```sh
uv sync && uv run playwright install chromium   # Python side: capture server, prerender, tests
uv run server.py                                # http://localhost:8008/web/  (playground)
npm install && npm run build                    # dist/ (minified lib + all-in-one bundle)
uv run python tests/smoke.py                    # headless smoke test (needs the server running)
```

## How it works

Two renders of the page, one with the text made transparent, are diffed into a pixel-exact ink
mask. Particle state lives in float textures; one fragment shader is the physics step, one vertex
shader draws `W×H` points. Every force is gated by a selector (CIE L\* is computed in-shader, so
"gravity on the dark pixels" is a uniform). Rigid bodies live in matter.js; their transforms are
uploaded as a small texture each frame and the particles inside a body follow it. The bodies are
also rasterised every frame into an obstacle map (glyph bodies textured with the ink mask), which
is what the sand piles on, even while the letters are falling. Points are drawn with a depth test, text
bodies in front, then loose particles, then shapes and frames, so a block's ground never paints over the
words that fell past it; each frame also draws its ground colour as a quad behind its particles.

Chrome, Firefox and Safari 15+ (WebGL2 with `EXT_color_buffer_float`).

## License

MIT © Ori Pekelman. Bundled: [matter-js](https://brm.io/matter-js/) (MIT) and
[html2canvas](https://html2canvas.hertzen.com/) (MIT).
