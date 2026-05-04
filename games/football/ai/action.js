/**
 * Pure: tactical intent + perception + personality -> 9-float action vector.
 * Caller owns no buffers; we allocate a fresh Float64Array per call.
 */

import {
  ACTION_MOVE_X,
  ACTION_MOVE_Y,
  ACTION_KICK_GATE,
  ACTION_KICK_DX,
  ACTION_KICK_DY,
  ACTION_KICK_DZ,
  ACTION_KICK_POWER,
  ACTION_PUSH_GATE,
  ACTION_PUSH_POWER,
  ACTION_VEC_SIZE as PHYSICS_ACTION_VEC_SIZE,
  PLAYER_WIDTH,
  PLAYER_HEIGHT,
  FIELD_HEIGHT,
  Z_STRETCH,
} from '../physics.js';

import { INTENT_KINDS } from './decision.js';

import {
  FALLBACK_DEAD_ZONE,
  FALLBACK_CAPTURE_RADIUS,
  STAMINA_CONSERVE_THRESHOLD,
  STAMINA_CONSERVE_MAGNITUDE,
  KICK_POWER_NEAR,
  KICK_POWER_FAR,
  PUSH_POWER_BASE,
  LOB_OPPONENT_BLOCK_DIST,
  LOB_KICK_DZ,
  LOB_BALL_FAST,
  APPROACH_RAMP_DIST,
  APPROACH_MIN_MAGNITUDE,
} from './tuning.js';

export const ACTION_VEC_SIZE = PHYSICS_ACTION_VEC_SIZE;

/**
 * Unit-vector pursuit toward a physics-space target, normalised in WORLD
 * coords. Physics depth is compressed by Z_STRETCH (4.7) so a naive
 * physics-space normalisation under-weighted dy and the player closed x
 * faster than y, arriving at the ball with a perp offset that broke
 * foot-ball contact. Normalising in world coords closes both axes
 * proportionally to what the eye sees. The returned (mx, my) is the
 * world-direction unit vector — physics' applyMovement then divides
 * targetVy by Z_STRETCH to produce visually-symmetric motion.
 */
function moveToward(self, tx, ty, captureRadius = 0) {
  const cx = self.x + PLAYER_WIDTH / 2;
  const cy = self.y + PLAYER_HEIGHT / 2;
  const dx = tx - cx;
  const dyWorld = (ty - cy) * Z_STRETCH;
  const d = Math.hypot(dx, dyWorld);
  if (captureRadius > 0 && d <= captureRadius) return { mx: 0, my: 0 };
  if (d < 1e-6) return { mx: 0, my: 0 };
  let mx = dx / d;
  let my = dyWorld / d;
  if (Math.abs(mx) < FALLBACK_DEAD_ZONE) mx = 0;
  if (Math.abs(my) < FALLBACK_DEAD_ZONE) my = 0;
  return { mx, my };
}

function magnitudeFor(self, perception) {
  if (perception.oppExhausted) return 1.0;
  if (self.stamina < STAMINA_CONSERVE_THRESHOLD) return STAMINA_CONSERVE_MAGNITUDE;
  return 1.0;
}

/**
 * Distance from ball to opp goal centre, normalised vs field width.
 * Used to scale kick power: short-range -> KICK_POWER_NEAR (avoid overshoot),
 * long-range -> KICK_POWER_FAR.
 */
function kickPowerFor(state, self) {
  const f = state.field;
  const tgx = self.side === 'left' ? f.goalLineR : f.goalLineL;
  const tgy = FIELD_HEIGHT / 2;
  const d = Math.hypot(tgx - state.ball.x, tgy - state.ball.y);
  const halfField = f.width / 2;
  const t = Math.min(1, d / halfField);
  return KICK_POWER_NEAR + t * (KICK_POWER_FAR - KICK_POWER_NEAR);
}

/**
 * Choose kick approach (ground / lob / angled) based on geometry +
 * urgency. Returns { dx, dy, dz } unit-ish direction with z elevated
 * for lob.
 */
function kickApproach(state, self, perception, personality) {
  const f = state.field;
  const ball = state.ball;
  const tgxBase = self.side === 'left' ? f.goalLineR : f.goalLineL;
  const tgyBase = FIELD_HEIGHT / 2;

  const aimYOffset = personality.kickAimYOffset * (f.goalMouthYMax - f.goalMouthYMin);
  const tgy = tgyBase + aimYOffset;

  const dx0 = tgxBase - ball.x;
  const dy0 = tgy - ball.y;
  const len = Math.hypot(dx0, dy0) || 1;

  const dxN = dx0 / len;
  const dyN = dy0 / len;

  const urgent = perception.ballSpeedXY > LOB_BALL_FAST || perception.oppWindingUp;

  let dz = 0;
  if (!urgent && perception.oppBlocksLane) {
    const ocx = perception.oppCx;
    const ocy = perception.oppCy;
    const distOppToBall = Math.hypot(ocx - ball.x, ocy - ball.y);
    if (distOppToBall < LOB_OPPONENT_BLOCK_DIST) {
      dz = LOB_KICK_DZ;
    }
  }

  return { dx: dxN, dy: dyN, dz };
}

/**
 * Encode intent into a 9-float action vector. Pure; allocates fresh Float64Array.
 *
 * personality: { kickAimYOffset, pushPowerScale } in [-1..1] range applied via
 * tuning constants in main caller.
 */
export function encode(state, which, perception, intent, personality) {
  const self = state[which];
  const out = new Float64Array(ACTION_VEC_SIZE);

  // Defaults: gates off, no kick, no push.
  out[ACTION_KICK_GATE] = -1;
  out[ACTION_PUSH_GATE] = -1;

  if (intent.kind === INTENT_KINDS.NEUTRAL) {
    return out;
  }

  // Movement target per intent kind. CONTENDER_KICK and the windup of an
  // already-active kick both leave MOVE at (0, 0): the player has arrived
  // at the kick spot and any drift during windup would shift the hip
  // (and therefore the foot world position relative to the frozen foot
  // target) and break contact. The approach run already aligned heading.
  let target = null;
  switch (intent.kind) {
    case INTENT_KINDS.GOALIE:
      target = intent.target;
      break;
    case INTENT_KINDS.CONTENDER_RUN:
    case INTENT_KINDS.SUPPORT:
      target = intent.target;
      break;
    default:
      target = null;
  }

  if (self.kick.active) target = null;

  if (target) {
    // Capture radius only applies to GOALIE (target is a fixed goal-line
    // point); CONTENDER_RUN/SUPPORT pursue continuously toward attackKickSpot
    // and the slowdown ramp brings them to a controlled arrival.
    const captureRadius = intent.kind === INTENT_KINDS.GOALIE ? FALLBACK_CAPTURE_RADIUS : 0;
    const { mx, my } = moveToward(self, target.x, target.y, captureRadius);
    let mag = magnitudeFor(self, perception);
    // Distance-based approach slowdown — see APPROACH_RAMP_DIST in tuning.js.
    const t = Math.min(1, perception.selfDistToBall / APPROACH_RAMP_DIST);
    const approachMag = APPROACH_MIN_MAGNITUDE + (1 - APPROACH_MIN_MAGNITUDE) * t;
    mag = Math.min(mag, approachMag);
    out[ACTION_MOVE_X] = mx * mag;
    out[ACTION_MOVE_Y] = my * mag;
  }

  if (intent.kind === INTENT_KINDS.CONTENDER_KICK && !self.kick.active) {
    const dir = kickApproach(state, self, perception, personality);
    out[ACTION_KICK_GATE] = 1;
    out[ACTION_KICK_DX] = dir.dx;
    out[ACTION_KICK_DY] = dir.dy;
    out[ACTION_KICK_DZ] = dir.dz;
    out[ACTION_KICK_POWER] = kickPowerFor(state, self);
  }

  if (intent.push && !self.kick.active) {
    out[ACTION_PUSH_GATE] = 1;
    out[ACTION_PUSH_POWER] = PUSH_POWER_BASE * personality.pushPowerScale;
  }

  return out;
}
