/*! physical-web — give the pixels of a web page mass.
 *
 *  Every pixel of a captured page becomes a GPU particle (WebGL2). Glyphs, images and
 *  author-marked elements become rigid bodies (matter.js). Free particles collide with
 *  the bodies, so sand pours over letters; letters can fall into a pile.
 *
 *  Plain script: defines window.PhysicalWeb. Optional runtime deps are loaded on demand
 *  from cdnjs unless already present on the page (or you vendor them):
 *    - matter-js   (rigid bodies)            window.Matter
 *    - html2canvas (client-only DOM capture) window.html2canvas
 *
 *  Quick use on a live page:
 *    <script src="physical-web.js"></script>
 *    <script>PhysicalWeb.attach({ idle: 8000, preset: 'Avalanche' });</script>
 *
 *  Author control in the page's CSS (inherits) or markup:
 *    header { --physics: solid; }   .card { --physics: rigid; }   .loose { --physics: sand; }
 *    <aside data-physics="solid">
 */
(function (global) {
'use strict';

const VERSION = '0.2.0';
const CDN = {
  matter: 'https://cdnjs.cloudflare.com/ajax/libs/matter-js/0.20.0/matter.min.js',
  html2canvas: 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js',
};

const HIDE_TEXT_CSS = `
*, *::before, *::after {
  color: transparent !important;
  -webkit-text-fill-color: transparent !important;
  text-shadow: none !important;
  caret-color: transparent !important;
  text-decoration-color: transparent !important;
}
::placeholder { color: transparent !important; }
svg text, svg tspan { fill: transparent !important; stroke: transparent !important; }
`;
const FREEZE_CSS = `
*, *::before, *::after { animation-play-state: paused !important; transition: none !important; }
html { scroll-behavior: auto !important; }
`;

// ------------------------------------------------------------------ DOM rect extraction
// Per-glyph rects for visible text, plus "shapes": img/svg/video/canvas and any element
// marked --physics: rigid|solid (CSS custom property, inherits) or data-physics="...".
// Roles: 0 default (rigid when rigid mode is on), 1 solid (never moves, blocks sand), 2 sand.
function extractRects(doc, opts) {
  doc = doc || document; opts = opts || {};
  const win = doc.defaultView;
  const W = opts.width || win.innerWidth, H = opts.height || win.innerHeight;
  const ignore = opts.ignore || (() => false);
  const ROLE = { '': 0, default: 0, rigid: 0, solid: 1, sand: 2, particles: 2, none: 2 };
  const roleOf = (el) => {
    const v = win.getComputedStyle(el).getPropertyValue('--physics').trim().toLowerCase();
    if (v) return v;
    const a = el.closest('[data-physics]');
    return a ? (a.dataset.physics || '').trim().toLowerCase() : '';
  };
  const visible = (b) => b.width >= 0.5 && b.height >= 0.5 && b.right >= 0 && b.bottom >= 0 && b.left <= W && b.top <= H;
  const skip = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TITLE']);

  const shapes = [];
  const shaped = new Set();
  for (const el of doc.body.querySelectorAll('*')) {
    if (skip.has(el.tagName) || ignore(el)) continue;
    const v = roleOf(el);
    if (v !== 'rigid' && v !== 'solid') continue;
    const pv = el.parentElement && el.parentElement !== doc.documentElement ? roleOf(el.parentElement) : '';
    if (pv === v) continue;
    const b = el.getBoundingClientRect();
    if (!visible(b)) continue;
    shapes.push([b.left, b.top, b.width, b.height, ROLE[v]]);
    shaped.add(el);
  }
  const insideShape = (el) => { for (let e = el; e; e = e.parentElement) if (shaped.has(e)) return true; return false; };
  const ignored = (el) => { for (let e = el; e; e = e.parentElement) if (ignore(e)) return true; return false; };

  const chars = [];
  const walker = doc.createTreeWalker(doc.body, 4 /* SHOW_TEXT */);
  const range = doc.createRange();
  let n;
  while ((n = walker.nextNode())) {
    const s = n.nodeValue;
    if (!s || !s.trim()) continue;
    const el = n.parentElement;
    if (!el || skip.has(el.tagName)) continue;
    const cs = win.getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || parseFloat(cs.opacity) === 0) continue;
    if (insideShape(el) || ignored(el)) continue;
    const role = ROLE[roleOf(el)] ?? 0;
    range.selectNodeContents(n);
    if (!visible(range.getBoundingClientRect())) continue;
    for (let i = 0; i < s.length; i++) {
      if (/\s/.test(s[i])) continue;
      range.setStart(n, i); range.setEnd(n, i + 1);
      for (const b of range.getClientRects()) {
        if (!visible(b)) continue;
        chars.push([Math.round(b.left * 10) / 10, Math.round(b.top * 10) / 10,
                    Math.round(b.width * 10) / 10, Math.round(b.height * 10) / 10, role]);
        break;
      }
    }
  }
  for (const el of doc.querySelectorAll('img, svg, video, canvas')) {
    if (el.closest('svg') && el.tagName.toLowerCase() !== 'svg') continue;
    if (insideShape(el) || ignored(el)) continue;
    const b = el.getBoundingClientRect();
    if (b.width < 4 || b.height < 4 || !visible(b)) continue;
    const cs = win.getComputedStyle(el);
    if (cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) continue;
    const r = roleOf(el);
    if (r === 'sand') continue;
    shapes.push([b.left, b.top, b.width, b.height, ROLE[r] ?? 0]);
  }
  return { chars, shapes, w: W, h: H };
}

// ------------------------------------------------------------------ shaders
const GLSL_HEADER = `#version 300 es
precision highp float; precision highp int; precision highp sampler2D;
`;
const GLSL_LAB = `
float labL(vec3 c){
  vec3 lin = mix(c/12.92, pow((c+0.055)/1.055, vec3(2.4)), step(0.04045, c));
  float Y = dot(lin, vec3(0.2126, 0.7152, 0.0722));
  float f = Y > 0.008856 ? pow(Y, 1.0/3.0) : 7.787*Y + 16.0/116.0;
  return clamp((116.0*f - 16.0)/100.0, 0.0, 1.0);
}
float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
`;
const GLSL_NOISE = `
vec3 mod289(vec3 x){return x - floor(x*(1.0/289.0))*289.0;}
vec4 mod289(vec4 x){return x - floor(x*(1.0/289.0))*289.0;}
vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159 - 0.85373472095314*r;}
float snoise(vec3 v){
  const vec2 C = vec2(1.0/6.0, 1.0/3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(i.z + vec4(0.0, i1.z, i2.z, 1.0)) + i.y + vec4(0.0, i1.y, i2.y, 1.0)) + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0)*2.0 + 1.0;
  vec4 s1 = floor(b1)*2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw*sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw*sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
}
vec2 curl(vec2 p, float t){
  float e = 0.02;
  vec3 q = vec3(p, t);
  float dx = snoise(q + vec3(e,0,0)) - snoise(q - vec3(e,0,0));
  float dy = snoise(q + vec3(0,e,0)) - snoise(q - vec3(0,e,0));
  return vec2(dy, -dx) / (2.0*e);
}
`;
const VS_FULL = GLSL_HEADER + `
void main(){ vec2 p = vec2(float((gl_VertexID<<1)&2), float(gl_VertexID&2)); gl_Position = vec4(p*2.0-1.0, 0.0, 1.0); }`;

const FS_INIT = GLSL_HEADER + GLSL_LAB + `
uniform sampler2D uShot;
layout(location=0) out vec4 oPos;
layout(location=1) out vec4 oVel;
void main(){
  ivec2 t = ivec2(gl_FragCoord.xy);
  vec3 c = texelFetch(uShot, t, 0).rgb;
  oPos = vec4(vec2(t) + 0.5, labL(c), 1.0);
  oVel = vec4(0.0);
}`;

const FS_SIM = GLSL_HEADER + GLSL_LAB + GLSL_NOISE + `
uniform sampler2D uPos, uVel, uShot, uMask, uGroup, uBodyNow, uBodyHome, uObs;
uniform vec2 uRes; uniform float uDt, uTime;
uniform vec2 uGravity; uniform int uGravSel;
uniform float uWind, uTurb, uLift, uNoiseScale; uniform vec2 uWindDir; uniform int uWindSel;
uniform float uDrag, uLightDrag; uniform int uDragSel;
uniform float uSpring; uniform int uSpringSel;
uniform int uFloor, uRigid, uSolid, uBodyW, uScatterSel, uRecycle;
uniform float uPile; uniform vec2 uSpout;
uniform vec2 uMouse; uniform float uMouseR, uMouseF;
layout(location=0) out vec4 oPos;
layout(location=1) out vec4 oVel;

float sel(int s, float isText, float L){
  if (s == 0) return 1.0;
  if (s == 1) return isText;
  if (s == 2) return 1.0 - isText;
  if (s == 3) return smoothstep(0.78, 0.30, L);
  if (s == 4) return smoothstep(0.30, 0.78, L);
  return 1.0;
}
float obstacle(vec2 p){
  ivec2 t = ivec2(floor(p));
  if (t.x < 0 || t.y < 0 || t.x >= int(uRes.x) || t.y >= int(uRes.y)) return 0.0;
  return texelFetch(uObs, t, 0).r;
}
vec2 spawnTop(vec2 seed){
  float r1 = hash(seed), r2 = hash(seed.yx * 1.91 + 3.0);
  float x = (uSpout.x + (r1 - 0.5) * uSpout.y) * uRes.x;
  return vec2(clamp(x, 0.5, uRes.x - 0.5), -4.0 - r2 * 60.0);
}
void main(){
  ivec2 t = ivec2(gl_FragCoord.xy);
  vec2 home = vec2(t) + 0.5;
  vec4 P = texelFetch(uPos, t, 0);
  vec4 V = texelFetch(uVel, t, 0);
  vec3 col = texelFetch(uShot, t, 0).rgb;
  float L = labL(col);
  float ink = texelFetch(uMask, t, 0).r;
  float isText = step(0.12, ink);
  ivec4 g = ivec4(texelFetch(uGroup, t, 0) * 255.0 + 0.5);
  int body = g.r + 256 * g.g - 1;
  int gtype = g.b;
  int role = g.a;
  if (role == 2) isText = 0.0;
  bool rigidPart = body >= 0 && (gtype == 2 || isText > 0.5) && (uRigid == 1 || role == 1);
  vec2 pos = P.xy; float z = P.z; vec3 vel = V.xyz;
  float dt = uDt;
  float rnd = hash(home);
  float rnd2 = hash(home.yx * 1.37 + 7.0);

  if (uScatterSel >= 0 && sel(uScatterSel, isText, L) > 0.5 && !rigidPart) {
    pos = vec2(home.x + (rnd2 - 0.5) * 60.0, -rnd * uRes.y * 1.6 - 8.0);
    if (uSpout.y < 0.999) pos = spawnTop(home) - vec2(0.0, rnd * uRes.y * 1.6);
    vel = vec3(0.0);
    oPos = vec4(pos, z, 1.0); oVel = vec4(vel, 0.0); return;
  }

  if (rigidPart) {
    ivec2 bt = ivec2(body % uBodyW, body / uBodyW);
    vec4 now = texelFetch(uBodyNow, bt, 0);
    vec4 bh  = texelFetch(uBodyHome, bt, 0);
    vec2 rel = home - bh.xy;
    vec2 np = now.xy + vec2(rel.x*now.z - rel.y*now.w, rel.x*now.w + rel.y*now.z);
    vel = vec3((np - pos) / max(dt, 1e-4), 0.0);
    if (length(vel.xy) > 4000.0) vel = vec3(0.0);
    pos = np;
  } else {
    vel.xy += uGravity * dt * sel(uGravSel, isText, L);
    float ws = sel(uWindSel, isText, L);
    if (uWind > 0.0 && ws > 0.0) {
      vec2 c = curl(pos * uNoiseScale, uTime * 0.25);
      vec2 w = uWindDir * uWind + c * uWind * uTurb * 0.6;
      float expose = mix(1.0, 0.35 + z, uLift);
      vel.xy += w * dt * ws * (0.5 + rnd) * expose;
      vel.z += (snoise(vec3(pos * uNoiseScale * 2.0, uTime * 0.5)) * 0.6 + 0.25) * uWind * 0.0025 * dt * ws * uLift;
    }
    if (uMouseF != 0.0) {
      vec2 d = pos - uMouse; float r = length(d);
      if (r < uMouseR) vel.xy += (d / max(r, 1e-3)) * uMouseF * (1.0 - r / uMouseR) * dt;
    }
    float ss = sel(uSpringSel, isText, L);
    if (uSpring > 0.0 && ss > 0.0) {
      vel.xy += (home - pos) * uSpring * dt * ss;
      vel.z  += (L - z) * uSpring * dt * ss;
      vel *= exp(-2.0 * sqrt(uSpring) * dt * ss);
    }
    float dr = uDrag * sel(uDragSel, isText, L) + uLightDrag * L * L;
    vel *= exp(-dr * dt);

    vec2 np = pos + vel.xy * dt;
    z = clamp(z + vel.z * dt, 0.0, 1.6);

    if (uSolid == 1 && isText < 0.5) {
      vec2 look = vec2(0.0, rnd * uPile);
      if (obstacle(np + look) > 0.3) {
        vec2 nx = vec2(np.x, pos.y);
        if (obstacle(nx + look) < 0.3 && obstacle(nx) < 0.3) {
          np = nx; vel.y = -vel.y * 0.1; vel.x += (rnd2 - 0.5) * 60.0;
        } else {
          np = pos; vel.xy *= 0.0; vel.x += (hash(pos + uTime) - 0.5) * 90.0;
          if (obstacle(pos) > 0.3) np.y -= 1.0;
        }
      }
    }
    pos = np;

    if (uFloor == 1) {
      float fy = uRes.y - 70.0 * rnd * rnd;
      if (vel.y > 0.0 && pos.y > fy && pos.y - vel.y * dt <= fy + 2.0) { pos.y = fy; vel.y = -abs(vel.y) * 0.15; vel.x *= 0.6; }
      if (pos.y > uRes.y - 0.5) { pos.y = uRes.y - 0.5; vel.y = -abs(vel.y) * 0.15; }
      if (pos.x < 0.5) { pos.x = 0.5; vel.x = abs(vel.x) * 0.3; }
      if (pos.x > uRes.x - 0.5) { pos.x = uRes.x - 0.5; vel.x = -abs(vel.x) * 0.3; }
    } else if (uRecycle == 1 && isText < 0.5 && (pos.y > uRes.y + 6.0 || pos.x < -40.0 || pos.x > uRes.x + 40.0)) {
      // endless pour: anything that leaves the page comes back in at the top (through the spout)
      pos = spawnTop(pos + uTime);
      vel = vec3(0.0, 0.0, 0.0);
    }
  }
  oPos = vec4(pos, z, 1.0);
  oVel = vec4(vel, 0.0);
}`;

const VS_POINTS = GLSL_HEADER + GLSL_LAB + `
uniform sampler2D uPos, uShot;
uniform vec2 uRes; uniform int uW; uniform float uPointSize, uDepthShade;
out vec4 vColor;
void main(){
  int id = gl_VertexID;
  ivec2 t = ivec2(id % uW, id / uW);
  vec4 P = texelFetch(uPos, t, 0);
  vec3 c = texelFetch(uShot, t, 0).rgb;
  float L = labL(c);
  float dz = P.z - L;
  vColor = vec4(c * (1.0 + uDepthShade * dz * 1.8), 1.0);
  vec2 p = P.xy;
  if (p.x < -4.0 || p.y < -4.0 || p.x > uRes.x + 4.0 || p.y > uRes.y + 4.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 1.0; return; }
  gl_Position = vec4(p.x / uRes.x * 2.0 - 1.0, 1.0 - p.y / uRes.y * 2.0, 0.0, 1.0);
  gl_PointSize = uPointSize * (1.0 + uDepthShade * max(dz, 0.0) * 2.5);
}`;
const FS_POINTS = GLSL_HEADER + `in vec4 vColor; out vec4 o; void main(){ o = vColor; }`;

const VS_OBS = GLSL_HEADER + `
uniform sampler2D uBodyNow, uBodyHome;
uniform vec2 uRes; uniform int uBodyW;
out vec2 vHome; out float vType;
void main(){
  int b = gl_InstanceID;
  ivec2 bt = ivec2(b % uBodyW, b / uBodyW);
  vec4 now = texelFetch(uBodyNow, bt, 0);
  vec4 bh  = texelFetch(uBodyHome, bt, 0);
  int v = gl_VertexID;
  vec2 corner = vec2(float((v == 1 || v == 2 || v == 4) ? 1 : 0), float((v == 2 || v == 4 || v == 5) ? 1 : 0));
  vec2 rel = (corner - 0.5) * (vec2(bh.z, abs(bh.w)) + 1.0);
  vHome = bh.xy + rel;
  vType = bh.w < 0.0 ? 2.0 : 1.0;
  vec2 p = now.xy + vec2(rel.x*now.z - rel.y*now.w, rel.x*now.w + rel.y*now.z);
  gl_Position = vec4(p.x / uRes.x * 2.0 - 1.0, p.y / uRes.y * 2.0 - 1.0, 0.0, 1.0);
}`;
const FS_OBS = GLSL_HEADER + `
uniform sampler2D uMask; uniform vec2 uRes;
in vec2 vHome; in float vType;
out vec4 o;
void main(){
  if (vType > 1.5) { o = vec4(1.0); return; }
  ivec2 t = ivec2(floor(vHome));
  float m = 0.0;
  for (int dy = -1; dy <= 1; dy++) for (int dx = -1; dx <= 1; dx++) {
    ivec2 q = t + ivec2(dx, dy);
    if (q.x >= 0 && q.y >= 0 && q.x < int(uRes.x) && q.y < int(uRes.y)) m = max(m, texelFetch(uMask, q, 0).r * (dx == 0 && dy == 0 ? 1.0 : 0.8));
  }
  if (m < 0.12) discard;
  o = vec4(1.0);
}`;

// ------------------------------------------------------------------ parameters & presets
const SEL = ['all pixels', 'text', 'non-text', 'dark pixels', 'light pixels'];
const DEFAULTS = {
  gravity: 0, gravSel: 3,
  wind: 0, windDir: 0, turb: 1.0, lift: 0, windSel: 2,
  drag: 0, dragSel: 0, lightDrag: 0,
  spring: 0, springSel: 0,
  floor: true, depthShade: false, rigid: false, solid: false, recycle: false,
  spoutX: 0.5, spoutW: 1,           // where recycled sand re-enters (fractions of width; spoutW 1 = whole top edge)
  granularity: 'lines', pile: 6, mouseF: 900, mouseR: 90, noiseScale: 0.004, timeScale: 1, backdrop: '#3f4654',
};
// `scatter` is a one-shot action, not a parameter: particles matching the selector are thrown above the page.
const PRESETS = {
  'Still':         {},
  'Ink falls':     { gravity: 1100, gravSel: 3, drag: 4, dragSel: 4, floor: true },
  'Sandstorm':     { wind: 800, windDir: 0, turb: 1.3, lift: 0.8, windSel: 2, spring: 120, springSel: 1, drag: 0.4, dragSel: 0, floor: false, depthShade: true },
  'Sand pour':     { gravity: 1400, gravSel: 2, spring: 200, springSel: 1, solid: true, floor: true, pile: 8, drag: 0.6, dragSel: 2, scatter: 2 },
  'Endless pour':  { gravity: 1400, gravSel: 2, spring: 200, springSel: 1, solid: true, floor: false, recycle: true, pile: 8, drag: 0.6, dragSel: 2, scatter: 2 },
  'Hourglass':     { gravity: 1600, gravSel: 2, spring: 200, springSel: 1, solid: true, floor: false, recycle: true, spoutX: 0.5, spoutW: 0.12, pile: 10, drag: 0.5, dragSel: 2, scatter: 2 },
  'Collapse':      { rigid: true, wind: 120, turb: 2.0, windSel: 2, lift: 0.3, floor: false, depthShade: true },
  'Letter pile':   { rigid: true, granularity: 'letters', wind: 60, turb: 2.5, windSel: 2, floor: false },
  'Avalanche':     { rigid: true, granularity: 'words', solid: true, gravity: 900, gravSel: 2, floor: true, pile: 10, drag: 0.5, dragSel: 2 },
  'Melt':          { gravity: 700, gravSel: 0, lightDrag: 9, floor: true },
  'Reassemble':    { spring: 90, springSel: 0, floor: false },
};
const KEEP_ACROSS_PRESETS = ['mouseF', 'mouseR', 'timeScale', 'backdrop'];

// ------------------------------------------------------------------ helpers
const loaded = {};
function ensureScript(url, globalName) {
  if (global[globalName]) return Promise.resolve(global[globalName]);
  if (!loaded[url]) loaded[url] = new Promise((res, rej) => {
    const s = document.createElement('script'); s.src = url; s.async = true;
    s.onload = () => res(global[globalName]); s.onerror = () => rej(new Error('failed to load ' + url));
    document.head.appendChild(s);
  });
  return loaded[url];
}
function toCanvas(src, W, H) {
  if (src instanceof HTMLCanvasElement && src.width === W && src.height === H) return src;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  c.getContext('2d').drawImage(src, 0, 0, W, H);
  return c;
}
function loadImg(src) { return new Promise((res, rej) => { const i = new Image(); i.crossOrigin = 'anonymous'; i.onload = () => res(i); i.onerror = rej; i.src = src; }); }
function parseColor(c) {
  const m = String(c).match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/);
  if (m) return [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]];
  const h = String(c).replace('#', '');
  if (h.length === 3) return [parseInt(h[0] + h[0], 16), parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16), 1];
  if (h.length === 6) return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 1];
  return null;
}
function hex(r, g, b) { return '#' + [r, g, b].map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join(''); }
// A backdrop that keeps the page's hue but sits in the mid-dark range, so both light sand and dark ink read on it.
function autoBackdrop(doc) {
  doc = doc || document;
  let bg = null;
  for (const el of [doc.body, doc.documentElement]) {
    const c = parseColor(doc.defaultView.getComputedStyle(el).backgroundColor);
    if (c && c[3] > 0) { bg = c; break; }
  }
  if (!bg) bg = [255, 255, 255, 1];
  const lum = (0.2126 * bg[0] + 0.7152 * bg[1] + 0.0722 * bg[2]) / 255;
  const target = 0.27, k = lum > 0.001 ? target / lum : 1;
  const mix = (v) => v * k * 0.75 + 60 * 0.25;         // scale toward target luminance, then nudge toward neutral
  return hex(mix(bg[0]), mix(bg[1]), mix(bg[2]));
}
function mergeRects(rects, gapFactor) {
  const out = [];
  const rs = rects.map(r => ({ x: r[0], y: r[1], w: r[2], h: r[3] })).filter(r => r.w >= 0.5 && r.h >= 0.5).sort((p, q) => p.y - q.y || p.x - q.x);
  for (const r of rs) {
    let hit = null;
    for (let i = out.length - 1; i >= 0; i--) {
      const l = out[i];
      if (l.y > r.y + r.h + 40) continue;
      const ov = Math.min(l.y + l.h, r.y + r.h) - Math.max(l.y, r.y);
      if (ov < 0.55 * Math.min(l.h, r.h)) continue;
      const gap = Math.max(l.x, r.x) - Math.min(l.x + l.w, r.x + r.w);
      if (gap > gapFactor * Math.max(l.h, r.h)) continue;
      hit = l; break;
    }
    if (hit) {
      const x0 = Math.min(hit.x, r.x), y0 = Math.min(hit.y, r.y);
      hit.w = Math.max(hit.x + hit.w, r.x + r.w) - x0; hit.h = Math.max(hit.y + hit.h, r.y + r.h) - y0; hit.x = x0; hit.y = y0;
    } else out.push({ ...r });
  }
  return out;
}

// ------------------------------------------------------------------ the simulation
class Sim {
  /** @param {HTMLCanvasElement} canvas  @param {{params?:object, pointer?:boolean, onStats?:Function}} opts */
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.params = { ...DEFAULTS, ...(opts.params || {}) };
    this.onStats = opts.onStats || null;
    this.scene = null; this.bodies = []; this.engine = null; this.granularity = null;
    this.running = false; this.time = 0; this.last = 0; this.frames = 0; this.fpsT = 0; this.fps = 0;
    this.scatterSel = -1; this.pointSize = 1; this.scale = 1;
    this.pointer = { x: 0, y: 0, down: false };
    this.bodyW = 1024; this.bodyRows = 1;
    const gl = this.gl = canvas.getContext('webgl2', { antialias: false, alpha: false, depth: false, powerPreference: 'high-performance', preserveDrawingBuffer: false });
    if (!gl) throw new Error('physical-web: WebGL2 is required');
    if (!gl.getExtension('EXT_color_buffer_float')) throw new Error('physical-web: EXT_color_buffer_float is required');
    this.progInit = this._program(VS_FULL, FS_INIT);
    this.progSim = this._program(VS_FULL, FS_SIM);
    this.progPts = this._program(VS_POINTS, FS_POINTS);
    this.progObs = this._program(VS_OBS, FS_OBS);
    gl.bindVertexArray(gl.createVertexArray());
    this.tex = {}; this.pos = []; this.vel = []; this.fb = []; this.cur = 0;
    this._frame = this._frame.bind(this);
    if (opts.pointer !== false) this._bindPointer();
    this._onResize = () => this.fit();
    global.addEventListener('resize', this._onResize);
  }

  // --- GL plumbing
  _compile(type, src) {
    const gl = this.gl, s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('physical-web shader: ' + gl.getShaderInfoLog(s));
    return s;
  }
  _program(vs, fs) {
    const gl = this.gl, p = gl.createProgram();
    gl.attachShader(p, this._compile(gl.VERTEX_SHADER, vs)); gl.attachShader(p, this._compile(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('physical-web link: ' + gl.getProgramInfoLog(p));
    p._u = {}; return p;
  }
  _U(p, name) { if (!(name in p._u)) p._u[name] = this.gl.getUniformLocation(p, name); return p._u[name]; }
  _tex(w, h, internal, format, type, data) {
    const gl = this.gl, t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, data);
    return t;
  }
  _bind(unit, t, prog, name) { const gl = this.gl; gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t); gl.uniform1i(this._U(prog, name), unit); }

  /** Load a scene: { shot, notext, chars, shapes, w, h } (shot/notext: canvas, image or bitmap at w×h). */
  load(scene) {
    const gl = this.gl;
    const W = scene.w, H = scene.h;
    const shotC = toCanvas(scene.shot, W, H), noC = toCanvas(scene.notext, W, H);
    const a = shotC.getContext('2d').getImageData(0, 0, W, H).data;
    const b = noC.getContext('2d').getImageData(0, 0, W, H).data;
    const mask = new Uint8Array(W * H * 4);
    let inkCount = 0;
    for (let i = 0; i < W * H; i++) {
      const d = Math.max(Math.abs(a[i*4] - b[i*4]), Math.abs(a[i*4+1] - b[i*4+1]), Math.abs(a[i*4+2] - b[i*4+2]));
      const v = Math.min(255, d * 3);
      mask[i*4] = v; mask[i*4+3] = 255;
      if (v > 30) inkCount++;
    }
    this.W = W; this.H = H; this.N = W * H;
    this.scene = { chars: scene.chars || [], shapes: scene.shapes || [], inkCount, W, H };
    this._freeGL();
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    const shot = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, shot);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, shotC);
    this.tex.shot = shot;
    this.tex.mask = this._tex(W, H, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, mask);
    this.tex.group = this._tex(W, H, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, null);
    this.tex.obs = this._tex(W, H, gl.R8, gl.RED, gl.UNSIGNED_BYTE, null);
    this.obsFb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, this.obsFb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.tex.obs, 0);
    for (let i = 0; i < 2; i++) {
      this.pos[i] = this._tex(W, H, gl.RGBA32F, gl.RGBA, gl.FLOAT, null);
      this.vel[i] = this._tex(W, H, gl.RGBA32F, gl.RGBA, gl.FLOAT, null);
      this.fb[i] = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, this.fb[i]);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.pos[i], 0);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, this.vel[i], 0);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('physical-web: sim framebuffer incomplete');
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.rebuildBodies();
    this.reset();
    this.fit();
    return this;
  }
  _freeGL() {
    const gl = this.gl;
    for (const t of [this.tex.shot, this.tex.mask, this.tex.group, this.tex.obs, this.tex.bodyNow, this.tex.bodyHome, ...this.pos, ...this.vel]) if (t) gl.deleteTexture(t);
    for (const f of [this.obsFb, ...this.fb]) if (f) gl.deleteFramebuffer(f);
    this.tex = {}; this.pos = []; this.vel = []; this.fb = []; this.obsFb = null;
  }

  /** Build rigid bodies at the current granularity (lines | words | letters) and the group texture. */
  rebuildBodies() {
    if (!this.scene || !global.Matter) { if (!global.Matter) this._matterMissing = true; return; }
    const { Engine, Bodies, Body, Composite, Mouse, MouseConstraint } = global.Matter;
    const gl = this.gl, P = this.params, { W, H, chars, shapes } = this.scene;
    this.granularity = P.granularity;
    const inShape = (r) => { const cx = r[0] + r[2] / 2, cy = r[1] + r[3] / 2; return shapes.some(sh => cx >= sh[0] && cx <= sh[0] + sh[2] && cy >= sh[1] && cy <= sh[1] + sh[3]); };
    const freeChars = chars.filter(r => !inShape(r));
    const bodyChars = freeChars.filter(r => (r[4] || 0) !== 2), sandChars = freeChars.filter(r => (r[4] || 0) === 2);
    const textRects = P.granularity === 'letters' ? bodyChars.map(r => ({ x: r[0], y: r[1], w: r[2], h: r[3] }))
                    : P.granularity === 'words' ? mergeRects(bodyChars, 0.16) : mergeRects(bodyChars, 1.1);
    const clip = (r, pad) => {
      const x0 = Math.max(0, Math.floor(r.x - pad)), y0 = Math.max(0, Math.floor(r.y - pad));
      const x1 = Math.min(W, Math.ceil(r.x + r.w + pad)), y1 = Math.min(H, Math.ceil(r.y + r.h + pad));
      return x1 - x0 >= 2 && y1 - y0 >= 2 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
    };
    let items = [];
    for (const r of shapes) { const c = clip({ x: r[0], y: r[1], w: r[2], h: r[3] }, 0); if (c && c.w * c.h < W * H * 0.6) items.push({ ...c, type: 2, role: r[4] || 0 }); }
    for (const r of textRects) { const c = clip(r, 1); if (c) items.push({ ...c, type: 1, role: 0 }); }
    const MAX = 3000;
    if (items.length > MAX) { items.sort((p, q) => q.w * q.h - p.w * p.h); items = items.slice(0, MAX); }

    const g = new Uint8Array(W * H * 4);
    for (const r of sandChars) {
      const c = clip({ x: r[0], y: r[1], w: r[2], h: r[3] }, 1); if (!c) continue;
      for (let y = c.y; y < c.y + c.h; y++) for (let x = c.x; x < c.x + c.w; x++) g[(y * W + x) * 4 + 3] = 2;
    }
    items.forEach((it, i) => {
      const id = i + 1;
      for (let y = it.y; y < it.y + it.h; y++) for (let x = it.x; x < it.x + it.w; x++) {
        const o = (y * W + x) * 4; g[o] = id & 255; g[o + 1] = id >> 8; g[o + 2] = it.type; g[o + 3] = it.role;
      }
    });
    gl.bindTexture(gl.TEXTURE_2D, this.tex.group);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, g);

    if (this.engine) Engine.clear(this.engine);
    this.engine = Engine.create({ enableSleeping: true, positionIterations: 6, velocityIterations: 4 });
    this.engine.gravity.y = 1;
    this.bodies = items.map(it => {
      const b = Bodies.rectangle(it.x + it.w / 2, it.y + it.h / 2, it.w, it.h, { restitution: 0.15, friction: 0.7, frictionAir: 0.012, density: it.type === 2 ? 0.002 : 0.001 });
      b.plugin.home = { x: it.x + it.w / 2, y: it.y + it.h / 2, w: it.w, h: it.h, type: it.type, role: it.role };
      Body.setStatic(b, true);
      return b;
    });
    const wall = { isStatic: true, friction: 0.8 };
    Composite.add(this.engine.world, [
      ...this.bodies,
      Bodies.rectangle(W / 2, H + 60, W * 3, 120, wall),
      Bodies.rectangle(-60, H / 2, 120, H * 4, wall),
      Bodies.rectangle(W + 60, H / 2, 120, H * 4, wall),
    ]);
    if (this.pointerEnabled) {
      if (this.mouse) this.mouse.element.removeEventListener('mousemove', this.mouse.mousemove);
      this.mouse = Mouse.create(this.canvas);
      this.mc = MouseConstraint.create(this.engine, { mouse: this.mouse, constraint: { stiffness: 0.25, damping: 0.1 } });
      Composite.add(this.engine.world, this.mc);
    }
    this.bodyRows = Math.max(1, Math.ceil(this.bodies.length / this.bodyW));
    if (this.tex.bodyNow) { gl.deleteTexture(this.tex.bodyNow); gl.deleteTexture(this.tex.bodyHome); }
    const home = new Float32Array(this.bodyW * this.bodyRows * 4);
    this.bodies.forEach((b, i) => { const h = b.plugin.home; home.set([h.x, h.y, h.w, h.type === 2 ? -h.h : h.h], i * 4); });
    this.tex.bodyHome = this._tex(this.bodyW, this.bodyRows, gl.RGBA32F, gl.RGBA, gl.FLOAT, home);
    this.bodyNowArr = new Float32Array(this.bodyW * this.bodyRows * 4);
    this.tex.bodyNow = this._tex(this.bodyW, this.bodyRows, gl.RGBA32F, gl.RGBA, gl.FLOAT, null);
    this._uploadBodies();
    if (P.rigid) this._setRigid(true, true);
    this.fit();
  }
  _uploadBodies() {
    if (!this.bodyNowArr) return;
    const gl = this.gl, a = this.bodyNowArr;
    this.bodies.forEach((b, i) => { a[i*4] = b.position.x; a[i*4+1] = b.position.y; a[i*4+2] = Math.cos(b.angle); a[i*4+3] = Math.sin(b.angle); });
    gl.bindTexture(gl.TEXTURE_2D, this.tex.bodyNow);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.bodyW, this.bodyRows, gl.RGBA, gl.FLOAT, a);
  }
  _setRigid(on, force) {
    if (!global.Matter) return;
    const { Body, Sleeping } = global.Matter;
    this.params.rigid = on;
    for (const b of this.bodies) {
      if (b.plugin.home.role === 1) continue;
      if (on) { if (b.isStatic) { Body.setStatic(b, false); Sleeping.set(b, false); } }
      else if (force || !b.isStatic) {
        Body.setStatic(b, true);
        Body.setPosition(b, { x: b.plugin.home.x, y: b.plugin.home.y }); Body.setAngle(b, 0);
        Body.setVelocity(b, { x: 0, y: 0 }); Body.setAngularVelocity(b, 0);
      }
    }
    this._uploadBodies();
  }

  /** Put every particle back on its home pixel (the page as captured). */
  reset() {
    if (!this.scene) return;
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fb[0]); gl.viewport(0, 0, this.W, this.H);
    gl.useProgram(this.progInit); this._bind(0, this.tex.shot, this.progInit, 'uShot');
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.cur = 0; this.time = 0;
    this._setRigid(false, true);
    if (this.params.rigid) this._setRigid(true);
  }
  /** Throw every particle matching a selector (0 all,1 text,2 non-text,3 dark,4 light) above the page. */
  scatter(sel = 2) { this.scatterSel = sel; }
  /** Change parameters; handles side effects (rigid toggling, granularity rebuild). */
  set(partial) {
    const before = { rigid: this.params.rigid, granularity: this.params.granularity };
    Object.assign(this.params, partial);
    if (this.scene && this.params.granularity !== this.granularity) this.rebuildBodies();
    if (this.params.rigid !== before.rigid) this._setRigid(this.params.rigid);
    return this;
  }
  /** Apply a named preset or a params object. Unlisted params go back to defaults (except mouse/time/backdrop). */
  applyPreset(preset) {
    const pr = typeof preset === 'string' ? PRESETS[preset] : preset;
    if (!pr) throw new Error('physical-web: unknown preset ' + preset);
    const keep = {}; for (const k of KEEP_ACROSS_PRESETS) keep[k] = this.params[k];
    const { scatter, ...rest } = pr;
    const next = { ...DEFAULTS, ...keep, ...rest, granularity: rest.granularity || this.params.granularity };
    const wasRigid = this.params.rigid;
    Object.assign(this.params, next);
    if (this.scene && this.params.granularity !== this.granularity) this.rebuildBodies();
    if (this.params.rigid !== wasRigid || this.params.rigid) this._setRigid(this.params.rigid, !wasRigid);
    if (scatter !== undefined) this.scatter(scatter);
    this.presetName = typeof preset === 'string' ? preset : null;
    return this;
  }

  /** Match the backing store to the canvas' CSS box; points are sized so the page tiles without gaps. */
  fit() {
    if (!this.W) return;
    const c = this.canvas, dpr = global.devicePixelRatio || 1;
    const cw = c.clientWidth || this.W, ch = c.clientHeight || this.H;
    this.scale = cw / this.W;
    const bw = Math.round(cw * dpr), bh = Math.round(ch * dpr);
    if (c.width !== bw || c.height !== bh) { c.width = bw; c.height = bh; }
    this.pointSize = Math.max(1, Math.ceil(this.scale * dpr - 0.02));
    if (this.mouse && global.Matter) global.Matter.Mouse.setScale(this.mouse, { x: 1 / this.scale, y: 1 / this.scale });
  }

  _bindPointer() {
    this.pointerEnabled = true;
    const c = this.canvas;
    const toPage = (e) => { const r = c.getBoundingClientRect(); return { x: (e.clientX - r.left) * this.W / r.width, y: (e.clientY - r.top) * this.H / r.height }; };
    this._ptr = {
      down: (e) => { Object.assign(this.pointer, toPage(e), { down: true }); },
      move: (e) => { Object.assign(this.pointer, toPage(e)); },
      up: () => { this.pointer.down = false; },
    };
    c.addEventListener('pointerdown', this._ptr.down); c.addEventListener('pointermove', this._ptr.move);
    global.addEventListener('pointerup', this._ptr.up);
  }

  start() { if (!this.running) { this.running = true; this.last = 0; requestAnimationFrame(this._frame); } return this; }
  stop() { this.running = false; return this; }
  dispose() {
    this.stop(); this._freeGL();
    global.removeEventListener('resize', this._onResize);
    if (this._ptr) { this.canvas.removeEventListener('pointerdown', this._ptr.down); this.canvas.removeEventListener('pointermove', this._ptr.move); global.removeEventListener('pointerup', this._ptr.up); }
    if (this.engine && global.Matter) global.Matter.Engine.clear(this.engine);
  }
  get stats() {
    return { particles: this.N || 0, bodies: this.bodies.length, granularity: this.granularity, ink: this.scene ? this.scene.inkCount : 0, fps: this.fps };
  }

  /** One simulation + render step. Called by the internal loop, or call it yourself with a timestamp. */
  step(now) {
    if (!this.W) return;
    const gl = this.gl, P = this.params;
    let dt = Math.min(0.033, Math.max(0.0005, (now - (this.last || now)) / 1000)); this.last = now;
    dt *= P.timeScale; this.time += dt;
    this.frames++; if (now - this.fpsT > 500) { this.fps = Math.round(this.frames * 1000 / (now - this.fpsT)); this.frames = 0; this.fpsT = now; if (this.onStats) this.onStats(this.stats); }

    if (P.rigid && dt > 0 && this.engine) {
      const steps = Math.max(1, Math.min(3, Math.round(dt * 60)));
      for (let i = 0; i < steps; i++) global.Matter.Engine.update(this.engine, 1000 / 60);
      this._uploadBodies();
    }
    const solid = P.solid && this.bodies.length > 0;
    if (solid) {
      const p = this.progObs;
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.obsFb); gl.viewport(0, 0, this.W, this.H);
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(p);
      this._bind(0, this.tex.bodyNow, p, 'uBodyNow'); this._bind(1, this.tex.bodyHome, p, 'uBodyHome'); this._bind(2, this.tex.mask, p, 'uMask');
      gl.uniform2f(this._U(p, 'uRes'), this.W, this.H); gl.uniform1i(this._U(p, 'uBodyW'), this.bodyW);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.bodies.length);
    }

    const src = this.cur, dst = 1 - this.cur, p = this.progSim, U = (n) => this._U(p, n);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fb[dst]); gl.viewport(0, 0, this.W, this.H);
    gl.useProgram(p);
    this._bind(0, this.pos[src], p, 'uPos'); this._bind(1, this.vel[src], p, 'uVel');
    this._bind(2, this.tex.shot, p, 'uShot'); this._bind(3, this.tex.mask, p, 'uMask'); this._bind(4, this.tex.group, p, 'uGroup');
    this._bind(5, this.tex.bodyNow || this.tex.mask, p, 'uBodyNow'); this._bind(6, this.tex.bodyHome || this.tex.mask, p, 'uBodyHome'); this._bind(7, this.tex.obs, p, 'uObs');
    gl.uniform2f(U('uRes'), this.W, this.H);
    gl.uniform1f(U('uDt'), dt); gl.uniform1f(U('uTime'), this.time);
    gl.uniform2f(U('uGravity'), 0, P.gravity); gl.uniform1i(U('uGravSel'), P.gravSel);
    const a = P.windDir * Math.PI / 180;
    gl.uniform1f(U('uWind'), P.wind); gl.uniform2f(U('uWindDir'), Math.cos(a), Math.sin(a));
    gl.uniform1f(U('uTurb'), P.turb); gl.uniform1f(U('uLift'), P.lift); gl.uniform1f(U('uNoiseScale'), P.noiseScale);
    gl.uniform1i(U('uWindSel'), P.windSel);
    gl.uniform1f(U('uDrag'), P.drag); gl.uniform1f(U('uLightDrag'), P.lightDrag); gl.uniform1i(U('uDragSel'), P.dragSel);
    gl.uniform1f(U('uSpring'), P.spring); gl.uniform1i(U('uSpringSel'), P.springSel);
    gl.uniform1i(U('uFloor'), P.floor ? 1 : 0); gl.uniform1i(U('uRigid'), P.rigid && this.bodies.length ? 1 : 0);
    gl.uniform1i(U('uSolid'), solid ? 1 : 0); gl.uniform1f(U('uPile'), P.pile);
    gl.uniform1i(U('uRecycle'), P.recycle ? 1 : 0); gl.uniform2f(U('uSpout'), P.spoutX, P.spoutW);
    gl.uniform1i(U('uBodyW'), this.bodyW); gl.uniform1i(U('uScatterSel'), this.scatterSel);
    const grabbing = this.mc && this.mc.body;
    gl.uniform2f(U('uMouse'), this.pointer.x, this.pointer.y); gl.uniform1f(U('uMouseR'), P.mouseR);
    gl.uniform1f(U('uMouseF'), this.pointer.down && !grabbing ? P.mouseF : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.cur = dst; this.scatterSel = -1;

    const bc = parseColor(P.backdrop) || [63, 70, 84];
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(bc[0] / 255, bc[1] / 255, bc[2] / 255, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    const q = this.progPts;
    gl.useProgram(q);
    this._bind(0, this.pos[this.cur], q, 'uPos'); this._bind(1, this.tex.shot, q, 'uShot');
    gl.uniform2f(this._U(q, 'uRes'), this.W, this.H); gl.uniform1i(this._U(q, 'uW'), this.W);
    gl.uniform1f(this._U(q, 'uPointSize'), this.pointSize); gl.uniform1f(this._U(q, 'uDepthShade'), P.depthShade ? 1 : 0);
    gl.drawArrays(gl.POINTS, 0, this.N);
  }
  _frame(now) {
    if (!this.running) return;
    requestAnimationFrame(this._frame);
    this.step(now);
  }
}

// ------------------------------------------------------------------ capture backends
// All return a scene: { shot, notext, chars, shapes, w, h, source }.

/** Client-only: render the live DOM twice with html2canvas (no server). `resolution` < 1 reduces particle count. */
async function captureDom(opts = {}) {
  const doc = opts.document || document, win = doc.defaultView;
  const h2c = await ensureScript(opts.html2canvasUrl || CDN.html2canvas, 'html2canvas');
  const vw = win.innerWidth, vh = win.innerHeight;
  const s = opts.resolution || 1;
  const ignore = opts.ignore || ((el) => el.classList && el.classList.contains('physical-web-overlay'));
  const bg = win.getComputedStyle(doc.body).backgroundColor;
  const base = {
    x: win.scrollX, y: win.scrollY, width: vw, height: vh, scrollX: 0, scrollY: 0,
    windowWidth: vw, windowHeight: vh, scale: s, useCORS: true, logging: false, removeContainer: true,
    backgroundColor: parseColor(bg) && parseColor(bg)[3] > 0 ? bg : '#ffffff',
    ignoreElements: ignore,
  };
  const freeze = (d) => { const st = d.createElement('style'); st.textContent = FREEZE_CSS; d.head.appendChild(st); };
  const shot = await h2c(doc.documentElement, { ...base, onclone: (d) => { freeze(d); if (opts.onclone) opts.onclone(d); } });
  const notext = await h2c(doc.documentElement, { ...base, onclone: (d) => { freeze(d); const st = d.createElement('style'); st.textContent = HIDE_TEXT_CSS; d.head.appendChild(st); if (opts.onclone) opts.onclone(d); } });
  const rects = extractRects(doc, { ignore });
  const W = shot.width, H = shot.height;
  const sc = (r) => [r[0] * s, r[1] * s, r[2] * s, r[3] * s, r[4] || 0];
  return { shot, notext, chars: rects.chars.map(sc), shapes: rects.shapes.map(sc), w: W, h: H, source: 'dom', resolution: s };
}

/** Server-assisted: a physical-web capture service (server.py) renders the URL in headless Chromium. */
async function captureServer(opts = {}) {
  const endpoint = opts.endpoint || '/capture';
  const url = opts.url || location.href;
  const w = opts.width || global.innerWidth, h = opts.height || global.innerHeight, y = opts.scrollY ?? Math.round(global.scrollY || 0);
  const res = await fetch(`${endpoint}?url=${encodeURIComponent(url)}&w=${w}&h=${h}&y=${y}`);
  if (!res.ok) throw new Error('physical-web capture failed: ' + (await res.text()).split('\n').slice(-2).join(' '));
  const j = await res.json();
  const [shot, notext] = await Promise.all([loadImg(j.shot), loadImg(j.notext)]);
  return { shot, notext, chars: j.chars, shapes: j.shapes, w: j.w, h: j.h, title: j.title, source: 'server' };
}

/** Static: pre-rendered full-page captures (prerender.py) listed in a manifest. Returns null if nothing matches. */
async function captureStatic(opts = {}) {
  const manifestUrl = opts.manifest || '/physics/manifest.json';
  const res = await fetch(manifestUrl, { cache: 'force-cache' });
  if (!res.ok) return null;
  const man = await res.json();
  const path = opts.path || location.pathname;
  const page = man.pages[path] || man.pages[path.replace(/\/$/, '/index.htm')] || man.pages[path.replace(/\/$/, '/index.html')];
  if (!page) return null;
  const vw = global.innerWidth, vh = global.innerHeight;
  const entry = page[String(vw)] || page[String(Object.keys(page).map(Number).filter(w => Math.abs(w - vw) <= (opts.tolerance || 0)).sort((a, b) => Math.abs(a - vw) - Math.abs(b - vw))[0])];
  if (!entry) return null;
  const base = new URL(manifestUrl, location.href);
  const [shotImg, noImg, rects] = await Promise.all([loadImg(new URL(entry.shot, base)), loadImg(new URL(entry.notext, base)), fetch(new URL(entry.rects, base)).then(r => r.json())]);
  const sy = Math.round(global.scrollY || 0), H = Math.min(vh, entry.h - sy), W = entry.w;
  const crop = (img) => { const c = document.createElement('canvas'); c.width = W; c.height = H; c.getContext('2d').drawImage(img, 0, sy, W, H, 0, 0, W, H); return c; };
  const shift = (r) => [r[0], r[1] - sy, r[2], r[3], r[4] || 0];
  const inView = (r) => r[1] + r[3] > 0 && r[1] < H;
  return { shot: crop(shotImg), notext: crop(noImg), chars: rects.chars.map(shift).filter(inView), shapes: rects.shapes.map(shift).filter(inView), w: W, h: H, source: 'static' };
}

// ------------------------------------------------------------------ live-page behaviour
/**
 * Attach to the current page: after `idle` ms without user activity the viewport is captured,
 * covered by a full-window canvas and the preset plays. Scroll / wheel / key presses end the
 * effect (reassemble, then the overlay is removed). Mouse drags push particles and grab bodies.
 */
function attach(opts = {}) {
  const o = {
    idle: 8000, preset: 'Avalanche', capture: 'auto', server: null, manifest: null, resolution: 'auto', maxParticles: 1.4e6,
    backdrop: 'auto', exitOn: ['wheel', 'keydown', 'touchmove', 'scroll'], exitPreset: 'Reassemble', exitDelay: 2600,
    once: false, zIndex: 2147483000, matterUrl: CDN.matter, html2canvasUrl: CDN.html2canvas, onStart: null, onEnd: null, onError: null,
    reducedMotion: 'respect', minWidth: 0,
    ...opts,
  };
  const inert = { play: async () => null, stop() {}, arm() {}, disarm() {}, get sim() { return null; }, get active() { return false; }, options: o, inert: true };
  if (o.reducedMotion === 'respect' && global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches) return inert;
  if (o.minWidth && global.innerWidth < o.minWidth) return inert;
  try { const c = document.createElement('canvas'); const g = c.getContext('webgl2'); if (!g || !g.getExtension('EXT_color_buffer_float')) return inert; } catch (e) { return inert; }
  const state = { timer: null, active: false, sim: null, canvas: null, armed: true, scene: null, capturing: false };

  const clearTimer = () => { if (state.timer) { clearTimeout(state.timer); state.timer = null; } };
  const arm = () => { clearTimer(); if (!state.armed || state.active) return; state.timer = setTimeout(begin, o.idle); };
  const activity = () => { if (!state.active) arm(); };

  async function getScene() {
    const res = o.resolution === 'auto' ? Math.min(1, Math.sqrt(o.maxParticles / (innerWidth * innerHeight))) : o.resolution;
    const order = o.capture === 'auto' ? ['static', 'dom'] : [].concat(o.capture);
    for (const kind of order) {
      try {
        if (kind === 'static') { const s = o.manifest ? await captureStatic({ manifest: o.manifest }) : null; if (s) return s; }
        else if (kind === 'server') return await captureServer({ endpoint: o.server });
        else if (kind === 'dom') return await captureDom({ resolution: res, html2canvasUrl: o.html2canvasUrl });
      } catch (e) { if (o.onError) o.onError(e); else console.warn('physical-web capture (' + kind + ') failed:', e); }
    }
    return null;
  }

  async function begin() {
    if (state.active || state.capturing) return;
    state.capturing = true;
    try {
      await ensureScript(o.matterUrl, 'Matter');
      const scene = await getScene();
      if (!scene) return;
      if (state.active || !state.armed) return;
      const canvas = document.createElement('canvas');
      canvas.className = 'physical-web-overlay';
      Object.assign(canvas.style, { position: 'fixed', inset: '0', width: '100vw', height: '100vh', zIndex: String(o.zIndex), display: 'block', touchAction: 'none', cursor: 'crosshair' });
      document.body.appendChild(canvas);
      const backdrop = o.backdrop === 'auto' ? autoBackdrop(document) : o.backdrop;
      const sim = new Sim(canvas, { params: { backdrop } });
      sim.load(scene);
      sim.applyPreset('Still');
      sim.start();
      state.sim = sim; state.canvas = canvas; state.active = true;
      // let the page be seen once as particles, then let it go
      setTimeout(() => { if (state.active) sim.applyPreset(o.preset); }, 350);
      if (o.onStart) o.onStart(sim);
    } catch (e) {
      if (o.onError) o.onError(e); else console.warn('physical-web:', e);
    } finally { state.capturing = false; }
  }

  function end(immediate) {
    if (!state.active) return;
    const { sim, canvas } = state;
    const finish = () => {
      sim.dispose(); canvas.remove();
      state.active = false; state.sim = null; state.canvas = null;
      if (o.onEnd) o.onEnd();
      if (o.once) state.armed = false; else arm();
    };
    if (immediate || !o.exitPreset) finish();
    else { sim.applyPreset(o.exitPreset); setTimeout(finish, o.exitDelay); }
  }

  const exitHandler = (e) => { if (state.active && !(e.type === 'keydown' && e.key === 'Shift')) end(false); };
  for (const ev of ['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll']) global.addEventListener(ev, activity, { passive: true });
  for (const ev of o.exitOn) global.addEventListener(ev, exitHandler, { passive: true });
  global.addEventListener('resize', () => { if (state.active) end(true); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) { clearTimer(); if (state.active) end(true); } else arm(); });
  if (document.readyState === 'complete') arm(); else global.addEventListener('load', arm);

  return {
    play: async (preset) => { clearTimer(); if (!state.active) await begin(); if (state.sim && preset) state.sim.applyPreset(preset); return state.sim; },
    stop: (immediate = true) => end(immediate),
    arm: () => { state.armed = true; arm(); },
    disarm: () => { state.armed = false; clearTimer(); },
    get sim() { return state.sim; },
    get active() { return state.active; },
    options: o,
  };
}

global.PhysicalWeb = { version: VERSION, Sim, PRESETS, DEFAULTS, SEL, extractRects, captureDom, captureServer, captureStatic, attach, autoBackdrop, mergeRects, HIDE_TEXT_CSS, FREEZE_CSS, CDN };
})(typeof window !== 'undefined' ? window : globalThis);
