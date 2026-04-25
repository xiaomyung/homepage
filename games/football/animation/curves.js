// Polynomial curve functions + their tuning constants for the kick,
// airkick, and push body-english animations. Pure module (no DOM,
// no three.js) so it can be unit-tested under node AND imported
// from both the renderer and animation/poses.js without cycles.
//
// The functions take normalized phase t ∈ [0, 1] covering the full
// composite action (kick wind → strike → recover, or push raise →
// windup → strike → settle) and return the channel's contribution
// at that phase.

import { easeInOut, easeOut } from '../renderer-math.js';
import {
  KICK_WINDUP_MS, KICK_DURATION_MS,
  AIRKICK_MS, AIRKICK_PEAK_FRAC,
  STICKMAN_GLYPH_SIZE,
} from '../physics.js';

// ── Push body-english constants + sub-stage boundaries ───────
// PUSH_TOTAL_TICKS = ceil(PUSH_ANIM_MS (1000) / TICK_MS (16)) = 63.
// All Ts below are fractions of that window.
export const PUSH_TOTAL_TICKS  = 63;
export const PUSH_RAISE_T      = 0.15;
export const PUSH_WINDUP_T     = 0.35;
export const PUSH_STRIKE_T     = 0.50;
export const PUSH_SETTLE_T     = 0.70;
export const PUSH_WINDUP_DIST  = 0.70 * STICKMAN_GLYPH_SIZE;  // pivot pull-back
export const PUSH_CROUCH_DEPTH = 0.30 * STICKMAN_GLYPH_SIZE;  // upper body dip during windup
export const PUSH_HOP_DIST     = 0.40 * STICKMAN_GLYPH_SIZE;  // whole body hop on strike
export const PUSH_BACK_TILT    = 0.28;                        // rad — body leans back during windup
export const PUSH_FWD_TILT     = 0.42;                        // rad — body leans forward on strike

// ── Kick + airkick tuning ─────────────────────────────────────
// Sub-stage boundaries derive from physics ms constants so the
// animation phase always aligns with the actual strike moment.
export const KICK_STRIKE_SPAN_T   = 0.15;
export const KICK_FIRE_T          = KICK_WINDUP_MS / KICK_DURATION_MS;
export const KICK_STRIKE_END_T    = Math.min(0.95, KICK_FIRE_T + KICK_STRIKE_SPAN_T);
export const KICK_ARM_SWING       = Math.PI * 0.45;           // rad — counter-arm forward throw
export const KICK_ARM_OPP_FRAC    = 0.55;                     // same-side arm back-swing (counter-balance)
export const KICK_BACK_TILT       = 0.18;                     // rad — body lean back during windup
export const KICK_FWD_TILT        = 0.30;                     // rad — body lean forward on strike
export const KICK_CROUCH_DEPTH    = 0.18 * STICKMAN_GLYPH_SIZE; // body dip during windup

export const AIRKICK_STRIKE_SPAN_T = 0.20;
export const AIRKICK_STRIKE_END_T  = Math.min(0.95, AIRKICK_PEAK_FRAC + AIRKICK_STRIKE_SPAN_T);
export const AIRKICK_BACK_TILT     = 0.55;                    // rad — big back lean on volley

// Airborne-specific overrides on the shared kick rig:
//   • TUCK_THIGH / TUCK_SHIN — non-striking leg folds up under the
//     hip (knee-up, foot tucked behind), instead of the ground-kick
//     planted-leg micro-crouch.
//   • ARM_SPLAY — both arms swing back-and-down for in-air balance,
//     not opposite-forward like a ground kick's counter-swing.
//   • ARM_YAW — outward yaw on each shoulder so the arms spread
//     sideways rather than parallel.
//   • HIP_TWIST_FRAC — volleys are more axial than rotational, so
//     scale the shared hip twist down.
export const AIRKICK_TUCK_THIGH    = 1.20;                    // rad (~69°) — knee-up at peak
export const AIRKICK_TUCK_SHIN     = -1.40;                   // rad (~-80°) — shin folded back
export const AIRKICK_ARM_SPLAY     = 0.45;                    // rad (~26°) — both arms back at peak
export const AIRKICK_ARM_YAW       = 0.50;                    // rad (~29°) — outward shoulder yaw
export const AIRKICK_ARM_ELBOW_FLEX = 0.40;                   // rad (~23°) — extra forearm bend on top of forearmAngleFor
export const AIRKICK_HIP_TWIST_FRAC = 0.5;                    // shared kickHipTwist × this

export const KICK_HIP_TWIST_MAX    = Math.PI * 0.11;          // ~20° at windup peak
export const KICK_SUPPORT_CROUCH   = 0.35;                    // rad — upper-leg forward on support
export const KICK_SUPPORT_SHIN_RATIO = 2;                     // shin rotates this × upper (opposite sign)

// Blend window after `isKicking` flips on. The kick override pose
// crossfades in over this duration so an in-stride kick doesn't
// snap from "walk-cycle leg" to "neutral hanging" in a single
// frame. Kept short (~3 frames at 60fps) so the wind-up itself
// is not cosmetic.
export const KICK_START_BLEND_MS   = 50;

// ── Walk / run elbow flex ────────────────────────────────────
// Real humans keep the elbow bent while walking or running — the
// bend is phase-independent (elbow stays flexed through the whole
// swing cycle rather than collapsing to straight at mid-swing) and
// grows with speed: ~20° at a slow walk, ~90° at a sprint. Applied
// only to the pure-locomotion path; kick/push/celebrate/matchend
// keep their specialist arm poses (which use forearmAngleFor).
export const WALK_ELBOW_BEND_MAX   = Math.PI * 0.42;          // rad — full bend at sprint (~75°)

// ── Walk / run knee flex ─────────────────────────────────────
// Real walking/running: the knee stays mostly straight during the
// stance phase (foot on ground, body passing over) and folds hard
// during swing (foot off ground, leg passing forward under the
// hip). This is the OPPOSITE pattern to the old `shinAngleFor`
// which bent proportional to |thigh|. New model: stance bend is a
// small per-speed baseline; swing bend peaks at swing-midpoint and
// drops back to the baseline at heel-strike / toe-off.
export const WALK_STANCE_KNEE_BEND = 0.22;                    // rad — stance-phase bend (~13°) at full amp
export const WALK_SWING_KNEE_BEND  = 1.00;                    // rad — added at swing midpoint (~57°) at full amp

// ── Rest (exhausted-recovery) pose ──────────────────────────
// The upper torso wobbles in a small horizontal circle while legs
// stay planted. REST_UPPER_SWAY is the radius (world units) of the
// circle the neck traces — small enough that the figure reads as a
// dazed wobble rather than a full body lean.
export const REST_UPPER_SWAY    = 2.5;
// Tired bent-knee stance — thighs slightly forward, shins slightly
// back so the foot stays under the hip.
export const REST_THIGH_FORWARD = 0.16;  // rad — thigh leaning forward (~9°)
export const REST_SHIN_BACK     = -0.18; // rad — shin pulled back relative to thigh (knee bend ~19°)

// ── Curve functions ──────────────────────────────────────────

/**
 * Upper-body crouch depth during push. Body drops while the pivot
 * pulls back, snaps upright during the strike, settles at 0. Negative
 * values are subtracted from the upper body's Y so a negative result
 * means "lower than neutral."
 */
export function pushBodyDipAt(t) {
  if (t < PUSH_RAISE_T) return 0;
  if (t < PUSH_WINDUP_T) {
    const p = (t - PUSH_RAISE_T) / (PUSH_WINDUP_T - PUSH_RAISE_T);
    return -PUSH_CROUCH_DEPTH * easeOut(p);
  }
  if (t < PUSH_STRIKE_T) {
    const p = (t - PUSH_WINDUP_T) / (PUSH_STRIKE_T - PUSH_WINDUP_T);
    return -PUSH_CROUCH_DEPTH * (1 - p * p);
  }
  return 0;
}

/**
 * Whole-body horizontal hop during push. 0 during raise/windup, springs
 * forward with quadratic acceleration during strike, decays during settle.
 * Magnitude only — multiply by pushDir outside.
 */
export function pushHopAt(t) {
  if (t < PUSH_WINDUP_T) return 0;
  if (t < PUSH_STRIKE_T) {
    const p = (t - PUSH_WINDUP_T) / (PUSH_STRIKE_T - PUSH_WINDUP_T);
    return PUSH_HOP_DIST * p * p;
  }
  if (t < PUSH_SETTLE_T) {
    const p = (t - PUSH_STRIKE_T) / (PUSH_SETTLE_T - PUSH_STRIKE_T);
    return PUSH_HOP_DIST * (1 - easeInOut(p));
  }
  return 0;
}

/**
 * Split-stance magnitude during a push: one leg forward, one leg
 * behind. 0 at rest, eases up to 1 during the raise phase, holds
 * through windup + strike (feet stay planted while the body loads
 * and thrusts), eases back to 0 during settle. Unit-amplitude [0,1].
 */
export function pushLegStanceAt(t) {
  if (t < PUSH_RAISE_T) {
    return easeOut(t / PUSH_RAISE_T);
  }
  if (t < PUSH_STRIKE_T) return 1;
  if (t < PUSH_SETTLE_T) {
    const p = (t - PUSH_STRIKE_T) / (PUSH_SETTLE_T - PUSH_STRIKE_T);
    return 1 - easeOut(p);
  }
  return 0;
}

/**
 * Knee flex (squat) magnitude added on top of the stance: both knees
 * bend as the body loads, then extend as the strike fires. 0 at rest
 * and during the raise, ramps up through windup, peaks at the end of
 * windup, eases back to 0 by the end of the strike. Unit-amplitude
 * [0,1].
 */
export function pushLegSquatAt(t) {
  if (t < PUSH_RAISE_T) return 0;
  if (t < PUSH_WINDUP_T) {
    const p = (t - PUSH_RAISE_T) / (PUSH_WINDUP_T - PUSH_RAISE_T);
    return easeOut(p);
  }
  if (t < PUSH_STRIKE_T) {
    const p = (t - PUSH_WINDUP_T) / (PUSH_STRIKE_T - PUSH_WINDUP_T);
    return 1 - p * p;
  }
  return 0;
}

/**
 * Body lean along the player's heading as a signed "forward amount":
 * negative = lean back (windup loading), positive = lean forward
 * (strike release). Added directly to the walk-tilt term because
 * both live in the same heading-relative (forward, up) frame.
 */
export function pushBodyTiltAt(t) {
  if (t < PUSH_RAISE_T) return 0;
  if (t < PUSH_WINDUP_T) {
    const p = (t - PUSH_RAISE_T) / (PUSH_WINDUP_T - PUSH_RAISE_T);
    return -PUSH_BACK_TILT * easeOut(p);
  }
  if (t < PUSH_STRIKE_T) {
    const p = (t - PUSH_WINDUP_T) / (PUSH_STRIKE_T - PUSH_WINDUP_T);
    return -PUSH_BACK_TILT + (PUSH_BACK_TILT + PUSH_FWD_TILT) * (p * p);
  }
  if (t < PUSH_SETTLE_T) {
    const p = (t - PUSH_STRIKE_T) / (PUSH_SETTLE_T - PUSH_STRIKE_T);
    return PUSH_FWD_TILT * (1 - easeInOut(p));
  }
  return 0;
}

/**
 * Counter-balance arm swing: forward during windup + strike, returns
 * to 0 during recovery. Same shape for ground and airkick — the arm
 * doesn't need airkick-specific tuning because it isn't the load-
 * bearing limb.
 */
export function kickArmAngleAt(t) {
  if (t < KICK_FIRE_T) {
    const p = t / KICK_FIRE_T;
    return KICK_ARM_SWING * easeInOut(p);
  }
  if (t < KICK_STRIKE_END_T) return KICK_ARM_SWING;
  const p = (t - KICK_STRIKE_END_T) / (1 - KICK_STRIKE_END_T);
  return KICK_ARM_SWING * (1 - easeInOut(p));
}

/**
 * Body dip: crouch into the windup, spring back up on strike, settle
 * during recovery. Negative values lower the upper body.
 */
export function kickDipAt(t) {
  if (t < KICK_FIRE_T) {
    const p = t / KICK_FIRE_T;
    return -KICK_CROUCH_DEPTH * easeOut(p);
  }
  if (t < KICK_STRIKE_END_T) {
    const p = (t - KICK_FIRE_T) / (KICK_STRIKE_END_T - KICK_FIRE_T);
    return -KICK_CROUCH_DEPTH * (1 - p * p);
  }
  return 0;
}

/**
 * Body tilt during ground kick: lean back during windup, flip forward
 * through strike, settle during recovery.
 */
export function kickTiltAt(t) {
  if (t < KICK_FIRE_T) {
    const p = t / KICK_FIRE_T;
    return -KICK_BACK_TILT * easeOut(p);
  }
  if (t < KICK_STRIKE_END_T) {
    const p = (t - KICK_FIRE_T) / (KICK_STRIKE_END_T - KICK_FIRE_T);
    return -KICK_BACK_TILT + (KICK_BACK_TILT + KICK_FWD_TILT) * (p * p);
  }
  const p = (t - KICK_STRIKE_END_T) / (1 - KICK_STRIKE_END_T);
  return KICK_FWD_TILT * (1 - easeInOut(p));
}

/**
 * Body tilt during airkick: big back lean that holds through the
 * leap, settles as the player lands.
 */
export function airkickTiltAt(t) {
  if (t < AIRKICK_PEAK_FRAC) {
    const p = t / AIRKICK_PEAK_FRAC;
    return -AIRKICK_BACK_TILT * easeOut(p);
  }
  if (t < AIRKICK_STRIKE_END_T) return -AIRKICK_BACK_TILT;
  const p = (t - AIRKICK_STRIKE_END_T) / (1 - AIRKICK_STRIKE_END_T);
  return -AIRKICK_BACK_TILT * (1 - easeInOut(p));
}

/**
 * Tuck factor (0..1) for the non-striking leg during an airkick:
 * ramps up as the player leaves the ground, holds at full tuck
 * through the strike window, eases back to 0 as the player lands.
 * Mirrors the airkickTilt envelope so the leg fold tracks the leap.
 * Multiply by AIRKICK_TUCK_THIGH / AIRKICK_TUCK_SHIN at the call
 * site to drive the trailing leg's hip + knee.
 */
export function airkickTuckAt(t) {
  if (t < AIRKICK_PEAK_FRAC) {
    const p = t / AIRKICK_PEAK_FRAC;
    return easeOut(p);
  }
  if (t < AIRKICK_STRIKE_END_T) return 1;
  const p = (t - AIRKICK_STRIKE_END_T) / (1 - AIRKICK_STRIKE_END_T);
  return 1 - easeInOut(p);
}

/**
 * Pelvis twist around the vertical axis. +angle rotates the right
 * hip back (and left hip forward) — the wind-up position for a
 * right-footed kick. Strike snaps the hip through to −MAX (right
 * hip forward, follow-through); recovery eases back to 0. Shared
 * between ground and airkick.
 */
export function kickHipTwistAt(t) {
  if (t < KICK_FIRE_T) {
    const p = t / KICK_FIRE_T;
    return KICK_HIP_TWIST_MAX * easeInOut(p);
  }
  if (t < KICK_STRIKE_END_T) {
    const p = (t - KICK_FIRE_T) / (KICK_STRIKE_END_T - KICK_FIRE_T);
    return KICK_HIP_TWIST_MAX * (1 - 2 * easeInOut(p));
  }
  const p = (t - KICK_STRIKE_END_T) / (1 - KICK_STRIKE_END_T);
  return -KICK_HIP_TWIST_MAX * (1 - easeInOut(p));
}

/**
 * Support-leg (planted, non-kicking) micro-crouch. Kicks in at the
 * strike phase and fades through recovery. Used as the upper-leg
 * forward angle; the shin rotates the opposite way to keep the foot
 * roughly planted under the hip (knee-out crouch).
 */
export function kickSupportCrouchAt(t) {
  if (t < KICK_FIRE_T) return 0;
  if (t < KICK_STRIKE_END_T) {
    const p = (t - KICK_FIRE_T) / (KICK_STRIKE_END_T - KICK_FIRE_T);
    return KICK_SUPPORT_CROUCH * easeInOut(p);
  }
  const p = (t - KICK_STRIKE_END_T) / (1 - KICK_STRIKE_END_T);
  return KICK_SUPPORT_CROUCH * (1 - easeInOut(p));
}
