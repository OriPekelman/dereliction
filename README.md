# Physical Web — pixels with mass

Give a web page physics. Every pixel of the rendered page becomes a GPU particle; glyphs,
images and author-marked elements become rigid bodies. Gravity by colour, wind with curl-noise
turbulence, viscosity by lightness, sand that pours (endlessly, if you like) over solid letters,
letters that fall into a pile. Works as a playground, and as a drop-in library that "happens" to
a live page after a few idle seconds.

```
lib/physical-web.js   the library (plain script, no build; ~45 KB)
web/index.html        playground / control panel
web/live-demo.html    a normal page with the library attached (idle → avalanche)
web/physics-test.html fixture for the CSS --physics roles
server.py             optional capture service (Playwright) + static file server
prerender.py          optional build-time captures for a static site
deploy/evo/           Dockerfile + compose for the capture service (not deployed)
```

## Run locally

```sh
uv sync && uv run playwright install chromium   # once
uv run server.py                                # http://localhost:8008/web/
```

The playground captures any URL through the server, or captures its own DOM with no server
(button "Capture this page"), or draws a built-in demo page. The live demo at
`/web/live-demo.html` needs no server at all.

## Library

```html
<script src="/js/physical-web.js"></script>
<script>
  PhysicalWeb.attach({
    idle: 8000,            // ms without pointer/key/scroll activity before it starts
    preset: 'Avalanche',   // any PhysicalWeb.PRESETS name, or a params object
    capture: 'auto',       // 'auto' = static manifest if one matches, else client-side DOM
    manifest: '/physics/manifest.json',   // optional, from prerender.py
    // server: 'https://physics.example.com/capture', capture: 'server'   // optional
    exitOn: ['wheel', 'keydown', 'touchmove', 'scroll'],   // ends the effect: reassemble, then remove overlay
    once: false,
  });
</script>
```

`attach()` returns a controller: `play(preset)`, `stop()`, `arm()`, `disarm()`, `.sim`, `.active`.
While the effect runs, dragging on the page pushes particles and grabs/throws bodies; scrolling,
the wheel or a key reassembles the page and removes the overlay.

Lower-level pieces, all on `PhysicalWeb`:

| | |
|---|---|
| `new Sim(canvas, {params, onStats})` | the simulation; `load(scene)`, `applyPreset(name|obj)`, `set(partial)`, `scatter(sel)`, `reset()`, `start()/stop()`, `fit()`, `dispose()` |
| `captureDom({resolution, ignore})` | client-only: renders the viewport twice with html2canvas (with and without text) and extracts rects from the live DOM |
| `captureServer({endpoint, url, width, height, scrollY})` | asks server.py for a headless-Chromium capture |
| `captureStatic({manifest, path})` | uses prerendered full-page captures, cropped to the current scroll position; `null` if no exact-width match |
| `extractRects(document)` | per-glyph rects + shapes with roles; the server and prerender inject this same function into the page |
| `PRESETS`, `DEFAULTS`, `SEL` | presets, parameter defaults, selector names |

Runtime dependencies are loaded from cdnjs when missing: matter-js 0.20.0 (rigid bodies) and
html2canvas 1.4.1 (DOM capture). Vendor them next to the library for a static site and pass
`matterUrl` / `html2canvasUrl`, or just include them with `<script>` tags before the library.

Browser support: WebGL2 with `EXT_color_buffer_float` (Chrome, Firefox, Safari 15+). The particle
count is the viewport area; `attach` lowers the capture resolution automatically above
`maxParticles` (1.4M).

### Author control in the page

An inheriting CSS custom property or a data attribute decides what an element is:

```css
header        { --physics: solid; }   /* one static block: never moves, sand piles on it */
.card         { --physics: rigid; }   /* the whole element is one rigid body, text included */
.block        { --physics: frame; }   /* a hollow rigid block: it falls as one body and its words fall inside it */
.footnotes    { --physics: sand;  }   /* its text is loose particles, never a body */
```
```html
<aside data-physics="solid">…</aside>
```
Defaults: text glyphs are bodies (lines, words or letters by `granularity`), `img/svg/video/canvas`
are rigid shapes, everything else is sand.

### Presets

| Preset | What it does |
|---|---|
| Ink falls | dark pixels get gravity, light pixels get viscosity |
| Sandstorm | wind on non-text, text pinned, L\* as depth with lift and shading |
| Sand pour | background thrown above the page and poured onto solid, pinned letters |
| Endless pour | same, but what leaves the bottom re-enters at the top, forever |
| Hourglass | endless pour through a narrow spout (`spoutX`, `spoutW`) |
| Collapse | lines of text and images fall as rigid bodies |
| Letter pile | every glyph is its own rigid body |
| Avalanche | words fall as rigid bodies while the background pours over them as sand |
| Melt | gravity on everything, drag proportional to lightness² |
| Reassemble | critically damped spring back to the original page |

## Three ways to get the pixels

1. **Client-only (`dom`)** — html2canvas re-renders the live DOM in the browser. No server,
   exact viewport size, exact scroll position. Costs 1–3 s of CPU on a big page (done during idle),
   and html2canvas is a re-implementation of CSS painting, so exotic CSS may differ from what the
   browser showed. Fonts already loaded by the page render fine. This is the default.
2. **Prerendered (`static`)** — `prerender.py` renders each page at a set of widths with real
   Chromium at build time and writes PNGs + rects + `manifest.json` into the site. Pixel-perfect,
   zero runtime cost, but only used when `window.innerWidth` matches a prerendered width exactly
   (layout depends on width); otherwise it falls back to `dom`.
   ```sh
   uv run prerender.py --base http://localhost:8080 --out ../pekelman.com/physics \
       --pages /index.htm /poemes.htm --widths 1280 1440 1512 1680 1920
   ```
3. **Server (`server`)** — `server.py` renders any URL on demand in headless Chromium, with an
   allowlist (`PW_ALLOW`), a capture cache (`PW_CACHE`) and CORS. Pixel-perfect at any size, but
   it is a public service to run and it adds a round trip. `deploy/evo/` has a Dockerfile and a
   compose file for running it on evo behind the existing cloudflared tunnel; nothing is deployed.

For a static site like pekelman.com the recommendation is 1 (+ 2 for the common widths). No
service on evo is needed for that.

## How it works

Two screenshots, one with all text made transparent, are diffed into a pixel-exact ink mask.
Particle state lives in RGBA32F ping-pong framebuffers; one fragment shader is the physics step,
one vertex shader draws `W×H` points via `gl_VertexID`. Every force is gated by a selector
(all / text / non-text / dark / light, with CIE L\* computed in-shader). Rigid bodies live in
matter.js; their transforms are uploaded as a small float texture each frame and particles inside a
body follow it. The bodies are also rasterised each frame into an obstacle map (glyph bodies
textured with the ink mask), which free particles collide with, so sand piles on the letters even
while the letters are falling. With `recycle`, particles that leave the page re-enter at the top
through the spout.
