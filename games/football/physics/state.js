/**
 * Football v2 — physics state factories.
 *
 * Pure factories: createField, createState, resetStateInPlace,
 * createSeededRng. Plus two helpers that the kick FSM reads
 * (kickoffSpawnX, gaussRandom) and the per-player initializers.
 * No physics math here — just allocation + initialisation.
 */

import {
  FIELD_WIDTH_REF, FIELD_HEIGHT, CEILING,
  PLAYER_WIDTH, PLAYER_HEIGHT, STARTING_GAP,
  GOAL_BACK_OFFSET, GOAL_DEPTH, GOAL_LINE_INSET,
  GOAL_MOUTH_Y_MIN, GOAL_MOUTH_Y_MAX, GOAL_MOUTH_Z, ROOF_FRACTION,
  GOAL_SENSOR_DEPTH,
  RESPAWN_DROP_Z, RESPAWN_GRACE,
} from './tuning.js';

export function createField(width = FIELD_WIDTH_REF) {
  const goalLLeft = GOAL_BACK_OFFSET;
  const goalLRight = goalLLeft + GOAL_DEPTH;
  const goalRRight = width - GOAL_BACK_OFFSET;
  const goalRLeft = goalRRight - GOAL_DEPTH;
  const goalLineL = goalLRight - GOAL_LINE_INSET;
  const goalLineR = goalRLeft + GOAL_LINE_INSET;
  const field = {
    width,
    height: FIELD_HEIGHT,
    ceiling: CEILING,
    playerWidth: PLAYER_WIDTH,
    playerHeight: PLAYER_HEIGHT,
    goalLLeft,
    goalLRight,
    goalRLeft,
    goalRRight,
    goalLineL,
    goalLineR,
    goalMouthYMin: GOAL_MOUTH_Y_MIN,
    goalMouthYMax: GOAL_MOUTH_Y_MAX,
    goalMouthZMax: GOAL_MOUTH_Z,
    midX: width / 2,
    aiLimitL: goalLLeft + GOAL_LINE_INSET,
    aiLimitR: goalRRight - GOAL_LINE_INSET,
  };
  // Precomputed goal-box AABBs — read on every physics tick for
  // player + ball collisions. Freezing them here kills ~6 object
  // allocations per tick that used to happen inside `goalBox(f, side)`.
  // `roofBackX` is the x of the upper-rear edge — where the flat
  // roof meets the slanted back net.
  field.goalBoxLeft = {
    minX: goalLLeft, maxX: goalLineL,
    minY: GOAL_MOUTH_Y_MIN, maxY: GOAL_MOUTH_Y_MAX,
    minZ: 0, maxZ: GOAL_MOUTH_Z,
    roofBackX: goalLineL + (goalLLeft - goalLineL) * ROOF_FRACTION,
  };
  field.goalBoxRight = {
    minX: goalLineR, maxX: goalRRight,
    minY: GOAL_MOUTH_Y_MIN, maxY: GOAL_MOUTH_Y_MAX,
    minZ: 0, maxZ: GOAL_MOUTH_Z,
    roofBackX: goalLineR + (goalRRight - goalLineR) * ROOF_FRACTION,
  };
  // Goal sensors — thin AABB slabs at each goal line spanning the full
  // mouth aperture (post-to-post, floor-to-crossbar; no insets, since
  // the post / crossbar cylinders physically deflect any contact-touching
  // trajectory). The sensor's *front face* sits exactly on the goal
  // line; the *back face* is GOAL_SENSOR_DEPTH units inside the goal.
  // A goal scores when the ball's trailing edge has fully crossed the
  // back face — see physics/ball.js::ballFullyCrossedSensor.
  field.goalSensorLeft = {
    minX: goalLineL - GOAL_SENSOR_DEPTH,
    maxX: goalLineL,
    minY: GOAL_MOUTH_Y_MIN, maxY: GOAL_MOUTH_Y_MAX,
    minZ: 0, maxZ: GOAL_MOUTH_Z,
  };
  field.goalSensorRight = {
    minX: goalLineR,
    maxX: goalLineR + GOAL_SENSOR_DEPTH,
    minY: GOAL_MOUTH_Y_MIN, maxY: GOAL_MOUTH_Y_MAX,
    minZ: 0, maxZ: GOAL_MOUTH_Z,
  };
  return field;
}

// Kickoff spawn x for a given side.
export function kickoffSpawnX(field, side) {
  const sign = side === 'left' ? -1 : +1;
  return field.midX + sign * STARTING_GAP - field.playerWidth / 2;
}

function initPlayer(p, side, field) {
  const x = kickoffSpawnX(field, side);
  p.side = side;
  p.x = x; p.y = FIELD_HEIGHT / 2;
  p.vx = 0; p.vy = 0;
  p.pushVx = 0; p.pushVy = 0;
  p.stamina = 1;
  p.exhausted = false;
  const kick = p.kick;
  kick.active = false;
  kick.kind = 'ground';
  kick.stage = 'windup';
  kick.timer = 0;
  kick.airZ = 0;
  kick.fired = false;
  kick.dx = 0; kick.dy = 0; kick.dz = 0;
  kick.power = 0;
  kick.footTargetX = 0; kick.footTargetY = 0; kick.footTargetZ = 0;
  p.pushTimer = 0;
  p.pushTargetX = 0; p.pushTargetY = 0; p.pushTargetZ = 0;
  p.pushArm = 'right';
  p.pushType = 'jab';
  p.pendingPushVictim = null;
  p.pendingPushVx = 0;
  p.pendingPushVy = 0;
  p.reactTimer = 0;
  p.reactForce = 0;
  p.reactDirX = 0;
  p.reactDirZ = 0;
  p.reactType = 'jab';
  p.reactLatSign = 1;
  p.heading = side === 'left' ? 0 : Math.PI;
  p.prevTargetDirX = 0;
  p.prevTargetDirY = 0;
  p.airZ = 0;
  return p;
}

function createPlayer(side, field) {
  return initPlayer({ kick: {} }, side, field);
}

/**
 * Re-initialize an existing state for a new match, without allocating
 * any new objects. The ball, p1, p2 (and their kick sub-objects), and
 * the events array are all mutated in place. Field + rng can be swapped
 * at will. Avoids per-match allocation so a long-running showcase loop
 * stays heap-stable.
 */
export function resetStateInPlace(state, field, rng) {
  state.field = field;
  state.rng = rng;
  const ball = state.ball;
  ball.x = field.midX; ball.y = FIELD_HEIGHT / 2;
  ball.vx = 0; ball.vy = 0;
  ball.z = RESPAWN_DROP_Z; ball.vz = 0;
  ball.frozen = false;
  ball.inGoal = false;
  initPlayer(state.p1, 'left', field);
  initPlayer(state.p2, 'right', field);
  state.scoreL = 0;
  state.scoreR = 0;
  state.tick = 0;
  state.graceFrames = RESPAWN_GRACE;
  state.lastKickTick = 0;
  state.stallCount = 0;
  state.pauseState = null;
  state.pauseTimer = 0;
  state.matchEndPhase = null;
  state.goalScorer = null;
  state.matchOver = false;
  state.winner = null;
  state.pairContactTicks = 0;
  state.events.length = 0;
  state.recordEvents = false;
  state.headless = false;
  return state;
}

/**
 * Create a fresh game state. Default rng is a seeded LCG with seed 0 so
 * accidentally-unseeded callers get a reproducible stream. recordEvents
 * is false by default — tests opt in to collect state.events; the visual
 * showcase enables it for renderer particle hooks.
 */
export function createState(field, rng = createSeededRng(0)) {
  const state = {
    field: null,
    rng: null,
    ball: {
      x: 0, y: 0,
      vx: 0, vy: 0,
      z: 0, vz: 0,
      frozen: false,
      inGoal: false,
    },
    p1: createPlayer('left', field),
    p2: createPlayer('right', field),
    scoreL: 0,
    scoreR: 0,
    tick: 0,
    graceFrames: 0,
    lastKickTick: 0,
    stallCount: 0,
    pauseState: null, // null | 'celebrate' | 'matchend' | 'reposition' | 'waiting'
    pauseTimer: 0,
    matchEndPhase: null, // 'reposition' | 'pose' | 'neutral' under pauseState='matchend'
    goalScorer: null,
    matchOver: false,
    winner: null,
    pairContactTicks: 0,
    events: [],
    recordEvents: false,
    headless: false,
  };
  resetStateInPlace(state, field, rng);
  return state;
}

/* ── Seeded PRNG (LCG, Numerical Recipes params) ──────────────── */

export function createSeededRng(seed) {
  let state = (seed >>> 0) || 1;
  return function rng() {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

export function gaussRandom(rng) {
  const u1 = rng() || 1e-10;
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/* ── Tiny math helpers shared across the physics modules ──────── */

export function clamp(v, lo, hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}

/** Wrap an angle into (-π, π]. Apply after subtracting two angles to
 *  get the shortest-arc signed difference. */
export function wrapAngle(a) {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a <= -Math.PI) a += 2 * Math.PI;
  return a;
}
