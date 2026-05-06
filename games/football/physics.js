/**
 * Football v2 — public physics surface.
 *
 * Thin re-export shim. The implementation lives under ./physics/.
 * Consumers can import either from './physics.js' (this shim, kept
 * for backwards compatibility) or from './physics/index.js' directly.
 * The shim does not add behaviour — every name re-exported here is
 * defined in one of the physics/ submodules.
 */

export * from './physics/index.js';
