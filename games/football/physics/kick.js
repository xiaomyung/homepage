/**
 * Football v2 — kick FSM + leg IK.
 *
 * The kick state machine runs windup → strike → recovery, with foot
 * IK against the ball-prediction target. Owns the analytic 2-bone IK
 * solver `solve2BoneIK`. The kick reach gate (`canKickReach`) is
 * exported for the AI controller so the gate the controller checks
 * is byte-identical to the physics gate that fires the kick.
 */

import {
  TICK_MS, GRAVITY, BALL_RADIUS, Z_STRETCH,
  PLAYER_WIDTH,
  AIRKICK_MS, AIRKICK_PEAK_FRAC, AIRKICK_DZ_THRESHOLD, AIRKICK_MAX_Z,
  KICK_WINDUP_MS, KICK_DURATION_MS, KICK_STRIKE_WINDOW_MS,
  KICK_FACE_TOL, KICK_REACH_MAX, KICK_DIR_MIN_LEN,
  KICK_NOISE_SCALE, KICK_NOISE_VERT,
  WASTED_KICK_SPEED,
  WINDUP_PEAK_TEFF, WINDUP_LOAD_FRAC,
  KICK_COCK_FWD_FRAC, KICK_COCK_UP_FRAC,
  MAX_KICK_POWER, MIN_KICK_POWER, MIN_KICK_STAMINA,
  STAMINA_KICK_DRAIN, STAMINA_AIRKICK_DRAIN,
  FOOT_RADIUS, FOOT_LATERAL_REACH, LATERAL_FOOT_FLEX,
  STICKMAN_UPPER_LEG, STICKMAN_LOWER_LEG,
} from './tuning.js';
import { clamp, wrapAngle, gaussRandom } from './state.js';
import { hipAnchor, projectHipLocal } from './geometry.js';

/* ── Two-bone IK (planar, hip → knee → foot) ────────────────── */

/**
 * Analytic 2-bone IK in the (forward, up) plane local to the hip.
 *
 * Inputs are already projected into that plane — `targetFwd` is the
 * forward distance from hip to target (+ = player's facing direction);
 * `targetUp` is the vertical offset (− = below hip).
 *
 * Outputs `upperAngle` and `lowerAngle` in the same convention the
 * renderer's `placeLeg` consumes: measured from straight-down,
 * increasing toward the forward axis. The solver always picks the
 * "knee forward" branch (knee bends in front of the hip→foot line).
 *
 * When the target is unreachable (distance > U+L), the foot lands on
 * the hip→target ray at maximum extent; clamped to |U−L| from below
 * so the leg never folds past itself. Pure, allocation-free into out.
 */
const _scratchIK = { upperAngle: 0, lowerAngle: 0, footFwd: 0, footUp: 0 };
export function solve2BoneIK(targetFwd, targetUp, U, L, out = _scratchIK) {
  const targetDown = -targetUp;
  const rawD = Math.hypot(targetFwd, targetDown);
  const maxReach = U + L;
  const minReach = Math.abs(U - L);
  const clampedD = Math.min(Math.max(rawD, minReach), maxReach);

  let tf, tdown;
  if (rawD < 1e-6) {
    tf = 0;
    tdown = clampedD;
  } else {
    const scale = clampedD / rawD;
    tf = targetFwd * scale;
    tdown = targetDown * scale;
  }

  const safeD = Math.max(clampedD, 1e-6);
  const theta0 = Math.atan2(tf, tdown);
  const cosAlpha = (U * U + safeD * safeD - L * L) / (2 * U * safeD);
  const alpha = Math.acos(Math.max(-1, Math.min(1, cosAlpha)));
  const upperAngle = theta0 + alpha;

  const kneeFwd = U * Math.sin(upperAngle);
  const kneeDown = U * Math.cos(upperAngle);
  const shinFwd = tf - kneeFwd;
  const shinDown = tdown - kneeDown;
  const lowerAngle = Math.atan2(shinFwd, shinDown);

  out.upperAngle = upperAngle;
  out.lowerAngle = lowerAngle;
  out.footFwd = tf;
  out.footUp = -tdown;
  return out;
}

/* ── Kick state machine ──────────────────────────────────────── */

/** Strike-tick lead for the reachability check and initial foot
 *  target prediction. Ground kicks strike at KICK_WINDUP_MS; air
 *  kicks strike at the peak of the jump arc. */
function strikeLeadTicks(kind) {
  return kind === 'air'
    ? Math.round((AIRKICK_PEAK_FRAC * AIRKICK_MS) / TICK_MS)
    : Math.round(KICK_WINDUP_MS / TICK_MS);
}

/**
 * Predict the ball's world-space CENTER position `ticks` from now.
 *
 * Matches the integrator in `updateBall`:
 *   - Horizontal (x, y): linear step — friction is applied once per
 *     tick post-substep, so over a short ~6-tick lead the quadratic
 *     decay is negligible.
 *   - Vertical (z): semi-implicit Euler — vz -= g; z += vz; — so
 *     the closed form is z₀ + N·vz₀ − g·N·(N+1)/2.
 */
const _scratchPredicted = { x: 0, y: 0, z: 0 };
const _scratchHip = { x: 0, y: 0, z: 0 };
const _scratchLocal = { fwd: 0, up: 0, perp: 0 };
function predictBallAtStrike(ball, ticks, out) {
  const nx = ball.x + ball.vx * ticks;
  const ny_phys = ball.y + ball.vy * ticks;
  const nz_phys = Math.max(0, ball.z + ball.vz * ticks - 0.5 * GRAVITY * ticks * (ticks + 1));
  out.x = nx;
  out.y = nz_phys + BALL_RADIUS;
  out.z = ny_phys * Z_STRETCH;
  return out;
}

/** Compute foot world position by IK'ing toward `kick.footTarget`.
 *  Writes (x, y=vertical, z=depth) into `out`. The leg yaws at the hip
 *  by `local.perp` (capped at LATERAL_FOOT_FLEX) so the foot lands on
 *  a ball off the sagittal plane — a natural-looking side-of-foot hook,
 *  not a stiff straight-ahead strike. */
const _scratchIKRes = { upperAngle: 0, lowerAngle: 0, footFwd: 0, footUp: 0 };
export function ikFootWorld(p, out) {
  const k = p.kick;
  const hip = hipAnchor(p, _scratchHip);
  const local = projectHipLocal(hip, p.heading, k.footTargetX, k.footTargetY, k.footTargetZ, _scratchLocal);
  const perpEff = clamp(local.perp, -LATERAL_FOOT_FLEX, LATERAL_FOOT_FLEX);
  solve2BoneIK(local.fwd, local.up, STICKMAN_UPPER_LEG, STICKMAN_LOWER_LEG, _scratchIKRes);
  const fwdX = Math.cos(p.heading);
  const fwdZ = Math.sin(p.heading);
  const perpX = -fwdZ;
  const perpZ = fwdX;
  out.x = hip.x + _scratchIKRes.footFwd * fwdX + perpEff * perpX;
  out.y = hip.y + _scratchIKRes.footUp;
  out.z = hip.z + _scratchIKRes.footFwd * fwdZ + perpEff * perpZ;
  return out;
}

/**
 * Would a ground kick by `p` pass the reachability + facing gate right
 * now? Mirrors `tryStartKick`'s ground-kick path exactly so the
 * controller never emits a kick action the engine then silently rejects.
 *
 * `safetyMargin` tightens the reach threshold — useful when the caller
 * wants headroom for one tick of post-perception movement.
 */
export function canKickReach(state, p, safetyMargin = 0) {
  const predicted = predictBallAtStrike(state.ball, strikeLeadTicks('ground'), _scratchPredicted);
  const hip = hipAnchor(p, _scratchHip);
  const local = projectHipLocal(hip, p.heading, predicted.x, predicted.y, predicted.z, _scratchLocal);
  const perpEff = clamp(local.perp, -LATERAL_FOOT_FLEX, LATERAL_FOOT_FLEX);
  const dist = Math.hypot(local.fwd, local.up, perpEff);
  if (dist > KICK_REACH_MAX - safetyMargin) return false;
  if (Math.abs(local.perp) > FOOT_LATERAL_REACH - safetyMargin) return false;
  const facePivotX = p.x + PLAYER_WIDTH / 2;
  const facePivotZ = p.y * Z_STRETCH;
  const wantAngle = Math.atan2(predicted.z - facePivotZ, predicted.x - facePivotX);
  return Math.abs(wrapAngle(wantAngle - p.heading)) < KICK_FACE_TOL;
}

/**
 * Reachability + facing gate. Called from applyAction when the
 * controller asks to kick. Returns true if the commit succeeded and
 * the kick is now active. Failure reasons surface as `kick_missed`
 * events so callers and tests can observe the rejection.
 */
const _scratchFoot = { x: 0, y: 0, z: 0 };
export function tryStartKick(state, p, dx, dy, dz, power) {
  if (p.kick.active) return false;
  const kickDz = clamp(dz, -1, 1);
  const kind = kickDz > AIRKICK_DZ_THRESHOLD ? 'air' : 'ground';
  const leadTicks = strikeLeadTicks(kind);

  const predicted = predictBallAtStrike(state.ball, leadTicks, _scratchPredicted);
  const hip = hipAnchor(p, _scratchHip);
  const local = projectHipLocal(hip, p.heading, predicted.x, predicted.y, predicted.z, _scratchLocal);
  const which = p === state.p1 ? 'p1' : 'p2';
  if (Math.abs(local.perp) > FOOT_LATERAL_REACH) {
    if (state.recordEvents) {
      state.events.push({ type: 'kick_missed', player: which, reason: 'out_of_reach' });
    }
    return false;
  }
  const perpEff = clamp(local.perp, -LATERAL_FOOT_FLEX, LATERAL_FOOT_FLEX);
  const dist = Math.hypot(local.fwd, local.up, perpEff);
  if (dist > KICK_REACH_MAX) {
    if (state.recordEvents) {
      state.events.push({ type: 'kick_missed', player: which, reason: 'out_of_reach' });
    }
    return false;
  }
  // Body-axis facing cone. `facingToward` is bubble-centric (off by
  // PLAYER_HEIGHT/2 on the depth axis) — fine for push geometry, but
  // here the reach and the cone must originate from the same body-axis
  // point, otherwise a ball aligned with the body reads as "off to the
  // side".
  const facePivotZ = p.y * Z_STRETCH;
  const facePivotX = p.x + PLAYER_WIDTH / 2;
  const wantAngle = Math.atan2(predicted.z - facePivotZ, predicted.x - facePivotX);
  if (Math.abs(wrapAngle(wantAngle - p.heading)) >= KICK_FACE_TOL) {
    if (state.recordEvents) {
      state.events.push({ type: 'kick_missed', player: which, reason: 'facing_away' });
    }
    return false;
  }

  const k = p.kick;
  k.active = true;
  k.kind = kind;
  k.stage = 'windup';
  k.timer = 0;
  k.fired = false;
  k.dx = clamp(dx, -1, 1);
  k.dy = clamp(dy, -1, 1);
  k.dz = kickDz;
  k.power = (clamp(power, -1, 1) + 1) / 2;
  if (kind === 'air') {
    // Map dz ∈ [THRESHOLD, 1] → jumpFrac ∈ [0, 1] so changing the
    // threshold auto-rescales without a stale magic factor.
    const jumpFrac = (kickDz - AIRKICK_DZ_THRESHOLD) / (1 - AIRKICK_DZ_THRESHOLD);
    k.airZ = jumpFrac * AIRKICK_MAX_Z;
    p.stamina = Math.max(0, p.stamina - STAMINA_AIRKICK_DRAIN);
  } else {
    k.airZ = 0;
  }
  k.footTargetX = predicted.x;
  k.footTargetY = predicted.y;
  k.footTargetZ = predicted.z;
  return true;
}

/**
 * Sphere-vs-sphere foot-ball contact test. The foot is IK'd to the
 * (frozen) footTarget each strike tick; contact fires on first overlap
 * against (FOOT_RADIUS + BALL_RADIUS).
 */
function testFootContact(state, p) {
  const ball = state.ball;
  if (ball.frozen) return false;
  const foot = ikFootWorld(p, _scratchFoot);
  const ballWX = ball.x;
  const ballWY = ball.z + BALL_RADIUS;
  const ballWZ = ball.y * Z_STRETCH;
  const dx = ballWX - foot.x;
  const dy = ballWY - foot.y;
  const dz = ballWZ - foot.z;
  const r = FOOT_RADIUS + BALL_RADIUS;
  return dx * dx + dy * dy + dz * dz <= r * r;
}

/** Stage-boundary timings for a kick: windup ends at `windupMs`,
 *  strike window closes at `strikeEndMs`, full kick ends at
 *  `durationMs`. Shared by `kickLegExtension` and `advanceKick`. */
function kickPhaseTimes(kick) {
  const isAir = kick.kind === 'air';
  const windupMs = isAir ? AIRKICK_PEAK_FRAC * AIRKICK_MS : KICK_WINDUP_MS;
  return {
    windupMs,
    strikeEndMs: windupMs + KICK_STRIKE_WINDOW_MS,
    durationMs: isAir ? AIRKICK_MS : KICK_DURATION_MS,
  };
}

/**
 * Stage-aware effective extension `tEff ∈ [0, 1]` for the kicking leg.
 *
 *   windup   : 0 → WINDUP_PEAK_TEFF (0.7) — leg extends partway
 *   strike   : 1.0                        — leg locks on the target
 *   recovery : 1.0 → 0                    — leg eases back to neutral
 *   inactive : 0                          — neutral standing pose
 *
 * Windup splits into load (0 → WINDUP_PEAK_TEFF) and rise
 * (WINDUP_PEAK_TEFF → 1) so the strike phase starts with the leg
 * already at full extension — windup→strike has no discontinuity.
 */
export function kickLegExtension(kick) {
  if (!kick || !kick.active) return 0;
  const { windupMs, strikeEndMs, durationMs } = kickPhaseTimes(kick);
  const t = kick.timer;
  const loadEndMs = windupMs * WINDUP_LOAD_FRAC;
  if (t < loadEndMs) {
    return WINDUP_PEAK_TEFF * (t / loadEndMs);
  }
  if (t < windupMs) {
    const riseT = (t - loadEndMs) / (windupMs - loadEndMs);
    return WINDUP_PEAK_TEFF + (1 - WINDUP_PEAK_TEFF) * riseT;
  }
  if (t < strikeEndMs) return 1;
  const recT = (t - strikeEndMs) / Math.max(1, durationMs - strikeEndMs);
  return Math.max(0, 1 - recT);
}

/**
 * Two-bone IK pose for the kicking leg, as (upperAngle, lowerAngle)
 * joint angles the renderer's placeLeg consumes directly. Three-key
 * cock-back foot path: rest → cock → target.
 *
 * Strike holds at target. Recovery does NOT pass through cock (that
 * would look like a re-load); it lerps target → rest directly so the
 * leg settles after follow-through.
 */
export function kickLegPose(kick, hipWX, hipWY, hipWZ, forwardX, forwardZ, out) {
  if (!kick || !kick.active) {
    out.upperAngle = 0;
    out.lowerAngle = 0;
    return out;
  }
  const tEff = kickLegExtension(kick);
  const dx = kick.footTargetX - hipWX;
  const dy = kick.footTargetY - hipWY;
  const dz = kick.footTargetZ - hipWZ;
  const fwd = dx * forwardX + dz * forwardZ;
  const up  = dy;
  const perp = -dx * forwardZ + dz * forwardX;
  const legYaw = clamp(perp, -LATERAL_FOOT_FLEX, LATERAL_FOOT_FLEX);
  const legLen = STICKMAN_UPPER_LEG + STICKMAN_LOWER_LEG;
  const cockFwd = -KICK_COCK_FWD_FRAC * legLen;
  const cockUp  = -KICK_COCK_UP_FRAC  * legLen;

  let targetFwd, targetUp, yawScale;
  if (kick.stage === 'recovery') {
    targetFwd = fwd * tEff;
    targetUp  = up * tEff + (-legLen) * (1 - tEff);
    yawScale = tEff;
  } else if (tEff < WINDUP_PEAK_TEFF) {
    const p = tEff / WINDUP_PEAK_TEFF;
    targetFwd =       0 * (1 - p) + cockFwd * p;
    targetUp  = -legLen * (1 - p) + cockUp  * p;
    yawScale = p;
  } else {
    const p = (tEff - WINDUP_PEAK_TEFF) / (1 - WINDUP_PEAK_TEFF);
    targetFwd = cockFwd * (1 - p) + fwd * p;
    targetUp  = cockUp  * (1 - p) + up  * p;
    yawScale = 1;
  }
  solve2BoneIK(targetFwd, targetUp, STICKMAN_UPPER_LEG, STICKMAN_LOWER_LEG, _scratchIKRes);
  out.upperAngle = _scratchIKRes.upperAngle;
  out.lowerAngle = _scratchIKRes.lowerAngle;
  out.legYaw = Math.atan2(legYaw * yawScale, Math.max(1e-3, Math.abs(targetFwd)));
  return out;
}

/** Advance the kick state machine. Returns true if the player is
 *  mid-kick and should NOT accept new outputs this tick. */
export function advanceKick(state, p) {
  const k = p.kick;
  if (!k.active) return false;
  k.timer += TICK_MS;
  const isAir = k.kind === 'air';
  const { windupMs, strikeEndMs, durationMs } = kickPhaseTimes(k);

  if (isAir) {
    const animFrac = Math.min(k.timer / AIRKICK_MS, 1);
    p.airZ = Math.sin(animFrac * Math.PI) * k.airZ;
  }

  // Windup: foot target tracks predicted ball.
  if (k.stage === 'windup') {
    const remainingTicks = Math.max(0, Math.round((windupMs - k.timer) / TICK_MS));
    const predicted = predictBallAtStrike(state.ball, remainingTicks, _scratchPredicted);
    k.footTargetX = predicted.x;
    k.footTargetY = predicted.y;
    k.footTargetZ = predicted.z;
    if (k.timer >= windupMs) k.stage = 'strike';
  }

  if (k.stage === 'strike') {
    if (!k.fired && testFootContact(state, p)) {
      k.fired = true;
      executeKick(state, p);
    }
    if (k.timer >= strikeEndMs) {
      if (!k.fired && state.recordEvents) {
        state.events.push({
          type: 'kick_missed',
          player: p === state.p1 ? 'p1' : 'p2',
          reason: 'no_contact',
        });
      }
      k.stage = 'recovery';
    }
  }

  if (k.timer >= durationMs) {
    if (isAir) p.airZ = 0;
    k.active = false;
    k.stage = 'windup';
  }
  return true;
}

function executeKick(state, p) {
  const ball = state.ball;
  const k = p.kick;
  const which = p === state.p1 ? 'p1' : 'p2';

  const rawPower = Math.max(MIN_KICK_POWER, k.power);
  const force = rawPower * MAX_KICK_POWER * Math.max(MIN_KICK_STAMINA, p.stamina);

  let dx = k.dx, dy = k.dy, dz = k.dz;
  const rawLen = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (rawLen < KICK_DIR_MIN_LEN) {
    dx = state.rng() * 2 - 1;
    dy = state.rng() * 2 - 1;
    dz = state.rng() * 0.5;
    const randLen = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    dx /= randLen; dy /= randLen; dz /= randLen;
  } else {
    dx /= rawLen; dy /= rawLen; dz /= rawLen;
  }

  // Accuracy noise — quadratic in power so low-power kicks are accurate.
  const noise = rawPower * rawPower * KICK_NOISE_SCALE;
  dx += gaussRandom(state.rng) * noise;
  dy += gaussRandom(state.rng) * noise;
  dz += gaussRandom(state.rng) * noise * KICK_NOISE_VERT;
  const noisyLen = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
  dx /= noisyLen; dy /= noisyLen; dz /= noisyLen;

  ball.vx = dx * force;
  ball.vy = dy * force;
  ball.vz = Math.max(0, dz * force);
  ball.frozen = false;

  p.stamina = Math.max(0, p.stamina - STAMINA_KICK_DRAIN * rawPower);
  state.lastKickTick = state.tick;

  if (state.recordEvents) {
    const ballSpeed = Math.sqrt(ball.vx * ball.vx + ball.vy * ball.vy);
    state.events.push({
      type: 'kick',
      player: which,
      power: rawPower,
      speed: ballSpeed,
      wasted: ballSpeed < WASTED_KICK_SPEED,
    });
  }
}
