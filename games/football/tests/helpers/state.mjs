/**
 * Shared test fixture helpers.
 *
 * `freshState(seed, opts)` builds a fresh game state with a seeded
 * RNG. Pass `withAI: true` to also initialise `aiRoleState` and
 * `aiPersonality` (matches the live nextShowcase() contract); decision
 * and controller tests use it, perception and action tests don't.
 *
 * `action({...})` builds a 9-slot action vector by name with the
 * neutral defaults that physics.js expects (gates at -1).
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
} from '../../physics.js';
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
