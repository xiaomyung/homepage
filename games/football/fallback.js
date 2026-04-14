/**
 * Football v2 — deterministic fallback AI.
 *
 * This is the handcoded opponent that v2 starts with. It's also the imitation
 * teacher for the warm-start seed: `build_warm_start.py` runs thousands of
 * fallback-vs-fallback matches, records (state, action) pairs, and trains
 * the initial NN weights to mimic this policy.
 *
 * Every output must be a pure deterministic function of state. The v1
 * version had a 3% random push roll — that was stripped because a stochastic
 * teacher signal causes imitation learning to collapse toward the mean,
 * turning crisp decisions into mush (see memory:
 * project_football_warm_start_fallback).
 *
 * Consumes the same state shape as physics.js — raw positions/velocities,
 * not the 18-dim NN input vector. The training loop computes `buildInputs`
 * separately on each sampled state so the NN learns (18-input → 9-output)
 * even though the teacher itself reads raw state.
 *
 * Output is a 9-float action vector matching the NN output layout:
 *   [moveX, moveY, kick, kickDx, kickDy, kickDz, kickPower, push, pushPower]
 */

// Ball-prediction horizon for lead-the-target movement
const AI_PREDICT_FRAMES = 20;

// Push-adjacency ranges — matched to physics.js PUSH_RANGE_X / PUSH_RANGE_Y
const PUSH_RANGE_X = 30;
const PUSH_RANGE_Y = 20;

// Ground-kick reach — matched to physics.js canKick(): ball must be within
// playerWidth in x AND within KICK_REACH_Y_NEAR in y AND near the ground.
const KICK_REACH_Y_NEAR = 10;
const KICK_BALL_Z_MAX = 10;

// Constant kick and push powers (deterministic teacher — no variation)
const KICK_POWER_NORM = 0.8;
const KICK_DZ = 0.2; // slight lob
const PUSH_POWER_NORM = 0.5;

/**
 * Compute the fallback action vector for one player.
 *
 * @param {object} state — physics state (createState return value)
 * @param {'p1'|'p2'} which — which player to act for
 * @returns {number[]} 9-float action vector
 */
export function fallbackAction(state, which) {
  const p = state[which];
  const opp = which === 'p1' ? state.p2 : state.p1;
  const ball = state.ball;
  const pw = state.field.playerWidth;

  // Lead the ball: predict where it will be AI_PREDICT_FRAMES ticks from now
  const targetX = ball.x + ball.vx * AI_PREDICT_FRAMES;
  const targetY = ball.y;

  // Normalized movement direction toward the predicted ball position
  const center = p.x + pw / 2;
  const dx = targetX - center;
  const dy = targetY - p.y;
  const dist = Math.sqrt(dx * dx + dy * dy) || 1;
  const moveX = dx / dist;
  const moveY = dy / dist;

  // Kick if the (current, not predicted) ball is within reach on the ground.
  // Predicted-position gate would cause the AI to kick at empty air.
  const ballDx = ball.x - center;
  const ballDy = ball.y - p.y;
  const canKickNow =
    Math.abs(ballDx) < pw &&
    Math.abs(ballDy) < KICK_REACH_Y_NEAR &&
    ball.z < KICK_BALL_Z_MAX;

  // Kick always aims toward the opponent's goal (+1 for left side, -1 for right)
  const kickDirX = p.side === 'left' ? 1 : -1;

  // Push is deterministic: fires whenever the opponent is in hitbox range.
  // The physics layer's pushTimer cooldown prevents spam, so the fallback can
  // safely output push=1 continuously without causing weird physics.
  const oppCenter = opp.x + pw / 2;
  const adjacent =
    Math.abs(center - oppCenter) < PUSH_RANGE_X &&
    Math.abs(p.y - opp.y) < PUSH_RANGE_Y;

  return [
    moveX,
    moveY,
    canKickNow ? 1 : -1,
    kickDirX,
    0,
    KICK_DZ,
    KICK_POWER_NORM,
    adjacent ? 1 : -1,
    PUSH_POWER_NORM,
  ];
}
