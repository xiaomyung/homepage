/**
 * Football v2 — physics public API barrel.
 *
 * Single import surface for everyone outside the physics/ directory
 * (main.js, ai/, animation/, renderer.js, debug-overlay.js, tests).
 * Internal physics modules import siblings directly. This file is the
 * stable seam: rename a file inside physics/, update one re-export
 * here, and consumers stay green.
 */

// World-model + tuning constants (every numeric constant lives in
// tuning.js; the full surface is re-exported here so renderer/,
// animation/, debug/, and ai/ keep their existing imports working.)
export * from './tuning.js';

// State / RNG / field-state factories.
export {
  createField, createState, resetStateInPlace,
  createSeededRng,
  clamp, wrapAngle, gaussRandom,
} from './state.js';

// Core tick orchestrator.
export { tick } from './core.js';

// Match flow (only endMatchByTime is consumed externally — main.js
// calls it when the match clock expires with no winner).
export { endMatchByTime } from './match-flow.js';

// Kick public surface. canKickReach is read by ai/perception.js;
// solve2BoneIK / ikFootWorld / kickLegPose / kickLegExtension feed
// animation/poses.js + debug-overlay.js.
export {
  canKickReach,
  ikFootWorld,
  kickLegExtension,
  kickLegPose,
  solve2BoneIK,
} from './kick.js';

// Push public surface — pose helpers consumed by animation/poses.js.
export {
  pushArmExtension,
  pushArmPose,
} from './push.js';

// Player heading helper (also imported by ai/perception.js for the
// push face-cone check).
export { facingToward } from './player.js';
