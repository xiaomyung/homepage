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

import {
  advanceKick, tryStartKick,
} from './physics/kick.js';
export {
  solve2BoneIK, ikFootWorld, canKickReach, kickLegExtension, kickLegPose,
} from './physics/kick.js';

import { clamp, wrapAngle } from './physics/state.js';
// Re-export for animation/state.js, ai/perception.js, and tests.
export { wrapAngle } from './physics/state.js';

import {
  advancePush, advanceReactTimer, applyPushPhysics, tryPush,
} from './physics/push.js';
export {
  pushArmExtension, pushArmPose,
} from './physics/push.js';

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
// `wrapAngle` lives in physics/state.js (re-exported above for
// external consumers).

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


/**
 * Stage-aware arm extension for a punch, mirroring
 * `kickLegExtension`. Pure function of `pushTimer` in ms.
 * Windup is split into a load (0 → PUSH_WINDUP_PEAK_TEFF over the
 * first WINDUP_LOAD_FRAC of windup) and a rise (PEAK_TEFF → 1
 * over the rest), so the fist reaches full extension by the
 * windup→strike boundary instead of jumping there. Strike holds
 * at 1, recovery eases back to 0. Returns 0 when no push active.
 */
/** Same gates as tryPush, used at the strike-commit tick to verify
 *  the victim hasn't escaped the range/facing cone during the windup. */

/* ── Ball physics live in physics/ball.js ─────────────────────── */

import { updateBall, checkBallScoreOrOut } from './physics/ball.js';

/* ── Scoring + pause FSM live in physics/match-flow.js ───────── */

import {
  scoreGoal, ballOut, resetBall, resetToKickoff,
  advancePause, clearInProgressActions,
} from './physics/match-flow.js';
export { endMatchByTime } from './physics/match-flow.js';

/* ── Helpers ──────────────────────────────────────────────────── */

