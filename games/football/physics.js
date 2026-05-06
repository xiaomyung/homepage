/**
 * Football v2 — pure physics module.
 *
 * No DOM, no three.js, no wall-clock — the caller owns tick cadence.
 * Determinism relies on the caller passing a seeded PRNG into
 * createState(); the bundled createSeededRng() is the canonical source.
 */

/* ── Constants imported from ./physics/tuning.js ──────────────── */

import {
  // Field & time
  FIELD_WIDTH_REF, FIELD_HEIGHT, CEILING, TICK_MS, STALL_TICKS,
  // Ball physics
  GRAVITY, AIR_FRICTION, GROUND_FRICTION, BOUNCE_RETAIN, AIR_BOUNCE,
  WALL_BOUNCE_DAMP, BOUNCE_VZ_MIN, BALL_VEL_CUTOFF, BALL_VEL_CUTOFF_SQ,
  BALL_RADIUS, RESPAWN_DROP_Z, BOUNCE_EVENT_MIN,
  // Player movement
  MAX_PLAYER_SPEED, PLAYER_ACCEL_TICKS, PLAYER_ACCEL,
  MOVE_THRESHOLD, MOVE_THRESHOLD_SQ, STARTING_GAP,
  PLAYER_WIDTH, PLAYER_HEIGHT, MIN_SPEED_STAMINA, MOVE_INPUT_DEAD_ZONE,
  Z_STRETCH, PLAYER_TURN_TICKS, PLAYER_TURN_RATE,
  KICK_FACE_TOL, PUSH_FACE_TOL,
  // Stamina
  STAMINA_REGEN, STAMINA_MOVE_BASE, STAMINA_MOVE_PER_UNIT,
  STAMINA_MOVE_THRESHOLD, DIRECTION_CHANGE_DRAIN,
  STAMINA_EXHAUSTION_THRESHOLD, STAMINA_KICK_DRAIN, STAMINA_AIRKICK_DRAIN,
  // Stickman rig
  STICKMAN_GLYPH_SIZE, STICKMAN_HIP_OFX, STICKMAN_SHOULDER_OFX,
  STICKMAN_SHOULDER_OFY, STICKMAN_HEAD_GAP_Y, STICKMAN_LIMB_FULL_H,
  STICKMAN_UPPER_LEG, STICKMAN_LOWER_LEG, STICKMAN_UPPER_ARM, STICKMAN_LOWER_ARM,
  STICKMAN_TORSO_RADIUS, STICKMAN_HEAD_RADIUS, STICKMAN_LEG_RADIUS,
  STICKMAN_LOWER_ARM_RADIUS, STICKMAN_UPPER_ARM_RADIUS,
  HIP_BASE_Z, SHOULDER_Z, HEAD_CENTER_Z, KICK_REACH_MAX,
  BODY_TANG_RETAIN, TUNNEL_CORRECTION_MIN_SPEED, TUNNEL_CORRECTION_BEHIND_DOT,
  STUCK_ON_TOP_NORMAL_THRESHOLD, STUCK_ON_TOP_TANG_THRESHOLD, STUCK_ON_TOP_SLIDE_SPEED,
  // Goal frame
  GOAL_BACK_OFFSET, GOAL_DEPTH, GOAL_LINE_INSET,
  GOAL_POST_RADIUS, GOAL_MOUTH_Z, ROOF_FRACTION,
  GOAL_MOUTH_WIDTH, GOAL_MOUTH_Y_MIN, GOAL_MOUTH_Y_MAX,
  // Match flow
  WIN_SCORE, CELEBRATE_TICKS,
  MATCHEND_REPOSITION_MAX_TICKS, MATCHEND_POSE_TICKS, MATCHEND_NEUTRAL_TICKS,
  RESPAWN_GRACE, REPOSITION_SPEED, REPOSITION_TOL,
  REPOSITION_LERP_FRAC, REPOSITION_Y_SPEED_FRAC, RESPAWN_DELAY_TICKS,
  // Kick
  MAX_KICK_POWER, MIN_KICK_POWER, MIN_KICK_STAMINA,
  KICK_NOISE_SCALE, KICK_NOISE_VERT, AIRKICK_MAX_Z,
  AIRKICK_MS, AIRKICK_PEAK_FRAC, AIRKICK_DZ_THRESHOLD,
  KICK_WINDUP_MS, KICK_DURATION_MS, KICK_STRIKE_WINDOW_MS,
  FOOT_RADIUS, KICK_DIR_MIN_LEN, WASTED_KICK_SPEED,
  LATERAL_FOOT_FLEX, FOOT_BALL_CONTACT_R, FOOT_LATERAL_REACH,
  WINDUP_PEAK_TEFF, WINDUP_LOAD_FRAC, KICK_COCK_FWD_FRAC, KICK_COCK_UP_FRAC,
  // Push
  PUSH_RANGE_X, PUSH_RANGE_SLACK_Y, PUSH_RANGE_Y,
  MAX_PUSH_FORCE, PUSH_DAMP, PUSH_APPLY,
  PUSH_VEL_THRESHOLD, PUSH_VEL_THRESHOLD_SQ, MIN_PUSH_STAMINA,
  PUSH_ANIM_MS, REACT_ANIM_MS,
  PUSH_WINDUP_FRAC, PUSH_STRIKE_FRAC, PUSH_CONTACT_FRAC,
  PUSH_WINDUP_PEAK_TEFF, PUSH_STAMINA_COST, PUSH_VICTIM_STAMINA_MULT,
  PUSH_STRIKE_TIMER, PUSH_UPPERCUT_RANGE, PUSH_HOOK_RANGE,
  // Push keyframes
  JAB_REST, JAB_WINDUP, JAB_STRIKE,
  HOOK_REST, HOOK_WINDUP, HOOK_STRIKE,
  UPPERCUT_REST, UPPERCUT_WINDUP, UPPERCUT_STRIKE,
  // Action vector layout
  ACTION_MOVE_X, ACTION_MOVE_Y, ACTION_KICK_GATE,
  ACTION_KICK_DX, ACTION_KICK_DY, ACTION_KICK_DZ, ACTION_KICK_POWER,
  ACTION_PUSH_GATE, ACTION_PUSH_POWER, ACTION_VEC_SIZE,
} from './physics/tuning.js';

// Re-export the public surface that callers (main.js, ai/, animation/,
// renderer.js, debug-overlay.js, tests/*) currently consume from
// physics.js. After the per-module split lands, callers will import
// from physics/index.js and this shim disappears.
export * from './physics/tuning.js';

/* ── State factories live in physics/state.js ─────────────────── */

import {
  createField, createState, resetStateInPlace,
  createSeededRng, gaussRandom, kickoffSpawnX,
} from './physics/state.js';
export {
  createField, createState, resetStateInPlace, createSeededRng,
} from './physics/state.js';

import {
  recordBounce, closestPointOnSegment,
  hipAnchor, projectHipLocal,
  resolveBallInsideGoal, resolveBallVsCylinder,
  resolveBallVsGoalBars, resolveBallVsGoalExterior,
} from './physics/geometry.js';

import {
  clampPlayerToField, clampAndCollide,
  resolveBallVsPlayerBody, resolvePlayerPairCollision,
} from './physics/collisions.js';

/* ── Main tick ────────────────────────────────────────────────── */

export function tick(state, p1Act, p2Act) {
  if (state.recordEvents) state.events.length = 0;
  state.tick++;

  if (state.matchOver) return state;

  if (state.pauseState !== null) {
    advancePause(state);
    // Ball physics run during pause too — gravity still pulls the
    // ball down so a scored shot settles visibly into the net
    // instead of freezing mid-flight. Score check is suppressed by
    // the grace-frame gate set in scoreGoal, and the inner-net
    // absorber handles wall contact without a bounce. Skipped only
    // for the static matchend pose / neutral phases — the match is
    // decided and the ball is irrelevant; reposition still runs ball
    // physics so the scored shot finishes settling during the walk
    // back.
    const skipBall = state.pauseState === 'matchend'
      && (state.matchEndPhase === 'pose' || state.matchEndPhase === 'neutral');
    if (!skipBall) updateBall(state);
    return state;
  }

  if (state.graceFrames > 0) state.graceFrames--;

  const pre1x = state.p1.x, pre1y = state.p1.y;
  const pre2x = state.p2.x, pre2y = state.p2.y;

  applyRegenAndExhaustion(state.p1);
  applyRegenAndExhaustion(state.p2);

  if (p1Act) applyAction(state, state.p1, p1Act);
  if (p2Act) applyAction(state, state.p2, p2Act);

  applyPushPhysics(state.p1);
  applyPushPhysics(state.p2);
  advanceReactTimer(state.p1);
  advanceReactTimer(state.p2);

  clampAndCollide(state, state.p1);
  clampAndCollide(state, state.p2);
  resolvePlayerPairCollision(state.p1, state.p2, pre1x, pre1y, pre2x, pre2y);
  // A wall-pinned pair collision can push one player outside the
  // field box. Re-clamp to recover; any residual overlap converges
  // over a few ticks as both sides pay half the gap each time.
  clampPlayerToField(state.p1, state.field);
  clampPlayerToField(state.p2, state.field);

  chargeStaminaFromDisplacement(state.p1, pre1x, pre1y);
  chargeStaminaFromDisplacement(state.p2, pre2x, pre2y);

  // Ball motion, scoring, and goal-surface collision are now all
  // resolved inside updateBall — it substeps the integration when the
  // per-tick motion exceeds BALL_RADIUS so a hard shot can't tunnel.
  updateBall(state);

  if (state.tick - state.lastKickTick > STALL_TICKS) {
    state.stallCount += 1;
    if (state.headless) {
      // Full kickoff reset — both players teleported, velocities
      // zeroed, ball on ground at midfield — so stale segments
      // cycle cleanly rather than dribbling the ball back into a
      // stuck configuration.
      resetToKickoff(state);
    } else {
      resetBall(state);
      state.lastKickTick = state.tick;
    }
  }

  return state;
}

/* ── Regen / exhaustion ──────────────────────────────────────── */

function applyRegenAndExhaustion(p) {
  if (p.stamina <= 0) p.exhausted = true;
  if (p.exhausted && p.stamina >= STAMINA_EXHAUSTION_THRESHOLD) p.exhausted = false;
  p.stamina = Math.min(1, p.stamina + STAMINA_REGEN);
}

/* ── Action dispatch ─────────────────────────────────────────── */

// Action vector layout (ACTION_*) and per-type push strike thresholds
// (PUSH_STRIKE_TIMER) come from physics/tuning.js — see imports above.

/** Tick a push cooldown forward. Returns true if the player is still
 *  mid-push and should not accept new actions this tick — mirrors
 *  `advanceKick`'s in-flight-lock contract. Also commits the pending
 *  push impulse to the victim at the strike tick, so the victim only
 *  moves on contact rather than on the windup frame. */
function advancePush(state, p) {
  if (p.pushTimer <= 0) return false;
  const prevTimer = p.pushTimer;
  p.pushTimer -= TICK_MS;
  if (p.pushTimer < 0) p.pushTimer = 0;
  // Strike fires on the single tick where pushTimer crosses the
  // per-type threshold (jab extends further than uppercut, so it
  // connects later in the strike blend). One-shot by construction:
  // after committing, the pending pointer is nulled so subsequent
  // ticks through the recovery phase do not re-apply the impulse.
  const threshold = PUSH_STRIKE_TIMER[p.pushType] || PUSH_STRIKE_TIMER.jab;
  if (p.pendingPushVictim && prevTimer > threshold && p.pushTimer <= threshold) {
    const victim = p.pendingPushVictim;
    // Re-check range + facing at strike time. The windup is ~400ms,
    // long enough for the victim to back out of reach — without this
    // gate the pre-computed impulse from tryPush would still land on
    // a victim who already ran away. Pusher's animation continues
    // through recovery as a whiff so they still pay the cooldown.
    if (!pushStillInRange(state, p, victim)) {
      p.pendingPushVictim = null;
      p.pendingPushVx = 0;
      p.pendingPushVy = 0;
      if (state.recordEvents) {
        state.events.push({
          type: 'push_missed',
          pusher: p === state.p1 ? 'p1' : 'p2',
          reason: 'out_of_range',
        });
      }
      return true;
    }
    victim.pushVx = p.pendingPushVx;
    victim.pushVy = p.pendingPushVy;
    // Hit-reaction state. Stored on the victim so the pose composer
    // can play a recoil animation keyed to the punch type, hit
    // direction (in world xz), and force magnitude.
    const impulseWX = p.pendingPushVx;
    const impulseWZ = p.pendingPushVy * Z_STRETCH;
    const impulseMag = Math.sqrt(impulseWX * impulseWX + impulseWZ * impulseWZ);
    if (impulseMag > 1e-6) {
      victim.reactDirX = impulseWX / impulseMag;
      victim.reactDirZ = impulseWZ / impulseMag;
    } else {
      victim.reactDirX = 0;
      victim.reactDirZ = 0;
    }
    victim.reactForce = Math.min(1, impulseMag / MAX_PUSH_FORCE);
    victim.reactTimer = REACT_ANIM_MS;
    victim.reactType = p.pushType;
    // Hook recoil direction in the victim's frame. A right-arm hook
    // APPROACHES the victim from the pusher's right → victim's left-
    // side; the victim's body rocks AWAY from the approach = toward
    // the victim's right. The fist's sweep direction in world xz is
    // pusher's left for a right hook (pusher's right for a left hook);
    // we project that onto the victim's lateral axis and NEGATE so
    // the body whips opposite the sweep (away from the punch), not
    // along it. Independent of impulse direction (which is axial
    // along pusher heading for all punch types).
    const pH = p.heading, vH = victim.heading;
    const sweepX = p.pushArm === 'right' ? -Math.sin(pH) :  Math.sin(pH);
    const sweepZ = p.pushArm === 'right' ?  Math.cos(pH) : -Math.cos(pH);
    const vLatX = -Math.sin(vH), vLatZ = Math.cos(vH);
    victim.reactLatSign = (sweepX * vLatX + sweepZ * vLatZ) >= 0 ? -1 : 1;
    p.pendingPushVictim = null;
    p.pendingPushVx = 0;
    p.pendingPushVy = 0;
    if (state.recordEvents) {
      // Impact point at the victim's head. Coordinates use the
      // ball_bounce convention: x = world x, y = physics y,
      // z = world height.
      const f = state.field;
      state.events.push({
        type: 'push_contact',
        x: victim.x + f.playerWidth / 2,
        y: victim.y,
        z: HEAD_CENTER_Z,
        force: victim.reactForce,
      });
    }
  }
  return true;
}

/** Tick the victim's hit-reaction timer down. Purely cosmetic — does
 *  NOT lock the victim's action, so they can retaliate while still
 *  playing the reaction animation. */
function advanceReactTimer(p) {
  if (p.reactTimer <= 0) return;
  p.reactTimer -= TICK_MS;
  if (p.reactTimer <= 0) {
    p.reactTimer = 0;
    p.reactForce = 0;
  }
}

function applyAction(state, p, out) {
  // In-flight kicks must always tick forward to completion — even if
  // the player became exhausted during the kick. Otherwise the
  // animation freezes for the whole exhaustion window and new kicks
  // are locked out.
  if (advanceKick(state, p)) return;
  // Push cooldown decrements unconditionally so a push issued right
  // before a kick doesn't get frozen at max for the kick's duration.
  if (advancePush(state, p)) return;

  if (p.exhausted) { p.vx = 0; p.vy = 0; return; }

  // Order: kick + push gates BEFORE movement. The controller's perception
  // sees the player's pre-tick state when computing canKickReach / push
  // gates; running movement first would shift heading + position before
  // the gate test, so a borderline reach the controller correctly saw
  // could fail at tryStartKick. With this order, controller perception
  // and physics gate test sample the same state — they agree by
  // construction. Movement still applies in the same tick (during
  // CONTENDER_KICK the action vector zeros MOVE anyway, so this matters
  // only for the failing-gate case).
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

/** Wrap an angle into (-π, π]. Apply after subtracting two angles
 *  to get the shortest-arc signed difference. Imported by
 *  animation/state.js. */
export function wrapAngle(a) {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a <= -Math.PI) a += 2 * Math.PI;
  return a;
}

/** Rotate `current` toward `target` by at most PLAYER_TURN_RATE. */
function turnToward(current, target) {
  const diff = wrapAngle(target - current);
  if (diff >  PLAYER_TURN_RATE) return current + PLAYER_TURN_RATE;
  if (diff < -PLAYER_TURN_RATE) return current - PLAYER_TURN_RATE;
  return target;
}

/** True iff `p`'s heading points at world-space (worldX, worldZ) within
 *  `tol` radians. Used by tryPush. (canKickReach inlines its own
 *  body-axis facing check because facingToward uses the bubble
 *  centre, which doesn't match the shoulder-line kick gate.) */
export function facingToward(p, worldX, worldZ, tol) {
  const centerX = p.x + PLAYER_WIDTH / 2;
  const centerZ = (p.y + PLAYER_HEIGHT / 2) * Z_STRETCH;
  const want = Math.atan2(worldZ - centerZ, worldX - centerX);
  return Math.abs(wrapAngle(want - p.heading)) < tol;
}

/* ── Movement ─────────────────────────────────────────────────── */

// Motion input dead zone (MOVE_INPUT_DEAD_ZONE) — floating-point
// filtering. Mirrors `FALLBACK_DEAD_ZONE` in `ai/tuning.js`. Imported
// from physics/tuning.js.

function applyMovement(state, p, moveX, moveY) {
  if (Math.abs(moveX) < MOVE_INPUT_DEAD_ZONE) moveX = 0;
  if (Math.abs(moveY) < MOVE_INPUT_DEAD_ZONE) moveY = 0;
  const effSpeed = MAX_PLAYER_SPEED * Math.max(MIN_SPEED_STAMINA, p.stamina);
  let targetVx = clamp(moveX, -1, 1) * effSpeed;
  // Y physics-space is compressed by Z_STRETCH relative to visual
  // space (see createField + renderer Z_STRETCH). Without this
  // scaling, the same action.moveY = 1.0 makes the player cross the
  // pitch depth-wise in ~5 ticks while taking ~90 ticks to cross
  // horizontally — visually the player "flies" across the y axis.
  // Dividing by Z_STRETCH makes equal visual distance cost equal
  // physics time, so walking reads symmetrically in both axes.
  let targetVy = clamp(moveY, -1, 1) * effSpeed / Z_STRETCH;

  if ((p.y <= 0 && targetVy < 0) || (p.y >= FIELD_HEIGHT - PLAYER_HEIGHT && targetVy > 0)) {
    targetVy = 0; p.vy = 0;
  }
  if ((p.x <= 0 && targetVx < 0) || (p.x >= state.field.width - state.field.playerWidth && targetVx > 0)) {
    targetVx = 0; p.vx = 0;
  }

  // Direction-change drain: fire exactly once on the tick where the
  // commanded target direction *flips*, not every tick while the
  // current velocity is still crossing zero toward the new target
  // (which would drain ~20× per flip under the acceleration cap).
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
  // reversal takes 2× that. Same rule for starting and stopping, so
  // momentum is symmetric.
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
    // Heading target = direction of current *visual* motion (physics
    // vy scaled by Z_STRETCH) so facing and motion read consistently
    // to the viewer. Hold current heading when nearly still.
    const targetHeading = Math.atan2(p.vy * Z_STRETCH, p.vx);
    p.heading = turnToward(p.heading, targetHeading);
  } else {
    p.vx = 0;
    p.vy = 0;
  }
}

/* ── Push physics ─────────────────────────────────────────────── */

function applyPushPhysics(p) {
  if (p.pushVx * p.pushVx > PUSH_VEL_THRESHOLD_SQ) {
    p.x += p.pushVx * PUSH_APPLY;
    p.pushVx *= PUSH_DAMP;
  } else {
    p.pushVx = 0;
  }
  if (p.pushVy * p.pushVy > PUSH_VEL_THRESHOLD_SQ) {
    p.y += p.pushVy * PUSH_APPLY;
    p.pushVy *= PUSH_DAMP;
  } else {
    p.pushVy = 0;
  }
}

function chargeStaminaFromDisplacement(p, preX, preY) {
  const dx = p.x - preX;
  const dy = p.y - preY;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist < STAMINA_MOVE_THRESHOLD) return;
  p.stamina -= STAMINA_MOVE_BASE + STAMINA_MOVE_PER_UNIT * dist;
  if (p.stamina < 0) p.stamina = 0;
}

/* ── Field bounds & goal-frame collision ──────────────────────
 *
 * Goal-frame collision is done against a single canonical "goal
 * box" primitive per side:
 *
 *   LEFT:  [goalLLeft, goalLineL] × [mouthYMin, mouthYMax] × [0, mouthZMax]
 *   RIGHT: [goalLineR, goalRRight] × [mouthYMin, mouthYMax] × [0, mouthZMax]
 *
 * The visible goal structure in the renderer is pinned to these
 * same bounds (goalLineL/R is the front mouth, goalLLeft/goalRRight
 * is the back). Both the ball and the stickmen resolve overlap
 * with this AABB using the shared `minPenetrationPush` helper,
 * which picks the axis of smallest overlap and returns a
 * (axis, delta) push vector. The ball treats its sphere as an
 * AABB of side 2*BALL_RADIUS; players are 2D rectangles (no z).
 *
 * Scoring check runs BEFORE ball-goal collision so a ball fully
 * crossing the open mouth freezes as a goal and is not bounced.
 */

/* ── Two-bone IK (planar, hip → knee → foot) ────────────────── */

/**
 * Analytic 2-bone IK in the (forward, up) plane local to the hip.
 *
 * Inputs are already projected into that plane — `targetFwd` is the
 * forward distance from hip to target (+ = player's facing
 * direction), `targetUp` is the vertical offset (− = below hip).
 *
 * Outputs `upperAngle` and `lowerAngle` in the same convention the
 * renderer's `_placeLeg` consumes: measured from straight-down,
 * increasing toward the forward axis. `upperAngle = 0` is the
 * neutral standing pose, `+π/2` is the thigh horizontal.
 *
 * The solver always picks the "knee forward" branch (knee bends in
 * front of the hip→foot line) — the natural human kicking pose.
 *
 * When `targetFwd² + targetUp² > (U+L)²` the target is unreachable;
 * distance is clamped to `U+L` and the returned foot lies on the
 * hip→target ray at the leg's maximum extent. Similarly clamped to
 * `|U−L|` from below so the leg never folds past itself.
 *
 * Pure, allocation-free into `out`. If `out` is omitted a fresh
 * object is returned — use the scratch form in hot loops.
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
    // Degenerate: target coincides with hip. Default to straight
    // down at whatever reach we're clamped to (usually minReach).
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

  // Knee position in local (forward, down) coords, then shin angle.
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


/**
 * Sphere-vs-capsule (finite cylinder with hemispherical caps, in the
 * geometric sense that clamp-to-segment naturally handles the ends).
 * The goal frame consists of thin cylindrical bars whose geometry
 * does NOT fit an AABB — an AABB approximation produces phantom
 * x-axis bounces for balls grazing a post side or the crossbar top.
 * This helper solves the real sphere-segment contact and bounces
 * along the true contact normal.
 *
 * Returns true on contact. The ball is pushed out along the normal
 * and its velocity reflected (with BOUNCE_RETAIN damping) only if
 * the ball is moving INTO the cylinder at the contact point.
 */
/* ── Kick state machine ──────────────────────────────────────── */

/** Strike-tick lead for the reachability check and initial foot
 *  target prediction. Ground kicks strike at `KICK_WINDUP_MS`; air
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
 *     decay is negligible (< 1 world-unit at typical kick speeds).
 *   - Vertical (z): semi-implicit Euler — `vz -= g; z += vz;` — so
 *     the closed form is `z₀ + N·vz₀ − g·N·(N+1)/2` (sum of the
 *     post-integration velocities), NOT the continuous `−½·g·N²`.
 *     Ignores bounces; clamps at the floor.
 */
const _scratchPredicted = { x: 0, y: 0, z: 0 };
const _scratchHip = { x: 0, y: 0, z: 0 };
const _scratchLocal = { fwd: 0, up: 0, perp: 0 };
function predictBallAtStrike(ball, ticks, out) {
  const nx = ball.x + ball.vx * ticks;
  const ny_phys = ball.y + ball.vy * ticks;
  const nz_phys = Math.max(0, ball.z + ball.vz * ticks - 0.5 * GRAVITY * ticks * (ticks + 1));
  out.x = nx;
  out.y = nz_phys + BALL_RADIUS;   // world vertical — ball CENTER, not bottom
  out.z = ny_phys * Z_STRETCH;
  return out;
}

/** Compute foot world position by IK'ing toward `kick.footTarget`.
 *  Writes (x, y=vertical, z=depth) into `out`. The leg yaws at the hip
 *  by `local.perp` (capped at LATERAL_FOOT_FLEX) so the foot lands on
 *  a ball that's off the sagittal plane — a natural-looking side-of-
 *  foot hook, not a stiff straight-ahead strike. */
const _scratchIKRes = { upperAngle: 0, lowerAngle: 0, footFwd: 0, footUp: 0 };
export function ikFootWorld(p, out) {
  const k = p.kick;
  const hip = hipAnchor(p, _scratchHip);
  const local = projectHipLocal(hip, p.heading, k.footTargetX, k.footTargetY, k.footTargetZ, _scratchLocal);
  // Lateral flex: the foot reaches up to LATERAL_FOOT_FLEX world units
  // off the sagittal plane. The IK solver still works in 2D (fwd, up),
  // but we apply the perp offset as a hip yaw afterwards. The 2D leg
  // length budget is reduced by `perpEff` (Pythagorean) so a ball
  // off-axis still lives inside a reachable cylinder.
  const perpEff = clamp(local.perp, -LATERAL_FOOT_FLEX, LATERAL_FOOT_FLEX);
  solve2BoneIK(local.fwd, local.up, STICKMAN_UPPER_LEG, STICKMAN_LOWER_LEG, _scratchIKRes);
  const fwdX = Math.cos(p.heading);
  const fwdZ = Math.sin(p.heading);
  // perp axis = heading rotated 90° in the floor plane: (-sin h, _, cos h).
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
 * wants headroom for one tick of post-perception movement. Pure,
 * allocation-free (reuses the module scratch buffers).
 */
// Lateral foot flex: real footballers hook the ball with a side-of-foot
// strike when the ball isn't dead ahead. We let the kicking leg yaw at
// the hip so the foot can reach a ball that's offset perpendicular to
// the sagittal plane, capped at LATERAL_FOOT_FLEX world units. Contact
// succeeds when the lateral offset is within (foot+ball) of the flex
// limit. The cap keeps the leg motion looking like a natural twist
// rather than a sideways spread. LATERAL_FOOT_FLEX, FOOT_BALL_CONTACT_R,
// and FOOT_LATERAL_REACH are imported from physics/tuning.js above.

export function canKickReach(state, p, safetyMargin = 0) {
  const predicted = predictBallAtStrike(state.ball, strikeLeadTicks('ground'), _scratchPredicted);
  const hip = hipAnchor(p, _scratchHip);
  const local = projectHipLocal(hip, p.heading, predicted.x, predicted.y, predicted.z, _scratchLocal);
  // 3D reach budget uses the sagittal projection (fwd, up) plus the
  // lateral component capped at the flex limit — beyond LATERAL_FOOT_FLEX
  // the foot can't reach the ball laterally even with the leg twist.
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
function tryStartKick(state, p, dx, dy, dz, power) {
  if (p.kick.active) return false;
  const kickDz = clamp(dz, -1, 1);
  const kind = kickDz > AIRKICK_DZ_THRESHOLD ? 'air' : 'ground';
  const leadTicks = strikeLeadTicks(kind);

  const predicted = predictBallAtStrike(state.ball, leadTicks, _scratchPredicted);
  // Reachability uses the body-centre hip: any kick committed here
  // has its centre-hip within U+L of the target. The foot-contact
  // test (testFootContact → ikFootWorld) uses the SAME centre hip
  // so a ball that passes this gate also has a valid kill zone at
  // strike time — using a different anchor caused balls to clear
  // the gate but never meet the foot sphere.
  const hip = hipAnchor(p, _scratchHip);
  const local = projectHipLocal(hip, p.heading, predicted.x, predicted.y, predicted.z, _scratchLocal);
  const which = p === state.p1 ? 'p1' : 'p2';
  // Lateral flex caps how far the foot can hook off the sagittal plane.
  // Ball outside that envelope is a guaranteed no_contact even after
  // the leg yaws fully, so reject before burning a 288 ms animation.
  if (Math.abs(local.perp) > FOOT_LATERAL_REACH) {
    if (state.recordEvents) {
      state.events.push({ type: 'kick_missed', player: which, reason: 'out_of_reach' });
    }
    return false;
  }
  // Reach budget: leg solves in (fwd, up); the perp axis is consumed
  // by the leg yaw so distances inside LATERAL_FOOT_FLEX don't eat
  // into the 2D leg-length budget. Same gate as canKickReach (which
  // the controller polls before sending the kick action). Defense in
  // depth: keep both in sync.
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
  // here the reach and the cone both have to originate from the same
  // body-axis point or a ball aligned with the body reads as "off to
  // the side" of the bubble center.
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
    // Map `dz ∈ [THRESHOLD, 1]` → `jumpFrac ∈ [0, 1]` so changing
    // the threshold auto-rescales without a stale magic factor.
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
 * (frozen) footTarget each strike tick; contact fires on first
 * overlap against `(FOOT_RADIUS + BALL_RADIUS)`. Compared in world
 * coords so the depth-axis Z_STRETCH compression doesn't leak into
 * the test radius.
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

/**
 * Stage-aware effective extension `tEff ∈ [0, 1]` for the kicking
 * leg. Pure function of `kick.stage` + `kick.timer`:
 *
 *   windup   : 0 → WINDUP_PEAK_TEFF (0.7)   — leg extends partway
 *   strike   : 1.0                          — leg locks on the target
 *   recovery : 1.0 → 0                      — leg eases back to neutral
 *   inactive : 0                            — neutral standing pose
 *
 * Shared by the renderer (for drawing) and the `kickLegPose`
 * helper below; exported so tests can assert the stage curve
 * without re-deriving it. WINDUP_PEAK_TEFF imported from physics/tuning.js.
 */

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

// Windup is split into two sub-phases so the foot never JUMPS:
//   • load (0 → LOAD_FRAC of windup)        : 0 → WINDUP_PEAK_TEFF
//   • rise (LOAD_FRAC → 1 of windup)        : WINDUP_PEAK_TEFF → 1
// This guarantees the strike phase starts with the leg already at
// full extension, so the windup→strike boundary has no discontinuity
// (the previous "tEff hops 0.7 → 1.0 in a single tick" caused the
// last 30% of leg travel to teleport in one frame). WINDUP_LOAD_FRAC
// imported from physics/tuning.js.
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
 * Stage-aware arm extension for a punch, mirroring
 * `kickLegExtension`. Pure function of `pushTimer` in ms.
 * Windup is split into a load (0 → PUSH_WINDUP_PEAK_TEFF over the
 * first WINDUP_LOAD_FRAC of windup) and a rise (PEAK_TEFF → 1
 * over the rest), so the fist reaches full extension by the
 * windup→strike boundary instead of jumping there. Strike holds
 * at 1, recovery eases back to 0. Returns 0 when no push active.
 */
export function pushArmExtension(pushTimer) {
  if (pushTimer <= 0) return 0;
  const t = 1 - (pushTimer / PUSH_ANIM_MS);
  // Same load+rise split as kickLegExtension: the last 30% of the
  // windup ramps from PUSH_WINDUP_PEAK_TEFF up to 1 instead of
  // jumping at the windup→strike boundary, so the fist doesn't
  // teleport the last 30% of its travel in one frame.
  const loadEndT = PUSH_WINDUP_FRAC * WINDUP_LOAD_FRAC;
  if (t < loadEndT) {
    return PUSH_WINDUP_PEAK_TEFF * (t / loadEndT);
  }
  if (t < PUSH_WINDUP_FRAC) {
    const riseT = (t - loadEndT) / (PUSH_WINDUP_FRAC - loadEndT);
    return PUSH_WINDUP_PEAK_TEFF + (1 - PUSH_WINDUP_PEAK_TEFF) * riseT;
  }
  if (t < PUSH_STRIKE_FRAC) return 1;
  const recT = (t - PUSH_STRIKE_FRAC) / Math.max(1e-6, 1 - PUSH_STRIKE_FRAC);
  return Math.max(0, 1 - recT);
}

/**
 * Scripted striking-arm pose for a punch. Three visually-distinct
 * variants share a single three-keyframe rig — rest (t=0), windup-
 * peak (t≈0.35) and strike (t=0.5) — interpolated by the progress
 * scalar derived from `pushTimer`. Each variant defines its own
 * keyframe angles so jab (straight forward thrust), hook (horizontal
 * cross-body sweep) and uppercut (vertical rising arc) read as
 * genuinely different motions, not cosmetic tweaks of one pose.
 *
 * Output is four angles consumed by the renderer's `_placeArm`:
 *   upperAngle / lowerAngle — hip-to-vertical polar swing
 *   upperYaw   / lowerYaw   — rotation of each segment's forward
 *                             direction around the vertical axis
 *
 * Hook uses `upperYaw` to carry the arm laterally; jab and uppercut
 * stay in the sagittal plane (yaw=0). The `pushArm` sign ('right' vs
 * 'left') flips hook polarity so either shoulder can throw.
 *
 * Pure, allocation-free into `out`.
 */

// Lerp helper — not exported; local to the pose builders.
const _lerp = (a, b, t) => a + (b - a) * t;

// Per-variant keyframes (JAB_*, HOOK_*, UPPERCUT_*) live in physics/tuning.js.
// Yaw magnitudes there are unsigned; `pushArm` supplies the sign at
// assembly time (right arm swings from right-outward to cross-body;
// left arm mirrors).
// Arm-angle convention: 0 = straight down, π/2 = forward horizontal
// (fist at shoulder height), π = straight up.

function blendPose(out, a, b, t, armSign) {
  out.upperAngle = _lerp(a[0], b[0], t);
  out.lowerAngle = _lerp(a[1], b[1], t);
  out.upperYaw   = _lerp(a[2], b[2], t) * armSign;
  out.lowerYaw   = _lerp(a[3], b[3], t) * armSign;
}

function resolvePoseKeyframes(pushType) {
  if (pushType === 'hook')     return [HOOK_REST,     HOOK_WINDUP,     HOOK_STRIKE];
  if (pushType === 'uppercut') return [UPPERCUT_REST, UPPERCUT_WINDUP, UPPERCUT_STRIKE];
  return [JAB_REST, JAB_WINDUP, JAB_STRIKE];
}

export function pushArmPose(player, out) {
  if (!player || player.pushTimer <= 0) {
    out.upperAngle = 0;
    out.lowerAngle = 0;
    out.upperYaw   = 0;
    out.lowerYaw   = 0;
    return out;
  }
  const t = 1 - (player.pushTimer / PUSH_ANIM_MS);
  const [rest, windup, strike] = resolvePoseKeyframes(player.pushType);
  // `pushArm` determines the sign of hook's lateral yaw. Left-arm
  // hooks mirror right-arm hooks across the sagittal plane.
  const armSign = player.pushArm === 'right' ? 1 : -1;

  if (t < PUSH_WINDUP_FRAC) {
    blendPose(out, rest, windup, t / PUSH_WINDUP_FRAC, armSign);
  } else if (t < PUSH_STRIKE_FRAC) {
    blendPose(out, windup, strike, (t - PUSH_WINDUP_FRAC) / (PUSH_STRIKE_FRAC - PUSH_WINDUP_FRAC), armSign);
  } else {
    const recT = (t - PUSH_STRIKE_FRAC) / Math.max(1e-6, 1 - PUSH_STRIKE_FRAC);
    blendPose(out, strike, rest, recT, armSign);
  }
  return out;
}

/**
 * Two-bone IK pose for the kicking leg, as (upperAngle, lowerAngle)
 * joint angles the renderer's `_placeLeg` consumes directly.
 *
 * Call with the world-space hip anchor the leg swings from
 * (typically the kicking-side hip) and the unit heading. The
 * helper reuses the shared rig constants so any future rig change
 * propagates automatically.
 *
 * Pure, allocation-free into `out`. `out` is returned.
 */
// Three-key cock-back foot path. Without an intermediate "cock"
// keyframe the foot travels in a straight line from rest to the
// ball, which reads as "snap to ball". A real kicker first loads
// the leg back-and-up (knee tucked, foot pulled behind) and only
// then drives forward into the strike. The path during windup is:
//   load (tEff: 0 → WINDUP_PEAK_TEFF):      rest → cock
//   rise (tEff: WINDUP_PEAK_TEFF → 1):      cock → target
// Strike holds at target. Recovery does NOT pass through cock
// (that would look like a re-load); it lerps target → rest
// directly so the leg settles after follow-through. KICK_COCK_FWD_FRAC
// and KICK_COCK_UP_FRAC are imported from physics/tuning.js.
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
  // Lateral component (perpendicular to heading in the floor plane).
  // Capped at LATERAL_FOOT_FLEX so the leg yaw stays in a natural
  // hooking range. Renderer reads `legYaw` and rotates the upper leg
  // around the vertical hip axis.
  const perp = -dx * forwardZ + dz * forwardX;
  const legYaw = clamp(perp, -LATERAL_FOOT_FLEX, LATERAL_FOOT_FLEX);
  const legLen = STICKMAN_UPPER_LEG + STICKMAN_LOWER_LEG;
  const cockFwd = -KICK_COCK_FWD_FRAC * legLen;
  const cockUp  = -KICK_COCK_UP_FRAC  * legLen;

  let targetFwd, targetUp, yawScale;
  if (kick.stage === 'recovery') {
    // Recovery: target → rest, no detour through cock.
    targetFwd = fwd * tEff;
    targetUp  = up * tEff + (-legLen) * (1 - tEff);
    yawScale = tEff;
  } else if (tEff < WINDUP_PEAK_TEFF) {
    // Load: rest → cock. Yaw blends from 0 (rest) to full (cocked).
    const p = tEff / WINDUP_PEAK_TEFF;
    targetFwd =       0 * (1 - p) + cockFwd * p;
    targetUp  = -legLen * (1 - p) + cockUp  * p;
    yawScale = p;
  } else {
    // Rise + strike-hold: cock → target.
    const p = (tEff - WINDUP_PEAK_TEFF) / (1 - WINDUP_PEAK_TEFF);
    targetFwd = cockFwd * (1 - p) + fwd * p;
    targetUp  = cockUp  * (1 - p) + up  * p;
    yawScale = 1;
  }
  solve2BoneIK(targetFwd, targetUp, STICKMAN_UPPER_LEG, STICKMAN_LOWER_LEG, _scratchIKRes);
  out.upperAngle = _scratchIKRes.upperAngle;
  out.lowerAngle = _scratchIKRes.lowerAngle;
  // Renderer-visible hip yaw (radians) for the kicking leg. Computed
  // here rather than at the renderer so a leg-length change auto-rescales.
  out.legYaw = Math.atan2(legYaw * yawScale, Math.max(1e-3, Math.abs(targetFwd)));
  return out;
}

/** Advance the kick state machine. Returns true if the player is
 *  mid-kick and should NOT accept new outputs this tick. */
function advanceKick(state, p) {
  const k = p.kick;
  if (!k.active) return false;
  k.timer += TICK_MS;
  const isAir = k.kind === 'air';
  const { windupMs, strikeEndMs, durationMs } = kickPhaseTimes(k);

  if (isAir) {
    const animFrac = Math.min(k.timer / AIRKICK_MS, 1);
    p.airZ = Math.sin(animFrac * Math.PI) * k.airZ;
  }

  // Windup: foot target tracks predicted ball. Froze automatically
  // when we transition to 'strike' — we just stop updating it.
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
    // Caller didn't supply a usable direction — pick a random one from the seeded stream.
    dx = state.rng() * 2 - 1;
    dy = state.rng() * 2 - 1;
    dz = state.rng() * 0.5;
    const randLen = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    dx /= randLen; dy /= randLen; dz /= randLen;
  } else {
    dx /= rawLen; dy /= rawLen; dz /= rawLen;
  }

  // Accuracy noise — quadratic in power so low-power kicks are accurate
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

/* ── Push ─────────────────────────────────────────────────────── */

// Punch variant thresholds (PUSH_UPPERCUT_RANGE, PUSH_HOOK_RANGE) live
// in physics/tuning.js. Very-close contact wants an uppercut (rising
// arc, comes up under the chin); mid range is the hook (lateral sweep);
// farther range is the jab (straight-forward reach). All three still
// cover the same PUSH_RANGE_X gate, they just shape the animation
// differently.

/** Same gates as tryPush, used at the strike-commit tick to verify
 *  the victim hasn't escaped the range/facing cone during the windup. */
function pushStillInRange(state, pusher, victim) {
  const f = state.field;
  const pusherCenterX = pusher.x + f.playerWidth / 2;
  const victimCenterX = victim.x + f.playerWidth / 2;
  if (Math.abs(pusherCenterX - victimCenterX) > PUSH_RANGE_X) return false;
  if (Math.abs(pusher.y - victim.y) > PUSH_RANGE_Y) return false;
  const victimZ = (victim.y + PLAYER_HEIGHT / 2) * Z_STRETCH;
  return facingToward(pusher, victimCenterX, victimZ, PUSH_FACE_TOL);
}

function tryPush(state, pusher, victim, powerNorm) {
  if (pusher.kick.active) return;
  if (pusher.pushTimer > 0) return;
  if (!pushStillInRange(state, pusher, victim)) return;

  const f = state.field;
  const pusherCenterX = pusher.x + f.playerWidth / 2;
  const victimCenterX = victim.x + f.playerWidth / 2;
  const power01 = (clamp(powerNorm, -1, 1) + 1) / 2;
  const force = power01 * MAX_PUSH_FORCE * Math.max(MIN_PUSH_STAMINA, pusher.stamina);

  // Push direction = pusher's heading. The face gate above
  // already ensures heading is within PUSH_FACE_TOL of the
  // victim direction, so this launches the victim along the
  // pusher's actual facing (not the relative-x sign shortcut).
  // Heading lives in world space, so convert the z component
  // back to physics-y via Z_STRETCH and re-normalize so that
  // the push magnitude in physics space still equals `force`.
  const fxWorld = Math.cos(pusher.heading);
  const fzWorld = Math.sin(pusher.heading);
  const fyPhys  = fzWorld / Z_STRETCH;
  const pMag    = Math.sqrt(fxWorld * fxWorld + fyPhys * fyPhys) || 1;
  pusher.pushTimer = PUSH_ANIM_MS;

  // Schedule the impulse for the strike tick instead of applying now.
  // The pending pointer + ∂v survives across ticks on the pusher; the
  // strike tick in `advancePush` writes them into the victim's active
  // push fields so physics applies the motion only on contact.
  pusher.pendingPushVictim = victim;
  pusher.pendingPushVx = (fxWorld / pMag) * force;
  pusher.pendingPushVy = (fyPhys  / pMag) * force;

  // Punch animation state. Pick the arm on the same side as the
  // victim (perpendicular to the pusher's heading) so the swing
  // reads naturally instead of crossing the body. Variant depends
  // on the pusher→victim distance in the heading plane.
  const victimCenterWX = victimCenterX;
  const victimCenterWZ = victim.y * Z_STRETCH;
  const pusherCenterWZ = pusher.y * Z_STRETCH;
  const dx = victimCenterWX - pusherCenterX;
  const dz = victimCenterWZ - pusherCenterWZ;
  const fwdDist = dx * fxWorld + dz * fzWorld;
  const perp    = -dx * fzWorld + dz * fxWorld;   // +ve = victim on pusher's right
  pusher.pushArm = perp >= 0 ? 'right' : 'left';
  if (fwdDist < PUSH_UPPERCUT_RANGE) pusher.pushType = 'uppercut';
  else if (fwdDist < PUSH_HOOK_RANGE) pusher.pushType = 'hook';
  else pusher.pushType = 'jab';
  // Target height: jab/hook aim at the centre of the head; uppercut
  // aims slightly above so the strike arc sweeps UP through the
  // chin and lands with the fist over the crown. All three use the
  // victim's body-axis in xz.
  const headY      = HEAD_CENTER_Z;
  const aboveHeadY = HEAD_CENTER_Z + STICKMAN_HEAD_RADIUS * 0.5;
  pusher.pushTargetX = victimCenterWX;
  pusher.pushTargetY = pusher.pushType === 'uppercut' ? aboveHeadY : headY;
  pusher.pushTargetZ = victimCenterWZ;

  pusher.stamina = Math.max(0, pusher.stamina - PUSH_STAMINA_COST * power01);
  victim.stamina = Math.max(0, victim.stamina - PUSH_STAMINA_COST * power01 * PUSH_VICTIM_STAMINA_MULT);

  if (state.recordEvents) {
    const pusherWhich = pusher === state.p1 ? 'p1' : 'p2';
    state.events.push({ type: 'push', pusher: pusherWhich, force, variant: pusher.pushType, arm: pusher.pushArm });
  }
}

/* ── Ball physics ─────────────────────────────────────────────── */

function updateBall(state) {
  const ball = state.ball;
  if (ball.frozen) return;
  // No early-exit for a completely-at-rest ball — the body-collider
  // resolver still needs to fire so a player walking into a dead
  // ball can push it. The substep loop does zero work when all
  // velocities are zero, so the only per-tick cost is two
  // capsule-sphere tests.

  // Z physics in one step per tick (gravity + ground/ceiling bounces)
  // — preserves the existing parabola timing for vertical motion.
  // Horizontal (X, Y) motion is what tunnels through thin goal
  // surfaces (post radius ≈ 1.2, ball radius ≈ 1.87), so only those
  // get substepped below.
  if (ball.z > 0 || ball.vz > 0) {
    ball.vz -= GRAVITY;
    ball.z += ball.vz;
    if (ball.z <= 0) {
      const preVz = Math.abs(ball.vz);
      ball.z = 0;
      if (preVz > BOUNCE_VZ_MIN) {
        ball.vz = preVz * AIR_BOUNCE;
        recordBounce(state, 'z', preVz);
      } else {
        ball.vz = 0;
      }
    }
  }
  if (ball.z > CEILING) {
    const preVz = Math.abs(ball.vz);
    ball.z = CEILING;
    ball.vz = -preVz * AIR_BOUNCE;
    recordBounce(state, 'z', preVz);
  }

  // Horizontal motion in substeps so a hard shot can't tunnel past
  // a thin post / back wall. Friction + velocity cutoffs apply once
  // after all substeps so per-tick magnitudes match the single-step
  // case when motion is slow enough for substeps=1.
  const motionXY = Math.sqrt(ball.vx * ball.vx + ball.vy * ball.vy);
  const substeps = motionXY > BALL_RADIUS ? Math.ceil(motionXY / BALL_RADIUS) : 1;
  const invN = 1 / substeps;
  const field = state.field;

  for (let s = 0; s < substeps; s++) {
    ball.x += ball.vx * invN;
    ball.y += ball.vy * invN;

    if (ball.y < BALL_RADIUS) {
      const preVy = Math.abs(ball.vy);
      ball.y = BALL_RADIUS;
      ball.vy = preVy * WALL_BOUNCE_DAMP;
      recordBounce(state, 'y', preVy);
    } else if (ball.y > FIELD_HEIGHT - BALL_RADIUS) {
      const preVy = Math.abs(ball.vy);
      ball.y = FIELD_HEIGHT - BALL_RADIUS;
      ball.vy = -preVy * WALL_BOUNCE_DAMP;
      recordBounce(state, 'y', preVy);
    }

    checkBallScoreOrOut(state);
    if (ball.frozen) return;
    // Bars (posts + crossbar) are solid from both sides — a ball
    // inside the net that bounces forward into a post must rebound
    // off it, just as one from the field would. Run unconditionally.
    resolveBallVsGoalBars(state, field.goalBoxLeft);
    resolveBallVsGoalBars(state, field.goalBoxRight);
    if (ball.inGoal) {
      // Inside the net. Back wall, sides, roof absorb the ball
      // (soft net catch) and let gravity drop it.
      resolveBallInsideGoal(state, field.goalBoxLeft);
      resolveBallInsideGoal(state, field.goalBoxRight);
    } else {
      // Outside the goal. Back wall, sides, roof are solid bounce
      // planes — prevents tunneling through the net from the field
      // side when a ball arrives off the mouth axis.
      resolveBallVsGoalExterior(state, field.goalBoxLeft);
      resolveBallVsGoalExterior(state, field.goalBoxRight);
    }
    if (ball.frozen) return;
    // Ball vs player bodies — cushion + deflect trap on torso/head.
    // Skipped internally for any player with an active kick so the
    // foot can reach the ball (see resolveBallVsPlayerBody). On a
    // clamp, break the substep loop — the cushioned / pinned velocity
    // should NOT drive further advancement within the same tick.
    const hit1 = resolveBallVsPlayerBody(state, state.p1);
    const hit2 = resolveBallVsPlayerBody(state, state.p2);
    if (hit1 || hit2) break;
  }

  const friction = ball.z > 0 ? AIR_FRICTION : GROUND_FRICTION;
  ball.vx *= friction;
  ball.vy *= friction;

  if (ball.vx * ball.vx < BALL_VEL_CUTOFF_SQ) ball.vx = 0;
  if (ball.vy * ball.vy < BALL_VEL_CUTOFF_SQ) ball.vy = 0;
}

/* ── Goal / OOB detection ─────────────────────────────────────── */

function checkBallScoreOrOut(state) {
  const f = state.field;
  const ball = state.ball;
  if (ball.frozen) return;

  // Out-of-bounds: ball fully past either field end. Fires as soon
  // as the entire sphere clears the touchline — no margin, ball was
  // visibly off-field well before the old 50-unit slack.
  if (ball.x + BALL_RADIUS < 0 || ball.x - BALL_RADIUS > f.width) {
    ballOut(state);
    return;
  }

  if (state.graceFrames > 0) return;

  const crossedL = ball.x < f.goalLineL;
  const crossedR = ball.x > f.goalLineR;
  if (!crossedL && !crossedR) return;

  // Goal requires the whole ball past the line AND the ball fully
  // inside the goal mouth opening (between posts, below crossbar).
  // Post / crossbar contact is resolved by resolveBallVsGoalBars
  // (sphere-cylinder); inner back / roof / side nets by
  // resolveBallInsideGoal once inGoal=true.
  //
  // The "ball.x ± BALL_RADIUS inside the back wall" clause prevents
  // a false score for a ball that was never actually kicked into the
  // mouth — a ball sitting just outside the back of the net still
  // satisfies `fully past the line`, so without this gate any ball
  // that reaches the behind-goal zone would score immediately.
  const fullyPastL = ball.x + BALL_RADIUS <= f.goalLineL
                  && ball.x - BALL_RADIUS >= f.goalLLeft;
  const fullyPastR = ball.x - BALL_RADIUS >= f.goalLineR
                  && ball.x + BALL_RADIUS <= f.goalRRight;
  // Mouth opening is inset by GOAL_POST_RADIUS so the ball must be
  // fully clear of the physical post cylinders to count as in the
  // mouth. Same inset applies below the crossbar.
  const withinMouthY =
    ball.y - BALL_RADIUS >= f.goalMouthYMin + GOAL_POST_RADIUS
    && ball.y + BALL_RADIUS <= f.goalMouthYMax - GOAL_POST_RADIUS;
  const belowCrossbar =
    ball.z + BALL_RADIUS <= f.goalMouthZMax - GOAL_POST_RADIUS;

  const goalL = crossedL && fullyPastL && withinMouthY && belowCrossbar;
  const goalR = crossedR && fullyPastR && withinMouthY && belowCrossbar;
  if (goalL) scoreGoal(state, 'left');
  else if (goalR) scoreGoal(state, 'right');
}

/* ── Scoring + pause FSM live in physics/match-flow.js ───────── */

import {
  scoreGoal, ballOut, resetBall, resetToKickoff,
  advancePause, clearInProgressActions,
} from './physics/match-flow.js';
export { endMatchByTime } from './physics/match-flow.js';

/* ── Helpers ──────────────────────────────────────────────────── */

function clamp(v, lo, hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}
