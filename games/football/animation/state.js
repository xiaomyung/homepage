// Animation state advancement — the pure, per-frame bookkeeping that
// used to sit at the top of `_addStickman()`. Extracted so the pose
// composer (poses.js), the renderer, and future test harnesses can
// share one authoritative source for LPF smoothing, phase
// accumulation, push-progress edge detection, and derived state
// (is the player kicking? pushing? celebrating?).
//
// Pure — no DOM, no three.js — imported from the renderer.

import { Z_STRETCH } from '../physics.js';

// ── Smoothing + phase-rate tuning ────────────────────────────
// Low-pass smoothing factor for tilt / amplitude / celebrate. Values
// converge to their targets in ~1/STICKMAN_SMOOTH frames.
export const STICKMAN_SMOOTH = 0.15;

// Walk-tilt shape. Below RUN_THRESHOLD, no forward/back lean. Above
// it, tilt grows linearly with speed up to TILT_MAX.
export const STICKMAN_RUN_THRESHOLD = 1.2;
export const STICKMAN_TILT_PER_SPEED = 0.09;
export const STICKMAN_TILT_MAX = 0.45;

// Celebrate rotation rate. ~25 ticks per jumping-jack cycle at 60Hz.
export const CELEB_PHASE_RATE = 0.25;

// Grieve rotation rate — the loser's slow back-and-forth body rock
// during a goal celebration (non-scorer reaction). Much slower than
// celebrate: ~80 ticks per cycle = ~1.3 s of gentle sway.
export const GRIEVE_PHASE_RATE = 0.08;

const TWO_PI = Math.PI * 2;

/** Allocate a fresh per-player animation state. Call once per
 *  player; mutate via advanceAnimState each frame. */
export function createAnimState(tick, player) {
  return {
    tilt: 0,
    amplitude: 0,
    phase: 0,
    celebrate: 0,
    celebratePhase: 0,
    grieve: 0,
    grievePhase: 0,
    pushing: 0,
    pushProgress: 0,
    prevPushTimer: 0,
    lastTick: tick,
    lastX: player.x,
    lastY: player.y,
  };
}

/** Advance one frame of anim state in place. Returns a snapshot
 *  object (populated into `out` to avoid per-frame allocation) that
 *  the pose composer consumes.
 *
 *  Effective velocity is derived from POSITION DELTA (player.x -
 *  anim.lastX), not player.vx — this matches the existing renderer
 *  behaviour and lets teleporting scenarios zero out walk animation
 *  by syncing anim.lastX after a jump.
 */
export function advanceAnimState(anim, player, tick, isCelebrating, out, isGrieving = false) {
  const dt = tick > anim.lastTick ? tick - anim.lastTick : 0;
  const denom = dt > 0 ? dt : 1;
  const effVx = (player.x - anim.lastX) / denom;
  const effVy = (player.y - anim.lastY) / denom;
  anim.lastTick = tick;
  anim.lastX = player.x;
  anim.lastY = player.y;

  const heading = player.heading ?? 0;
  const forwardX = Math.cos(heading);
  const forwardZ = Math.sin(heading);

  const speed = Math.sqrt(effVx * effVx + effVy * effVy);

  // Walk tilt — sign from the component of motion along the player's
  // heading. Positive = moving forward; negative = moving backward.
  const effVworldZ = effVy * Z_STRETCH;
  const forwardSpeed = effVx * forwardX + effVworldZ * forwardZ;
  const targetAmplitude = Math.min(speed * 0.2, 1.0);
  const targetTilt = speed > STICKMAN_RUN_THRESHOLD
    ? Math.sign(forwardSpeed) * Math.min(
        (speed - STICKMAN_RUN_THRESHOLD) * STICKMAN_TILT_PER_SPEED,
        STICKMAN_TILT_MAX,
      )
    : 0;
  const swingRate = 0.2 + speed * 0.04;

  const targetCelebrate = isCelebrating ? 1 : 0;
  const targetGrieve    = isGrieving    ? 1 : 0;
  const targetPushing   = player.pushTimer > 0 ? 1 : 0;

  // Push-progress edge detection: reset to 0 on the rising edge of
  // pushTimer, then accumulate dt while it's positive.
  if (player.pushTimer > 0) {
    if (anim.prevPushTimer <= 0) anim.pushProgress = 0;
    anim.pushProgress += dt;
  } else {
    anim.pushProgress = 0;
  }
  anim.prevPushTimer = player.pushTimer;

  // LPF smoothing + phase advancement.
  anim.tilt      += (targetTilt      - anim.tilt)      * STICKMAN_SMOOTH;
  anim.amplitude += (targetAmplitude - anim.amplitude) * STICKMAN_SMOOTH;
  anim.celebrate += (targetCelebrate - anim.celebrate) * STICKMAN_SMOOTH;
  anim.grieve    += (targetGrieve    - anim.grieve)    * STICKMAN_SMOOTH;
  anim.pushing = targetPushing;
  anim.phase          = (anim.phase          + swingRate        * dt) % TWO_PI;
  anim.celebratePhase = (anim.celebratePhase + CELEB_PHASE_RATE  * dt) % TWO_PI;
  anim.grievePhase    = (anim.grievePhase    + GRIEVE_PHASE_RATE * dt) % TWO_PI;

  const kick = player.kick;
  const isKicking = !!(kick && kick.active);
  const isAirkick = isKicking && kick.kind === 'air';

  // Top-level state label — useful for the editor / debug panels /
  // future FSM extensions. Derived from physics flags only, not from
  // anim smoothing, so transitions are crisp.
  let stateName;
  if (isCelebrating)              stateName = 'CELEBRATE';
  else if (isGrieving)            stateName = 'GRIEVE';
  else if (isKicking)             stateName = isAirkick ? 'KICK_AIR' : 'KICK_GROUND';
  else if (player.pushTimer > 0)  stateName = 'PUSH';
  else if (speed > 0.5)           stateName = 'WALK';
  else                            stateName = 'IDLE';

  if (!out) out = {};
  out.state          = stateName;
  out.heading        = heading;
  out.forwardX       = forwardX;
  out.forwardZ       = forwardZ;
  out.dt             = dt;
  out.speed          = speed;
  out.swing          = Math.sin(anim.phase);
  out.amplitude      = anim.amplitude;
  out.walkTilt       = anim.tilt;
  out.celebrate      = anim.celebrate;
  out.celebratePhase = anim.celebratePhase;
  out.grieve         = anim.grieve;
  out.grievePhase    = anim.grievePhase;
  out.pushing        = anim.pushing;
  out.pushProgress   = anim.pushProgress;
  out.isKicking      = isKicking;
  out.isAirkick      = isAirkick;
  out.airLift        = player.airZ || 0;
  out.kick           = kick;
  return out;
}
