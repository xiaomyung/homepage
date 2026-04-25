/**
 * Football v2 — pure physics module.
 *
 * No DOM, no three.js, no wall-clock. The caller owns cadence: the showcase
 * loop calls tick() once per animation frame; training workers call it in a
 * tight loop. Determinism relies on the caller passing a seeded PRNG into
 * createState(); the bundled createSeededRng() is the canonical source.
 */

/* ── Constants ────────────────────────────────────────────────── */

export const FIELD_WIDTH_REF = 900;
export const FIELD_HEIGHT = 54.6;
const CEILING = 100;

export const TICK_MS = 16;
// Mercy rule — if no kick for STALL_MS wall-clock seconds, reset so
// the match doesn't sit motionless. Visual mode just respawns the
// ball; headless mode does a full kickoff (both players teleported)
// so every training segment starts from a clean, identical state.
// Single value for both so showcase replays (which run with
// state.headless=true for scoreGoal-determinism) reset on the same
// schedule the worker did — otherwise a worker match with a reset
// at t=187 ticks wouldn't reproduce if the visual replay waited
// until t=625 to reset.
const STALL_TICKS = Math.ceil(10000 / TICK_MS);

// Ball
export const GRAVITY = 0.3;
const AIR_FRICTION = 0.99;
const GROUND_FRICTION = 0.944;
const BOUNCE_RETAIN = 0.5;
const AIR_BOUNCE = 0.6;
const WALL_BOUNCE_DAMP = 0.5;
const BOUNCE_VZ_MIN = 1.5;
const BALL_VEL_CUTOFF = 0.1;
const BALL_VEL_CUTOFF_SQ = BALL_VEL_CUTOFF * BALL_VEL_CUTOFF;
// Single source of truth for the ball's physical + visual radius.
// Physics collisions (goal, walls, body, ground) and the rendered
// sphere both use this value so there is no drift between "where
// physics thinks the ball is touching" and "where you see it touch".
export const BALL_RADIUS = 4.224;
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
const MAX_KICK_POWER = 22;
const MIN_KICK_POWER = 0.15;
const MIN_KICK_STAMINA = 0.2;
const KICK_NOISE_SCALE = 0.3;
const KICK_NOISE_VERT = 0.5;
const AIRKICK_MAX_Z = 20;
export const AIRKICK_MS = 350;
export const AIRKICK_PEAK_FRAC = 0.5;
const AIRKICK_DZ_THRESHOLD = 0.5;
// Ground-kick timing: windup → strike window → recovery → idle.
// `KICK_WINDUP_MS` and `AIRKICK_PEAK_FRAC * AIRKICK_MS` mark the
// *start* of the strike phase (not the instant of impact); impact
// fires at the first tick inside the strike window on which the
// foot-contact sphere overlaps the ball.
export const KICK_WINDUP_MS = 96;
export const KICK_DURATION_MS = 288;
// Contact window: IK locks the foot target and runs a sphere-vs-
// ball overlap every tick. ~48 ms = 3 ticks — enough for the ball
// to move into or out of the frozen target but not so long that
// the strike feels slow. Air and ground kicks share the window.
export const KICK_STRIKE_WINDOW_MS = 48;
// Effective contact radius on the foot. Smaller than a real cleat
// but large enough that a ball within ~1.5 world units of the
// frozen foot target still registers a hit on the first tick.
export const FOOT_RADIUS = 1.5;
// Reachability gate: distance from the hip-anchor to the predicted
// ball at strike time must not exceed the full stretched leg. See
// `KICK_REACH_MAX` below — computed from the rig constants once
// they're declared.
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
const MAX_PUSH_FORCE = 200;
const PUSH_DAMP = 0.88;
const PUSH_APPLY = 0.12;
const PUSH_VEL_THRESHOLD = 0.5;
const PUSH_VEL_THRESHOLD_SQ = PUSH_VEL_THRESHOLD * PUSH_VEL_THRESHOLD;
const MIN_PUSH_STAMINA = 0.2;
export const PUSH_ANIM_MS = 1000;
// Victim's hit-reaction animation length. Independent of the pusher's
// PUSH_ANIM_MS; intentionally shorter because a punch reaction is a
// quick spike + recovery, not a full choreographed thrust.
export const REACT_ANIM_MS = 550;
// Sub-stage boundaries of the push animation as fractions of
// PUSH_ANIM_MS. Used by pushArmExtension + pushArmPose (arm blend)
// and by advancePush (strike commit).
const PUSH_WINDUP_FRAC = 0.35;   // windup → strike transition
const PUSH_STRIKE_FRAC = 0.50;   // strike → recover transition;
                                 //   pose blends WINDUP→STRIKE end
                                 //   here; arm at peak forward.
// Contact fraction per punch type — when the fist FIRST meets the
// target. Different types engage at different pair distances
// (uppercut PUSH_UPPERCUT_RANGE=14, hook <22, jab <PUSH_RANGE_X=30),
// so the arm must extend further for a jab than an uppercut. Longer
// throws land later in the WINDUP→STRIKE blend — closer to peak
// extension — while close-range uppercuts connect early.
const PUSH_CONTACT_FRAC = {
  jab:      0.47,
  hook:     0.46,
  uppercut: 0.42,
};
const PUSH_WINDUP_PEAK_TEFF = 0.7;
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
export const GOAL_POST_RADIUS = 1.2;
const GOAL_MOUTH_Z = 26;  // crossbar height (unchanged)
const GOAL_MOUTH_WIDTH = 28.6;  // z-span of the mouth (30% + another 10% wider than the original 20)
const GOAL_MOUTH_Y_MIN = (FIELD_HEIGHT - GOAL_MOUTH_WIDTH) / 2;
const GOAL_MOUTH_Y_MAX = (FIELD_HEIGHT + GOAL_MOUTH_WIDTH) / 2;

// Match
const WIN_SCORE = 3;
const CELEBRATE_TICKS = Math.ceil(1500 / TICK_MS);
const MATCHEND_PAUSE_TICKS = Math.ceil(3000 / TICK_MS);
const RESPAWN_GRACE = 30;
const REPOSITION_SPEED = 6;
const REPOSITION_TOL = 5;
const RESPAWN_DELAY_TICKS = Math.ceil(300 / TICK_MS);

/* ── Stickman rig constants (shared with renderer) ─────────────
 *
 * All rig proportions live here. `renderer.js` imports them so a
 * single change — e.g. bumping torso radius — is picked up by both
 * the drawn silhouette AND the physics ball-vs-body collider without
 * drift. Dimensions are in world units (y-up, same axis for physics
 * z and rendering y).
 */
export const STICKMAN_GLYPH_SIZE   = 22;
export const STICKMAN_HIP_OFX      = 0.12 * STICKMAN_GLYPH_SIZE;       // 2.64
export const STICKMAN_SHOULDER_OFX = 0.23814 * STICKMAN_GLYPH_SIZE;    // 5.2391 (~10.25% wider than the old 4.752)
export const STICKMAN_SHOULDER_OFY = 0.92 * STICKMAN_GLYPH_SIZE;       // 20.24
export const STICKMAN_HEAD_GAP_Y   = 0.0476 * STICKMAN_GLYPH_SIZE;    // 1.047 — head tucked close to the shoulders
export const STICKMAN_LIMB_FULL_H  = 20;                               // was 19.8; cleaner 10+10 split
export const STICKMAN_UPPER_LEG    = STICKMAN_LIMB_FULL_H / 2;         // 10
export const STICKMAN_LOWER_LEG    = STICKMAN_LIMB_FULL_H / 2;         // 10
export const STICKMAN_UPPER_ARM    = STICKMAN_LIMB_FULL_H / 2;         // 10
export const STICKMAN_LOWER_ARM    = STICKMAN_LIMB_FULL_H / 2;         // 10
export const STICKMAN_TORSO_RADIUS = 3.3;
export const STICKMAN_HEAD_RADIUS  = 4.0;
export const STICKMAN_LEG_RADIUS   = 2.2;
// Arms taper: upper 15% thicker than the forearm, matching rough
// human proportions. Used by the renderer's two-capsule-per-arm rig.
export const STICKMAN_LOWER_ARM_RADIUS = STICKMAN_LEG_RADIUS * 0.8;    // 1.76
export const STICKMAN_UPPER_ARM_RADIUS = STICKMAN_LOWER_ARM_RADIUS * 1.15; // ~2.024

// Ball-trap inelastic deflect factor. 0 = full absorb (dead stop on
// surface normal); 1 = elastic. 0.25 cushions the normal component
// fully (v·n dropped) and retains 25 % of the tangential component
// so the ball slides along the body surface and gravity settles it.
const BODY_TANG_RETAIN = 0.25;
// Tunnel-correction thresholds (see `tryBodyContact`): if the
// player is moving faster than `TUNNEL_CORRECTION_MIN_SPEED` world
// units/tick AND the ball's contact normal points more than
// `TUNNEL_CORRECTION_BEHIND_DOT` *against* the player's forward
// direction, the body moved past the ball in one tick — relocate
// the ball to the player's forward face instead of clamping behind.
const TUNNEL_CORRECTION_MIN_SPEED = 1.0;
const TUNNEL_CORRECTION_BEHIND_DOT = -0.3;

// Body column vertical anchors above the ground (z=0). Hip base is
// where the leg capsules meet the torso; shoulder sits one torso
// length above; head sits a neck-gap + head-radius above the shoulder.
const HIP_BASE_Z      = STICKMAN_LIMB_FULL_H;                          // 20
const SHOULDER_Z      = HIP_BASE_Z + STICKMAN_SHOULDER_OFY;            // 40.24
const HEAD_CENTER_Z   = SHOULDER_Z + STICKMAN_HEAD_GAP_Y + STICKMAN_HEAD_RADIUS; // 47.11

// Maximum kick reach — full stretched leg length. See the Kick
// constants block above for context; defined here because it needs
// the rig constants.
const KICK_REACH_MAX = STICKMAN_UPPER_LEG + STICKMAN_LOWER_LEG;        // 20

/* ── Field & state factories ──────────────────────────────────── */

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
  // Precomputed goal-box AABBs — called on every physics tick for
  // player + ball collisions. Freezing them here kills ~6 object
  // allocations per tick that used to happen inside `goalBox(f, side)`.
  field.goalBoxLeft = {
    minX: goalLLeft, maxX: goalLineL,
    minY: GOAL_MOUTH_Y_MIN, maxY: GOAL_MOUTH_Y_MAX,
    minZ: 0, maxZ: GOAL_MOUTH_Z,
  };
  field.goalBoxRight = {
    minX: goalLineR, maxX: goalRRight,
    minY: GOAL_MOUTH_Y_MIN, maxY: GOAL_MOUTH_Y_MAX,
    minZ: 0, maxZ: GOAL_MOUTH_Z,
  };
  return field;
}

function initPlayer(p, side, field) {
  const x = side === 'left'
    ? field.midX - STARTING_GAP - field.playerWidth / 2
    : field.midX + STARTING_GAP - field.playerWidth / 2;
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
  // Pending push impulse — committed at the animation's strike tick
  // (`advancePush`), not at push start, so the victim only moves on
  // actual contact rather than on the windup frame.
  p.pendingPushVictim = null;
  p.pendingPushVx = 0;
  p.pendingPushVy = 0;
  // Hit-reaction state. Written on the VICTIM when a push lands so the
  // pose layer can play a recoil animation keyed to the hit type,
  // knockback direction, and force. Purely cosmetic — the physics
  // impulse is still pushVx/pushVy.
  p.reactTimer = 0;
  p.reactForce = 0;     // normalized 0..1
  p.reactDirX = 0;      // world xz unit vector, knockback direction
  p.reactDirZ = 0;
  p.reactType = 'jab';  // copied from pusher.pushType
  p.reactLatSign = 1;   // +1/-1 in victim's lateral frame — direction
                        // a hook sweeps the victim's body (independent
                        // of impulse direction, which is axial).
  p.heading = side === 'left' ? 0 : Math.PI;
  p.prevTargetDirX = 0;
  p.prevTargetDirY = 0;
  p.airZ = 0;
  return p;
}

function createPlayer(side, field) {
  // Pre-allocated kick slot — gated by `.active` so we never allocate
  // a fresh object per kick attempt on the hot path.
  //
  // `kind` picks ground vs air; `stage` walks windup → strike →
  // recovery. `footTargetX/Y/Z` is the world-space point the foot
  // aims to reach at strike; it tracks the predicted ball during
  // windup and freezes when stage flips to 'strike'.
  return initPlayer({ kick: {} }, side, field);
}

/**
 * Re-initialize an existing state for a new match, without allocating
 * any new objects. The ball, p1, p2 (and their kick sub-objects), and
 * the events array are all mutated in place. Field + rng can be swapped
 * at will. `recordEvents` and `headless` are reset to their defaults;
 * callers (worker, main) re-set them after reset as needed.
 *
 * Lets worker.js keep one state across thousands of matches instead of
 * allocating a fresh state per runMatch. With N workers × thousands of
 * matches/sec, that churn was the dominant source of old-gen drift —
 * see project_football_renderer_oom in session memory.
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
  state.goalScorer = null;
  state.matchOver = false;
  state.winner = null;
  state.events.length = 0;
  state.recordEvents = false;
  state.headless = false;
  return state;
}

/**
 * Create a fresh game state. Default rng is a seeded LCG with seed 0 so that
 * accidentally-unseeded callers get a reproducible stream.
 * `recordEvents` is false by default — tests and runners opt in to collect
 * state.events; production callers (main, worker) skip all event allocation.
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
      // Set true on scoreGoal so updateBall routes goal-box collisions
      // through the absorbing inner-net resolver (ball stops, falls)
      // instead of the bouncing outer resolver. Cleared on reset.
      inGoal: false,
    },
    p1: createPlayer('left', field),
    p2: createPlayer('right', field),
    scoreL: 0,
    scoreR: 0,
    tick: 0,
    graceFrames: 0,
    lastKickTick: 0,
    // Incremented every time the stall timeout fires. Workers read
    // this after a match to tag the result — stalled matches are
    // filtered out of the showcase replay buffer so visuals never
    // show a mid-match teleport. Fitness unaffected: goals scored
    // during or after a stall still count.
    stallCount: 0,
    pauseState: null, // null | 'celebrate' | 'matchend' | 'reposition' | 'waiting'
    pauseTimer: 0,
    goalScorer: null,
    matchOver: false,
    winner: null,
    events: [],
    recordEvents: false,
    // Training-mode flag. When true, `scoreGoal`/`ballOut` bypass the
    // celebrate/reposition/waiting pause state machine entirely and
    // instantly reset the pitch so every tick of the match budget is
    // spent on active play — no animations, no idle frames, no
    // WIN_SCORE early-stop. Default false so the visual showcase path
    // stays untouched.
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
    // Ball physics run during pause too — gravity still pulls the
    // ball down so a scored shot settles visibly into the net
    // instead of freezing mid-flight. Score check is suppressed by
    // the grace-frame gate set in scoreGoal, and the inner-net
    // absorber handles wall contact without a bounce.
    if (state.pauseState !== 'matchend') updateBall(state);
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

// Action vector layout — 9 floats, same order as nn.js output. Exported
// so fallback.js, tests, and any future consumer can build/read the
// vector by name instead of by magic index.
export const ACTION_MOVE_X     = 0;
export const ACTION_MOVE_Y     = 1;
export const ACTION_KICK_GATE  = 2;
export const ACTION_KICK_DX    = 3;
export const ACTION_KICK_DY    = 4;
export const ACTION_KICK_DZ    = 5;
export const ACTION_KICK_POWER = 6;
export const ACTION_PUSH_GATE  = 7;
export const ACTION_PUSH_POWER = 8;
export const NN_OUTPUT_SIZE    = 9;

/** Strike threshold in ms of `pushTimer` remaining, keyed by the
 *  pusher's pushType. Jab fist has to extend furthest and connects
 *  close to peak; uppercut engages at short range and connects
 *  early in the strike blend. pushTimer counts DOWN from
 *  PUSH_ANIM_MS, so the trigger for a type is
 *  `PUSH_ANIM_MS * (1 - PUSH_CONTACT_FRAC[type])`. */
const PUSH_STRIKE_TIMER = {
  jab:      PUSH_ANIM_MS * (1 - PUSH_CONTACT_FRAC.jab),
  hook:     PUSH_ANIM_MS * (1 - PUSH_CONTACT_FRAC.hook),
  uppercut: PUSH_ANIM_MS * (1 - PUSH_CONTACT_FRAC.uppercut),
};

/** Tick a push cooldown forward. Returns true if the player is still
 *  mid-push and should not accept new actions this tick — mirrors
 *  `advanceKick`'s in-flight-lock contract. Also commits the pending
 *  push impulse to the victim at the strike tick, so the victim only
 *  moves on contact rather than on the windup frame. */
function advancePush(p) {
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
  if (advancePush(p)) return;

  if (p.exhausted) { p.vx = 0; p.vy = 0; return; }

  applyMovement(state, p, out[ACTION_MOVE_X], out[ACTION_MOVE_Y]);

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
}

/* ── Angle helpers ────────────────────────────────────────────── */

/** Shortest-arc signed difference between two angles, in (-π, π]. */
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
 *  `tol` radians. Shared by canKick, tryPush, and both fallbacks so the
 *  "is this action aligned" rule lives in exactly one place. */
export function facingToward(p, worldX, worldZ, tol) {
  const centerX = p.x + PLAYER_WIDTH / 2;
  const centerZ = (p.y + PLAYER_HEIGHT / 2) * Z_STRETCH;
  const want = Math.atan2(worldZ - centerZ, worldX - centerX);
  return Math.abs(wrapAngle(want - p.heading)) < tol;
}

/* ── Movement ─────────────────────────────────────────────────── */

// Motion input dead zone. Snaps small commanded moves to 0 so
// imitation-trained NNs emitting ±0.05 noise don't produce 10 sign
// flips per second of actual motion — each of which burns
// DIRECTION_CHANGE_DRAIN stamina. Matches `FALLBACK_DEAD_ZONE` in
// fallback.js so teacher and student share the same effective
// quantization; the teacher already emits exact 0 below this
// threshold, so this change is a no-op for fallback behaviour.
const MOVE_INPUT_DEAD_ZONE = 0.15;

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

/** Goal box AABB for one side, in physics units. */
// Thin accessor kept for call-site readability. The actual AABBs
// are precomputed on the field at creation time so this returns the
// same object every tick — no allocation.
function goalBox(f, side) {
  return side === 'left' ? f.goalBoxLeft : f.goalBoxRight;
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
    if (tx <= ty) { _scratchPush.axis = 'x'; _scratchPush.delta = dx; }
    else          { _scratchPush.axis = 'y'; _scratchPush.delta = dy; }
    return _scratchPush;
  }
  const pushMinZ = ent.maxZ - box.minZ;
  const pushMaxZ = box.maxZ - ent.minZ;
  const dz = vz > 0 ? -pushMinZ : vz < 0 ? pushMaxZ : (pushMinZ < pushMaxZ ? -pushMinZ : pushMaxZ);
  const tz = Math.abs(dz) / (Math.abs(vz) + EPS);
  if (tx <= ty && tx <= tz)      { _scratchPush.axis = 'x'; _scratchPush.delta = dx; }
  else if (ty <= tz)             { _scratchPush.axis = 'y'; _scratchPush.delta = dy; }
  else                           { _scratchPush.axis = 'z'; _scratchPush.delta = dz; }
  return _scratchPush;
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

// Module-level scratch AABBs reused by the collision resolvers.
// Physics runs synchronously on the main thread (or per-worker) so
// a single shared scratch is safe — the caller consumes the result
// before anyone else can see it.
const _scratchEnt2D = { minX: 0, maxX: 0, minY: 0, maxY: 0 };
const _scratchEnt3D = { minX: 0, maxX: 0, minY: 0, maxY: 0, minZ: 0, maxZ: 0 };
// Scratch output for `minPenetrationPush`. Filled in place and
// returned by reference — no object allocation on the hit path.
// Caller inspects `.axis` ('x' / 'y' / 'z') and `.delta`.
const _scratchPush = { axis: 'x', delta: 0 };

/**
 * Ball vs inner goal surfaces. The ball has already scored (scoreGoal
 * set ball.inGoal) and is now bouncing around inside the net. Each
 * inner face absorbs on contact — the net catches the ball and lets
 * gravity do the rest. Bars (posts + crossbar) are not part of this
 * path; they're solid colliders on the outer resolver and the ball
 * never approaches them from inside in a scoring trajectory (posts
 * live at the mouth plane; by the time the ball is inGoal it's past
 * the mouth on its way to the back net).
 */
function resolveBallInsideGoal(state, box) {
  const ball = state.ball;
  if (ball.frozen) return;

  const isLeftGoal = box === state.field.goalBoxLeft;
  let hitBackOrSide = false;

  // Inner back net. For a left goal the back wall is `box.minX`
  // (ball came in from +x); for a right goal it's `box.maxX`.
  const backX = isLeftGoal ? box.minX : box.maxX;
  const penetration = isLeftGoal
    ? backX - (ball.x - BALL_RADIUS)
    : (ball.x + BALL_RADIUS) - backX;
  if (penetration > 0) {
    ball.x = isLeftGoal ? backX + BALL_RADIUS : backX - BALL_RADIUS;
    hitBackOrSide = true;
    if (state.recordEvents && Math.abs(ball.vx) > BOUNCE_EVENT_MIN) {
      state.events.push({ type: 'ball_bounce', axis: 'x', force: Math.abs(ball.vx), x: ball.x, y: ball.y, z: ball.z });
    }
  }

  // Inner side nets.
  if (ball.y - BALL_RADIUS < box.minY) {
    ball.y = box.minY + BALL_RADIUS;
    hitBackOrSide = true;
  } else if (ball.y + BALL_RADIUS > box.maxY) {
    ball.y = box.maxY - BALL_RADIUS;
    hitBackOrSide = true;
  }

  if (hitBackOrSide) {
    // Net absorbs — ball loses horizontal momentum and drops.
    ball.vx = 0;
    ball.vy = 0;
  }

  // Inner roof (crossbar underside). If ball rose into it, kill upward
  // vz only — gravity will pull it back down naturally.
  if (ball.z + BALL_RADIUS > box.maxZ) {
    ball.z = box.maxZ - BALL_RADIUS;
    if (ball.vz > 0) ball.vz = 0;
  }
}

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

/* ── Ball vs player body (torso capsule + head sphere) ──────── */

const _scratchClosest = { x: 0, y: 0, z: 0 };

/** Closest point on segment AB to point P, written into `out` (same
 *  {x,y,z} object style as _scratchPush). Pure math, no allocation. */
function closestPointOnSegment(ax, ay, az, bx, by, bz, px, py, pz, out) {
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  const len2 = dx * dx + dy * dy + dz * dz;
  let t = 0;
  if (len2 > 1e-12) {
    t = ((px - ax) * dx + (py - ay) * dy + (pz - az) * dz) / len2;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
  }
  out.x = ax + t * dx;
  out.y = ay + t * dy;
  out.z = az + t * dz;
  return out;
}

/**
 * Ball vs player's body-column capsule + head sphere.
 *
 * Collision math runs in WORLD coordinates (y = vertical,
 * z = depth) so the spherical body radii compare apples-to-apples
 * against physics distances. Physics space has its depth axis
 * compressed by Z_STRETCH for gameplay feel — if we used physics y
 * directly the collider would be stretched into a flat sheet.
 *
 * Body is inert for the entire duration of an active kick (any
 * phase) so the foot can reach the ball without the torso stealing
 * it first. Other players' bodies still trap normally.
 *
 * Emergent dribble: a stationary ball gets clamped to the body
 * surface each tick. As the player walks forward, the clamp
 * re-fires and the ball stays "pinned" at contact distance — no
 * special-case code.
 *
 * Returns `true` if a clamp fired, so the caller can break the
 * substep integration loop — otherwise the post-clamp substeps
 * would keep advancing the ball with the freshly-boosted velocity
 * and over-shoot the contact distance.
 */
function resolveBallVsPlayerBody(state, p) {
  if (p.kick.active) return false;
  const ball = state.ball;
  if (ball.frozen) return false;

  const airZ = p.airZ || 0;
  // Body-column capsule is anchored at the same world position the
  // renderer draws the figure at: `(player.x + PLAYER_WIDTH/2,
  // player.y * Z_STRETCH)`. PLAYER_HEIGHT is only a ground-plane
  // personal-space span used by player-pair math; using it here
  // shifted the collider ~14 world-z units deeper than the visible
  // stickman, so the ball looked like it was bouncing off empty air.
  const centerX = p.x + PLAYER_WIDTH / 2;
  const centerWorldZ = p.y * Z_STRETCH;

  // Ball in world coords: physics (x, y=depth, z=vertical) → world
  // (x, y=vertical, z=depth). Velocity follows the same mapping.
  //
  // `ball.z` stores the altitude of the ball's **bottom** (ball.z = 0
  // ≡ resting on the pitch; the renderer draws the mesh at
  // `ball.z + BALL_VISUAL_RADIUS`). Capsule/sphere collision needs
  // the center, so we add `BALL_RADIUS` here. Missing this shifted
  // contact ~4 units below the visible ball and made drops onto the
  // head look like they were hitting the torso instead.
  const ballWX = ball.x;
  const ballWY = ball.z + BALL_RADIUS;
  const ballWZ = ball.y * Z_STRETCH;
  const ballWVX = ball.vx;
  const ballWVY = ball.vz;
  const ballWVZ = ball.vy * Z_STRETCH;

  // Body-column capsule in world coords: vertical from ground
  // (+airZ) to shoulder height, x and z fixed at the player center.
  const closest = closestPointOnSegment(
    centerX, airZ, centerWorldZ,
    centerX, SHOULDER_Z + airZ, centerWorldZ,
    ballWX, ballWY, ballWZ,
    _scratchClosest,
  );
  const torsoHit = tryBodyContact(state, p, closest, ballWX, ballWY, ballWZ,
    ballWVX, ballWVY, ballWVZ, STICKMAN_TORSO_RADIUS);

  // Head sphere in world coords.
  _scratchClosest.x = centerX;
  _scratchClosest.y = HEAD_CENTER_Z + airZ;
  _scratchClosest.z = centerWorldZ;
  // After possible torso clamp, re-read ball world coords so the
  // head test sees the post-clamp position. Same bottom-to-center
  // shift as the torso read above.
  const ballWX2 = ball.x;
  const ballWY2 = ball.z + BALL_RADIUS;
  const ballWZ2 = ball.y * Z_STRETCH;
  const ballWVX2 = ball.vx;
  const ballWVY2 = ball.vz;
  const ballWVZ2 = ball.vy * Z_STRETCH;
  const headHit = tryBodyContact(state, p, _scratchClosest, ballWX2, ballWY2, ballWZ2,
    ballWVX2, ballWVY2, ballWVZ2, STICKMAN_HEAD_RADIUS);
  return torsoHit || headHit;
}

/** Apply cushion + deflect against a single sphere/segment-closest-
 *  point in world coords. Writes new ball position + velocity back
 *  to physics coords. `collider` is the world-space closest point
 *  of the collider to the ball. Returns true if a clamp fired. */
function tryBodyContact(state, p, collider, wx, wy, wz, wvx, wvy, wvz, colliderRadius) {
  const ball = state.ball;
  let nx = wx - collider.x;
  let ny = wy - collider.y;
  let nz = wz - collider.z;
  let d2 = nx * nx + ny * ny + nz * nz;
  const r = colliderRadius + BALL_RADIUS;
  if (d2 >= r * r) return false;

  let d = Math.sqrt(d2);
  if (d < 1e-9) {
    // Ball coincident with collider — push out on +x (deterministic).
    nx = 1; ny = 0; nz = 0; d = 1;
  }
  let inv = 1 / d;
  let nxU = nx * inv, nyU = ny * inv, nzU = nz * inv;

  // Tunnel correction: if the player is walking in a direction that
  // has the ball behind them (contact normal is opposite to player's
  // heading-projected velocity), the player has tunneled past the
  // ball this tick — its per-tick step can be larger than the torso
  // radius. In that case, flip the contact normal to the player's
  // forward direction so the dribble clamp puts the ball AHEAD of
  // the player, not behind. Preserves arcade "ball stays at feet"
  // feel without solving a full swept-player collision.
  const pWVX = p.vx, pWVZ = p.vy * Z_STRETCH;
  const pSpeed = Math.hypot(pWVX, pWVZ);
  if (pSpeed > TUNNEL_CORRECTION_MIN_SPEED) {
    const fwdX = pWVX / pSpeed, fwdZ = pWVZ / pSpeed;
    const fwdDotN = fwdX * nxU + fwdZ * nzU;
    if (fwdDotN < TUNNEL_CORRECTION_BEHIND_DOT) {
      // Ball ended up behind a walking player → relocate to front.
      nxU = fwdX;
      nyU = 0;
      nzU = fwdZ;
    }
  }
  const overlap = r - d;

  // Clamp ball out along the (possibly adjusted) normal.
  const newWX = collider.x + nxU * r;  // in the "tunnel" case, clamp to contact distance exactly in front
  const newWY = (nyU !== 0) ? wy + nyU * overlap : wy;
  const newWZ = collider.z + nzU * r;
  // Note: we use `collider.x/z` plus full r for the horizontal clamp.
  // For the untunneled case this is equivalent to `w* + n* * overlap`.

  // Cushion + deflect velocity. Normal component is absorbed, the
  // tangential component is damped to BODY_TANG_RETAIN.
  const vDotN = wvx * nxU + wvy * nyU + wvz * nzU;
  let newWVX = wvx, newWVY = wvy, newWVZ = wvz;
  if (vDotN < 0) {
    const vnx = vDotN * nxU, vny = vDotN * nyU, vnz = vDotN * nzU;
    newWVX = (wvx - vnx) * BODY_TANG_RETAIN;
    newWVY = (wvy - vny) * BODY_TANG_RETAIN;
    newWVZ = (wvz - vnz) * BODY_TANG_RETAIN;
    if (state.recordEvents) {
      state.events.push({
        type: 'ball_trap',
        player: p === state.p1 ? 'p1' : 'p2',
        x: newWX, y: newWZ / Z_STRETCH, z: newWY,
      });
    }
  }

  // Dribble assist: if the player is walking along +normal (into
  // ball's side of the body), match the player's normal-component
  // velocity so the ball keeps up instead of falling behind.
  const pvDotN = pWVX * nxU + pWVZ * nzU;
  if (pvDotN > 0) {
    const ballVAlongN = newWVX * nxU + newWVY * nyU + newWVZ * nzU;
    const delta = pvDotN - ballVAlongN;
    if (delta > 0) {
      newWVX += delta * nxU;
      newWVY += delta * nyU;
      newWVZ += delta * nzU;
    }
  }

  // Stuck-on-top escape: a perfectly vertical contact (ball dropped
  // directly onto head / shoulder) produces zero tangential velocity
  // after cushion and re-clamps each tick. Give a small deterministic
  // forward slide so gravity carries the ball off the body instead
  // of pinning it on top. Cap is small (~0.5) so non-pathological
  // cases aren't affected.
  if (vDotN < 0 && nyU > 0.95
      && Math.abs(newWVX) < 0.05 && Math.abs(newWVZ) < 0.05) {
    const fwdX = Math.cos(p.heading);
    const fwdZ = Math.sin(p.heading);
    newWVX = fwdX * 0.5;
    newWVZ = fwdZ * 0.5;
  }

  ball.x  = newWX;
  // `newWY` is the ball-center world-y; `ball.z` stores the bottom.
  ball.z  = newWY - BALL_RADIUS;
  ball.y  = newWZ / Z_STRETCH;
  ball.vx = newWVX;
  ball.vz = newWVY;
  ball.vy = newWVZ / Z_STRETCH;
  return true;
}

/**
 * Player-vs-player body-capsule collision with swept circle-circle
 * solver in the world-horizontal plane. Each player is modelled as a
 * vertical capsule of radius STICKMAN_TORSO_RADIUS — the same body
 * column the ball uses. Swept because a player walking at full speed
 * into another (combined 20 u/tick of closure) can easily cross the
 * 6.6-unit contact diameter in one tick; without swept detection they
 * pass straight through.
 *
 * Takes pre-tick positions so we can solve for the exact time of
 * first contact along the linear motion. On contact, we put both
 * players AT contact distance (not past) and zero the relevant
 * velocity components.
 */
function resolvePlayerPairCollision(p1, p2, pre1x, pre1y, pre2x, pre2y) {
  const r = 2 * STICKMAN_TORSO_RADIUS;
  // Pre-tick centers in world coords.
  const preC1x = pre1x + PLAYER_WIDTH / 2;
  const preC1z = (pre1y + PLAYER_HEIGHT / 2) * Z_STRETCH;
  const preC2x = pre2x + PLAYER_WIDTH / 2;
  const preC2z = (pre2y + PLAYER_HEIGHT / 2) * Z_STRETCH;
  // Post-tick centers.
  const postC1x = p1.x + PLAYER_WIDTH / 2;
  const postC1z = (p1.y + PLAYER_HEIGHT / 2) * Z_STRETCH;
  const postC2x = p2.x + PLAYER_WIDTH / 2;
  const postC2z = (p2.y + PLAYER_HEIGHT / 2) * Z_STRETCH;

  const preDx = preC1x - preC2x, preDz = preC1z - preC2z;
  const postDx = postC1x - postC2x, postDz = postC1z - postC2z;
  const mdx = postDx - preDx, mdz = postDz - preDz;
  const preDist2 = preDx * preDx + preDz * preDz;
  const postDist2 = postDx * postDx + postDz * postDz;

  // Swept-minimum reject. For linear motion of two centres over
  // [0, 1], distance²(t) is a quadratic with minimum at
  //   t* = −(preD·m) / |m|²
  // clamped to [0, 1]. If the minimum distance² stays ≥ r², the
  // pair never overlapped this tick — early out.
  //
  // The previous implementation used a per-axis sign-flip heuristic
  // (`preDz * postDz < 0 → tunneled`) which fires as a false positive
  // whenever the perpendicular centre-offset crossed zero — common
  // for two players on nearly-identical y-coordinates with any tiny
  // y-velocity difference. That false positive reached the full
  // solver with roots far outside [0, 1], fell through to `tc = 0`,
  // rewound both players to pre-tick positions, and zeroed their x-
  // velocities along the wide separation normal — stalling motion
  // for players 79 units apart.
  const aMot = mdx * mdx + mdz * mdz;
  let minDist2;
  if (aMot < 1e-12) {
    minDist2 = preDist2;
  } else {
    const preDotM = preDx * mdx + preDz * mdz;
    let tStar = -preDotM / aMot;
    if      (tStar <= 0) minDist2 = preDist2;
    else if (tStar >= 1) minDist2 = postDist2;
    else                 minDist2 = preDist2 + 2 * tStar * preDotM + tStar * tStar * aMot;
  }
  if (minDist2 >= r * r) return;

  // Solve |preD + t * m|² = r² for t in [0, 1]. Quadratic
  // |m|² t² + 2 (preD · m) t + (|preD|² − r²) = 0.
  //
  // t1 is the ENTRY contact time (first root, first moment distance
  // drops to r). t2 is EXIT (distance rises past r again). We always
  // want the entry. Floating-point noise on the preDist² − r² term
  // can make t1 slip slightly negative when the players start AT
  // contact distance — we clamp to 0 if it's inside a small tolerance
  // so we don't accidentally take t2 (exit) as the contact time and
  // teleport the players past each other.
  let tc = 0;
  const TOL = 1e-4;
  if (aMot > 1e-9) {
    const b = 2 * (preDx * mdx + preDz * mdz);
    const c = preDist2 - r * r;
    const disc = b * b - 4 * aMot * c;
    if (disc >= 0) {
      const sq = Math.sqrt(disc);
      const t1 = (-b - sq) / (2 * aMot);
      const t2 = (-b + sq) / (2 * aMot);
      if (t1 >= -TOL && t1 <= 1 + TOL) {
        tc = Math.max(0, Math.min(1, t1));
      } else if (t2 >= -TOL && t2 <= 1 + TOL) {
        tc = Math.max(0, Math.min(1, t2));
      }
      // else: crossing outside the tick window — leave tc at 0 so we
      // resolve at pre-tick (current overlap already, separate below).
    }
  }

  // Rewind to the contact moment along the linear motion.
  p1.x = pre1x + (p1.x - pre1x) * tc;
  p1.y = pre1y + (p1.y - pre1y) * tc;
  p2.x = pre2x + (p2.x - pre2x) * tc;
  p2.y = pre2y + (p2.y - pre2y) * tc;

  // Compute the contact-time normal. If the players were already
  // overlapping at tick start, the time-of-contact is 0 and the
  // positions are still overlapping — push them apart to contact
  // distance. Otherwise we've landed exactly at contact distance.
  const c1x = p1.x + PLAYER_WIDTH / 2;
  const c1z = (p1.y + PLAYER_HEIGHT / 2) * Z_STRETCH;
  const c2x = p2.x + PLAYER_WIDTH / 2;
  const c2z = (p2.y + PLAYER_HEIGHT / 2) * Z_STRETCH;
  const dx = c1x - c2x;
  const dz = c1z - c2z;
  const dist2 = dx * dx + dz * dz;
  const dist = Math.sqrt(dist2);
  let nxU, nzU;
  if (dist < 1e-9) {
    nxU = 1; nzU = 0;
  } else {
    const inv = 1 / dist;
    nxU = dx * inv; nzU = dz * inv;
  }
  if (dist < r - 1e-6) {
    const half = (r - dist) / 2;
    const wx = nxU * half, wz = nzU * half;
    p1.x += wx;  p1.y += wz / Z_STRETCH;
    p2.x -= wx;  p2.y -= wz / Z_STRETCH;
  }

  // Zero each player's velocity component INTO the opponent so they
  // stop pressing together. Normal points from p2's center toward
  // p1's center. p1 moving in −normal direction = moving into p2
  // (v1·n < 0); p2 moving in +normal direction = moving into p1
  // (v2·n > 0). Velocities in physics space (vx = world x,
  // vy = world z / Z_STRETCH).
  const v1DotN = p1.vx * nxU + p1.vy * Z_STRETCH * nzU;
  if (v1DotN < 0) {
    p1.vx -= v1DotN * nxU;
    p1.vy -= v1DotN * nzU / Z_STRETCH;
  }
  const v2DotN = p2.vx * nxU + p2.vy * Z_STRETCH * nzU;
  if (v2DotN > 0) {
    p2.vx -= v2DotN * nxU;
    p2.vy -= v2DotN * nzU / Z_STRETCH;
  }
  // Push impulses (pushVx/pushVy) are also squashed on the contact
  // axis so a push into an opponent doesn't impale them.
  const pv1DotN = p1.pushVx * nxU + p1.pushVy * Z_STRETCH * nzU;
  if (pv1DotN < 0) {
    p1.pushVx -= pv1DotN * nxU;
    p1.pushVy -= pv1DotN * nzU / Z_STRETCH;
  }
  const pv2DotN = p2.pushVx * nxU + p2.pushVy * Z_STRETCH * nzU;
  if (pv2DotN > 0) {
    p2.pushVx -= pv2DotN * nxU;
    p2.pushVy -= pv2DotN * nzU / Z_STRETCH;
  }
}

function resolvePlayerGoalBox(p, pw, box) {
  const ent = _scratchEnt2D;
  ent.minX = p.x; ent.maxX = p.x + pw;
  ent.minY = p.y; ent.maxY = p.y + PLAYER_HEIGHT;
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
function resolveBallVsCylinder(state, ax, ay, az, bx, by, bz, radius) {
  const ball = state.ball;
  if (ball.frozen) return false;

  // Parametric projection of ball center onto axis segment A→B, clamped
  // to [0,1]. Gives the nearest point on the segment.
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  const len2 = dx * dx + dy * dy + dz * dz;
  const rx = ball.x - ax, ry = ball.y - ay, rz = ball.z - az;
  let t = len2 > 0 ? (rx * dx + ry * dy + rz * dz) / len2 : 0;
  if (t < 0) t = 0; else if (t > 1) t = 1;
  const nx = ax + t * dx, ny = ay + t * dy, nz = az + t * dz;

  // Vector from nearest axis point to ball center → contact normal.
  const vx = ball.x - nx, vy = ball.y - ny, vz = ball.z - nz;
  const dist2 = vx * vx + vy * vy + vz * vz;
  const contact = BALL_RADIUS + radius;
  if (dist2 >= contact * contact) return false;

  const dist = Math.sqrt(dist2);
  const penetration = contact - dist;

  // Normal = unit vector from axis to ball. Degenerate case (ball
  // center coincident with axis) uses the negated velocity direction
  // so the ball rebounds the way it came.
  let normX, normY, normZ;
  if (dist > 1e-6) {
    const inv = 1 / dist;
    normX = vx * inv; normY = vy * inv; normZ = vz * inv;
  } else {
    const vmag = Math.hypot(ball.vx, ball.vy, ball.vz);
    if (vmag > 1e-6) {
      normX = -ball.vx / vmag;
      normY = -ball.vy / vmag;
      normZ = -ball.vz / vmag;
    } else {
      normX = 1; normY = 0; normZ = 0;
    }
  }

  // Push ball out of interpenetration along the normal. Floor clamp
  // stops a crossbar-top bounce from dropping ball.z negative.
  ball.x += normX * penetration;
  ball.y += normY * penetration;
  ball.z += normZ * penetration;
  if (ball.z < 0) ball.z = 0;

  // Reflect the velocity component along the normal if the ball is
  // heading INTO the cylinder (vDotN < 0). Tangential components are
  // preserved — this is what gives glancing hits their proper
  // deflection instead of a pure-axis rebound.
  const vDotN = ball.vx * normX + ball.vy * normY + ball.vz * normZ;
  if (vDotN < 0) {
    const k = (1 + BOUNCE_RETAIN) * vDotN;
    ball.vx -= k * normX;
    ball.vy -= k * normY;
    ball.vz -= k * normZ;
    const absNx = Math.abs(normX), absNy = Math.abs(normY), absNz = Math.abs(normZ);
    const axis = absNx >= absNy && absNx >= absNz
      ? 'x' : absNy >= absNz ? 'y' : 'z';
    recordBounce(state, axis, Math.abs(vDotN));
  }
  return true;
}

/**
 * Ball vs the three bars at one goal's mouth: left post, right post,
 * crossbar. Each is a thin cylinder. Contact produces a bounce along
 * the real cylinder normal. Bars are solid from BOTH sides — a ball
 * inside the goal hitting a post from the interior bounces off it
 * just as one from the field does — so this runs on every path,
 * inGoal or not.
 *
 * Bar geometry (left goal uses mouthX = goalLineL; right goal uses
 * goalLineR — the ball approaches from the opposite side in each case,
 * but the cylinder math is symmetric):
 *   • left post   — vertical, axis (mouthX, mouthYMin, 0→mouthZMax)
 *   • right post  — vertical, axis (mouthX, mouthYMax, 0→mouthZMax)
 *   • crossbar    — horizontal, axis (mouthX, mouthYMin→mouthYMax, mouthZMax)
 */
function resolveBallVsGoalBars(state, box) {
  const isLeft = box === state.field.goalBoxLeft;
  const mouthX = isLeft ? box.maxX : box.minX;
  const mouthZ = box.maxZ;
  // Left post.
  resolveBallVsCylinder(state,
    mouthX, box.minY, 0,
    mouthX, box.minY, mouthZ,
    GOAL_POST_RADIUS);
  // Right post.
  resolveBallVsCylinder(state,
    mouthX, box.maxY, 0,
    mouthX, box.maxY, mouthZ,
    GOAL_POST_RADIUS);
  // Crossbar.
  resolveBallVsCylinder(state,
    mouthX, box.minY, mouthZ,
    mouthX, box.maxY, mouthZ,
    GOAL_POST_RADIUS);
}

/**
 * Ball vs one goal's EXTERIOR non-bar faces: back wall, two side
 * walls, roof. Each is a flat rectangular plane; the ball bounces off
 * the outside face with standard reflected velocity. Runs only when
 * the ball is outside the goal (inGoal=false); the interior is handled
 * by resolveBallInsideGoal with absorber semantics.
 *
 * Each face check is independent:
 *   1. Velocity points INWARD (toward the goal interior on that axis).
 *   2. Sphere overlaps the plane AND ball center hasn't yet fully
 *      crossed to the interior side. A fast ball can sweep across the
 *      plane in one substep and land with center just inside — the
 *      "sphere overlaps" branch catches that and still bounces.
 *   3. The clipping point is within the face's finite rectangle.
 *
 * Without these faces solid from outside, a ball approaching the goal
 * OFF the mouth axis (wide on y, or high on z) would tunnel through
 * the side net / roof net and spawn inside the goal volume.
 */
function resolveBallVsGoalExterior(state, box) {
  const ball = state.ball;
  if (ball.frozen) return;
  const isLeft = box === state.field.goalBoxLeft;

  // ── Back wall — plane at x=backX, outside half-space faces the touchline.
  const backX = isLeft ? box.minX : box.maxX;
  const inwardVxBack = isLeft ? ball.vx : -ball.vx;  // +ve = toward mouth
  const fullyPastBack = isLeft
    ? ball.x - BALL_RADIUS >= backX
    : ball.x + BALL_RADIUS <= backX;
  if (inwardVxBack > 0 && !fullyPastBack
      && ball.y + BALL_RADIUS > box.minY
      && ball.y - BALL_RADIUS < box.maxY
      && ball.z - BALL_RADIUS < box.maxZ) {
    ball.x = isLeft ? backX - BALL_RADIUS : backX + BALL_RADIUS;
    const pre = Math.abs(ball.vx);
    ball.vx = -ball.vx * BOUNCE_RETAIN;
    recordBounce(state, 'x', pre);
  }
  if (ball.frozen) return;

  // ── Lower side wall — plane at y=mouthYMin, outside half-space y<mouthYMin.
  // x-extent: the full goal depth [minX, maxX]. z-extent: [0, mouthZMax].
  const fullyPastLower = ball.y - BALL_RADIUS >= box.minY;
  if (ball.vy > 0 && !fullyPastLower
      && ball.y + BALL_RADIUS > box.minY
      && ball.x + BALL_RADIUS > box.minX
      && ball.x - BALL_RADIUS < box.maxX
      && ball.z - BALL_RADIUS < box.maxZ) {
    ball.y = box.minY - BALL_RADIUS;
    const pre = Math.abs(ball.vy);
    ball.vy = -ball.vy * BOUNCE_RETAIN;
    recordBounce(state, 'y', pre);
  }
  if (ball.frozen) return;

  // ── Upper side wall — plane at y=mouthYMax, outside half-space y>mouthYMax.
  const fullyPastUpper = ball.y + BALL_RADIUS <= box.maxY;
  if (ball.vy < 0 && !fullyPastUpper
      && ball.y - BALL_RADIUS < box.maxY
      && ball.x + BALL_RADIUS > box.minX
      && ball.x - BALL_RADIUS < box.maxX
      && ball.z - BALL_RADIUS < box.maxZ) {
    ball.y = box.maxY + BALL_RADIUS;
    const pre = Math.abs(ball.vy);
    ball.vy = -ball.vy * BOUNCE_RETAIN;
    recordBounce(state, 'y', pre);
  }
  if (ball.frozen) return;

  // ── Roof — plane at z=mouthZMax, outside half-space z>mouthZMax.
  // Covers x in [minX, maxX] and y in [minY, maxY]. The rendered roof
  // is a trapezoidal net (flat front 35% + slanted rear), but the
  // physics approximation is a flat plane across the full depth —
  // matching the interior roof model used by resolveBallInsideGoal.
  const fullyPastRoof = ball.z + BALL_RADIUS <= box.maxZ;
  if (ball.vz < 0 && !fullyPastRoof
      && ball.z - BALL_RADIUS < box.maxZ
      && ball.x + BALL_RADIUS > box.minX
      && ball.x - BALL_RADIUS < box.maxX
      && ball.y + BALL_RADIUS > box.minY
      && ball.y - BALL_RADIUS < box.maxY) {
    ball.z = box.maxZ + BALL_RADIUS;
    const pre = Math.abs(ball.vz);
    ball.vz = -ball.vz * BOUNCE_RETAIN;
    recordBounce(state, 'z', pre);
  }
}

/* ── Kick state machine ──────────────────────────────────────── */

/**
 * Hip anchor in WORLD coords — the pivot a leg swings from.
 * Uses the body-axis center so the reach gate and the foot-contact
 * test stay symmetric on both kick sides. Matches the renderer's
 * draw origin: `(p.x + PLAYER_WIDTH/2, p.y * Z_STRETCH)` on the
 * floor, HIP_BASE_Z above the ground, plus `p.airZ` during an
 * airkick.
 */
const _scratchHip = { x: 0, y: 0, z: 0 };
function hipAnchor(p, out) {
  out.x = p.x + PLAYER_WIDTH / 2;
  out.y = HIP_BASE_Z + (p.airZ || 0);
  out.z = p.y * Z_STRETCH;
  return out;
}

/**
 * Project a world-space point into the player's hip-local frame:
 * `fwd` along the heading, `up` vertical, `perp` perpendicular to
 * heading in the floor plane. The IK solver only uses (fwd, up);
 * `perp` feeds the sphere-sphere contact test so a ball that's off
 * to the side still misses even if (fwd, up) lines up.
 */
const _scratchLocal = { fwd: 0, up: 0, perp: 0 };
function projectHipLocal(hip, heading, wx, wy, wz, out) {
  const dx = wx - hip.x;
  const dy = wy - hip.y;
  const dz = wz - hip.z;
  const fwdX = Math.cos(heading);
  const fwdZ = Math.sin(heading);
  out.fwd  = dx * fwdX + dz * fwdZ;
  out.up   = dy;
  out.perp = -dx * fwdZ + dz * fwdX;
  return out;
}

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
 *  Writes (x, y=vertical, z=depth) into `out`. */
const _scratchIKRes = { upperAngle: 0, lowerAngle: 0, footFwd: 0, footUp: 0 };
function ikFootWorld(p, out) {
  const k = p.kick;
  // Center hip matches the reach-gate anchor in `tryStartKick` so
  // a ball that passes the gate has the same kill zone at strike
  // time — otherwise balls inside the left-hip arc cleared the
  // gate but never met the right-hip foot sphere, burning 288 ms
  // per miss. The renderer still draws the right leg from its
  // offset hip for visual flavor; the ~2.64 world-unit gap between
  // the visible foot and the physics foot is well inside
  // (FOOT_RADIUS + BALL_RADIUS ≈ 5.7), so the eye still reads a
  // clean foot-ball contact.
  const hip = hipAnchor(p, _scratchHip);
  const local = projectHipLocal(hip, p.heading, k.footTargetX, k.footTargetY, k.footTargetZ, _scratchLocal);
  solve2BoneIK(local.fwd, local.up, STICKMAN_UPPER_LEG, STICKMAN_LOWER_LEG, _scratchIKRes);
  const fwdX = Math.cos(p.heading);
  const fwdZ = Math.sin(p.heading);
  out.x = hip.x + _scratchIKRes.footFwd * fwdX;
  out.y = hip.y + _scratchIKRes.footUp;
  out.z = hip.z + _scratchIKRes.footFwd * fwdZ;
  return out;
}

/**
 * Would a ground kick by `p` pass the reachability + facing gate
 * right now? Mirrors `tryStartKick`'s ground-kick path exactly, so
 * the fallback teacher never emits a kick action the engine then
 * silently rejects.
 *
 * `safetyMargin` tightens the reach threshold — fallback calls this
 * with a small margin so the teacher only commits on clearly-in-
 * reach balls, avoiding flapping at the edge. Pure, allocation-
 * free (reuses the module scratch buffers).
 */
export function canKickReach(state, p, safetyMargin = 0) {
  const predicted = predictBallAtStrike(state.ball, strikeLeadTicks('ground'), _scratchPredicted);
  const hip = hipAnchor(p, _scratchHip);
  const local = projectHipLocal(hip, p.heading, predicted.x, predicted.y, predicted.z, _scratchLocal);
  const dist = Math.hypot(local.fwd, local.up, local.perp);
  if (dist > KICK_REACH_MAX - safetyMargin) return false;
  const facePivotX = p.x + PLAYER_WIDTH / 2;
  const facePivotZ = p.y * Z_STRETCH;
  const wantAngle = Math.atan2(predicted.z - facePivotZ, predicted.x - facePivotX);
  return Math.abs(wrapAngle(wantAngle - p.heading)) < KICK_FACE_TOL;
}

/**
 * Reachability + facing gate. Called from applyAction when the NN
 * or fallback asks to kick. Returns true if the commit succeeded
 * and the kick is now active. Failure reasons are surfaced as
 * `kick_missed` events so the teacher and trained brains both see
 * the same rejection signal.
 */
const _scratchFoot = { x: 0, y: 0, z: 0 };
function tryStartKick(state, p, dx, dy, dz, power) {
  if (p.kick.active) return false;
  const kickDz = clamp(dz, -1, 1);
  const kind = kickDz > AIRKICK_DZ_THRESHOLD ? 'air' : 'ground';
  const leadTicks = strikeLeadTicks(kind);

  const predicted = predictBallAtStrike(state.ball, leadTicks, _scratchPredicted);
  // Reachability uses the body-center hip as a conservative gate:
  // any kick committed here has at least one hip within U+L of the
  // target. The foot-contact test in advanceKick switches to the
  // right hip for visual alignment with the rendered leg.
  const hip = hipAnchor(p, _scratchHip);
  const local = projectHipLocal(hip, p.heading, predicted.x, predicted.y, predicted.z, _scratchLocal);
  const dist = Math.hypot(local.fwd, local.up, local.perp);
  const which = p === state.p1 ? 'p1' : 'p2';
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
 * without re-deriving it.
 */
const WINDUP_PEAK_TEFF = 0.7;

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
// last 30% of leg travel to teleport in one frame).
const WINDUP_LOAD_FRAC = 0.7;
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
 * `kickLegExtension`. Pure function of `pushTimer` in ms:
 *   windup   : 0 → 0.7 (arm cocks back)
 *   strike   : 1.0      (arm extended to target)
 *   recovery : 1.0 → 0  (arm eases to neutral)
 * Returns 0 when `pushTimer <= 0` (no active push).
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

// Per-variant keyframes as [upper, lower, upperYawMag, lowerYawMag].
// Yaw magnitudes are unsigned; `pushArm` supplies the sign at
// assembly time (right arm swings from right-outward to cross-body;
// left arm mirrors).
// Arm-angle convention: 0 = straight down, π/2 = forward horizontal
// (fist at shoulder height), π = straight up. With UPPER_ARM +
// LOWER_ARM = 20 and the shoulder 6.9 units below the head, landing
// a fist at head level needs the arm tilted ≈20° above horizontal
// → angle-from-vertical ≈ π/2 + 0.35 ≈ 1.92 rad.

const JAB_REST   = [0,    0,    0, 0];
const JAB_WINDUP = [-0.25, 2.4, 0, 0];
// Jab strike: straight arm angled up to head height.
const JAB_STRIKE = [1.92, 1.92, 0, 0];

const HOOK_REST   = [0,          0,           0,           0];
// Windup: arm raised to head-height, yawed outward to the striking side;
// forearm bent 90° inward (pointing forward relative to body).
const HOOK_WINDUP = [1.92, 1.92, Math.PI / 2, 0];
// Strike: upper arm swept across body at head-height; yaw flips to a
// small cross-body sign; forearm extends past to continue the arc.
const HOOK_STRIKE = [1.92, 1.92, -0.35,      -1.2];

const UPPERCUT_REST   = [0,          0,           0, 0];
// Windup: elbow drops low and tucks, forearm rotated forward near the
// belly — classic cocked-uppercut stance.
const UPPERCUT_WINDUP = [-0.3,       1.7,         0, 0];
// Strike: upper arm rises forward-and-up (elbow well above shoulder),
// forearm whips almost straight up so the fist ends clearly above the
// head. Yaw tucks the arm inward toward the pusher's centerline so
// the right-arm fist finishes on the pusher's LEFT (and vice versa)
// — a chin-height punch driving up through the target from below.
const UPPERCUT_STRIKE = [2.0,        3.0,         -0.50, -0.80];

function writePose(out, kf, armSign) {
  out.upperAngle = kf[0];
  out.lowerAngle = kf[1];
  out.upperYaw   = kf[2] * armSign;
  out.lowerYaw   = kf[3] * armSign;
}

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
// directly so the leg settles after follow-through.
const KICK_COCK_FWD_FRAC = 0.20;  // foot 20% of leg-length behind hip
const KICK_COCK_UP_FRAC  = 0.50;  // foot at 50% of leg-length below hip
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
  const legLen = STICKMAN_UPPER_LEG + STICKMAN_LOWER_LEG;
  const cockFwd = -KICK_COCK_FWD_FRAC * legLen;
  const cockUp  = -KICK_COCK_UP_FRAC  * legLen;

  let targetFwd, targetUp;
  if (kick.stage === 'recovery') {
    // Recovery: target → rest, no detour through cock.
    targetFwd = fwd * tEff;
    targetUp  = up * tEff + (-legLen) * (1 - tEff);
  } else if (tEff < WINDUP_PEAK_TEFF) {
    // Load: rest → cock.
    const p = tEff / WINDUP_PEAK_TEFF;
    targetFwd =       0 * (1 - p) + cockFwd * p;
    targetUp  = -legLen * (1 - p) + cockUp  * p;
  } else {
    // Rise + strike-hold: cock → target.
    const p = (tEff - WINDUP_PEAK_TEFF) / (1 - WINDUP_PEAK_TEFF);
    targetFwd = cockFwd * (1 - p) + fwd * p;
    targetUp  = cockUp  * (1 - p) + up  * p;
  }
  solve2BoneIK(targetFwd, targetUp, STICKMAN_UPPER_LEG, STICKMAN_LOWER_LEG, _scratchIKRes);
  out.upperAngle = _scratchIKRes.upperAngle;
  out.lowerAngle = _scratchIKRes.lowerAngle;
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

// Punch variant thresholds, in world-xz units (pusher→victim
// distance projected onto the heading plane). Very-close contact
// wants an uppercut (rising arc, comes up under the chin); mid
// range is the hook (lateral sweep); farther range is the jab
// (straight-forward reach). All three still cover the same
// `PUSH_RANGE_X` gate, they just shape the animation differently.
const PUSH_UPPERCUT_RANGE = 14;
const PUSH_HOOK_RANGE     = 22;

function tryPush(state, pusher, victim, powerNorm) {
  const f = state.field;
  const pusherCenterX = pusher.x + f.playerWidth / 2;
  const victimCenterX = victim.x + f.playerWidth / 2;

  if (pusher.kick.active) return;
  if (pusher.pushTimer > 0) return;
  if (Math.abs(pusherCenterX - victimCenterX) > PUSH_RANGE_X) return;
  if (Math.abs(pusher.y - victim.y) > PUSH_RANGE_Y) return;

  const victimZ = (victim.y + PLAYER_HEIGHT / 2) * Z_STRETCH;
  if (!facingToward(pusher, victimCenterX, victimZ, PUSH_FACE_TOL)) return;

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

/** Snap the whole pitch back to its kickoff state in one tick —
 *  used by the headless training path after every goal or ball-out
 *  so the match budget isn't burned on celebrate/reposition/waiting
 *  pause frames that produce zero training signal. Teleports players
 *  to their starting spots, zeros all velocities + pending animation
 *  timers, drops the ball at midfield on the ground, and clears any
 *  pause/grace state. */
function resetToKickoff(state) {
  const f = state.field;
  const ball = state.ball;
  ball.x = f.midX;
  ball.y = FIELD_HEIGHT / 2;
  ball.z = 0;
  ball.vx = 0;
  ball.vy = 0;
  ball.vz = 0;
  ball.frozen = false;
  ball.inGoal = false;

  const cy = FIELD_HEIGHT / 2;
  const tx1 = f.midX - STARTING_GAP - f.playerWidth / 2;
  const tx2 = f.midX + STARTING_GAP - f.playerWidth / 2;
  const sides = [[state.p1, tx1], [state.p2, tx2]];
  for (let i = 0; i < sides.length; i++) {
    const p = sides[i][0];
    p.x = sides[i][1];
    p.y = cy;
    p.vx = 0; p.vy = 0;
    p.pushVx = 0; p.pushVy = 0;
    p.airZ = 0;
    p.pushTimer = 0;
    p.pendingPushVictim = null;
    p.pendingPushVx = 0;
    p.pendingPushVy = 0;
    p.reactTimer = 0;
    p.reactForce = 0;
    p.reactDirX = 0;
    p.reactDirZ = 0;
    p.reactLatSign = 1;
    p.kick.active = false;
    p.kick.timer = 0;
    p.kick.fired = false;
  }

  state.pauseState = null;
  state.pauseTimer = 0;
  state.goalScorer = null;
  state.graceFrames = 0;
  state.lastKickTick = state.tick;
}

function scoreGoal(state, side) {
  // Re-entrant guard — if a pause is already active (this shouldn't
  // normally fire once graceFrames is raised below, but belt-and-
  // braces for any post-score substep that still happens to match
  // the scoring gate), skip so we don't stack pause states.
  if (state.pauseState !== null) return;

  // Fresh legs for both sides on every goal. Stamina is otherwise
  // slow-regen only during reposition, which can leave exhausted
  // players visibly drained at kickoff for the next point.
  state.p1.stamina = 1;
  state.p2.stamina = 1;
  state.p1.exhausted = false;
  state.p2.exhausted = false;

  if (side === 'left') {
    // Ball into LEFT goal = RIGHT scored
    state.scoreR++;
    if (state.recordEvents) state.events.push({ type: 'goal', scorer: 'p2' });
    if (!state.headless) state.goalScorer = state.p2;
  } else {
    state.scoreL++;
    if (state.recordEvents) state.events.push({ type: 'goal', scorer: 'p1' });
    if (!state.headless) state.goalScorer = state.p1;
  }

  if (state.headless) {
    // Training matches follow the same "first to WIN_SCORE wins"
    // rule as the visual match. Capping training (rather than
    // running the full tick budget and racking up 30-0 blowouts)
    // makes training and visual statistics identical, bounds
    // goal-diff naturally to ±WIN_SCORE, and lets dominant brains
    // finish a match in seconds — more matches per wall-clock hour
    // means faster selection. Workers terminate their loop on
    // `state.matchOver`; physics just sets the flag.
    if (state.scoreL >= WIN_SCORE || state.scoreR >= WIN_SCORE) {
      state.matchOver = true;
      state.winner = state.scoreL >= WIN_SCORE ? 'left' : 'right';
    } else {
      resetToKickoff(state);
    }
    return;
  }

  // Ball keeps moving under gravity through the celebrate pause so a
  // scored shot visibly settles into the net instead of freezing in
  // mid-air. `inGoal` routes goal-box collisions through the inner
  // absorbing resolver (dampens completely, falls); graceFrames
  // suppresses any re-trigger of the scoring gate until the reset.
  state.ball.inGoal = true;
  state.graceFrames = RESPAWN_GRACE;
  state.pauseState = 'celebrate';
  state.pauseTimer = CELEBRATE_TICKS;

  // Winning goal: flag the winner now, but still run the full
  // celebrate animation. The advancePause celebrate handler detects
  // `state.winner` on pause-end and jumps straight to matchend
  // (bypassing reposition/waiting). Previously we overwrote
  // pauseState to 'matchend' here, which skipped the scorer's
  // celebrate pose entirely on the winning strike.
  if (state.scoreL >= WIN_SCORE || state.scoreR >= WIN_SCORE) {
    state.winner = state.scoreL >= WIN_SCORE ? 'left' : 'right';
  }
}

function ballOut(state) {
  // Re-entrant guard — during the pause that follows an out, the ball
  // keeps moving (per user spec) so the OOB check may still trip on
  // later ticks. Skip so we don't re-emit the event or restart the
  // pause clock.
  if (state.pauseState !== null) return;

  if (state.recordEvents) state.events.push({ type: 'out' });
  if (state.headless) {
    resetToKickoff(state);
    return;
  }
  // Ball keeps moving — gravity settles it naturally wherever it is.
  // Reposition pause drives the players back to kickoff; at the end
  // of the waiting pause, resetBall snaps the ball to midfield.
  state.pauseState = 'reposition';
  state.pauseTimer = 0;
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
  ball.inGoal = false;
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
      if (state.winner) {
        // Winning goal just celebrated — go straight to matchend
        // (no reposition; the match is over).
        state.pauseState = 'matchend';
        state.pauseTimer = MATCHEND_PAUSE_TICKS;
      } else {
        state.pauseState = 'reposition';
        state.pauseTimer = 0;
        state.goalScorer = null;
      }
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
      // End the post-goal cycle with a FULL kickoff reset (same one
      // the headless path uses on scoreGoal). Previously we only ran
      // resetBall here, which left player velocity/kick/push state
      // from the pre-goal tick intact. Worker and visual replay then
      // diverged on subsequent possessions — the worker saw a clean
      // kickoff, the visual saw players still decelerating. Using
      // the shared reset keeps the two bit-identical.
      resetToKickoff(state);
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

export const NN_INPUT_SIZE = 25;

/**
 * Action-repeat stride (a.k.a. frame-skip). The NN evaluates a fresh
 * action every `NN_ACTION_STRIDE` physics ticks; on the in-between
 * ticks the *previous* action vector is reused verbatim. Physics
 * still runs every tick, so ball trajectories and collisions stay
 * at the native 16 ms/tick resolution — only the decision cadence
 * widens.
 *
 * This is the classic RL "frame skip" optimisation: 2× here cuts NN
 * forward compute in half for essentially free, because our policy
 * is a slow control loop (walk + occasional kick) and action-repeat
 * over one extra 16 ms tick is imperceptible.
 *
 * CRITICAL: this constant must be the same number used by **both**
 * the headless worker and the visual showcase loop. Per memory
 * `feedback_training_visual_parity.md`, any mismatch causes the
 * brains you train to behave differently from the brains you watch,
 * and fitness selection silently picks up a bias. Keep both call
 * sites pointed at this single source of truth.
 */
export const NN_ACTION_STRIDE = 3;

/**
 * Build the NN input vector for one player, normalized to [-1, 1].
 * Length is NN_INPUT_SIZE.
 *
 * Raw state (0–19): self/opp pos+vel, ball pos+vel+z, target-goal
 * line, own-goal line, field width, heading cos/sin.
 *
 * Derived signals (20–24): pre-computed answers to questions the
 * teacher asks every tick. The NN can derive these from the raw
 * state given enough capacity, but exposing them directly cuts the
 * imitation sample complexity substantially.
 *   20 — possession:            sign+magnitude of whoever reaches the ball first
 *   21 — ball_speed_to_my_goal: signed component of ball velocity toward own goal
 *   22 — ball_range_to_my_goal: normalized distance from ball to own goal
 *   23 — self_dist_to_own_goal: normalized distance from me to own goal
 *   24 — self_dist_to_opp_goal: normalized distance from me to opponent goal
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
  out[18] = Math.cos(p.heading);
  out[19] = Math.sin(p.heading);

  // Derived signals — computed inline to avoid the extra fallback
  // import; `buildInputs` is on the hot path (~50k calls/sec during
  // training) so we want zero allocation and zero cross-module jumps.
  const cx = p.x + PLAYER_WIDTH / 2;
  const cy = p.y + PLAYER_HEIGHT / 2;
  const ocx = opp.x + PLAYER_WIDTH / 2;
  const ocy = opp.y + PLAYER_HEIGHT / 2;
  const myDx = b.x - cx, myDy = b.y - cy;
  const oppDx = b.x - ocx, oppDy = b.y - ocy;
  const myDist = Math.hypot(myDx, myDy);
  const oppDist = Math.hypot(oppDx, oppDy);
  // Possession: positive = I'm closer. Normalise by half field width
  // so the magnitude has a sensible [-1, 1] range.
  const possHalfWidth = fw * 0.5;
  out[20] = (oppDist - myDist) / possHalfWidth;

  // Ball velocity component toward OWN goal (negative = receding).
  // Magnitude normalised by MAX_KICK_POWER so shots read as ~1.
  const ownGoalY = FIELD_HEIGHT / 2;
  const ownDX = ogx - b.x, ownDY = ownGoalY - b.y;
  const ownDLen = Math.hypot(ownDX, ownDY) || 1;
  out[21] = (b.vx * ownDX + b.vy * ownDY) / (ownDLen * MAX_KICK_POWER);

  // Ball range to own goal, normalised (1 = full field length away).
  out[22] = Math.min(1, ownDLen / fw);

  // Self distances to own/opp goal, normalised.
  const selfOwnDist = Math.hypot(ogx - cx, ownGoalY - cy);
  const selfOppDist = Math.hypot(tgx - cx, ownGoalY - cy);
  out[23] = Math.min(1, selfOwnDist / fw);
  out[24] = Math.min(1, selfOppDist / fw);

  for (let i = 0; i < NN_INPUT_SIZE; i++) {
    out[i] = clamp(out[i], -1, 1);
  }
  return out;
}

/* ── Helpers ──────────────────────────────────────────────────── */

function clamp(v, lo, hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}
