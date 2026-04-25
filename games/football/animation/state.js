// Animation state advancement — the pure, per-frame bookkeeping that
// used to sit at the top of `_addStickman()`. Extracted so the pose
// composer (poses.js), the renderer, and future test harnesses can
// share one authoritative source for LPF smoothing, phase
// accumulation, push-progress edge detection, and derived state
// (is the player kicking? pushing? celebrating?).
//
// Pure — no DOM, no three.js — imported from the renderer.

import { REACT_ANIM_MS, Z_STRETCH, wrapAngle } from '../physics.js';

// ── Smoothing + phase-rate tuning ────────────────────────────
// Low-pass smoothing factor for tilt / amplitude / celebrate. Values
// converge to their targets in ~1/STICKMAN_SMOOTH frames.
export const STICKMAN_SMOOTH = 0.15;

// Walk-tilt shape. Below RUN_THRESHOLD, no forward/back lean. Above
// it, tilt grows linearly with speed up to TILT_MAX.
export const STICKMAN_RUN_THRESHOLD = 1.2;
export const STICKMAN_TILT_PER_SPEED = 0.09;
export const STICKMAN_TILT_MAX = 0.45;

// Celebrate rotation rate. 50% slower than the original jumping-jack
// tempo — the jump-cycle pose (crouch → launch → apex → land) needs
// more time to read as a real hop, and the fist-pump cadence at the
// new rate sits around one pump every ~0.8 s, which matches natural
// celebration tempo better than the old frenetic beat.
export const CELEB_PHASE_RATE = 0.125;

// Grieve rotation rate — the loser's slow back-and-forth body rock
// during a goal celebration (non-scorer reaction). Much slower than
// celebrate: ~80 ticks per cycle = ~1.3 s of gentle sway.
export const GRIEVE_PHASE_RATE = 0.08;

// Rest (exhausted-and-recovering) body-spin rate. Slower than walk
// swing — a dazed, sluggish circle. ~62 ticks per full body rotation
// ≈ 1 s. Keeps the animation legible at game speed without inducing
// motion sickness.
export const REST_PHASE_RATE = 0.10;

// TURN / STOP detection thresholds. Scales map raw angular velocity
// (rad/tick) and deceleration (u/tick²) onto the 0..1 factor the
// pose composer reads. Empirical — tuned against the locomotion
// harness 'turn 180°' and 'hard stop' scenarios.
export const TURN_ANGVEL_SCALE = 0.08;   // rad/tick that reads as "full turn"
export const STOP_DECEL_SCALE  = 0.8;    // u/tick² deceleration that reads as "full stop brake"

// Walk-cycle tuning. Amplitude grows linearly with speed up to a cap;
// swing rate (radians per tick of phase advance) also rises with speed
// so faster movement = faster step cadence.
const WALK_AMP_PER_SPEED   = 0.35;
const WALK_AMP_MAX         = 1.0;
const SWING_RATE_BASE      = 0.2;
const SWING_RATE_PER_SPEED = 0.04;

// Reposition heading-override gate. Below this physics speed the
// motion-vector heading is too noisy to track, so animHeading sticks
// with the physics heading instead.
const REPOSITION_SPEED_GATE = 0.3;

// State-label gates. Used only to emit the advisory `out.state`
// label; the pose composer reads smoothed factors directly.
const STATE_LABEL_STOP_GATE = 0.5;
const STATE_LABEL_TURN_GATE = 0.5;
const STATE_LABEL_WALK_GATE = 0.5;

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
    // Rest (exhausted recovery) state — body spins slowly while
    // stamina recharges past STAMINA_EXHAUSTION_THRESHOLD.
    rest: 0,
    restPhase: 0,
    // TURN + STOP detection history
    turn: 0,
    stop: 0,
    prevHeading: player.heading ?? 0,
    prevSpeed: 0,
    // Animation-side smoothed heading — decoupled from physics
    // heading during reposition so the stickman actually faces
    // where it's walking instead of side-stepping.
    animHeading: null,
    // MATCHEND poses — triumph (winner) or slump (loser) at match over.
    matchWin: 0,
    matchLose: 0,
    lastTick: tick,
    lastX: player.x,
    lastY: player.y,
    // Cached motion-derived values — written on frames where
    // physics ticked (dt > 0), re-read on no-tick render frames so
    // the speed-slider doesn't drain the LPFs toward zero on
    // fractional-speed / paused frames.
    cachedHeading: player.heading ?? 0,
    cachedForwardX: Math.cos(player.heading ?? 0),
    cachedForwardZ: Math.sin(player.heading ?? 0),
    cachedSpeed: 0,
    cachedTargetTurn: 0,
    cachedTargetStop: 0,
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
export function advanceAnimState(
  anim, player, tick, isCelebrating, out,
  isGrieving = false, isReposition = false,
  isMatchendWin = false, isMatchendLose = false,
) {
  const dt = tick > anim.lastTick ? tick - anim.lastTick : 0;

  // Tick-rewind handling: when the simulation restarts (showcase
  // replay, new match via `resetStateInPlace`, scenario re-init in
  // the harness), `tick` jumps backwards. Without resyncing here,
  // `anim.lastTick` would stay frozen at the old high value and
  // every subsequent frame would compute `dt = 0` until physics
  // caught up — the stickman would slide without animating for an
  // entire match. Resync the reference frame so the next physics
  // tick produces a sane `dt = 1`.
  if (tick < anim.lastTick) {
    anim.lastTick = tick;
    anim.lastX    = player.x;
    anim.lastY    = player.y;
  }

  // Motion-dependent updates only run on frames where physics
  // ticked. Speed-slider frames with no tick (slider < 1 or paused)
  // would otherwise observe effVx = 0 / dt = 0, drain `amplitude`
  // through the LPF, and visibly deflate the walk cycle — the
  // animation must track PHYSICS time, not render time. On no-tick
  // frames we re-emit the snapshot from cached anim state.
  if (dt > 0) {
    const denom = dt;
    const effVx = (player.x - anim.lastX) / denom;
    const effVy = (player.y - anim.lastY) / denom;
    anim.lastTick = tick;
    anim.lastX = player.x;
    anim.lastY = player.y;

    const physicsHeading = player.heading ?? 0;
    const speed = Math.sqrt(effVx * effVx + effVy * effVy);

    // Animation heading — normally the physics heading, but during
    // reposition the physics-side heading lags (stepReposition just
    // translates position without updating heading). Face the motion
    // direction instead so the stickman walks FACING kickoff instead
    // of side-stepping. Smoothly interpolated via anim.animHeading
    // so the turn doesn't snap.
    let heading = physicsHeading;
    if (isReposition && speed > REPOSITION_SPEED_GATE) {
      const motionHeading = Math.atan2(effVy * Z_STRETCH, effVx);
      // Seed on first frame of reposition so we don't pop from an old
      // physics heading to the new motion heading.
      if (anim.animHeading == null) anim.animHeading = motionHeading;
      const delta = wrapAngle(motionHeading - anim.animHeading);
      anim.animHeading = wrapAngle(anim.animHeading + delta * STICKMAN_SMOOTH * 2);
      heading = anim.animHeading;
    } else {
      // Not repositioning — track physics heading so re-entry into
      // reposition smoothly interpolates from the current facing.
      anim.animHeading = physicsHeading;
    }
    const forwardX = Math.cos(heading);
    const forwardZ = Math.sin(heading);

    // Walk tilt — sign from the component of motion along the player's
    // heading. Positive = moving forward; negative = moving backward.
    const effVworldZ = effVy * Z_STRETCH;
    const forwardSpeed = effVx * forwardX + effVworldZ * forwardZ;
    // Amplitude drives the walk-swing magnitude. Bumped slope from
    // 0.2 → 0.35 so slow walking has visible leg movement instead
    // of the near-idle shuffle the old coefficient produced; cap
    // stays at 1.0 so max thigh swing stays in the natural
    // ~40° range (legSwing coefficient 0.7 × amp 1.0 = 0.7 rad).
    const targetAmplitude = Math.min(speed * WALK_AMP_PER_SPEED, WALK_AMP_MAX);
    const targetTilt = speed > STICKMAN_RUN_THRESHOLD
      ? Math.sign(forwardSpeed) * Math.min(
          (speed - STICKMAN_RUN_THRESHOLD) * STICKMAN_TILT_PER_SPEED,
          STICKMAN_TILT_MAX,
        )
      : 0;
    const swingRate = SWING_RATE_BASE + speed * SWING_RATE_PER_SPEED;

    const targetCelebrate = isCelebrating  ? 1 : 0;
    const targetGrieve    = isGrieving     ? 1 : 0;
    const targetMatchWin  = isMatchendWin  ? 1 : 0;
    const targetMatchLose = isMatchendLose ? 1 : 0;
    const targetPushing   = player.pushTimer > 0 ? 1 : 0;
    // Rest target: only exhausted players who aren't doing anything
    // else play the dazed-spin pose. Once stamina passes the
    // STAMINA_EXHAUSTION_THRESHOLD, physics clears `exhausted` and
    // the rest LPF unwinds to 0.
    const isResting = !!player.exhausted
      && !isCelebrating && !isGrieving
      && !isMatchendWin && !isMatchendLose
      && !isReposition;
    const targetRest = isResting ? 1 : 0;

    // TURN / STOP detection — both inferred from per-frame deltas.
    // angVel = how fast the heading is swinging this tick; decel =
    // how much speed dropped this tick. Scaled by the shared scales
    // above so the smoothed `turn` / `stop` live in [0, 1].
    const angVel = Math.abs(wrapAngle(heading - anim.prevHeading)) / denom;
    const decel  = Math.max(0, (anim.prevSpeed - speed) / denom);
    anim.prevHeading = heading;
    anim.prevSpeed   = speed;
    const targetTurn = Math.min(1, angVel / TURN_ANGVEL_SCALE);
    const targetStop = Math.min(1, decel  / STOP_DECEL_SCALE);

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
    anim.matchWin  += (targetMatchWin  - anim.matchWin)  * STICKMAN_SMOOTH;
    anim.matchLose += (targetMatchLose - anim.matchLose) * STICKMAN_SMOOTH;
    anim.turn      += (targetTurn      - anim.turn)      * STICKMAN_SMOOTH;
    anim.stop      += (targetStop      - anim.stop)      * STICKMAN_SMOOTH;
    anim.rest      += (targetRest      - anim.rest)      * STICKMAN_SMOOTH;
    anim.pushing = targetPushing;
    anim.phase          = (anim.phase          + swingRate        * dt) % TWO_PI;
    anim.celebratePhase = (anim.celebratePhase + CELEB_PHASE_RATE  * dt) % TWO_PI;
    anim.grievePhase    = (anim.grievePhase    + GRIEVE_PHASE_RATE * dt) % TWO_PI;
    // restPhase advances only while `rest` is active, so the LPF
    // tail on exit doesn't add residual rotation. Reset to 0 when
    // rest is fully off so re-entry starts at a clean angle.
    if (anim.rest > 0.001) {
      anim.restPhase = (anim.restPhase + REST_PHASE_RATE * dt) % TWO_PI;
    } else {
      anim.restPhase = 0;
    }

    // Cache the tick-derived non-LPF scalars for no-tick render
    // frames to pass through verbatim.
    anim.cachedHeading    = heading;
    anim.cachedForwardX   = forwardX;
    anim.cachedForwardZ   = forwardZ;
    anim.cachedSpeed      = speed;
    anim.cachedTargetTurn = targetTurn;
    anim.cachedTargetStop = targetStop;
  }

  // Re-use cached values when physics didn't tick this frame.
  const heading   = anim.cachedHeading;
  const forwardX  = anim.cachedForwardX;
  const forwardZ  = anim.cachedForwardZ;
  const speed     = anim.cachedSpeed;
  const targetTurn = anim.cachedTargetTurn;
  const targetStop = anim.cachedTargetStop;

  const kick = player.kick;
  const isKicking = !!(kick && kick.active);
  const isAirkick = isKicking && kick.kind === 'air';

  // Top-level state label — useful for the editor / debug panels /
  // future FSM extensions. Derived from physics flags only, not from
  // anim smoothing, so transitions are crisp.
  let stateName;
  if (isMatchendWin)                          stateName = 'MATCHEND_WIN';
  else if (isMatchendLose)                    stateName = 'MATCHEND_LOSE';
  else if (isCelebrating)                     stateName = 'CELEBRATE';
  else if (isGrieving)                        stateName = 'GRIEVE';
  else if (isReposition && speed > REPOSITION_SPEED_GATE) stateName = 'REPOSITION';
  else if (isKicking)                         stateName = isAirkick ? 'KICK_AIR' : 'KICK_GROUND';
  else if (player.pushTimer > 0)              stateName = 'PUSH';
  else if (player.exhausted)                  stateName = 'EXHAUSTED';
  else if (targetStop > STATE_LABEL_STOP_GATE) stateName = 'STOP';
  else if (targetTurn > STATE_LABEL_TURN_GATE) stateName = 'TURN';
  else if (speed > STATE_LABEL_WALK_GATE)     stateName = 'WALK';
  else                                        stateName = 'IDLE';

  if (!out) out = {};
  out.state          = stateName;
  out.heading        = heading;
  out.forwardX       = forwardX;
  out.forwardZ       = forwardZ;
  out.dt             = dt;
  out.speed          = speed;
  out.swing          = Math.sin(anim.phase);
  // cosine of phase used by the walk-leg composer to split swing
  // vs stance per leg (swing phase of the right leg coincides with
  // cos(phase) > 0; the left leg is 180° out of phase).
  out.cosPhase       = Math.cos(anim.phase);
  out.amplitude      = anim.amplitude;
  out.walkTilt       = anim.tilt;
  out.celebrate      = anim.celebrate;
  out.celebratePhase = anim.celebratePhase;
  out.grieve         = anim.grieve;
  out.grievePhase    = anim.grievePhase;
  out.matchWin       = anim.matchWin;
  out.matchLose      = anim.matchLose;
  out.turn           = anim.turn;
  out.stop           = anim.stop;
  out.rest           = anim.rest;
  out.restPhase      = anim.restPhase;
  out.pushing        = anim.pushing;
  out.pushProgress   = anim.pushProgress;
  out.isKicking      = isKicking;
  out.isAirkick      = isAirkick;
  out.airLift        = player.airZ || 0;
  out.kick           = kick;
  // Victim hit-reaction passthrough (purely read-only from physics).
  // reactT is 0→1 over REACT_ANIM_MS; reactForce is normalized 0..1.
  if (player.reactTimer > 0) {
    out.reactT       = 1 - (player.reactTimer / REACT_ANIM_MS);
    out.reactForce   = player.reactForce  || 0;
    out.reactDirX    = player.reactDirX   || 0;
    out.reactDirZ    = player.reactDirZ   || 0;
    out.reactType    = player.reactType   || 'jab';
    out.reactLatSign = player.reactLatSign || 1;
  } else {
    out.reactT       = 0;
    out.reactForce   = 0;
    out.reactDirX    = 0;
    out.reactDirZ    = 0;
    out.reactType    = 'jab';
    out.reactLatSign = 1;
  }
  return out;
}
