/**
 * Pure: state -> situational facts. No state mutation, no allocation
 * caching. Decision and action layers consume the returned object.
 */

import {
  PLAYER_WIDTH,
  PLAYER_HEIGHT,
  FIELD_HEIGHT,
  BALL_RADIUS,
  MAX_PLAYER_SPEED,
  KICK_FACE_TOL,
  PUSH_FACE_TOL,
  canKickReach,
} from '../physics.js';

import {
  PREDICTION_HORIZON_TICKS,
  FALLBACK_SAFETY_MARGIN,
  ATTACK_OFFSET,
  NEAR_BLOCK_DIST,
  NEAR_BLOCK_RADIUS,
  GOALIE_THREAT_VEL,
  GOALIE_THREAT_X_FRAC,
  PUSH_RANGE_FRAC,
} from './tuning.js';

const SHORT_HORIZON_TICKS = 6;
const LONG_HORIZON_TICKS = 30;
const PUSH_RANGE_X = PLAYER_WIDTH;

function playerCenter(p) {
  return { x: p.x + PLAYER_WIDTH / 2, y: p.y + PLAYER_HEIGHT / 2 };
}

function dist(ax, ay, bx, by) {
  return Math.hypot(ax - bx, ay - by);
}

function wrapAngle(a) {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

/** Earliest tick within `horizon` at which `p` can reach the ball at
 *  max player speed, given linear ball extrapolation. Infinity if
 *  unreachable in horizon. */
export function interceptTicks(ball, p, horizon = PREDICTION_HORIZON_TICKS) {
  const cx = p.x + PLAYER_WIDTH / 2;
  const cy = p.y + PLAYER_HEIGHT / 2;
  for (let k = 0; k <= horizon; k++) {
    const bx = ball.x + ball.vx * k;
    const by = ball.y + ball.vy * k;
    if (Math.hypot(bx - cx, by - cy) <= MAX_PLAYER_SPEED * k + 1e-6) return k;
  }
  return Infinity;
}

/** Linear ball position prediction `ticks` ahead in (x, y). */
function predictBallXY(ball, ticks) {
  return { x: ball.x + ball.vx * ticks, y: ball.y + ball.vy * ticks };
}

/** Point just behind the ball on the line ball -> opp goal centre. */
function attackKickSpot(field, ball, side) {
  const tgx = side === 'left' ? field.goalLineR : field.goalLineL;
  const tgy = FIELD_HEIGHT / 2;
  const dx = tgx - ball.x;
  const dy = tgy - ball.y;
  const len = Math.hypot(dx, dy) || 1;
  return {
    x: ball.x - (dx / len) * ATTACK_OFFSET,
    y: ball.y - (dy / len) * ATTACK_OFFSET,
  };
}

/** Is opp directly on the ball -> direction ray from ball, in close range? */
function opponentBlocksLane(bx, by, dirX, dirY, ox, oy) {
  const t = (ox - bx) * dirX + (oy - by) * dirY;
  if (t <= 0 || t > NEAR_BLOCK_DIST) return false;
  const perpX = (ox - bx) - t * dirX;
  const perpY = (oy - by) - t * dirY;
  return Math.hypot(perpX, perpY) < NEAR_BLOCK_RADIUS;
}

/** Self's goal line is threatened: ball is on own half AND moving
 *  toward own goal faster than the threat threshold. */
function ballThreatensOwnGoal(field, ball, side) {
  const ownIsLeft = side === 'left';
  const onOwnHalf = ownIsLeft ? ball.x < field.midX : ball.x > field.midX;
  if (!onOwnHalf) return false;
  return ownIsLeft ? ball.vx < -GOALIE_THREAT_VEL : ball.vx > GOALIE_THREAT_VEL;
}

/** Predicted y-coordinate of ball when it crosses self's goal line. */
function ballYAtOwnGoalLine(field, ball, side) {
  const goalX = side === 'left' ? field.goalLineL : field.goalLineR;
  if (Math.abs(ball.vx) < 1e-3) return ball.y;
  const ticks = (goalX - ball.x) / ball.vx;
  if (ticks <= 0) return ball.y;
  return ball.y + ball.vy * ticks;
}

/** Push opportunity: opp between self and ball, within range and facing
 *  aligned to opp's bearing. */
function pushOpportunity(self, opp, ball) {
  const sc = playerCenter(self);
  const oc = playerCenter(opp);
  const bx = ball.x;
  const by = ball.y;
  const selfToOpp = Math.hypot(oc.x - sc.x, oc.y - sc.y);
  if (selfToOpp > PUSH_RANGE_X * PUSH_RANGE_FRAC) return false;
  const sx = oc.x - sc.x;
  const sy = oc.y - sc.y;
  const bxr = bx - sc.x;
  const byr = by - sc.y;
  const dot = sx * bxr + sy * byr;
  if (dot <= 0) return false;
  const wantAngle = Math.atan2(oc.y - sc.y, oc.x - sc.x);
  return Math.abs(wrapAngle(wantAngle - self.heading)) < PUSH_FACE_TOL;
}

/**
 * Build perception facts for `self` against `opp`. Pure; returns a fresh
 * object (no caching, no state mutation).
 */
export function perceive(state, which) {
  const self = state[which];
  const opp = state[which === 'p1' ? 'p2' : 'p1'];
  const ball = state.ball;
  const field = state.field;

  const sc = playerCenter(self);
  const oc = playerCenter(opp);

  const selfDistToBall = dist(sc.x, sc.y, ball.x, ball.y);
  const oppDistToBall = dist(oc.x, oc.y, ball.x, ball.y);
  const selfDistToOpp = dist(sc.x, sc.y, oc.x, oc.y);

  const selfInterceptTicks = interceptTicks(ball, self);
  const oppInterceptTicks = interceptTicks(ball, opp);

  const ballPredShort = predictBallXY(ball, SHORT_HORIZON_TICKS);
  const ballPredLong = predictBallXY(ball, LONG_HORIZON_TICKS);

  const kickSpot = attackKickSpot(field, ball, self.side);

  const selfHasKickReach = canKickReach(state, self, FALLBACK_SAFETY_MARGIN);
  const oppHasKickReach = canKickReach(state, opp, FALLBACK_SAFETY_MARGIN);

  const kickDirX = self.side === 'left' ? 1 : -1;
  const oppBlocksLane = opponentBlocksLane(ball.x, ball.y, kickDirX, 0, oc.x, oc.y);

  const threatensOwnGoal = ballThreatensOwnGoal(field, ball, self.side);
  const ownGoalInterceptY = threatensOwnGoal ? ballYAtOwnGoalLine(field, ball, self.side) : null;

  const selfBlocked = state.pauseState !== null
    || self.exhausted
    || self.pushTimer > 0
    || self.reactTimer > 0;
  const selfKicking = self.kick.active;

  const ballSpeedXY = Math.hypot(ball.vx, ball.vy);

  const push = pushOpportunity(self, opp, ball);
  const oppWindingUp = opp.kick.active;

  return {
    selfCx: sc.x, selfCy: sc.y,
    oppCx: oc.x, oppCy: oc.y,
    selfDistToBall, oppDistToBall, selfDistToOpp,
    selfInterceptTicks, oppInterceptTicks,
    ballPredShort, ballPredLong,
    attackKickSpot: kickSpot,
    selfHasKickReach, oppHasKickReach,
    oppBlocksLane,
    threatensOwnGoal,
    ownGoalInterceptY,
    selfBlocked,
    selfKicking,
    ballSpeedXY,
    pushOpportunity: push,
    oppWindingUp,
    oppExhausted: opp.exhausted,
    selfStamina: self.stamina,
    selfSide: self.side,
    kickDirX,
  };
}
