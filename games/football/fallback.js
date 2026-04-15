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

import {
  PLAYER_WIDTH,
  PLAYER_HEIGHT,
  Z_STRETCH,
  PUSH_RANGE_X,
  PUSH_RANGE_Y,
  KICK_REACH_Y,
  KICK_FACE_TOL,
  PUSH_FACE_TOL,
} from './physics.js?v=45';

// Ball-prediction horizon for lead-the-target movement.
const AI_PREDICT_FRAMES = 20;
// Teacher-only ball-height limit — the fallback refuses to kick
// balls far above the ground; physics.js's canKick is stricter
// (PLAYER_HEIGHT ≈ 6), but this gives the teacher a slightly wider
// window to aim for during the predict-ahead phase.
const KICK_BALL_Z_MAX = 10;

// Constant kick and push powers (deterministic teacher — no variation).
const KICK_POWER_NORM = 0.8;
const KICK_DZ = 0.2; // slight lob
const PUSH_POWER_NORM = 0.5;

/** Shortest-arc signed difference in (-π, π]. */
function wrapAngle(a) {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a <= -Math.PI) a += 2 * Math.PI;
  return a;
}

/** True iff `p` is pointed at world-space target (wx, wz) within `tol`. */
function facingToward(p, wx, wz, tol) {
  const cx = p.x + PLAYER_WIDTH / 2;
  const cz = (p.y + PLAYER_HEIGHT / 2) * Z_STRETCH;
  const want = Math.atan2(wz - cz, wx - cx);
  return Math.abs(wrapAngle(want - p.heading)) < tol;
}

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

  // Kick if the (current, not predicted) ball is within reach on the
  // ground AND the player is already facing the ball. The face gate
  // matches physics.js canKick() — emitting kick=1 while unaligned
  // would be silently rejected and would confuse the imitation
  // learner. The fallback's move-toward-ball command drives the
  // heading into alignment over ~PLAYER_TURN_TICKS ticks, so this is
  // a "wait until you're lined up, then strike" pattern.
  const pMidY = p.y + PLAYER_HEIGHT / 2;
  const ballDx = ball.x - center;
  const ballDy = ball.y - pMidY;
  const ballZ  = ball.y * Z_STRETCH;
  const inKickRange =
    Math.abs(ballDx) < pw &&
    Math.abs(ballDy) < KICK_REACH_Y &&
    ball.z < KICK_BALL_Z_MAX;
  const canKickNow = inKickRange && facingToward(p, ball.x, ballZ, KICK_FACE_TOL);

  // Kick always aims toward the opponent's goal (+1 for left side, -1 for right)
  const kickDirX = p.side === 'left' ? 1 : -1;

  // Push: fire when the opponent is adjacent AND the player is
  // facing them. Same rationale as kick — silent gate rejections
  // would poison the warm-start signal.
  const oppCenter = opp.x + pw / 2;
  const oppZ      = (opp.y + PLAYER_HEIGHT / 2) * Z_STRETCH;
  const inPushRange =
    Math.abs(center - oppCenter) < PUSH_RANGE_X &&
    Math.abs(p.y - opp.y) < PUSH_RANGE_Y;
  const adjacent = inPushRange && facingToward(p, oppCenter, oppZ, PUSH_FACE_TOL);

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
