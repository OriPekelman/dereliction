// ES module wrapper: the library registers itself on window; import this and use the default export.
import './dereliction.js';
export default globalThis.Dereliction;
export const { Sim, PRESETS, DEFAULTS, SEL, extractRects, captureDom, captureServer, captureStatic, attach } = globalThis.Dereliction;
