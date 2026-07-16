/**
 * Shared test fixture helpers.
 *
 * `freshState(seed, opts)` builds a fresh game state with a seeded
 * RNG. Pass `withAI: true` to also initialise `aiRoleState` and
 * `aiPersonality` (matches the live nextShowcase() contract);
 * controller tests use it. decision tests build their own fixture
 * with a fixed neutral personality instead (see decision.test.mjs);
 * perception and action tests don't need either.
 *
 * `action({...})` builds a 9-slot action vector by name with the
 * neutral defaults that applyAction (physics/player.js) expects (gates at -1).
 */

import {
  createField,
  createSeededRng,
  createState,
  ACTION_KICK_DX,
  ACTION_KICK_DY,
  ACTION_KICK_DZ,
  ACTION_KICK_GATE,
  ACTION_KICK_POWER,
  ACTION_MOVE_X,
  ACTION_MOVE_Y,
  ACTION_PUSH_GATE,
  ACTION_PUSH_POWER,
  ACTION_VEC_SIZE,
  PLAYER_HEIGHT,
  PLAYER_WIDTH,
  Z_STRETCH,
} from '../../physics/index.js';
import { derivePersonality } from '../../ai/controller.js';
import { RNG_SALT_PERSONALITY } from '../../util/rng-salts.js';

export function freshState(seed = 42, { withAI = false, recordEvents = true, graceFrames = 0 } = {}) {
  const field = createField();
  const rng = createSeededRng(seed);
  const state = createState(field, rng);
  state.graceFrames = graceFrames;
  state.recordEvents = recordEvents;
  if (withAI) {
    state.aiPersonality = derivePersonality(createSeededRng(seed ^ RNG_SALT_PERSONALITY));
    state.aiRoleState = { left: { role: null, since: 0 }, right: { role: null, since: 0 } };
  }
  return state;
}

export function action({
  moveX = 0, moveY = 0,
  kickGate = -1, kickDx = 0, kickDy = 0, kickDz = 0, kickPower = 0,
  pushGate = -1, pushPower = 0,
} = {}) {
  const a = new Array(ACTION_VEC_SIZE);
  a[ACTION_MOVE_X]     = moveX;
  a[ACTION_MOVE_Y]     = moveY;
  a[ACTION_KICK_GATE]  = kickGate;
  a[ACTION_KICK_DX]    = kickDx;
  a[ACTION_KICK_DY]    = kickDy;
  a[ACTION_KICK_DZ]    = kickDz;
  a[ACTION_KICK_POWER] = kickPower;
  a[ACTION_PUSH_GATE]  = pushGate;
  a[ACTION_PUSH_POWER] = pushPower;
  return a;
}

export const NOOP = action();
export const moveAction = (mx, my = 0) => action({ moveX: mx, moveY: my });
export const pushAction = (power = 1) => action({ pushGate: 1, pushPower: power });
export const kickAction = (dx = 1, dy = 0, dz = 0, power = 1) =>
  action({ kickGate: 1, kickDx: dx, kickDy: dy, kickDz: dz, kickPower: power });

/** Minimal player fixture for the animation pose/state suites. This is
 *  the superset of the fields both suites read — the state suite only
 *  touches the movement/kick/push fields, so the extra react/target
 *  fields are inert there. */
export function makePlayer(overrides = {}) {
  return {
    x: 0, y: 0, heading: 0, vx: 0, vy: 0, airZ: 0, stamina: 1,
    kick: { active: false, kind: 'ground', timer: 0, stage: 'windup' },
    pushTimer: 0, pushArm: 'right', pushType: 'jab',
    pushTargetX: 0, pushTargetY: 0, pushTargetZ: 0,
    reactTimer: 0, reactForce: 0, reactDirX: 0, reactDirZ: 0,
    reactType: 'jab', reactLatSign: 1,
    ...overrides,
  };
}

/* ── Shared physics-test helpers (formerly inline in physics.test.mjs) ── */

/** World-space horizontal distance between two players' body capsule
 *  centres — the single number that defines whether two players are in
 *  contact. Mirrors the pair-collision math. */
export function capsuleDist(p1, p2) {
  const dx = (p1.x + PLAYER_WIDTH / 2) - (p2.x + PLAYER_WIDTH / 2);
  const dz = ((p1.y + PLAYER_HEIGHT / 2) - (p2.y + PLAYER_HEIGHT / 2)) * Z_STRETCH;
  return Math.hypot(dx, dz);
}

/** Body-trap scenario fixture. p1 mid-field, p2 parked far away,
 *  pause state machine disabled. Used by every torso/head trap test. */
export function trapState(seed = 7) {
  const state = freshState(seed);
  state.headless = true;
  state.p1.x = 400;
  state.p1.y = 24;
  state.p1.vx = 0; state.p1.vy = 0;
  state.p1.heading = 0;
  state.p2.x = 800;
  state.p2.y = 24;
  state.p2.vx = 0; state.p2.vy = 0;
  return state;
}

/** Project through the IK solver output and verify the foot ends at
 *  the expected (fwd, up) position. Returns the absolute error. */
export function footError(res, expectedFwd, expectedUp) {
  return Math.hypot(res.footFwd - expectedFwd, res.footUp - expectedUp);
}

/** Reconstruct the foot position from the solver's joint angles +
 *  bone lengths. Catches a sign error in the shin computation. */
export function reconstructFoot(res, U, L) {
  const kneeFwd  = U * Math.sin(res.upperAngle);
  const kneeDown = U * Math.cos(res.upperAngle);
  const footFwd  = kneeFwd + L * Math.sin(res.lowerAngle);
  const footDown = kneeDown + L * Math.cos(res.lowerAngle);
  return { fwd: footFwd, up: -footDown };
}

/** Clean kick-bench fixture: p1 facing +x with a ball just within reach
 *  along the body axis. Used by every kick-gate / kick-FSM test. */
export function kickBenchState() {
  const state = freshState();
  state.p1.x = 300;
  state.p1.y = 20;
  state.p1.heading = 0;
  state.ball.x = state.p1.x + PLAYER_WIDTH / 2 + 5;
  state.ball.y = state.p1.y;
  state.ball.z = 0;
  state.ball.vx = 0; state.ball.vy = 0; state.ball.vz = 0;
  state.ball.frozen = false;
  return state;
}
