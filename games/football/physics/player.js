/**
 * Football v2 — per-player tick state machine.
 *
 * Stamina regen + exhausted-flag hysteresis, action-vector dispatch
 * (kick / push gates → tryStartKick / tryPush; movement vector →
 * applyMovement), heading-rate clamp, and the displacement-based
 * stamina drain. Everything that mutates one player's per-tick state
 * lives here. Push-velocity damping (`applyPushPhysics`) and the
 * push hit-reaction timer (`advanceReactTimer`) live in push.js.
 */

import {
  Z_STRETCH,
  PLAYER_HEIGHT, PLAYER_WIDTH, FIELD_HEIGHT,
  PLAYER_TURN_RATE, PLAYER_ACCEL, PLAYER_ACCEL_TICKS,
  MAX_PLAYER_SPEED, MIN_SPEED_STAMINA,
  MOVE_INPUT_DEAD_ZONE, MOVE_THRESHOLD_SQ,
  STAMINA_REGEN, STAMINA_EXHAUSTION_THRESHOLD,
  STAMINA_MOVE_BASE, STAMINA_MOVE_PER_UNIT, STAMINA_MOVE_THRESHOLD,
  DIRECTION_CHANGE_DRAIN,
  ACTION_MOVE_X, ACTION_MOVE_Y,
  ACTION_KICK_GATE, ACTION_KICK_DX, ACTION_KICK_DY, ACTION_KICK_DZ, ACTION_KICK_POWER,
  ACTION_PUSH_GATE, ACTION_PUSH_POWER,
} from './tuning.js';
import { clamp, wrapAngle } from './state.js';
import { advanceKick, tryStartKick } from './kick.js';
import { advancePush, tryPush } from './push.js';

export function applyRegenAndExhaustion(p) {
  if (p.stamina <= 0) p.exhausted = true;
  if (p.exhausted && p.stamina >= STAMINA_EXHAUSTION_THRESHOLD) p.exhausted = false;
  p.stamina = Math.min(1, p.stamina + STAMINA_REGEN);
}

/* ── Action dispatch ─────────────────────────────────────────── */

export function applyAction(state, p, out) {
  // In-flight kicks must always tick forward to completion — even if
  // the player became exhausted during the kick.
  if (advanceKick(state, p)) return;
  // Push cooldown decrements unconditionally so a push issued right
  // before a kick doesn't get frozen at max for the kick's duration.
  if (advancePush(state, p)) return;

  if (p.exhausted) { p.vx = 0; p.vy = 0; return; }

  // Order: kick + push gates BEFORE movement. The controller's perception
  // sees the player's pre-tick state when computing canKickReach / push
  // gates; running movement first would shift heading + position before
  // the gate test, so a borderline reach the controller correctly saw
  // could fail at tryStartKick.
  if (out[ACTION_PUSH_GATE] > 0) {
    const opp = p === state.p1 ? state.p2 : state.p1;
    tryPush(state, p, opp, out[ACTION_PUSH_POWER]);
  }

  if (out[ACTION_KICK_GATE] > 0) {
    tryStartKick(
      state, p,
      out[ACTION_KICK_DX],
      out[ACTION_KICK_DY],
      out[ACTION_KICK_DZ],
      out[ACTION_KICK_POWER],
    );
  }

  applyMovement(state, p, out[ACTION_MOVE_X], out[ACTION_MOVE_Y]);
}

/* ── Angle helpers ────────────────────────────────────────────── */

/** Rotate `current` toward `target` by at most PLAYER_TURN_RATE. */
function turnToward(current, target) {
  const diff = wrapAngle(target - current);
  if (diff >  PLAYER_TURN_RATE) return current + PLAYER_TURN_RATE;
  if (diff < -PLAYER_TURN_RATE) return current - PLAYER_TURN_RATE;
  return target;
}

/** True iff `p`'s heading points at world-space (worldX, worldZ) within
 *  `tol` radians. Note: bubble-centric — kick reach uses its own
 *  shoulder-line cone via `canKickReach`. */
export function facingToward(p, worldX, worldZ, tol) {
  const centerX = p.x + PLAYER_WIDTH / 2;
  const centerZ = (p.y + PLAYER_HEIGHT / 2) * Z_STRETCH;
  const want = Math.atan2(worldZ - centerZ, worldX - centerX);
  return Math.abs(wrapAngle(want - p.heading)) < tol;
}

/* ── Movement ─────────────────────────────────────────────────── */

export function applyMovement(state, p, moveX, moveY) {
  if (Math.abs(moveX) < MOVE_INPUT_DEAD_ZONE) moveX = 0;
  if (Math.abs(moveY) < MOVE_INPUT_DEAD_ZONE) moveY = 0;
  const effSpeed = MAX_PLAYER_SPEED * Math.max(MIN_SPEED_STAMINA, p.stamina);
  let targetVx = clamp(moveX, -1, 1) * effSpeed;
  // Y physics-space is compressed by Z_STRETCH relative to visual
  // space; dividing the y target velocity by Z_STRETCH makes equal
  // visual distance cost equal physics time, so walking reads
  // symmetrically in both axes.
  let targetVy = clamp(moveY, -1, 1) * effSpeed / Z_STRETCH;

  if ((p.y <= 0 && targetVy < 0) || (p.y >= FIELD_HEIGHT - PLAYER_HEIGHT && targetVy > 0)) {
    targetVy = 0; p.vy = 0;
  }
  if ((p.x <= 0 && targetVx < 0) || (p.x >= state.field.width - state.field.playerWidth && targetVx > 0)) {
    targetVx = 0; p.vx = 0;
  }

  // Direction-change drain: fire exactly once on the tick where the
  // commanded target direction *flips*, not every tick while the
  // current velocity is still crossing zero toward the new target.
  const targetDirX = targetVx > 0 ? 1 : targetVx < 0 ? -1 : 0;
  const targetDirY = targetVy > 0 ? 1 : targetVy < 0 ? -1 : 0;
  const xFlipped = targetDirX !== 0 && p.prevTargetDirX !== 0 && targetDirX !== p.prevTargetDirX;
  const yFlipped = targetDirY !== 0 && p.prevTargetDirY !== 0 && targetDirY !== p.prevTargetDirY;
  if (xFlipped || yFlipped) {
    p.stamina = Math.max(0, p.stamina - DIRECTION_CHANGE_DRAIN);
  }
  p.prevTargetDirX = targetDirX;
  p.prevTargetDirY = targetDirY;

  // Acceleration cap — bound |Δv| to PLAYER_ACCEL per tick. A full
  // stop from max speed takes PLAYER_ACCEL_TICKS ticks, a 180°
  // reversal takes 2× that.
  const dvx = targetVx - p.vx;
  const dvy = targetVy - p.vy;
  const dvMag = Math.sqrt(dvx * dvx + dvy * dvy);
  if (dvMag > PLAYER_ACCEL) {
    const scale = PLAYER_ACCEL / dvMag;
    p.vx += dvx * scale;
    p.vy += dvy * scale;
  } else {
    p.vx = targetVx;
    p.vy = targetVy;
  }

  const speedSq = p.vx * p.vx + p.vy * p.vy;
  if (speedSq > MOVE_THRESHOLD_SQ) {
    p.x += p.vx;
    p.y += p.vy;
    // Heading target = direction of current visual motion (physics
    // vy scaled by Z_STRETCH) so facing and motion read consistently.
    const targetHeading = Math.atan2(p.vy * Z_STRETCH, p.vx);
    p.heading = turnToward(p.heading, targetHeading);
  } else {
    p.vx = 0;
    p.vy = 0;
  }
}

export function chargeStaminaFromDisplacement(p, preX, preY) {
  const dx = p.x - preX;
  const dy = p.y - preY;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist < STAMINA_MOVE_THRESHOLD) return;
  p.stamina -= STAMINA_MOVE_BASE + STAMINA_MOVE_PER_UNIT * dist;
  if (p.stamina < 0) p.stamina = 0;
}
