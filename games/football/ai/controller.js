/**
 * Public controller: `decide(state, which) -> Float64Array(9)`.
 *
 * Pipeline: perceive -> decide intent -> encode action. The only mutated
 * state is `state.aiRoleState[side]` (role hysteresis), which main.js's
 * `nextShowcase` reassigns to a fresh object at the start of every match
 * (NOT reset by `resetStateInPlace`, which never touches aiRoleState).
 *
 * The returned Float64Array is a reused per-side scratch buffer (one for
 * 'p1', one for 'p2'), not a fresh allocation — the whole pipeline is
 * zero-allocation on the hot path. The caller must consume the result
 * before the next *same-side* `decide` (main.js passes p1's and p2's
 * buffers straight into physicsTick, which reads both synchronously). The
 * two sides own independent buffers, so evaluating both as sibling
 * arguments stays correct.
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

/** Pure (with bounded mutation): per-side action for `which` side ('p1' |
 *  'p2'). Lazily inits `state.aiPersonality` / `state.aiRoleState` on the
 *  first call, and the decision stage writes `state.aiRoleState[side].role`
 *  / `.since` for role hysteresis. */
export function decide(state, which) {
  const self = state[which];
  // Defensive init for callers (mainly tests) that build a state without
  // going through nextShowcase(). Live matches always have these set.
  if (!state.aiPersonality) {
    state.aiPersonality = {
      left:  { kickAimYOffset: 0, pushPowerScale: 1 },
      right: { kickAimYOffset: 0, pushPowerScale: 1 },
    };
  }
  if (!state.aiRoleState) {
    state.aiRoleState = { left: { role: null, since: 0 }, right: { role: null, since: 0 } };
  }
  const perception = perceive(state, which);
  const intent = decideIntent(state, which, perception);
  const personality = state.aiPersonality[self.side];
  return encode(state, which, perception, intent, personality);
}
