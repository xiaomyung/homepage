/**
 * Football v2 — physics tuning constants.
 *
 * Single source of truth for every physics tunable. Derived values
 * (e.g. *_TICKS computed from *_MS) live here too so callers never
 * recompute them. Other directories (renderer/, animation/, debug/,
 * ai/) import the world-model constants they need from this file via
 * physics/index.js. No magic numbers anywhere outside this file.
 */

/* ── Field & time ─────────────────────────────────────────────── */

export const FIELD_WIDTH_REF = 900;
export const FIELD_HEIGHT    = 54.6;
export const CEILING         = 100;
export const TICK_MS         = 16;

// Stale-segment detection: 10s of no-kick activity in headless training
// triggers a kickoff reset (see core.js / match-flow.js). 1s before
// reset, the user-visible game does a softer ball-only respawn.
export const STALL_TICKS = Math.ceil(10000 / TICK_MS);

/* ── Ball physics ─────────────────────────────────────────────── */

export const GRAVITY            = 0.3;
export const AIR_FRICTION       = 0.99;
export const GROUND_FRICTION    = 0.944;
export const BOUNCE_RETAIN      = 0.5;   // matches WALL_BOUNCE_DAMP so goal hits don't pop
export const AIR_BOUNCE         = 0.6;
export const WALL_BOUNCE_DAMP   = 0.5;
export const BOUNCE_VZ_MIN      = 1.5;
export const BALL_VEL_CUTOFF    = 0.1;
export const BALL_VEL_CUTOFF_SQ = BALL_VEL_CUTOFF * BALL_VEL_CUTOFF;
export const BALL_RADIUS        = 4.224;
export const RESPAWN_DROP_Z     = 60;
export const BOUNCE_EVENT_MIN   = 0.3; // suppress particle events below this magnitude

/* ── Player movement & posture ────────────────────────────────── */

export const MAX_PLAYER_SPEED   = 10;
export const PLAYER_ACCEL_TICKS = 20;
export const PLAYER_ACCEL       = MAX_PLAYER_SPEED / PLAYER_ACCEL_TICKS;
export const MOVE_THRESHOLD     = 0.1;
export const MOVE_THRESHOLD_SQ  = MOVE_THRESHOLD * MOVE_THRESHOLD;
export const STARTING_GAP       = 40;
export const PLAYER_WIDTH       = 18;
export const PLAYER_HEIGHT      = 6;
export const MIN_SPEED_STAMINA  = 0.3;
export const MOVE_INPUT_DEAD_ZONE = 0.02;

// Vertical depth scaling: a player whose footprint advances 1 world unit
// in y moves Z_STRETCH world units along the visible Z axis. Imported by
// renderer.js — single source of truth.
export const Z_STRETCH = 4.7;

export const PLAYER_TURN_TICKS = 20;            // ticks to complete a 180° turn
export const PLAYER_TURN_RATE  = Math.PI / PLAYER_TURN_TICKS;
export const KICK_FACE_TOL     = Math.PI / 3;   // 60° cone toward ball
export const PUSH_FACE_TOL     = Math.PI / 3;   // 60° cone toward victim

/* ── Stamina ──────────────────────────────────────────────────── */

export const STAMINA_REGEN              = 0.005;
export const STAMINA_MOVE_BASE          = 0.003;
export const STAMINA_MOVE_PER_UNIT      = 0.00036;
export const STAMINA_MOVE_THRESHOLD     = 0.1;
export const DIRECTION_CHANGE_DRAIN     = 0.02;
export const STAMINA_EXHAUSTION_THRESHOLD = 0.5;
export const STAMINA_KICK_DRAIN         = 0.3;
export const STAMINA_AIRKICK_DRAIN      = 0.1;

/* ── Stickman rig (shared with renderer + animation + debug) ───── */

export const STICKMAN_GLYPH_SIZE   = 22;
export const STICKMAN_HIP_OFX      = 0.12 * STICKMAN_GLYPH_SIZE;       // 2.64
export const STICKMAN_SHOULDER_OFX = 0.23814 * STICKMAN_GLYPH_SIZE;    // 5.2391
export const STICKMAN_SHOULDER_OFY = 0.92 * STICKMAN_GLYPH_SIZE;       // 20.24
export const STICKMAN_HEAD_GAP_Y   = 0.0476 * STICKMAN_GLYPH_SIZE;     // 1.047 — head tucked close to shoulders
export const STICKMAN_LIMB_FULL_H  = 20;                               // clean 10+10 split
export const STICKMAN_UPPER_LEG    = STICKMAN_LIMB_FULL_H / 2;         // 10
export const STICKMAN_LOWER_LEG    = STICKMAN_LIMB_FULL_H / 2;         // 10
export const STICKMAN_UPPER_ARM    = STICKMAN_LIMB_FULL_H / 2;         // 10
export const STICKMAN_LOWER_ARM    = STICKMAN_LIMB_FULL_H / 2;         // 10
export const STICKMAN_TORSO_RADIUS = 3.3;
export const STICKMAN_HEAD_RADIUS  = 4.0;
export const STICKMAN_LEG_RADIUS   = 2.2;
export const STICKMAN_LOWER_ARM_RADIUS = STICKMAN_LEG_RADIUS * 0.8;        // 1.76
export const STICKMAN_UPPER_ARM_RADIUS = STICKMAN_LOWER_ARM_RADIUS * 1.15; // ~2.024

// Body capsule + body-vs-ball collision tunables.
export const BODY_TANG_RETAIN              = 0.25;
export const TUNNEL_CORRECTION_MIN_SPEED   = 1.0;
export const TUNNEL_CORRECTION_BEHIND_DOT  = -0.3;
export const STUCK_ON_TOP_NORMAL_THRESHOLD = 0.95;
export const STUCK_ON_TOP_TANG_THRESHOLD   = 0.05;
export const STUCK_ON_TOP_SLIDE_SPEED      = 0.5;

// World-space anchors derived from the rig.
export const HIP_BASE_Z      = STICKMAN_LIMB_FULL_H;                                // 20
export const SHOULDER_Z      = HIP_BASE_Z + STICKMAN_SHOULDER_OFY;                   // 40.24
export const HEAD_CENTER_Z   = SHOULDER_Z + STICKMAN_HEAD_GAP_Y + STICKMAN_HEAD_RADIUS; // 47.11
export const KICK_REACH_MAX  = STICKMAN_UPPER_LEG + STICKMAN_LOWER_LEG;              // 20

/* ── Goal frame ───────────────────────────────────────────────── */

export const GOAL_BACK_OFFSET   = 30;
export const GOAL_DEPTH         = 78;
export const GOAL_LINE_INSET    = 6; // scoring line sits this far inside the mouth
export const GOAL_POST_RADIUS   = 1.2;
export const GOAL_MOUTH_Z       = 58.5;  // crossbar height
export const ROOF_FRACTION      = 0.35;  // flat roof spans [mouthX..roofBackX] of the depth
export const GOAL_MOUTH_WIDTH   = 28.6;  // y-span of the mouth
export const GOAL_MOUTH_Y_MIN   = (FIELD_HEIGHT - GOAL_MOUTH_WIDTH) / 2;
export const GOAL_MOUTH_Y_MAX   = (FIELD_HEIGHT + GOAL_MOUTH_WIDTH) / 2;

/* ── Match flow ───────────────────────────────────────────────── */

export const WIN_SCORE                     = 3;
export const CELEBRATE_TICKS               = Math.ceil(1500 / TICK_MS);
export const MATCHEND_REPOSITION_MAX_TICKS = Math.ceil(4000 / TICK_MS);
export const MATCHEND_POSE_TICKS           = Math.ceil(4000 / TICK_MS);
export const MATCHEND_NEUTRAL_TICKS        = Math.ceil(2500 / TICK_MS);
export const RESPAWN_GRACE                 = 30;
export const REPOSITION_SPEED              = 6;
export const REPOSITION_TOL                = 5;
export const REPOSITION_LERP_FRAC          = 0.1;
export const REPOSITION_Y_SPEED_FRAC       = 0.5;
export const RESPAWN_DELAY_TICKS           = Math.ceil(300 / TICK_MS);

/* ── Kick ─────────────────────────────────────────────────────── */

export const MAX_KICK_POWER          = 22;
export const MIN_KICK_POWER          = 0.15;
export const MIN_KICK_STAMINA        = 0.2;
export const KICK_NOISE_SCALE        = 0.3;
export const KICK_NOISE_VERT         = 0.5;
export const AIRKICK_MAX_Z           = 20;
export const AIRKICK_MS              = 350;
export const AIRKICK_PEAK_FRAC       = 0.5;
export const AIRKICK_DZ_THRESHOLD    = 0.5;
export const KICK_WINDUP_MS          = 96;
export const KICK_DURATION_MS        = 288;
export const KICK_STRIKE_WINDOW_MS   = 48;
export const FOOT_RADIUS             = 1.5;
export const KICK_DIR_MIN_LEN        = 0.01;
export const WASTED_KICK_SPEED       = MIN_KICK_POWER * 0.1;
export const LATERAL_FOOT_FLEX       = 6;
export const FOOT_BALL_CONTACT_R     = FOOT_RADIUS + BALL_RADIUS;
export const FOOT_LATERAL_REACH      = LATERAL_FOOT_FLEX + FOOT_BALL_CONTACT_R;

// Kick-pose internals (read by kickLegPose / advanceKick).
export const WINDUP_PEAK_TEFF        = 0.7;
export const WINDUP_LOAD_FRAC        = 0.7;
export const KICK_COCK_FWD_FRAC      = 0.20; // foot 20% of leg-length behind hip
export const KICK_COCK_UP_FRAC       = 0.50; // foot at 50% of leg-length below hip

/* ── Push ─────────────────────────────────────────────────────── */

export const PUSH_RANGE_X            = 30;
export const PUSH_RANGE_SLACK_Y      = 1;
export const PUSH_RANGE_Y            = PLAYER_HEIGHT + PUSH_RANGE_SLACK_Y;
export const MAX_PUSH_FORCE          = 100;
export const PUSH_DAMP               = 0.88;
export const PUSH_APPLY              = 0.12;
export const PUSH_VEL_THRESHOLD      = 0.5;
export const PUSH_VEL_THRESHOLD_SQ   = PUSH_VEL_THRESHOLD * PUSH_VEL_THRESHOLD;
export const MIN_PUSH_STAMINA        = 0.2;
export const PUSH_ANIM_MS            = 1000;
export const REACT_ANIM_MS           = 550;
export const PUSH_WINDUP_FRAC        = 0.35; // windup → strike transition
export const PUSH_STRIKE_FRAC        = 0.50; // strike → recover transition
export const PUSH_WINDUP_PEAK_TEFF   = 0.7;
export const PUSH_STAMINA_COST       = 0.15;
export const PUSH_VICTIM_STAMINA_MULT = 3;
export const PUSH_UPPERCUT_RANGE     = 14;
export const PUSH_HOOK_RANGE         = 22;

// Strike-commit timing per type. Different types engage at different
// pair distances (uppercut PUSH_UPPERCUT_RANGE=14, hook <22, jab
// <PUSH_RANGE_X=30), so the arm extends further for a jab than an
// uppercut.
export const PUSH_CONTACT_FRAC = {
  jab:      0.47,
  hook:     0.46,
  uppercut: 0.42,
};

// pushTimer counts DOWN from PUSH_ANIM_MS, so each type fires at
// PUSH_ANIM_MS * (1 - PUSH_CONTACT_FRAC[type]).
export const PUSH_STRIKE_TIMER = {
  jab:      PUSH_ANIM_MS * (1 - PUSH_CONTACT_FRAC.jab),
  hook:     PUSH_ANIM_MS * (1 - PUSH_CONTACT_FRAC.hook),
  uppercut: PUSH_ANIM_MS * (1 - PUSH_CONTACT_FRAC.uppercut),
};

/* ── Push keyframes (4-channel pose: upper-pitch, lower-pitch, upper-yaw, lower-yaw) ── */

export const JAB_REST   = [0,    0,    0, 0];
export const JAB_WINDUP = [-0.25, 2.4, 0, 0];
export const JAB_STRIKE = [1.92, 1.92, 0, 0];

export const HOOK_REST   = [0,    0,    0,           0];
export const HOOK_WINDUP = [1.92, 1.92, Math.PI / 2, 0];
export const HOOK_STRIKE = [1.92, 1.92, -0.35,      -1.2];

export const UPPERCUT_REST   = [0,    0,    0,     0];
export const UPPERCUT_WINDUP = [-0.3, 1.7,  0,     0];
export const UPPERCUT_STRIKE = [2.0,  3.0,  -0.50, -0.80];

/* ── Action vector layout (shared with ai/) ───────────────────── */

export const ACTION_MOVE_X     = 0;
export const ACTION_MOVE_Y     = 1;
export const ACTION_KICK_GATE  = 2;
export const ACTION_KICK_DX    = 3;
export const ACTION_KICK_DY    = 4;
export const ACTION_KICK_DZ    = 5;
export const ACTION_KICK_POWER = 6;
export const ACTION_PUSH_GATE  = 7;
export const ACTION_PUSH_POWER = 8;
export const ACTION_VEC_SIZE   = 9;
