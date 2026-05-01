/**
 * Public controller: pure `decide(state, which) -> Float64Array(9)`.
 *
 * Pipeline: perceive -> decide intent -> encode action. The only mutated
 * state is `state.aiRoleState[side]` (role hysteresis) which is reset by
 * `resetStateInPlace` via the showcase loop.
 *
 * Future learned controllers slot in here by exporting a function with
 * the same signature.
 */

import { perceive } from './perception.js';
import { decide as decideIntent } from './decision.js';
import { encode, ACTION_VEC_SIZE } from './action.js';
import {
  KICK_AIM_OFFSET_RANGE,
  PUSH_POWER_RANGE,
} from './tuning.js';

export { ACTION_VEC_SIZE };

/**
 * Build per-side personality from a 0..1 RNG. Symmetric range so left
 * and right deviate in opposite directions; magnitudes scaled by tuning
 * constants. Cheap and deterministic given the same RNG draws.
 */
export function derivePersonality(rng) {
  const aimSign = rng() < 0.5 ? -1 : 1;
  const pushSign = rng() < 0.5 ? -1 : 1;
  const aimMag = rng() * KICK_AIM_OFFSET_RANGE;
  const pushMag = rng() * PUSH_POWER_RANGE;
  return {
    left: {
      kickAimYOffset: aimSign * aimMag,
      pushPowerScale: 1 + pushSign * pushMag,
    },
    right: {
      kickAimYOffset: -aimSign * aimMag,
      pushPowerScale: 1 - pushSign * pushMag,
    },
  };
}

/** Pure: per-side action for `which` side ('p1' | 'p2'). */
export function decide(state, which) {
  const self = state[which];
  if (!state.aiPersonality) {
    state.aiPersonality = { left: { kickAimYOffset: 0, pushPowerScale: 1 }, right: { kickAimYOffset: 0, pushPowerScale: 1 } };
  }
  if (!state.aiRoleState) {
    state.aiRoleState = { left: { role: null, since: 0 }, right: { role: null, since: 0 } };
  }
  const perception = perceive(state, which);
  const intent = decideIntent(state, which, perception);
  const personality = state.aiPersonality[self.side];
  return encode(state, which, perception, intent, personality);
}
