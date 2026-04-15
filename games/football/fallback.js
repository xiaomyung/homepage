/**
 * Football v2 — deterministic fallback AI.
 *
 * Handcoded opponent + imitation teacher for the warm-start seed:
 * evolution/build-warm-start.mjs runs fallback-vs-fallback matches,
 * pairs (buildInputs(state), fallbackAction(state)) each tick, and
 * fits the NN to the resulting policy. Output is a 9-float action
 * vector in the same layout the NN produces.
 *
 * The whole point of this module is that the policy is a pure
 * deterministic function of state — the v1 version had a 3% random
 * push roll that made the imitation target noisy and caused the
 * warm-start NN to collapse toward the mean. Keep this file free of
 * any rng() calls.
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
  facingToward,
} from './physics.js?v=46';

const AI_PREDICT_FRAMES = 20;
// Teacher-only ball-height ceiling. physics.js's ground-kick check is
// stricter (PLAYER_HEIGHT = 6); this slightly wider window lets the
// teacher start aiming while the ball is still descending.
const KICK_BALL_Z_MAX = 10;

const KICK_POWER_NORM = 0.8;
const KICK_DZ = 0.2;
const PUSH_POWER_NORM = 0.5;

/**
 * @param {object} state — physics state (createState return value)
 * @param {'p1'|'p2'} which — which player to act for
 * @returns {number[]} 9-float action vector
 */
export function fallbackAction(state, which) {
  const p = state[which];
  const opp = which === 'p1' ? state.p2 : state.p1;
  const ball = state.ball;
  const pw = state.field.playerWidth;

  // Lead the ball on x (not y — the depth axis is noisy and shallow).
  const center = p.x + pw / 2;
  const dx = (ball.x + ball.vx * AI_PREDICT_FRAMES) - center;
  const dy = ball.y - p.y;
  const dist = Math.sqrt(dx * dx + dy * dy) || 1;
  const moveX = dx / dist;
  const moveY = dy / dist;

  // Kick gate uses the *current* ball position (not the lead target)
  // plus the same face cone as physics.canKick so the teacher never
  // emits actions that the physics silently rejects.
  const pMidY = p.y + PLAYER_HEIGHT / 2;
  const inKickRange =
    Math.abs(ball.x - center) < pw &&
    Math.abs(ball.y - pMidY) < KICK_REACH_Y &&
    ball.z < KICK_BALL_Z_MAX;
  const canKickNow = inKickRange
    && facingToward(p, ball.x, ball.y * Z_STRETCH, KICK_FACE_TOL);

  // Aim at the opponent's goal: +1 for the left side, -1 for the right.
  const kickDirX = p.side === 'left' ? 1 : -1;

  // Push gate: same structure, victim instead of ball.
  const oppCenter = opp.x + pw / 2;
  const oppZ = (opp.y + PLAYER_HEIGHT / 2) * Z_STRETCH;
  const inPushRange =
    Math.abs(center - oppCenter) < PUSH_RANGE_X &&
    Math.abs(p.y - opp.y) < PUSH_RANGE_Y;
  const adjacent = inPushRange
    && facingToward(p, oppCenter, oppZ, PUSH_FACE_TOL);

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
