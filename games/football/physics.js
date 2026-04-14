/**
 * Football v2 — pure physics module.
 *
 * No DOM. No three.js. No setTimeout / Date.now / requestAnimationFrame.
 * No wall-clock references of any kind. The caller owns cadence — the
 * showcase loop calls tick() once per animation frame; the training worker
 * calls it in a tight loop for maximum throughput. Determinism relies on
 * the caller passing a seeded PRNG into createState() or the optional
 * `rng` argument of tick().
 *
 * Ported from v1 engine.js with four bug fixes:
 *   1. Stamina is charged against *actual per-tick displacement*, not NN
 *      output magnitude. Closes the sliding-without-drain exploit.
 *   2. Player bodies cannot penetrate the goal frame. Closes goal camping.
 *   3. Push attempts always return a structured result. No silent rejects.
 *   4. Ball OOB is checked before goal-line, in strict order, and the ball
 *      is frozen on either event so it can't re-score the next tick.
 */

/* ── Constants ────────────────────────────────────────────────── */

// Logical field (NN-normalization reference). The renderer projects these
// to screen coordinates; physics never cares about pixels.
export const FIELD_WIDTH_REF = 900;
export const FIELD_HEIGHT = 42;
export const CEILING = 100;

// Timing
export const TICK_MS = 16; // ~60 Hz, caller-enforced
const STALL_TICKS = Math.ceil(10000 / TICK_MS); // 10s without a kick → respawn ball

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
const BALL_RADIUS = 4;
const RESPAWN_DROP_Z = 60;
const OUT_OF_BOUNDS_MARGIN = 50;

// Player movement
export const MAX_PLAYER_SPEED = 10;
const PLAYER_INERTIA = 0.7; // 0 = instant response, 1 = frozen
const MOVE_THRESHOLD = 0.1;
const STARTING_GAP = 40;
const PLAYER_WIDTH = 18; // 3 chars × 6 px
const PLAYER_HEIGHT = 6; // ~1.8 text rows × 3.3 px/row
const MIN_SPEED_STAMINA = 0.3; // stamina floor for speed scaling

// Stamina
const STAMINA_REGEN = 0.005; // per tick, always
const STAMINA_MOVE_BASE = 0.003; // flat per tick when displacement > threshold
const STAMINA_MOVE_PER_UNIT = 0.00036; // per unit of displacement
const STAMINA_MOVE_THRESHOLD = 0.1; // displacement below this is "not moving"
const DIRECTION_CHANGE_DRAIN = 0.02; // on velocity-direction reversal
const STAMINA_EXHAUSTION_THRESHOLD = 0.5; // recovery target while exhausted
const STAMINA_KICK_DRAIN = 0.3; // max drain on a full-power kick
const STAMINA_AIRKICK_DRAIN = 0.1; // flat cost for airkick launch

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
const KICK_WINDUP_MS = 96; // 6 ticks; v1: WALK_ANIM_BASE * TICK
const KICK_RECOVERY_MS = 288; // 18 ticks; v1: 3 * WALK_ANIM_BASE * TICK
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
const PUSH_STAMINA_COST = 0.15; // at full power
const PUSH_VICTIM_STAMINA_MULT = 3;

// Goal frame (AABB per goal — simpler than v1's per-character ASCII hitboxes)
const GOAL_BACK_OFFSET = 30; // distance from field edge to goal back wall
const GOAL_DEPTH = 54; // goal width (9 chars × 6 px)
const GOAL_MOUTH_Z = 20; // crossbar height in world units (z axis)
const GOAL_MOUTH_Y_MIN = (FIELD_HEIGHT - 20) / 2; // center the mouth vertically
const GOAL_MOUTH_Y_MAX = (FIELD_HEIGHT + 20) / 2;

// Match
export const WIN_SCORE = 3;
const CELEBRATE_TICKS = Math.ceil(1500 / TICK_MS);
const MATCHEND_PAUSE_TICKS = Math.ceil(3000 / TICK_MS);
const RESPAWN_GRACE = 30; // ticks after ball reset before goals can score
const REPOSITION_SPEED = 6;
const REPOSITION_TOL = 5;
const RESPAWN_DELAY_TICKS = Math.ceil(300 / TICK_MS);

/* ── Field config ─────────────────────────────────────────────── */

/**
 * Build a field description. All coordinates are in logical world units.
 * `width` defaults to FIELD_WIDTH_REF; passing a different width lets the
 * renderer scale, but NN inputs are always normalized to FIELD_WIDTH_REF
 * via buildInputs().
 */
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
    // Goal bounding boxes (AABB in the x-y plane)
    goalLLeft,
    goalLRight,
    goalRLeft,
    goalRRight,
    // Goal lines: ball crosses these to score
    goalLineL: goalLRight - 6, // slightly inside the mouth
    goalLineR: goalRLeft + 6,
    // Goal mouth vertical extent (y axis, not z)
    goalMouthYMin: GOAL_MOUTH_Y_MIN,
    goalMouthYMax: GOAL_MOUTH_Y_MAX,
    goalMouthZMax: GOAL_MOUTH_Z,
    // Center of field (x)
    midX: width / 2,
    // AI positioning limits (not used by physics but exported for NN inputs)
    aiLimitL: goalLLeft + 6,
    aiLimitR: goalRRight - 6,
  };
}

/* ── State factories ─────────────────────────────────────────── */

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
    // Kick state machine — null when idle, otherwise a kick in progress
    kick: null, // { phase: 'windup'|'airkick'|'recovery', timer, airZ, fired, dx, dy, dz, power }
    pushTimer: 0, // ms; blocks new actions while pushing
    // Facing direction, updated on movement (for renderer only; physics ignores)
    dir: side === 'left' ? 1 : -1,
    // Air-kick jump state (affects hitbox z range during airkick)
    airZ: 0,
  };
}

/**
 * Create a fresh game state. `rng` is stored on the state so all downstream
 * physics calls use the same seeded generator. Defaults to Math.random.
 */
export function createState(field, rng = Math.random) {
  return {
    field,
    rng,
    ball: {
      x: field.midX, y: FIELD_HEIGHT / 2,
      vx: 0, vy: 0,
      z: RESPAWN_DROP_Z, vz: 0,
      frozen: false, // true after OOB or goal until reset; blocks re-scoring
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
  };
}

/* ── Gaussian noise (uses injected rng for determinism) ───────── */

function gaussRandom(rng) {
  const u1 = rng() || 1e-10;
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/* ── Main tick ────────────────────────────────────────────────── */

/**
 * Advance state by one physics tick. Mutates `state` in place and returns it.
 *
 * @param {object} state       — state returned by createState()
 * @param {number[]|null} p1Act — 9-float action vector for player 1, or null
 * @param {number[]|null} p2Act — same for player 2
 */
export function tick(state, p1Act, p2Act) {
  state.events = [];
  state.tick++;

  if (state.matchOver) return state;

  if (state.pauseState !== null) {
    advancePause(state);
    return state;
  }

  if (state.graceFrames > 0) state.graceFrames--;

  // Record pre-movement positions for stamina charge (fix #1)
  const pre1x = state.p1.x, pre1y = state.p1.y;
  const pre2x = state.p2.x, pre2y = state.p2.y;

  // Regen always happens first (matches v1 ordering)
  applyRegenAndExhaustion(state.p1);
  applyRegenAndExhaustion(state.p2);

  // Apply NN / fallback outputs
  if (p1Act) applyAction(state, state.p1, p1Act);
  if (p2Act) applyAction(state, state.p2, p2Act);

  // Push physics — pushVx/pushVy displace players outside of NN control
  applyPushPhysics(state.p1);
  applyPushPhysics(state.p2);

  // Clamp to field bounds AND collide with goal frames (fix #2)
  clampAndCollide(state, state.p1);
  clampAndCollide(state, state.p2);

  // Charge stamina against actual displacement (fix #1) — covers movement
  // from NN intent, push physics, and collision resolution in one rule.
  chargeStaminaFromDisplacement(state.p1, pre1x, pre1y);
  chargeStaminaFromDisplacement(state.p2, pre2x, pre2y);

  // Ball physics (motion + wall bounces + goal frame bounce)
  updateBall(state);

  // Authoritative OOB → goal ordering check, runs unconditionally so a ball
  // that comes to rest past the boundary still triggers ballOut.
  checkBallScoreOrOut(state);

  // Stall detection — if no kick for 10s, reset ball to center
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

/* ── Action application ──────────────────────────────────────── */

function applyAction(state, p, out) {
  // Exhausted players can't act — they stand still and wait for recovery
  if (p.exhausted) { p.vx = 0; p.vy = 0; return; }

  // Advance any in-flight kick first; kicking players ignore new input
  if (advanceKick(state, p)) return;

  // Push animation lockout
  if (p.pushTimer > 0) {
    p.pushTimer -= TICK_MS;
    if (p.pushTimer < 0) p.pushTimer = 0;
    return;
  }

  const [moveX, moveY, kick, kickDx, kickDy, kickDz, kickPower, push, pushPower] = out;

  applyMovement(state, p, moveX, moveY);

  // Push attempt
  if (push > 0) {
    const opp = p === state.p1 ? state.p2 : state.p1;
    tryPush(state, p, opp, pushPower);
  }

  // Kick attempt
  if (kick > 0 && canKick(state, p)) {
    startKick(state, p, kickDx, kickDy, kickDz, kickPower);
  }
}

/* ── Movement ─────────────────────────────────────────────────── */

function applyMovement(state, p, moveX, moveY) {
  const effSpeed = MAX_PLAYER_SPEED * Math.max(MIN_SPEED_STAMINA, p.stamina);
  let targetVx = clamp(moveX, -1, 1) * effSpeed;
  let targetVy = clamp(moveY, -1, 1) * effSpeed;

  // Block movement into boundaries
  if ((p.y <= 0 && targetVy < 0) || (p.y >= FIELD_HEIGHT && targetVy > 0)) {
    targetVy = 0; p.vy = 0;
  }
  if ((p.x <= 0 && targetVx < 0) || (p.x >= state.field.width - state.field.playerWidth && targetVx > 0)) {
    targetVx = 0; p.vx = 0;
  }

  // Direction-reversal drain (kept from v1)
  if (p.vx * targetVx < 0 || p.vy * targetVy < 0) {
    p.stamina = Math.max(0, p.stamina - DIRECTION_CHANGE_DRAIN);
  }

  // Inertia blending
  const blend = 1 - PLAYER_INERTIA;
  p.vx += (targetVx - p.vx) * blend;
  p.vy += (targetVy - p.vy) * blend;

  // Only commit movement if the resulting velocity exceeds the floor
  const speed = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
  if (speed > MOVE_THRESHOLD) {
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

/* ── Stamina from displacement (fix #1) ──────────────────────── */

function chargeStaminaFromDisplacement(p, preX, preY) {
  const dx = p.x - preX;
  const dy = p.y - preY;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist < STAMINA_MOVE_THRESHOLD) return;
  p.stamina -= STAMINA_MOVE_BASE + STAMINA_MOVE_PER_UNIT * dist;
  if (p.stamina < 0) p.stamina = 0;
}

/* ── Clamp and collide (fix #2) ──────────────────────────────── */

function clampAndCollide(state, p) {
  const f = state.field;
  const pw = f.playerWidth;
  // Field bounds
  if (p.x < 0) p.x = 0;
  if (p.x > f.width - pw) p.x = f.width - pw;
  if (p.y < 0) p.y = 0;
  if (p.y > FIELD_HEIGHT) p.y = FIELD_HEIGHT;

  // Goal-frame collision — players cannot enter either goal box, from any
  // direction. AABB overlap test + axis-of-least-penetration resolution.
  // Left goal box: x ∈ [goalLLeft, goalLRight], y ∈ [goalMouthYMin, goalMouthYMax]
  resolveGoalCollision(p, pw, f.goalLLeft, f.goalLRight, f);
  resolveGoalCollision(p, pw, f.goalRLeft, f.goalRRight, f);
}

function resolveGoalCollision(p, pw, gxL, gxR, f) {
  const pxL = p.x;
  const pxR = p.x + pw;
  if (pxR <= gxL || pxL >= gxR) return;
  if (p.y + PLAYER_HEIGHT <= f.goalMouthYMin || p.y >= f.goalMouthYMax) return;

  // Compute shortest axis to push out. Prefer x-axis (pushes player out of
  // the goal mouth sideways), fall back to y-axis only if x-push is larger.
  const pushLeft = pxR - gxL; // move player left by this to clear
  const pushRight = gxR - pxL; // move player right by this to clear
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
  if (p.kick !== null) return false;
  const f = state.field;
  const center = p.x + f.playerWidth / 2;
  const closeX = Math.abs(state.ball.x - center) < f.playerWidth * KICK_REACH_X_MULT;
  const closeY = Math.abs(state.ball.y - p.y) < KICK_REACH_Y;
  return closeX && closeY;
}

function startKick(state, p, dx, dy, dz, power) {
  const kickDx = clamp(dx, -1, 1);
  const kickDy = clamp(dy, -1, 1);
  const kickDz = clamp(dz, -1, 1);
  const kickPower = (clamp(power, -1, 1) + 1) / 2; // map [-1,1] → [0,1]

  if (dz > 0.5) {
    // Airkick — player jumps
    const jumpFrac = (dz - 0.5) * 2;
    p.kick = {
      phase: 'airkick',
      timer: 0,
      airZ: jumpFrac * AIRKICK_MAX_Z,
      fired: false,
      dx: kickDx, dy: kickDy, dz: kickDz,
      power: kickPower,
    };
    p.stamina = Math.max(0, p.stamina - STAMINA_AIRKICK_DRAIN);
  } else {
    p.kick = {
      phase: 'windup',
      timer: 0,
      airZ: 0,
      fired: false,
      dx: kickDx, dy: kickDy, dz: kickDz,
      power: kickPower,
    };
  }
}

/** Returns true if the player is mid-kick and should not accept new outputs. */
function advanceKick(state, p) {
  if (p.kick === null) return false;
  p.kick.timer += TICK_MS;

  if (p.kick.phase === 'airkick') {
    const phase = Math.min(p.kick.timer / AIRKICK_MS, 1);
    p.airZ = Math.sin(phase * Math.PI) * p.kick.airZ;
    if (!p.kick.fired && phase >= AIRKICK_PEAK_FRAC) {
      p.kick.fired = true;
      executeKick(state, p);
    }
    if (phase >= 1) {
      p.airZ = 0;
      p.kick = null;
    }
    return true;
  }

  // Ground kick: windup → fire → recovery → idle
  if (!p.kick.fired && p.kick.timer >= KICK_WINDUP_MS) {
    p.kick.fired = true;
    executeKick(state, p);
  }
  if (p.kick.timer >= KICK_RECOVERY_MS) {
    p.kick = null;
  }
  return true;
}

function executeKick(state, p) {
  const f = state.field;
  const ball = state.ball;
  const which = p === state.p1 ? 'p1' : 'p2';
  const isAirkick = p.kick.phase === 'airkick';

  // Whiff check: airkick with ball on ground, or ground-kick with ball too high
  if (isAirkick && ball.z <= 1) {
    state.events.push({ type: 'kick_missed', player: which, reason: 'airkick_ground_ball' });
    return;
  }
  if (!isAirkick && ball.z > PLAYER_HEIGHT) {
    state.events.push({ type: 'kick_missed', player: which, reason: 'ground_kick_high_ball' });
    return;
  }

  // Airkick range check (wider than ground kick)
  if (isAirkick) {
    const center = p.x + f.playerWidth / 2;
    const reachX = f.playerWidth * AIRKICK_REACH_X_MULT;
    if (Math.abs(ball.x - center) > reachX || Math.abs(ball.y - p.y) > AIRKICK_REACH_Y) {
      state.events.push({ type: 'kick_missed', player: which, reason: 'airkick_out_of_range' });
      return;
    }
  }

  const rawPower = Math.max(MIN_KICK_POWER, p.kick.power);
  const effectiveMaxPower = MAX_KICK_POWER * Math.max(MIN_KICK_STAMINA, p.stamina);
  const force = rawPower * effectiveMaxPower;

  let dx = p.kick.dx;
  let dy = p.kick.dy;
  let dz = p.kick.dz;

  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (len < KICK_DIR_MIN_LEN) {
    // NN didn't commit to a direction — pick one deterministically from state.rng
    dx = state.rng() * 2 - 1;
    dy = state.rng() * 2 - 1;
    dz = state.rng() * 0.5;
    const rlen = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    dx /= rlen; dy /= rlen; dz /= rlen;
  } else {
    dx /= len; dy /= len; dz /= len;
  }

  // Accuracy noise (quadratic in power — low-power kicks are accurate)
  const noise = rawPower * rawPower * KICK_NOISE_SCALE;
  dx += gaussRandom(state.rng) * noise;
  dy += gaussRandom(state.rng) * noise;
  dz += gaussRandom(state.rng) * noise * KICK_NOISE_VERT;
  const len2 = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
  dx /= len2; dy /= len2; dz /= len2;

  ball.vx = dx * force;
  ball.vy = dy * force;
  ball.vz = Math.max(0, dz * force);
  ball.frozen = false;

  p.stamina = Math.max(0, p.stamina - STAMINA_KICK_DRAIN * rawPower);
  state.lastKickTick = state.tick;

  const ballSpeed = Math.sqrt(ball.vx * ball.vx + ball.vy * ball.vy);
  state.events.push({
    type: 'kick',
    player: which,
    power: rawPower,
    speed: ballSpeed,
    wasted: ballSpeed < WASTED_KICK_SPEED,
  });
}

/* ── Push (fix #3: always return structured result) ─────────── */

/**
 * Attempt a push. Returns { landed: true } on success, or
 * { landed: false, reason: string } on rejection. The caller can inspect
 * the reason; no silent rejects.
 */
function tryPush(state, pusher, victim, powerNorm) {
  const f = state.field;
  const ca = pusher.x + f.playerWidth / 2;
  const cb = victim.x + f.playerWidth / 2;

  if (pusher.kick !== null) {
    return { landed: false, reason: 'pusher_kicking' };
  }
  if (pusher.pushTimer > 0) {
    return { landed: false, reason: 'pusher_cooldown' };
  }
  if (Math.abs(ca - cb) > PUSH_RANGE_X) {
    return { landed: false, reason: 'out_of_range_x' };
  }
  if (Math.abs(pusher.y - victim.y) > PUSH_RANGE_Y) {
    return { landed: false, reason: 'out_of_range_y' };
  }

  const power01 = (clamp(powerNorm, -1, 1) + 1) / 2;
  const effectiveMaxPush = MAX_PUSH_FORCE * Math.max(MIN_PUSH_STAMINA, pusher.stamina);
  const force = power01 * effectiveMaxPush;

  pusher.dir = ca < cb ? 1 : -1;
  pusher.pushTimer = PUSH_ANIM_MS;

  victim.pushVx = pusher.dir * force;
  victim.pushVy = (state.rng() - 0.5) * force * 0.5;

  pusher.stamina = Math.max(0, pusher.stamina - PUSH_STAMINA_COST * power01);
  victim.stamina = Math.max(0, victim.stamina - PUSH_STAMINA_COST * power01 * PUSH_VICTIM_STAMINA_MULT);

  const pusherWhich = pusher === state.p1 ? 'p1' : 'p2';
  state.events.push({ type: 'push', pusher: pusherWhich, force });
  return { landed: true, force };
}

/* ── Ball physics ─────────────────────────────────────────────── */

function updateBall(state) {
  const ball = state.ball;
  if (ball.frozen) return;

  const moving = ball.vx * ball.vx > 0 || ball.vy * ball.vy > 0 || ball.z > 0 || ball.vz > 0;
  if (!moving) return;

  ball.x += ball.vx;
  ball.y += ball.vy;

  const friction = ball.z > 0 ? AIR_FRICTION : GROUND_FRICTION;
  ball.vx *= friction;
  ball.vy *= friction;

  // Air physics
  if (ball.z > 0 || ball.vz > 0) {
    ball.vz -= GRAVITY;
    ball.z += ball.vz;
    if (ball.z <= 0) {
      ball.z = 0;
      ball.vz = Math.abs(ball.vz) > BOUNCE_VZ_MIN ? Math.abs(ball.vz) * AIR_BOUNCE : 0;
    }
  }

  // Field Y bounds (walls on the long sides)
  if (ball.y < 0) { ball.y = 0; ball.vy = Math.abs(ball.vy) * WALL_BOUNCE_DAMP; }
  if (ball.y > FIELD_HEIGHT) { ball.y = FIELD_HEIGHT; ball.vy = -Math.abs(ball.vy) * WALL_BOUNCE_DAMP; }

  // Ceiling
  if (ball.z > CEILING) {
    ball.z = CEILING;
    ball.vz = -Math.abs(ball.vz) * AIR_BOUNCE;
  }

  // Velocity cutoff
  if (ball.vx * ball.vx < BALL_VEL_CUTOFF_SQ) ball.vx = 0;
  if (ball.vy * ball.vy < BALL_VEL_CUTOFF_SQ) ball.vy = 0;
}

/* ── OOB and goal check (fix #4: strict ordering) ───────────── */

function checkBallScoreOrOut(state) {
  const f = state.field;
  const ball = state.ball;
  if (ball.frozen) return;

  // STEP 1: OOB check first. If the ball has exited the playing area
  // (past either back wall by the margin), it's out; freeze and return
  // before the goal-line check can see it.
  if (ball.x < -OUT_OF_BOUNDS_MARGIN || ball.x > f.width + OUT_OF_BOUNDS_MARGIN) {
    ballOut(state);
    return;
  }

  // STEP 2: Grace frames after respawn block scoring (prevents insta-goals)
  if (state.graceFrames > 0) return;

  // STEP 3: Goal-line check. Only runs if ball is inside the playable area
  // AND hasn't been frozen by OOB in step 1. Goal requires:
  //  (a) ball crosses the goal line (past goalLineL or goalLineR)
  //  (b) ball is inside the goal mouth Y range
  //  (c) ball is below the crossbar (z)
  const crossedL = ball.x < f.goalLineL;
  const crossedR = ball.x > f.goalLineR;
  if (!crossedL && !crossedR) return;

  const withinY = ball.y >= f.goalMouthYMin && ball.y <= f.goalMouthYMax;
  const belowCrossbar = ball.z <= f.goalMouthZMax;

  if (withinY && belowCrossbar) {
    scoreGoal(state, crossedL ? 'left' : 'right');
    return;
  }

  // Past the goal line but not a valid goal — the ball has hit the goal
  // frame. Bounce it back into the field instead of marking it OOB. The
  // ball can only pass through the mouth (low z, within mouth Y range).
  //
  //   - If ball is outside the mouth Y range: hit a goal post / side wall
  //   - If ball is above the crossbar: hit the crossbar from below
  // In both cases, reverse the x velocity and push the ball back past
  // the line so it can't re-trigger the check next tick.
  const line = crossedL ? f.goalLineL : f.goalLineR;
  const sign = crossedL ? 1 : -1; // +1 = push ball to +x (right), -1 = push to -x
  ball.x = line + sign * (BALL_RADIUS + 1);
  if (ball.vx * sign < 0) {
    ball.vx = -ball.vx * BOUNCE_RETAIN;
  }

  // If the ball is above the crossbar, give it a downward kick too, so
  // crossbar-hits send the ball back down into the field
  if (!belowCrossbar && ball.vz > 0) {
    ball.vz = -ball.vz * BOUNCE_RETAIN;
  }
}

/* ── Scoring / ball-out / reset ──────────────────────────────── */

function scoreGoal(state, side) {
  state.ball.frozen = true;
  state.ball.vx = 0;
  state.ball.vy = 0;
  state.ball.vz = 0;
  state.pauseState = 'celebrate';
  state.pauseTimer = CELEBRATE_TICKS;

  if (side === 'left') {
    // Ball went into the LEFT goal, so RIGHT scored
    state.scoreR++;
    state.goalScorer = state.p2;
    state.events.push({ type: 'goal', scorer: 'p2' });
  } else {
    state.scoreL++;
    state.goalScorer = state.p1;
    state.events.push({ type: 'goal', scorer: 'p1' });
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
  state.events.push({ type: 'out' });
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

function resetPlayer(state, p) {
  const f = state.field;
  p.x = p.side === 'left'
    ? f.midX - STARTING_GAP - f.playerWidth / 2
    : f.midX + STARTING_GAP - f.playerWidth / 2;
  p.y = FIELD_HEIGHT / 2;
  p.vx = 0;
  p.vy = 0;
  p.pushVx = 0;
  p.pushVy = 0;
  p.stamina = 1;
  p.exhausted = false;
  p.kick = null;
  p.pushTimer = 0;
  p.airZ = 0;
  p.dir = p.side === 'left' ? 1 : -1;
}

function resetMatch(state) {
  state.scoreL = 0;
  state.scoreR = 0;
  resetPlayer(state, state.p1);
  resetPlayer(state, state.p2);
  resetBall(state);
  state.pauseState = null;
  state.pauseTimer = 0;
  state.goalScorer = null;
  state.matchOver = true;
}

/* ── Pause state machine ──────────────────────────────────────── */

function advancePause(state) {
  if (state.pauseState === 'matchend') {
    state.pauseTimer--;
    if (state.pauseTimer <= 0) resetMatch(state);
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
    // Linear interpolation back to starting positions. Players don't take
    // input, stamina regens (handled by the normal regen path would require
    // entering the main tick body, which we skip when paused; apply directly).
    const f = state.field;
    state.p1.stamina = Math.min(1, state.p1.stamina + STAMINA_REGEN);
    state.p2.stamina = Math.min(1, state.p2.stamina + STAMINA_REGEN);
    for (const p of [state.p1, state.p2]) {
      const tx = p.side === 'left'
        ? f.midX - STARTING_GAP - f.playerWidth / 2
        : f.midX + STARTING_GAP - f.playerWidth / 2;
      const ty = FIELD_HEIGHT / 2;
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
    if (
      Math.abs(state.p1.x - (f.midX - STARTING_GAP - f.playerWidth / 2)) < REPOSITION_TOL &&
      Math.abs(state.p2.x - (f.midX + STARTING_GAP - f.playerWidth / 2)) < REPOSITION_TOL
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

/* ── NN input builder ────────────────────────────────────────── */

/**
 * Build the 18-dim NN input vector for one player, normalized to [-1, 1].
 * Ported verbatim from v1 engine.buildInputs with state-shape adjustments.
 * The Python port in evolution/physics_py.py must produce identical outputs.
 */
export function buildInputs(state, which) {
  const out = new Array(18);
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

/* ── Seeded PRNG (LCG) for deterministic tests ───────────────── */

/**
 * Create a seeded pseudo-random generator. Returns a function that
 * produces floats in [0, 1). Numerical Recipes LCG parameters.
 * Deterministic across runs for a given seed.
 */
export function createSeededRng(seed) {
  let state = (seed >>> 0) || 1;
  return function rng() {
    // Numerical Recipes LCG: a = 1664525, c = 1013904223, m = 2^32
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/* ── Helpers ──────────────────────────────────────────────────── */

function clamp(v, lo, hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}
