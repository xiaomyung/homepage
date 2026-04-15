/**
 * Football v2 — pure physics module.
 *
 * No DOM, no three.js, no wall-clock. The caller owns cadence: the showcase
 * loop calls tick() once per animation frame; training workers call it in a
 * tight loop. Determinism relies on the caller passing a seeded PRNG into
 * createState(); the bundled createSeededRng() is the canonical source.
 *
 * A Python port at evolution/physics_py.py must stay bit-identical on
 * seeded runs. Enforced by tests/test_parity.py.
 */

/* ── Constants ────────────────────────────────────────────────── */

export const FIELD_WIDTH_REF = 900;
export const FIELD_HEIGHT = 54.6;
export const CEILING = 100;

export const TICK_MS = 16;
const STALL_TICKS = Math.ceil(10000 / TICK_MS);

// Ball
const GRAVITY = 0.3;
const AIR_FRICTION = 0.99;
const GROUND_FRICTION = 0.944;
const BOUNCE_RETAIN = 0.8;
const AIR_BOUNCE = 0.6;
const WALL_BOUNCE_DAMP = 0.5;
const BOUNCE_VZ_MIN = 1.5;
const BALL_VEL_CUTOFF = 0.1;
const BALL_VEL_CUTOFF_SQ = BALL_VEL_CUTOFF * BALL_VEL_CUTOFF;
export const BALL_RADIUS = 1.8711;
const RESPAWN_DROP_Z = 60;

// Player movement
export const MAX_PLAYER_SPEED = 10;
// Acceleration cap: limits |Δv| per tick so players can't start/stop
// instantly. Full speed → stop takes PLAYER_ACCEL_TICKS ticks; a
// 180° reversal takes 2×. Tuned for ~320 ms at 60 Hz.
const PLAYER_ACCEL_TICKS = 20;
const PLAYER_ACCEL = MAX_PLAYER_SPEED / PLAYER_ACCEL_TICKS;
const MOVE_THRESHOLD = 0.1;
const MOVE_THRESHOLD_SQ = MOVE_THRESHOLD * MOVE_THRESHOLD;
const STARTING_GAP = 40;
export const PLAYER_WIDTH = 18;
export const PLAYER_HEIGHT = 6;
const MIN_SPEED_STAMINA = 0.3;

// Heading — angular orientation in world-space (cos(h), sin(h)*Z_STRETCH)
// is the unit "front" vector of the stickman. Tracks visual motion
// direction with bounded angular velocity (angular inertia), so a
// 180° turn takes PLAYER_TURN_TICKS ticks regardless of how fast the
// NN slams the stick. Also defines which way the player must face to
// land a kick or a push — see FACE_TOL constants below.
export const Z_STRETCH = 4.7;  // must match renderer.js Z_STRETCH
const PLAYER_TURN_TICKS = 20;  // ticks to complete a 180° turn
const PLAYER_TURN_RATE = Math.PI / PLAYER_TURN_TICKS;
export const KICK_FACE_TOL = Math.PI / 3;  // 60° cone toward ball
export const PUSH_FACE_TOL = Math.PI / 3;  // 60° cone toward victim

// Stamina
const STAMINA_REGEN = 0.005;
const STAMINA_MOVE_BASE = 0.003;
const STAMINA_MOVE_PER_UNIT = 0.00036;
const STAMINA_MOVE_THRESHOLD = 0.1;
const DIRECTION_CHANGE_DRAIN = 0.02;
const STAMINA_EXHAUSTION_THRESHOLD = 0.5;
const STAMINA_KICK_DRAIN = 0.3;
const STAMINA_AIRKICK_DRAIN = 0.1;

// Kick
export const MAX_KICK_POWER = 22;
const MIN_KICK_POWER = 0.15;
const MIN_KICK_STAMINA = 0.2;
const KICK_NOISE_SCALE = 0.3;
const KICK_NOISE_VERT = 0.5;
// Ground-kick reach: foot/leg swings in the (facing, up) plane only,
// so lateral reach is essentially zero. The allowed ball offset on
// the depth axis is one body-half + ball radius + a small slack for
// animation smoothing. Expressed as center-to-center in the canKick
// check below (see the mid-Y formula, not the legacy top-Y version).
const KICK_REACH_SLACK_Y = 1.5;
const KICK_REACH_X_MULT = 1.0;
export const KICK_REACH_Y = PLAYER_HEIGHT / 2 + BALL_RADIUS + KICK_REACH_SLACK_Y;
// Airkick has a slightly more generous depth tolerance — the leap
// lets the player tilt into the ball a touch past the standing footprint.
const AIRKICK_REACH_SLACK_Y = 3;
const AIRKICK_REACH_X_MULT = 1.5;
export const AIRKICK_REACH_Y = PLAYER_HEIGHT / 2 + BALL_RADIUS + AIRKICK_REACH_SLACK_Y;
const AIRKICK_MAX_Z = 20;
export const AIRKICK_MS = 350;
export const AIRKICK_PEAK_FRAC = 0.4;
const AIRKICK_DZ_THRESHOLD = 0.5;
// Ground-kick timing: fire impact at KICK_WINDUP_MS, deactivate at
// KICK_DURATION_MS. Both are *total* elapsed times, not spans — so
// the recovery window lasts (KICK_DURATION_MS - KICK_WINDUP_MS).
export const KICK_WINDUP_MS = 96;
export const KICK_DURATION_MS = 288;
const KICK_DIR_MIN_LEN = 0.01;
const WASTED_KICK_SPEED = MIN_KICK_POWER * 0.1;

// Push
export const PUSH_RANGE_X = 30;
// Push range on the depth axis: fists also swing in the (facing, up)
// plane with ~zero lateral reach, so bodies must overlap (or nearly
// touch) in y. PLAYER_HEIGHT covers the full overlap-to-touching
// range from top-to-top, plus a small slack for animation timing.
const PUSH_RANGE_SLACK_Y = 1;
export const PUSH_RANGE_Y = PLAYER_HEIGHT + PUSH_RANGE_SLACK_Y;
export const MAX_PUSH_FORCE = 200;
const PUSH_DAMP = 0.88;
const PUSH_APPLY = 0.12;
const PUSH_VEL_THRESHOLD = 0.5;
const PUSH_VEL_THRESHOLD_SQ = PUSH_VEL_THRESHOLD * PUSH_VEL_THRESHOLD;
const MIN_PUSH_STAMINA = 0.2;
const PUSH_ANIM_MS = 300;
const PUSH_STAMINA_COST = 0.15;
const PUSH_VICTIM_STAMINA_MULT = 3;

// Goal frame
const GOAL_BACK_OFFSET = 30;
const GOAL_DEPTH = 78;
const GOAL_LINE_INSET = 6; // scoring line sits this far inside the mouth
// Physics radius of the goal posts / crossbar — must match the
// renderer's GOAL_BAR_RADIUS. The mouth opening is inset by this
// much on each side (y posts and crossbar) so the ball's sphere
// must be fully past the post's inner surface to count as in the
// mouth. Without this inset a ball clipping the visible post
// surface would score through it.
const GOAL_POST_RADIUS = 1.2;
const GOAL_MOUTH_Z = 26;  // crossbar height (unchanged)
const GOAL_MOUTH_WIDTH = 28.6;  // z-span of the mouth (30% + another 10% wider than the original 20)
const GOAL_MOUTH_Y_MIN = (FIELD_HEIGHT - GOAL_MOUTH_WIDTH) / 2;
const GOAL_MOUTH_Y_MAX = (FIELD_HEIGHT + GOAL_MOUTH_WIDTH) / 2;

// Match
export const WIN_SCORE = 3;
const CELEBRATE_TICKS = Math.ceil(1500 / TICK_MS);
const MATCHEND_PAUSE_TICKS = Math.ceil(3000 / TICK_MS);
const RESPAWN_GRACE = 30;
const REPOSITION_SPEED = 6;
const REPOSITION_TOL = 5;
const RESPAWN_DELAY_TICKS = Math.ceil(300 / TICK_MS);

/* ── Field & state factories ──────────────────────────────────── */

export function createField(width = FIELD_WIDTH_REF) {
  const goalLLeft = GOAL_BACK_OFFSET;
  const goalLRight = goalLLeft + GOAL_DEPTH;
  const goalRRight = width - GOAL_BACK_OFFSET;
  const goalRLeft = goalRRight - GOAL_DEPTH;
  return {
    width,
    height: FIELD_HEIGHT,
    ceiling: CEILING,
    playerWidth: PLAYER_WIDTH,
    playerHeight: PLAYER_HEIGHT,
    goalLLeft,
    goalLRight,
    goalRLeft,
    goalRRight,
    goalLineL: goalLRight - GOAL_LINE_INSET,
    goalLineR: goalRLeft + GOAL_LINE_INSET,
    goalMouthYMin: GOAL_MOUTH_Y_MIN,
    goalMouthYMax: GOAL_MOUTH_Y_MAX,
    goalMouthZMax: GOAL_MOUTH_Z,
    midX: width / 2,
    aiLimitL: goalLLeft + GOAL_LINE_INSET,
    aiLimitR: goalRRight - GOAL_LINE_INSET,
  };
}

function createPlayer(side, field) {
  const x = side === 'left'
    ? field.midX - STARTING_GAP - field.playerWidth / 2
    : field.midX + STARTING_GAP - field.playerWidth / 2;
  return {
    side,
    x, y: FIELD_HEIGHT / 2,
    vx: 0, vy: 0,
    pushVx: 0, pushVy: 0,
    stamina: 1,
    exhausted: false,
    // Pre-allocated kick slot — gated by `.active` so we never allocate
    // a fresh object per kick attempt on the hot path.
    kick: {
      active: false,
      phase: 'windup', // 'windup' (ground) | 'airkick'
      timer: 0,
      airZ: 0,
      fired: false,
      dx: 0, dy: 0, dz: 0,
      power: 0,
    },
    pushTimer: 0,
    // Heading: 0 = facing toward +x (right side of field). Players
    // start facing the opposing goal so the first frame of a match
    // looks like a kick-off, not two stickmen staring at the camera.
    heading: side === 'left' ? 0 : Math.PI,
    // Previous tick's commanded move direction (sign of move axis).
    // Used to fire DIRECTION_CHANGE_DRAIN exactly once on each
    // reversal instead of continuously while velocity crosses zero.
    prevTargetDirX: 0,
    prevTargetDirY: 0,
    airZ: 0,
  };
}

/**
 * Create a fresh game state. Default rng is a seeded LCG with seed 0 so that
 * accidentally-unseeded callers get a reproducible stream (parity with Py).
 * `recordEvents` is false by default — tests and runners opt in to collect
 * state.events; production callers (main, worker) skip all event allocation.
 */
export function createState(field, rng = createSeededRng(0)) {
  return {
    field,
    rng,
    ball: {
      x: field.midX, y: FIELD_HEIGHT / 2,
      vx: 0, vy: 0,
      z: RESPAWN_DROP_Z, vz: 0,
      frozen: false,
    },
    p1: createPlayer('left', field),
    p2: createPlayer('right', field),
    scoreL: 0,
    scoreR: 0,
    tick: 0,
    graceFrames: RESPAWN_GRACE,
    lastKickTick: 0,
    pauseState: null, // null | 'celebrate' | 'matchend' | 'reposition' | 'waiting'
    pauseTimer: 0,
    goalScorer: null,
    matchOver: false,
    winner: null,
    events: [],
    recordEvents: false,
  };
}

/* ── Seeded PRNG (LCG, Numerical Recipes params) ──────────────── */

export function createSeededRng(seed) {
  let state = (seed >>> 0) || 1;
  return function rng() {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function gaussRandom(rng) {
  const u1 = rng() || 1e-10;
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/* ── Main tick ────────────────────────────────────────────────── */

export function tick(state, p1Act, p2Act) {
  if (state.recordEvents) state.events.length = 0;
  state.tick++;

  if (state.matchOver) return state;

  if (state.pauseState !== null) {
    advancePause(state);
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

  clampAndCollide(state, state.p1);
  clampAndCollide(state, state.p2);

  chargeStaminaFromDisplacement(state.p1, pre1x, pre1y);
  chargeStaminaFromDisplacement(state.p2, pre2x, pre2y);

  updateBall(state);
  checkBallScoreOrOut(state);
  // Goal-frame collision runs after the scoring check — a ball that
  // legitimately crossed the open mouth has already frozen as a goal
  // and will short-circuit the resolver. Every other overlap (sides,
  // back, roof, posts, crossbar, from any direction) is pushed out
  // along the minimum-penetration axis.
  const field = state.field;
  resolveBallGoalBox(state, goalBox(field, 'left'));
  resolveBallGoalBox(state, goalBox(field, 'right'));

  if (state.tick - state.lastKickTick > STALL_TICKS) {
    resetBall(state);
    state.lastKickTick = state.tick;
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

// Action layout: [moveX, moveY, kick, kickDx, kickDy, kickDz, kickPower, push, pushPower]
function applyAction(state, p, out) {
  // In-flight kicks must always tick forward to completion — even if the
  // player became exhausted during the kick. Otherwise the animation freezes
  // for the entire exhaustion window and new kicks are locked out.
  if (advanceKick(state, p)) return;

  // Push cooldown decrements unconditionally so a push issued right before
  // a kick doesn't get frozen at max for the kick's duration.
  if (p.pushTimer > 0) {
    p.pushTimer -= TICK_MS;
    if (p.pushTimer < 0) p.pushTimer = 0;
    return;
  }

  if (p.exhausted) { p.vx = 0; p.vy = 0; return; }

  applyMovement(state, p, out[0], out[1]);

  if (out[7] > 0) {
    const opp = p === state.p1 ? state.p2 : state.p1;
    tryPush(state, p, opp, out[8]);
  }

  if (out[2] > 0 && canKick(state, p)) {
    startKick(p, out[3], out[4], out[5], out[6]);
  }
}

/* ── Movement ─────────────────────────────────────────────────── */

/** Shortest-arc signed difference between two angles, in (-π, π]. */
function wrapAngle(a) {
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

/** Signed heading difference between a player's current heading and
 *  the world-space direction toward (worldX, worldZ). Used by both
 *  kick and push alignment gates, and by the renderer for the limb
 *  swing frame (via the exported helper below). */
function angleToTarget(p, worldX, worldZ) {
  const centerX = p.x + PLAYER_WIDTH / 2;
  const centerZ = (p.y + PLAYER_HEIGHT / 2) * Z_STRETCH;
  return Math.atan2(worldZ - centerZ, worldX - centerX);
}

function applyMovement(state, p, moveX, moveY) {
  const effSpeed = MAX_PLAYER_SPEED * Math.max(MIN_SPEED_STAMINA, p.stamina);
  let targetVx = clamp(moveX, -1, 1) * effSpeed;
  let targetVy = clamp(moveY, -1, 1) * effSpeed;

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

/** Goal box AABB for one side, in physics units. */
function goalBox(f, side) {
  if (side === 'left') {
    return { minX: f.goalLLeft, maxX: f.goalLineL,
             minY: f.goalMouthYMin, maxY: f.goalMouthYMax,
             minZ: 0, maxZ: f.goalMouthZMax };
  }
  return { minX: f.goalLineR, maxX: f.goalRRight,
           minY: f.goalMouthYMin, maxY: f.goalMouthYMax,
           minZ: 0, maxZ: f.goalMouthZMax };
}

/**
 * AABB-AABB push with velocity-biased axis selection. Given an
 * entity AABB, a box AABB, and the entity's current velocity,
 * returns `{ axis, delta }` pushing the entity out through the
 * face it most recently crossed. The "entry face" is found by
 * dividing each axis's push magnitude by that axis's velocity
 * magnitude (rewind time) — the axis with the smallest rewind
 * is the most recent entry, which is the physically correct
 * face to push back through.
 *
 * Pure min-penetration (shallowest overlap) fails for classic
 * "glancing post" cases where the ball clips a thin sliver of
 * the box on one axis while entering deeply on another — this
 * function resolves those by respecting motion direction.
 *
 * `useZ=false` ignores z axis — used for 2D players.
 * Returns null if the AABBs do not overlap.
 */
function minPenetrationPush(ent, box, useZ, vel) {
  if (ent.maxX <= box.minX || ent.minX >= box.maxX) return null;
  if (ent.maxY <= box.minY || ent.minY >= box.maxY) return null;
  if (useZ && (ent.maxZ <= box.minZ || ent.minZ >= box.maxZ)) return null;

  // Push magnitudes on each axis, directed opposite to velocity so
  // the entity is sent back the way it came. If velocity is zero
  // on an axis, fall back to the shallower overlap side for that
  // axis (the entity is stationary — push through nearest face).
  const vx = vel.vx || 0, vy = vel.vy || 0, vz = vel.vz || 0;
  const pushMinX = ent.maxX - box.minX; // magnitude to push in -x
  const pushMaxX = box.maxX - ent.minX; // magnitude to push in +x
  const pushMinY = ent.maxY - box.minY;
  const pushMaxY = box.maxY - ent.minY;

  const dx = vx > 0 ? -pushMinX : vx < 0 ? pushMaxX : (pushMinX < pushMaxX ? -pushMinX : pushMaxX);
  const dy = vy > 0 ? -pushMinY : vy < 0 ? pushMaxY : (pushMinY < pushMaxY ? -pushMinY : pushMaxY);
  const EPS = 1e-9;
  const tx = Math.abs(dx) / (Math.abs(vx) + EPS);
  const ty = Math.abs(dy) / (Math.abs(vy) + EPS);

  if (!useZ) {
    return tx <= ty ? { axis: 'x', delta: dx } : { axis: 'y', delta: dy };
  }
  const pushMinZ = ent.maxZ - box.minZ;
  const pushMaxZ = box.maxZ - ent.minZ;
  const dz = vz > 0 ? -pushMinZ : vz < 0 ? pushMaxZ : (pushMinZ < pushMaxZ ? -pushMinZ : pushMaxZ);
  const tz = Math.abs(dz) / (Math.abs(vz) + EPS);
  if (tx <= ty && tx <= tz) return { axis: 'x', delta: dx };
  if (ty <= tz) return { axis: 'y', delta: dy };
  return { axis: 'z', delta: dz };
}

function clampPlayerToField(p, f) {
  if (p.x < 0) p.x = 0;
  else if (p.x > f.width - f.playerWidth) p.x = f.width - f.playerWidth;
  if (p.y < 0) p.y = 0;
  else if (p.y > FIELD_HEIGHT - PLAYER_HEIGHT) p.y = FIELD_HEIGHT - PLAYER_HEIGHT;
}

function clampAndCollide(state, p) {
  const f = state.field;
  clampPlayerToField(p, f);
  resolvePlayerGoalBox(p, f.playerWidth, goalBox(f, 'left'));
  resolvePlayerGoalBox(p, f.playerWidth, goalBox(f, 'right'));
  // The goal-frame resolution can push a player past a field edge (notably
  // the right goal → right wall). Re-clamp so the body stays fully inside.
  clampPlayerToField(p, f);
}

/**
 * Player-vs-goal-box collision. Player is a 2D AABB [x, x+pw] ×
 * [y, y+ph] on the ground plane — z is ignored. Pushes the player
 * out along the axis of minimum penetration and zeroes the velocity
 * on that axis.
 */
function resolvePlayerGoalBox(p, pw, box) {
  const ent = {
    minX: p.x, maxX: p.x + pw,
    minY: p.y, maxY: p.y + PLAYER_HEIGHT,
  };
  const push = minPenetrationPush(ent, box, false, p);
  if (!push) return;
  if (push.axis === 'x') {
    p.x += push.delta;
    p.vx = 0;
    p.pushVx = 0;
  } else {
    p.y += push.delta;
    p.vy = 0;
    p.pushVy = 0;
  }
}

/**
 * Ball-vs-goal-box collision. Ball is a sphere approximated as a
 * cube of side 2*BALL_RADIUS for AABB math (the 2D game uses
 * radius-around-center collisions everywhere else, so the inflation
 * is consistent). Runs AFTER the scoring check so a ball legitimately
 * crossing the open mouth is frozen as a goal and skips this path.
 * On collision, the ball is pushed out along the minimum-penetration
 * axis and the velocity component on that axis flips with a bounce
 * damping, producing a believable rebound off any face of the goal.
 */
function resolveBallGoalBox(state, box) {
  const ball = state.ball;
  if (ball.frozen) return;

  // Open-mouth exemption: if the ball sphere is fully inside the
  // mouth y and z opening (shrunk by GOAL_POST_RADIUS to account
  // for the physical post/crossbar thickness), the front face is
  // transparent — let the ball cross unimpeded so the scoring
  // check on the next tick can see it "fully past the line".
  // Matches the scoring withinMouthY/belowCrossbar exactly so any
  // ball cleared by one is cleared by the other.
  const inMouthY =
    ball.y - BALL_RADIUS >= box.minY + GOAL_POST_RADIUS
    && ball.y + BALL_RADIUS <= box.maxY - GOAL_POST_RADIUS;
  const inMouthZ = ball.z + BALL_RADIUS <= box.maxZ - GOAL_POST_RADIUS;
  if (inMouthY && inMouthZ) return;

  const ent = {
    minX: ball.x - BALL_RADIUS, maxX: ball.x + BALL_RADIUS,
    minY: ball.y - BALL_RADIUS, maxY: ball.y + BALL_RADIUS,
    minZ: ball.z - BALL_RADIUS, maxZ: ball.z + BALL_RADIUS,
  };
  const push = minPenetrationPush(ent, box, true, ball);
  if (!push) return;
  if (push.axis === 'x') {
    ball.x += push.delta;
    if (ball.vx * push.delta < 0) {
      const preVx = Math.abs(ball.vx);
      ball.vx = -ball.vx * BOUNCE_RETAIN;
      recordBounce(state, 'x', preVx);
    }
  } else if (push.axis === 'y') {
    ball.y += push.delta;
    if (ball.vy * push.delta < 0) {
      const preVy = Math.abs(ball.vy);
      ball.vy = -ball.vy * BOUNCE_RETAIN;
      recordBounce(state, 'y', preVy);
    }
  } else {
    ball.z += push.delta;
    if (ball.z < 0) ball.z = 0;
    if (ball.vz * push.delta < 0) {
      const preVz = Math.abs(ball.vz);
      ball.vz = -ball.vz * BOUNCE_RETAIN;
      recordBounce(state, 'z', preVz);
    }
  }
}

/* ── Kick state machine ──────────────────────────────────────── */

function canKick(state, p) {
  if (p.kick.active) return false;
  const f = state.field;
  const centerX = p.x + f.playerWidth / 2;
  const centerY = p.y + PLAYER_HEIGHT / 2;
  const closeX = Math.abs(state.ball.x - centerX) < f.playerWidth * KICK_REACH_X_MULT;
  const closeY = Math.abs(state.ball.y - centerY) < KICK_REACH_Y;
  if (!(closeX && closeY)) return false;
  // Face gate: the player must be pointed toward the ball (within a
  // ~60° cone) to connect. This is what forces the brain to turn
  // before kicking — same rule for ground and air kicks.
  const ballZ = state.ball.y * Z_STRETCH;
  const wantAngle = angleToTarget(p, state.ball.x, ballZ);
  return Math.abs(wrapAngle(wantAngle - p.heading)) < KICK_FACE_TOL;
}

function startKick(p, dx, dy, dz, power) {
  const kickDx = clamp(dx, -1, 1);
  const kickDy = clamp(dy, -1, 1);
  const kickDz = clamp(dz, -1, 1);
  const kickPower = (clamp(power, -1, 1) + 1) / 2;
  const k = p.kick;
  k.active = true;
  k.timer = 0;
  k.fired = false;
  k.dx = kickDx; k.dy = kickDy; k.dz = kickDz;
  k.power = kickPower;

  if (dz > AIRKICK_DZ_THRESHOLD) {
    const jumpFrac = (dz - AIRKICK_DZ_THRESHOLD) * 2;
    k.phase = 'airkick';
    k.airZ = jumpFrac * AIRKICK_MAX_Z;
    p.stamina = Math.max(0, p.stamina - STAMINA_AIRKICK_DRAIN);
  } else {
    k.phase = 'windup';
    k.airZ = 0;
  }
}

/** Returns true if the player is mid-kick and should not accept new outputs. */
function advanceKick(state, p) {
  const k = p.kick;
  if (!k.active) return false;
  k.timer += TICK_MS;

  if (k.phase === 'airkick') {
    const animFrac = Math.min(k.timer / AIRKICK_MS, 1);
    p.airZ = Math.sin(animFrac * Math.PI) * k.airZ;
    if (!k.fired && animFrac >= AIRKICK_PEAK_FRAC) {
      k.fired = true;
      executeKick(state, p);
    }
    if (animFrac >= 1) {
      p.airZ = 0;
      k.active = false;
    }
    return true;
  }

  // Ground kick: windup → fire → recovery → idle
  if (!k.fired && k.timer >= KICK_WINDUP_MS) {
    k.fired = true;
    executeKick(state, p);
  }
  if (k.timer >= KICK_DURATION_MS) {
    k.active = false;
  }
  return true;
}

function executeKick(state, p) {
  const f = state.field;
  const ball = state.ball;
  const k = p.kick;
  const which = p === state.p1 ? 'p1' : 'p2';
  const isAirkick = k.phase === 'airkick';

  if (isAirkick && ball.z <= 1) {
    if (state.recordEvents) state.events.push({ type: 'kick_missed', player: which, reason: 'airkick_ground_ball' });
    return;
  }
  if (!isAirkick && ball.z > PLAYER_HEIGHT) {
    if (state.recordEvents) state.events.push({ type: 'kick_missed', player: which, reason: 'ground_kick_high_ball' });
    return;
  }

  if (isAirkick) {
    const centerX = p.x + f.playerWidth / 2;
    const centerY = p.y + PLAYER_HEIGHT / 2;
    const reachX = f.playerWidth * AIRKICK_REACH_X_MULT;
    if (Math.abs(ball.x - centerX) > reachX || Math.abs(ball.y - centerY) > AIRKICK_REACH_Y) {
      if (state.recordEvents) state.events.push({ type: 'kick_missed', player: which, reason: 'airkick_out_of_range' });
      return;
    }
  }

  const rawPower = Math.max(MIN_KICK_POWER, k.power);
  const force = rawPower * MAX_KICK_POWER * Math.max(MIN_KICK_STAMINA, p.stamina);

  let dx = k.dx, dy = k.dy, dz = k.dz;
  const rawLen = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (rawLen < KICK_DIR_MIN_LEN) {
    // NN didn't commit — pick a random direction from the seeded stream
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

function tryPush(state, pusher, victim, powerNorm) {
  const f = state.field;
  const pusherCenterX = pusher.x + f.playerWidth / 2;
  const victimCenterX = victim.x + f.playerWidth / 2;

  if (pusher.kick.active) return;
  if (pusher.pushTimer > 0) return;
  if (Math.abs(pusherCenterX - victimCenterX) > PUSH_RANGE_X) return;
  if (Math.abs(pusher.y - victim.y) > PUSH_RANGE_Y) return;

  // Face gate: the pusher must be pointed toward the victim.
  const victimZ = (victim.y + PLAYER_HEIGHT / 2) * Z_STRETCH;
  const wantAngle = angleToTarget(pusher, victimCenterX, victimZ);
  if (Math.abs(wrapAngle(wantAngle - pusher.heading)) > PUSH_FACE_TOL) return;

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

  victim.pushVx = (fxWorld / pMag) * force;
  victim.pushVy = (fyPhys  / pMag) * force;

  pusher.stamina = Math.max(0, pusher.stamina - PUSH_STAMINA_COST * power01);
  victim.stamina = Math.max(0, victim.stamina - PUSH_STAMINA_COST * power01 * PUSH_VICTIM_STAMINA_MULT);

  if (state.recordEvents) {
    const pusherWhich = pusher === state.p1 ? 'p1' : 'p2';
    state.events.push({ type: 'push', pusher: pusherWhich, force });
  }
}

/* ── Ball physics ─────────────────────────────────────────────── */

function updateBall(state) {
  const ball = state.ball;
  if (ball.frozen) return;
  if (ball.vx === 0 && ball.vy === 0 && ball.z === 0 && ball.vz === 0) return;

  ball.x += ball.vx;
  ball.y += ball.vy;

  const friction = ball.z > 0 ? AIR_FRICTION : GROUND_FRICTION;
  ball.vx *= friction;
  ball.vy *= friction;

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

  // Ball body stays fully inside the top/bottom walls; bounces off.
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

  if (ball.z > CEILING) {
    const preVz = Math.abs(ball.vz);
    ball.z = CEILING;
    ball.vz = -preVz * AIR_BOUNCE;
    recordBounce(state, 'z', preVz);
  }

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
  // Everything else — bouncing off the posts, crossbar, back wall,
  // roof, or side walls — is handled by resolveBallGoalBox running
  // immediately after this check.
  const fullyPastL = ball.x + BALL_RADIUS <= f.goalLineL;
  const fullyPastR = ball.x - BALL_RADIUS >= f.goalLineR;
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
  if (goalL || goalR) scoreGoal(state, goalL ? 'left' : 'right');
}

/**
 * Record a ball bounce event for the renderer's particle system. Only
 * emitted when recordEvents is on; gated at `BOUNCE_EVENT_MIN` so
 * microscopic settle-bounces don't spawn noise. `axis` is the velocity
 * component that was reversed ('x' posts, 'y' field walls, 'z' ground/
 * ceiling); `force` is the magnitude of that component before the flip.
 */
const BOUNCE_EVENT_MIN = 0.3;
function recordBounce(state, axis, force) {
  if (!state.recordEvents) return;
  if (force < BOUNCE_EVENT_MIN) return;
  const ball = state.ball;
  state.events.push({
    type: 'ball_bounce',
    axis,
    force,
    x: ball.x,
    y: ball.y,
    z: ball.z,
  });
}

/* ── Scoring, ball-out, reset, finalize ──────────────────────── */

function scoreGoal(state, side) {
  state.ball.frozen = true;
  state.ball.vx = 0;
  state.ball.vy = 0;
  state.ball.vz = 0;
  state.pauseState = 'celebrate';
  state.pauseTimer = CELEBRATE_TICKS;

  if (side === 'left') {
    // Ball into LEFT goal = RIGHT scored
    state.scoreR++;
    state.goalScorer = state.p2;
    if (state.recordEvents) state.events.push({ type: 'goal', scorer: 'p2' });
  } else {
    state.scoreL++;
    state.goalScorer = state.p1;
    if (state.recordEvents) state.events.push({ type: 'goal', scorer: 'p1' });
  }

  if (state.scoreL >= WIN_SCORE || state.scoreR >= WIN_SCORE) {
    state.pauseState = 'matchend';
    state.pauseTimer = MATCHEND_PAUSE_TICKS;
    state.winner = state.scoreL >= WIN_SCORE ? 'left' : 'right';
  }
}

function ballOut(state) {
  state.ball.frozen = true;
  state.ball.vx = 0;
  state.ball.vy = 0;
  state.ball.vz = 0;
  state.pauseState = 'reposition';
  state.pauseTimer = 0;
  if (state.recordEvents) state.events.push({ type: 'out' });
}

function resetBall(state) {
  const ball = state.ball;
  ball.x = state.field.midX;
  ball.y = FIELD_HEIGHT / 2;
  ball.vx = 0;
  ball.vy = 0;
  ball.z = RESPAWN_DROP_Z;
  ball.vz = 0;
  ball.frozen = false;
  state.graceFrames = RESPAWN_GRACE;
  state.lastKickTick = state.tick;
}

/**
 * Finalize the match after the matchend pause. Callers poll `state.matchOver`
 * and discard the state (main.js starts a new showcase, workers break the
 * tick loop), so we only flip the terminal flags — no reset work.
 */
function finalizeMatch(state) {
  state.matchOver = true;
  state.pauseState = null;
  state.pauseTimer = 0;
}

/* ── Pause state machine ──────────────────────────────────────── */

function advancePause(state) {
  if (state.pauseState === 'matchend') {
    state.pauseTimer--;
    if (state.pauseTimer <= 0) finalizeMatch(state);
    return;
  }

  if (state.pauseState === 'celebrate') {
    state.pauseTimer--;
    if (state.pauseTimer <= 0) {
      state.pauseState = 'reposition';
      state.pauseTimer = 0;
      state.goalScorer = null;
    }
    return;
  }

  if (state.pauseState === 'reposition') {
    const f = state.field;
    const tx1 = f.midX - STARTING_GAP - f.playerWidth / 2;
    const tx2 = f.midX + STARTING_GAP - f.playerWidth / 2;
    const cy = FIELD_HEIGHT / 2;

    state.p1.stamina = Math.min(1, state.p1.stamina + STAMINA_REGEN);
    state.p2.stamina = Math.min(1, state.p2.stamina + STAMINA_REGEN);
    stepReposition(state.p1, tx1, cy);
    stepReposition(state.p2, tx2, cy);

    if (
      Math.abs(state.p1.x - tx1) < REPOSITION_TOL &&
      Math.abs(state.p2.x - tx2) < REPOSITION_TOL &&
      Math.abs(state.p1.y - cy) < REPOSITION_TOL &&
      Math.abs(state.p2.y - cy) < REPOSITION_TOL
    ) {
      state.pauseState = 'waiting';
      state.pauseTimer = RESPAWN_DELAY_TICKS;
    }
    return;
  }

  if (state.pauseState === 'waiting') {
    state.pauseTimer--;
    if (state.pauseTimer <= 0) {
      resetBall(state);
      state.pauseState = null;
    }
  }
}

function stepReposition(p, tx, ty) {
  const dx = tx - p.x;
  const dy = ty - p.y;
  const absDx = Math.abs(dx);
  const absDy = Math.abs(dy);
  if (absDx > REPOSITION_TOL || absDy > REPOSITION_TOL) {
    p.x += Math.sign(dx) * Math.min(absDx * 0.1, REPOSITION_SPEED);
    p.y += Math.sign(dy) * Math.min(absDy * 0.1, REPOSITION_SPEED * 0.5);
  } else {
    p.x = tx;
    p.y = ty;
  }
}

/* ── NN input builder ────────────────────────────────────────── */

export const NN_INPUT_SIZE = 20;

/**
 * Build the NN input vector for one player, normalized to [-1, 1].
 * Length is NN_INPUT_SIZE. The `out` parameter lets callers reuse
 * a buffer and skip the per-tick Array allocation. Must stay
 * bit-identical to physics_py.py:build_inputs.
 *
 * Inputs 18 and 19 are cos/sin of the player's heading — a direct
 * signal of which way the stickman is pointed, so a stationary
 * brain can still reason about its own facing relative to the
 * ball / opponent without having to move first.
 */
export function buildInputs(state, which, out) {
  if (!out) out = new Array(NN_INPUT_SIZE);
  const f = state.field;
  const p = state[which];
  const opp = which === 'p1' ? state.p2 : state.p1;
  const b = state.ball;
  const fw = f.width;
  const tgx = p.side === 'left' ? f.goalLineR : f.goalLineL;
  const ogx = p.side === 'left' ? f.goalLineL : f.goalLineR;

  out[0]  = (p.x / fw) * 2 - 1;
  out[1]  = (p.y / FIELD_HEIGHT) * 2 - 1;
  out[2]  = p.vx / MAX_PLAYER_SPEED;
  out[3]  = p.vy / MAX_PLAYER_SPEED;
  out[4]  = p.stamina * 2 - 1;
  out[5]  = (opp.x / fw) * 2 - 1;
  out[6]  = (opp.y / FIELD_HEIGHT) * 2 - 1;
  out[7]  = opp.vx / MAX_PLAYER_SPEED;
  out[8]  = opp.vy / MAX_PLAYER_SPEED;
  out[9]  = (b.x / fw) * 2 - 1;
  out[10] = (b.y / FIELD_HEIGHT) * 2 - 1;
  out[11] = b.z / CEILING;
  out[12] = b.vx / MAX_KICK_POWER;
  out[13] = b.vy / MAX_KICK_POWER;
  out[14] = b.vz / MAX_KICK_POWER;
  out[15] = (tgx / fw) * 2 - 1;
  out[16] = (ogx / fw) * 2 - 1;
  out[17] = (fw / FIELD_WIDTH_REF) * 2 - 1;
  // cos/sin of heading are already in [-1, 1] — no normalization.
  out[18] = Math.cos(p.heading);
  out[19] = Math.sin(p.heading);

  for (let i = 0; i < NN_INPUT_SIZE; i++) {
    if (out[i] > 1) out[i] = 1;
    else if (out[i] < -1) out[i] = -1;
  }
  return out;
}

/* ── Helpers ──────────────────────────────────────────────────── */

function clamp(v, lo, hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}
