/**
 * Football v2 — public renderer surface.
 *
 * Thin re-export shim. The implementation lives under ./renderer/.
 * Consumers can import either from './renderer.js' (this shim) or
 * from './renderer/index.js' directly.
 */

export { Renderer } from './renderer/index.js';
