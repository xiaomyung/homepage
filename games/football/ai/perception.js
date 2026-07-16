/**
 * Pure (no state mutation): state -> situational facts. Returns a per-side
 * scratch object (keyed by `which`, reused across ticks) so the hot path
 * allocates nothing. Decision and action layers consume the returned object
 * synchronously; a caller must not hold a `perceive` result across a later
 * *same-side* `perceive` call (they alias). The two sides ('p1'/'p2') own
 * independent scratch, so holding both at once (as tests do) stays valid.
 */

import {
  PLAYER_WIDTH,
  PLAYER_HEIGHT,
  FIELD_HEIGHT,
  MAX_PLAYER_SPEED,
  PUSH_FACE_TOL,
  PUSH_RANGE_X,
  canKickReach,
  wrapAngle,
} from '../physics/index.js';

import {
  PREDICTION_HORIZON_TICKS,
  FALLBACK_SAFETY_MARGIN,
  ATTACK_OFFSET,
  NEAR_BLOCK_DIST,
  NEAR_BLOCK_RADIUS,
  GOALIE_THREAT_VEL,
  PUSH_RANGE_FRAC,
} from './tuning.js';

function dist(ax, ay, bx, by) {
  return Math.hypot(ax - bx, ay - by);
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

/** Point just behind the ball on the line ball -> opp goal centre. Writes
 *  into `out` (caller-owned) to avoid per-tick allocation.
 *  The y offset shifts by +PLAYER_HEIGHT/2 because moveToward targets the
 *  player CENTER (`p.y + PLAYER_HEIGHT/2`) while canKickReach checks the
 *  HIP at `p.y`. Without the shift, center-targeting parks the hip ~3
 *  physics-y units short of the ball — and via Z_STRETCH that becomes
 *  ~14 world units of perp offset, well past the foot/ball contact gap. */
function attackKickSpot(field, ball, side, out) {
  const tgx = side === 'left' ? field.goalLineR : field.goalLineL;
  const tgy = FIELD_HEIGHT / 2;
  const dx = tgx - ball.x;
  const dy = tgy - ball.y;
  const len = Math.hypot(dx, dy) || 1;
  out.x = ball.x - (dx / len) * ATTACK_OFFSET;
  out.y = ball.y - (dy / len) * ATTACK_OFFSET + PLAYER_HEIGHT / 2;
  return out;
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
  const scx = self.x + PLAYER_WIDTH / 2;
  const scy = self.y + PLAYER_HEIGHT / 2;
  const ocx = opp.x + PLAYER_WIDTH / 2;
  const ocy = opp.y + PLAYER_HEIGHT / 2;
  const bx = ball.x;
  const by = ball.y;
  const selfToOpp = Math.hypot(ocx - scx, ocy - scy);
  if (selfToOpp > PUSH_RANGE_X * PUSH_RANGE_FRAC) return false;
  const sx = ocx - scx;
  const sy = ocy - scy;
  const bxr = bx - scx;
  const byr = by - scy;
  const dot = sx * bxr + sy * byr;
  if (dot <= 0) return false;
  const wantAngle = Math.atan2(ocy - scy, ocx - scx);
  return Math.abs(wrapAngle(wantAngle - self.heading)) < PUSH_FACE_TOL;
}

/** Per-side facts scratch. `perceive` writes into `factsScratch[which]`
 *  instead of allocating a literal each call. The nested `attackKickSpot`
 *  is owned here (never aliased out), so a later intent-layer write to its
 *  copy of the target can't corrupt these facts mid-decide. */
function makeFactsScratch() {
  return {
    selfCx: 0, selfCy: 0,
    oppCx: 0, oppCy: 0,
    selfDistToBall: 0, oppDistToBall: 0, selfDistToOpp: 0,
    selfInterceptTicks: 0, oppInterceptTicks: 0,
    attackKickSpot: { x: 0, y: 0 },
    selfHasKickReach: false, oppHasKickReach: false,
    oppBlocksLane: false,
    threatensOwnGoal: false,
    ownGoalInterceptY: null,
    selfBlocked: false,
    selfKicking: false,
    ballSpeedXY: 0,
    pushOpportunity: false,
    oppWindingUp: false,
    oppExhausted: false,
    selfSide: null,
  };
}

const factsScratch = { p1: makeFactsScratch(), p2: makeFactsScratch() };

/**
 * Build perception facts for `self` against `opp`. Pure (no state mutation);
 * returns the reused per-side scratch object (see module header).
 */
export function perceive(state, which) {
  const self = state[which];
  const opp = state[which === 'p1' ? 'p2' : 'p1'];
  const ball = state.ball;
  const field = state.field;

  const facts = factsScratch[which];

  const scx = self.x + PLAYER_WIDTH / 2;
  const scy = self.y + PLAYER_HEIGHT / 2;
  const ocx = opp.x + PLAYER_WIDTH / 2;
  const ocy = opp.y + PLAYER_HEIGHT / 2;

  facts.selfCx = scx;
  facts.selfCy = scy;
  facts.oppCx = ocx;
  facts.oppCy = ocy;

  facts.selfDistToBall = dist(scx, scy, ball.x, ball.y);
  facts.oppDistToBall = dist(ocx, ocy, ball.x, ball.y);
  facts.selfDistToOpp = dist(scx, scy, ocx, ocy);

  facts.selfInterceptTicks = interceptTicks(ball, self);
  facts.oppInterceptTicks = interceptTicks(ball, opp);

  attackKickSpot(field, ball, self.side, facts.attackKickSpot);

  facts.selfHasKickReach = canKickReach(state, self, FALLBACK_SAFETY_MARGIN);
  facts.oppHasKickReach = canKickReach(state, opp, FALLBACK_SAFETY_MARGIN);

  const kickDirX = self.side === 'left' ? 1 : -1;
  facts.oppBlocksLane = opponentBlocksLane(ball.x, ball.y, kickDirX, 0, ocx, ocy);

  const threatensOwnGoal = ballThreatensOwnGoal(field, ball, self.side);
  facts.threatensOwnGoal = threatensOwnGoal;
  facts.ownGoalInterceptY = threatensOwnGoal ? ballYAtOwnGoalLine(field, ball, self.side) : null;

  facts.selfBlocked = state.pauseState !== null
    || self.exhausted
    || self.pushTimer > 0
    || self.reactTimer > 0;
  facts.selfKicking = self.kick.active;

  facts.ballSpeedXY = Math.hypot(ball.vx, ball.vy);

  facts.pushOpportunity = pushOpportunity(self, opp, ball);
  facts.oppWindingUp = opp.kick.active;
  facts.oppExhausted = opp.exhausted;
  facts.selfSide = self.side;

  return facts;
}
