/**
 * Football v2 — physics public API barrel.
 *
 * Single import surface for everyone outside the physics/ directory.
 * Internal physics modules import siblings directly.
 */

export * from './tuning.js';

export {
  createField, createState, resetStateInPlace,
  createSeededRng,
  clamp, wrapAngle, gaussRandom,
} from './state.js';

export { tick } from './core.js';

export { endMatchByTime } from './match-flow.js';

export {
  canKickReach,
  ikFootWorld,
  kickLegExtension,
  kickLegPose,
  solve2BoneIK,
} from './kick.js';

export {
  pushArmExtension,
  pushArmPose,
} from './push.js';

export { facingToward } from './player.js';
