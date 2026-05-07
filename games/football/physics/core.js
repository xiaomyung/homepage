/**
 * Football v2 — main physics tick.
 *
 * Single per-tick orchestrator. Order matters: pause-state advance
 * runs first (and the ball still falls under gravity during most
 * pauses), then the active-play sequence:
 *
 *   regen + exhaustion → action dispatch (kick/push/movement) →
 *   push-velocity damp → react-timer countdown → field clamp +
 *   player-vs-player + player-vs-goal → stamina drain from movement →
 *   ball physics (substepped).
 *
 * Wraps a stall-timeout escape so a pinned ball doesn't hang the match.
 */

import { STALL_TICKS } from './tuning.js';
import { advanceReactTimer, applyPushPhysics } from './push.js';
import { applyAction, applyRegenAndExhaustion, chargeStaminaFromDisplacement } from './player.js';
import { clampAndCollide, clampPlayerToField, resolvePlayerPairCollision } from './collisions.js';
import { updateBall } from './ball.js';
import { advancePause, resetBall, resetToKickoff } from './match-flow.js';

export function tick(state, p1Act, p2Act) {
  if (state.recordEvents) state.events.length = 0;
  state.tick++;

  if (state.matchOver) return state;

  if (state.pauseState !== null) {
    advancePause(state);
    // Ball physics run during pause too — gravity still pulls the
    // ball down so a scored shot settles visibly into the net
    // instead of freezing mid-flight. Skipped only for the static
    // matchend pose / neutral phases; reposition still runs ball
    // physics so the scored shot finishes settling during the walk
    // back.
    const skipBall = state.pauseState === 'matchend'
      && (state.matchEndPhase === 'pose' || state.matchEndPhase === 'neutral');
    if (!skipBall) updateBall(state);
    return state;
  }

  if (state.graceFrames > 0) state.graceFrames--;

  const pre1x = state.p1.x, pre1y = state.p1.y;
  const pre2x = state.p2.x, pre2y = state.p2.y;

  applyRegenAndExhaustion(state.p1);
  applyRegenAndExhaustion(state.p2);

  if (p1Act) applyAction(state, state.p1, p1Act);
  if (p2Act) applyAction(state, state.p2, p2Act);

  applyPushPhysics(state.p1);
  applyPushPhysics(state.p2);
  advanceReactTimer(state.p1);
  advanceReactTimer(state.p2);

  clampAndCollide(state, state.p1);
  clampAndCollide(state, state.p2);
  resolvePlayerPairCollision(state.p1, state.p2, pre1x, pre1y, pre2x, pre2y);
  // A wall-pinned pair collision can push one player outside the
  // field box; re-clamp so residual overlap converges in a few ticks.
  clampPlayerToField(state.p1, state.field);
  clampPlayerToField(state.p2, state.field);

  chargeStaminaFromDisplacement(state.p1, pre1x, pre1y);
  chargeStaminaFromDisplacement(state.p2, pre2x, pre2y);

  updateBall(state);

  if (state.tick - state.lastKickTick > STALL_TICKS) {
    state.stallCount += 1;
    if (state.headless) {
      // Full kickoff reset — both players teleported, velocities
      // zeroed, ball on ground at midfield — so stale segments
      // cycle cleanly rather than dribbling the ball back into a
      // stuck configuration.
      resetToKickoff(state);
    } else {
      resetBall(state);
      state.lastKickTick = state.tick;
    }
  }

  return state;
}
