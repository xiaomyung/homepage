// Animation tuning constants. Single source of truth for every
// numeric coefficient consumed by animation/state.js, animation/curves.js
// and animation/poses.js — and through them, by renderer.js. Pure
// module — no DOM, no three.js. World-model constants come from
// physics.js as needed.

import {
  AIRKICK_PEAK_FRAC,
  KICK_DURATION_MS, KICK_WINDUP_MS,
  STICKMAN_GLYPH_SIZE,
} from '../physics/index.js';

/* ── Smoothing + phase-rate tuning (state.js) ────────────────── */

// Low-pass smoothing factor for tilt / amplitude / celebrate. Values
// converge to their targets in ~1/STICKMAN_SMOOTH frames.
export const STICKMAN_SMOOTH = 0.15;

// Walk-tilt shape. Below RUN_THRESHOLD, no forward/back lean. Above
// it, tilt grows linearly with speed up to TILT_MAX.
export const STICKMAN_RUN_THRESHOLD  = 1.2;
export const STICKMAN_TILT_PER_SPEED = 0.09;
export const STICKMAN_TILT_MAX       = 0.45;

// Phase rates — radians per tick of phase advance.
export const CELEB_PHASE_RATE  = 0.125;  // ~0.8 s per fist-pump
export const GRIEVE_PHASE_RATE = 0.08;   // ~80 ticks per cycle ≈ 1.3 s
export const REST_PHASE_RATE   = 0.10;   // ~62 ticks per full rotation ≈ 1 s

// Heading the matchend pose snaps to so winner/loser both face the
// camera (+z world axis = π/2 in the heading frame).
export const FACE_CAMERA_HEADING = Math.PI / 2;

// TURN / STOP detection thresholds.
export const TURN_ANGVEL_SCALE = 0.08;   // rad/tick that reads as "full turn"
export const STOP_DECEL_SCALE  = 0.8;    // u/tick² deceleration that reads as "full stop brake"

// Walk-cycle tuning. Amplitude grows linearly with speed up to a cap.
export const WALK_AMP_PER_SPEED   = 0.35;
export const WALK_AMP_MAX         = 1.0;
export const SWING_RATE_BASE      = 0.2;
export const SWING_RATE_PER_SPEED = 0.04;

// Reposition heading-override gate.
export const REPOSITION_SPEED_GATE = 0.3;

// State-label gates (advisory `out.state` only).
export const STATE_LABEL_STOP_GATE = 0.5;
export const STATE_LABEL_TURN_GATE = 0.5;
export const STATE_LABEL_WALK_GATE = 0.5;

export const TWO_PI = Math.PI * 2;

/* ── Push body-english (curves.js) ───────────────────────────── */

// PUSH_TOTAL_TICKS = ceil(PUSH_ANIM_MS (1000) / TICK_MS (16)) = 63.
// All Ts below are fractions of that window.
export const PUSH_TOTAL_TICKS  = 63;
export const PUSH_RAISE_T      = 0.15;
export const PUSH_WINDUP_T     = 0.35;
export const PUSH_STRIKE_T     = 0.50;
export const PUSH_SETTLE_T     = 0.70;
export const PUSH_CROUCH_DEPTH = 0.30 * STICKMAN_GLYPH_SIZE;
export const PUSH_HOP_DIST     = 0.40 * STICKMAN_GLYPH_SIZE;
export const PUSH_BACK_TILT    = 0.28;   // rad — body leans back during windup
export const PUSH_FWD_TILT     = 0.42;   // rad — body leans forward on strike

/* ── Kick body-english (curves.js) ───────────────────────────── */

// Sub-stage boundaries derive from physics ms constants so the
// animation phase always aligns with the actual strike moment.
export const KICK_STRIKE_SPAN_T   = 0.15;
export const KICK_FIRE_T          = KICK_WINDUP_MS / KICK_DURATION_MS;
export const KICK_STRIKE_END_T    = Math.min(0.95, KICK_FIRE_T + KICK_STRIKE_SPAN_T);
export const KICK_ARM_SWING       = Math.PI * 0.45;             // counter-arm forward throw
export const KICK_ARM_OPP_FRAC    = 0.55;                       // same-side arm back-swing
export const KICK_BACK_TILT       = 0.18;                       // rad — body lean back during windup
export const KICK_FWD_TILT        = 0.30;                       // rad — body lean forward on strike
export const KICK_CROUCH_DEPTH    = 0.18 * STICKMAN_GLYPH_SIZE; // body dip during windup
export const KICK_HIP_TWIST_MAX   = Math.PI * 0.11;             // ~20° at windup peak
export const KICK_SUPPORT_CROUCH  = 0.35;                       // rad — upper-leg forward on support
export const KICK_SUPPORT_SHIN_RATIO = 2;                       // shin rotates this × upper (opposite sign)

// Blend window after `isKicking` flips on so an in-stride kick
// crossfades in over ~3 frames at 60fps instead of snapping.
export const KICK_START_BLEND_MS = 50;

/* ── Airkick overrides (curves.js) ───────────────────────────── */

export const AIRKICK_STRIKE_SPAN_T  = 0.20;
export const AIRKICK_STRIKE_END_T   = Math.min(0.95, AIRKICK_PEAK_FRAC + AIRKICK_STRIKE_SPAN_T);
export const AIRKICK_BACK_TILT      = 0.55;   // big back lean on volley
export const AIRKICK_TUCK_THIGH     = 1.20;   // rad (~69°) — knee-up at peak
export const AIRKICK_TUCK_SHIN      = -1.40;  // rad (~-80°) — shin folded back
export const AIRKICK_ARM_SPLAY      = 0.45;   // rad (~26°) — both arms back at peak
export const AIRKICK_ARM_YAW        = 0.50;   // rad (~29°) — outward shoulder yaw
export const AIRKICK_ARM_ELBOW_FLEX = 0.40;   // rad (~23°) — extra forearm bend
export const AIRKICK_HIP_TWIST_FRAC = 0.5;    // shared kickHipTwist × this

/* ── Walk locomotion (curves.js + poses.js) ──────────────────── */

// Elbow bends grow with speed; ~20° at slow walk, ~75° at sprint.
export const WALK_ELBOW_BEND_MAX   = Math.PI * 0.42;

// Knee flex pattern — straight through stance, folds hard through swing.
export const WALK_STANCE_KNEE_BEND = 0.22;   // rad — stance-phase baseline at full amp
export const WALK_SWING_KNEE_BEND  = 1.00;   // rad — peak swing-midpoint flex at full amp

// Walk-cycle base shape (pure-locomotion arms/legs). armSwingBias
// shifts the centre BACKWARD so the back-swing reaches further.
export const WALK_ARM_SWING_COEF = 0.72;
export const WALK_LEG_SWING_COEF = 0.7;
export const WALK_ARM_SWING_BIAS = -0.18;
export const WALK_BOB_FRAC       = 0.08;

/* ── Rest pose (curves.js) ───────────────────────────────────── */

export const REST_UPPER_SWAY    = 2.5;
export const REST_THIGH_FORWARD = 0.16;   // rad — thigh leaning forward (~9°)
export const REST_SHIN_BACK     = -0.18;  // rad — shin pulled back (knee bend ~19°)

/* ── Hit reactions (poses.js) ────────────────────────────────── */

export const REACT_JAB_BODY_TILT   = 0.70;          // rad — full-force jab tilt
export const REACT_JAB_HEAD_BACK   = 0.95;          // rad — head snaps back
export const REACT_HOOK_BODY_ROLL  = 0.80;          // rad — dominant lateral torso roll
export const REACT_HOOK_BODY_TILT  = 0.20;          // rad — small axial follow
export const REACT_HOOK_HEAD_SIDE  = 1.30;          // rad — head whips sideways
export const REACT_UPPER_BODY_BACK = 0.50;          // rad — body rocks back
export const REACT_UPPER_HIP_LIFT  = 7.0;           // world units — hip lurches up
export const REACT_UPPER_HEAD_UP   = 1.10;          // rad — head jerks up + back
export const REACT_ARM_THROW       = Math.PI / 2.8; // ≈64° forward at peak

/* ── Celebration (poses.js) ──────────────────────────────────── */

export const CELEB_JUMP_PEAK     = 0.55 * STICKMAN_GLYPH_SIZE;
export const CELEB_CROUCH_DEPTH  = 0.32 * STICKMAN_GLYPH_SIZE;
export const CELEB_LEG_SQUAT     = 0.60;   // rad thigh-fwd / shin-back at crouch
export const CELEB_ARM_RAISE_MAX = 0.95;   // × π — arms near straight up at apex
export const CELEB_ARM_RAISE_REST = 0.80;  // × π — between jumps, fists still raised
export const CELEB_ARM_PUMP      = 0.14;   // × π — symmetric fist-pump amplitude
export const CELEB_ARM_YAW       = 0.22;   // rad — outward lateral spread for the V
export const CELEB_ARM_PUMP_RATE = 2;      // fist-pumps per on-ground rest phase

/* ── Stop / turn micro-poses (poses.js) ──────────────────────── */

export const STOP_BACK_TILT_MAX = 0.22;
export const TURN_BODY_DIP_MAX  = 1.4;     // world units subtracted from upperHipY at full turn

/* ── Matchend (poses.js) ─────────────────────────────────────── */

export const MATCH_WIN_ARM_UPPER  =  2.3;     // ~132° — arms raised up-and-out
export const MATCH_WIN_ARM_LOWER  =  2.3;     // forearms straight in line with upper
export const MATCH_WIN_ARM_YAW    =  0.25;    // rad — outward lateral spread
export const MATCH_LOSE_TILT      =  0.30;    // rad — moderate forward slump
export const MATCH_LOSE_ARM_UPPER = -0.25;    // arms slightly behind vertical

/* ── LPF tail dead-zone (poses.js) ───────────────────────────── */

export const LPF_DEAD_ZONE = 0.001;

/* ── Sampler (sampler.js) ────────────────────────────────────── */

// Step-ease threshold: <1 lets `u===1` still hit the high branch
// across float-rounding paths.
export const STEP_EASE_THRESHOLD = 0.9999;

/* ── REPOSITION heading LPF override (state.js) ──────────────── */

// Multiplier on STICKMAN_SMOOTH for the animHeading LPF during
// REPOSITION so the walk-back faces motion instead of edge-on.
export const ANIM_HEADING_LPF_MULT = 2;

/* ── Push split-stance + squat (poses.js) ────────────────────── */

export const PUSH_FRONT_THIGH = 0.28;   // rad — lead leg forward at full stance
export const PUSH_REAR_THIGH  = 0.35;   // rad — rear leg back at full stance
export const PUSH_SQUAT_FLEX  = 0.35;   // rad — knee bend on top of stance during squat

/* ── Grieve pose (poses.js) ──────────────────────────────────── */

export const GRIEVE_KNEEL_DROP = 7.88;            // standing→kneeling hip-Y drop
export const GRIEVE_BASE_TILT  = 0.45;            // rad — forward body lean
export const GRIEVE_ROCK_AMP   = 0.10;            // rad — gentle sway amplitude
export const GRIEVE_LEG_UPPER  = Math.PI / 6;     // +30° — thigh tilted forward
export const GRIEVE_LEG_LOWER  = -Math.PI / 2;    // shin horizontal backward
export const GRIEVE_ARM_UPPER     = 1.22;         // 70° — upper arm forward
export const GRIEVE_ARM_LOWER     = -2.57;        // −147° — forearm bent back to face
export const GRIEVE_ARM_UPPER_YAW = 0.05;         // inward tilt of upper-arm plane
export const GRIEVE_ARM_LOWER_YAW = 1.0;          // strong inward yaw on forearms
