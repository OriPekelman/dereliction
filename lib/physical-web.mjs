// ES module wrapper: the library registers itself on window; import this and use the default export.
import './physical-web.js';
export default globalThis.PhysicalWeb;
export const { Sim, PRESETS, DEFAULTS, SEL, extractRects, captureDom, captureServer, captureStatic, attach } = globalThis.PhysicalWeb;
