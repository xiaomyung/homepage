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
export const FIELD_HEIGHT = 42;
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
export const BALL_RADIUS = 6;
const RESPAWN_DROP_Z = 60;
const OUT_OF_BOUNDS_MARGIN = 50;

// Player movement
export const MAX_PLAYER_SPEED = 10;
const PLAYER_INERTIA = 0.7;
const MOVE_THRESHOLD = 0.1;
const MOVE_THRESHOLD_SQ = MOVE_THRESHOLD * MOVE_THRESHOLD;
const STARTING_GAP = 40;
const PLAYER_WIDTH = 18;
export const PLAYER_HEIGHT = 6;
const MIN_SPEED_STAMINA = 0.3;

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
const KICK_REACH_X_MULT = 1.0;
const KICK_REACH_Y = 16;
const AIRKICK_REACH_X_MULT = 1.5;
const AIRKICK_REACH_Y = 24;
const AIRKICK_MAX_Z = 20;
const AIRKICK_MS = 350;
const AIRKICK_PEAK_FRAC = 0.4;
const AIRKICK_DZ_THRESHOLD = 0.5;
const KICK_WINDUP_MS = 96;
const KICK_RECOVERY_MS = 288;
const KICK_DIR_MIN_LEN = 0.01;
const WASTED_KICK_SPEED = MIN_KICK_POWER * 0.1;

// Push
const PUSH_RANGE_X = 30;
const PUSH_RANGE_Y = 20;
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
const GOAL_DEPTH = 54;
const GOAL_LINE_INSET = 6; // scoring line sits this far inside the mouth
const GOAL_MOUTH_Z = 20;
const GOAL_MOUTH_Y_MIN = (FIELD_HEIGHT - 20) / 2;
const GOAL_MOUTH_Y_MAX = (FIELD_HEIGHT + 20) / 2;

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
    dir: side === 'left' ? 1 : -1,
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

  if (p.vx * targetVx < 0 || p.vy * targetVy < 0) {
    p.stamina = Math.max(0, p.stamina - DIRECTION_CHANGE_DRAIN);
  }

  const blend = 1 - PLAYER_INERTIA;
  p.vx += (targetVx - p.vx) * blend;
  p.vy += (targetVy - p.vy) * blend;

  const speedSq = p.vx * p.vx + p.vy * p.vy;
  if (speedSq > MOVE_THRESHOLD_SQ) {
    p.x += p.vx;
    p.y += p.vy;
    p.dir = p.vx > 0 ? 1 : -1;
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

/* ── Field bounds & goal-frame collision ─────────────────────── */

function clampPlayerToField(p, f) {
  if (p.x < 0) p.x = 0;
  else if (p.x > f.width - f.playerWidth) p.x = f.width - f.playerWidth;
  if (p.y < 0) p.y = 0;
  else if (p.y > FIELD_HEIGHT - PLAYER_HEIGHT) p.y = FIELD_HEIGHT - PLAYER_HEIGHT;
}

function clampAndCollide(state, p) {
  const f = state.field;
  clampPlayerToField(p, f);
  resolveGoalCollision(p, f.playerWidth, f.goalLLeft, f.goalLRight, f);
  resolveGoalCollision(p, f.playerWidth, f.goalRLeft, f.goalRRight, f);
  // The goal-frame resolution can push a player past a field edge (notably
  // the right goal → right wall). Re-clamp so the body stays fully inside.
  clampPlayerToField(p, f);
}

function resolveGoalCollision(p, pw, gxL, gxR, f) {
  const pxL = p.x;
  const pxR = p.x + pw;
  if (pxR <= gxL || pxL >= gxR) return;
  if (p.y + PLAYER_HEIGHT <= f.goalMouthYMin || p.y >= f.goalMouthYMax) return;

  const pushLeft = pxR - gxL;
  const pushRight = gxR - pxL;
  const pushUp = p.y + PLAYER_HEIGHT - f.goalMouthYMin;
  const pushDown = f.goalMouthYMax - p.y;

  const xPush = Math.min(pushLeft, pushRight);
  const yPush = Math.min(pushUp, pushDown);

  if (xPush <= yPush) {
    p.x += pushLeft <= pushRight ? -pushLeft : pushRight;
    p.vx = 0;
    p.pushVx = 0;
  } else {
    p.y += pushUp <= pushDown ? -pushUp : pushDown;
    p.vy = 0;
    p.pushVy = 0;
  }
}

/* ── Kick state machine ──────────────────────────────────────── */

function canKick(state, p) {
  if (p.kick.active) return false;
  const f = state.field;
  const center = p.x + f.playerWidth / 2;
  const closeX = Math.abs(state.ball.x - center) < f.playerWidth * KICK_REACH_X_MULT;
  const closeY = Math.abs(state.ball.y - p.y) < KICK_REACH_Y;
  return closeX && closeY;
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
  if (k.timer >= KICK_RECOVERY_MS) {
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
    const center = p.x + f.playerWidth / 2;
    const reachX = f.playerWidth * AIRKICK_REACH_X_MULT;
    if (Math.abs(ball.x - center) > reachX || Math.abs(ball.y - p.y) > AIRKICK_REACH_Y) {
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

  const power01 = (clamp(powerNorm, -1, 1) + 1) / 2;
  const force = power01 * MAX_PUSH_FORCE * Math.max(MIN_PUSH_STAMINA, pusher.stamina);

  pusher.dir = pusherCenterX < victimCenterX ? 1 : -1;
  pusher.pushTimer = PUSH_ANIM_MS;

  victim.pushVx = pusher.dir * force;
  victim.pushVy = (state.rng() - 0.5) * force * 0.5;

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
      ball.z = 0;
      ball.vz = Math.abs(ball.vz) > BOUNCE_VZ_MIN ? Math.abs(ball.vz) * AIR_BOUNCE : 0;
    }
  }

  // Ball body stays fully inside the top/bottom walls; bounces off.
  if (ball.y < BALL_RADIUS) {
    ball.y = BALL_RADIUS;
    ball.vy = Math.abs(ball.vy) * WALL_BOUNCE_DAMP;
  } else if (ball.y > FIELD_HEIGHT - BALL_RADIUS) {
    ball.y = FIELD_HEIGHT - BALL_RADIUS;
    ball.vy = -Math.abs(ball.vy) * WALL_BOUNCE_DAMP;
  }

  if (ball.z > CEILING) {
    ball.z = CEILING;
    ball.vz = -Math.abs(ball.vz) * AIR_BOUNCE;
  }

  if (ball.vx * ball.vx < BALL_VEL_CUTOFF_SQ) ball.vx = 0;
  if (ball.vy * ball.vy < BALL_VEL_CUTOFF_SQ) ball.vy = 0;
}

/* ── Goal / OOB detection ─────────────────────────────────────── */

function checkBallScoreOrOut(state) {
  const f = state.field;
  const ball = state.ball;
  if (ball.frozen) return;

  // Strict ordering: OOB → grace → goal. Freezing on either event keeps the
  // next tick from re-triggering.
  if (ball.x < -OUT_OF_BOUNDS_MARGIN || ball.x > f.width + OUT_OF_BOUNDS_MARGIN) {
    ballOut(state);
    return;
  }

  if (state.graceFrames > 0) return;

  const crossedL = ball.x < f.goalLineL;
  const crossedR = ball.x > f.goalLineR;
  if (!crossedL && !crossedR) return;

  // Goal requires the whole ball past the line AND the ball fully inside
  // the goal frame on all axes (between posts, below crossbar, not past the
  // back wall).
  const fullyPastL = ball.x + BALL_RADIUS <= f.goalLineL;
  const fullyPastR = ball.x - BALL_RADIUS >= f.goalLineR;
  const withinBoxLX = ball.x >= f.goalLLeft;
  const withinBoxRX = ball.x <= f.goalRRight;
  const withinMouthY = ball.y - BALL_RADIUS >= f.goalMouthYMin
                    && ball.y + BALL_RADIUS <= f.goalMouthYMax;
  const belowCrossbar = ball.z + BALL_RADIUS <= f.goalMouthZMax;

  const goalL = crossedL && fullyPastL && withinBoxLX && withinMouthY && belowCrossbar;
  const goalR = crossedR && fullyPastR && withinBoxRX && withinMouthY && belowCrossbar;

  if (goalL || goalR) {
    scoreGoal(state, goalL ? 'left' : 'right');
    return;
  }

  // Past the line but not a goal. If still in the mouth (y/z), the ball is
  // mid-cross — let it continue. Otherwise it hit a post/crossbar; bounce.
  if (withinMouthY && belowCrossbar) return;

  const line = crossedL ? f.goalLineL : f.goalLineR;
  const sign = crossedL ? 1 : -1;
  ball.x = line + sign * (BALL_RADIUS + 1);
  if (ball.vx * sign < 0) {
    ball.vx = -ball.vx * BOUNCE_RETAIN;
  }
  if (!belowCrossbar && ball.vz > 0) {
    ball.vz = -ball.vz * BOUNCE_RETAIN;
  }
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

/**
 * Build the 18-dim NN input vector for one player, normalized to [-1, 1].
 * The `out` parameter lets callers reuse a buffer and skip the per-tick
 * Array allocation. Must stay bit-identical to physics_py.py:build_inputs.
 */
export function buildInputs(state, which, out) {
  if (!out) out = new Array(18);
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

  for (let i = 0; i < 18; i++) {
    if (out[i] > 1) out[i] = 1;
    else if (out[i] < -1) out[i] = -1;
  }
  return out;
}

/* ── Helpers ──────────────────────────────────────────────────── */

function clamp(v, lo, hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}
