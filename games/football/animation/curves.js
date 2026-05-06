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
import { AIRKICK_PEAK_FRAC } from '../physics.js';
import {
  PUSH_RAISE_T, PUSH_WINDUP_T, PUSH_STRIKE_T, PUSH_SETTLE_T,
  PUSH_CROUCH_DEPTH, PUSH_HOP_DIST,
  PUSH_BACK_TILT, PUSH_FWD_TILT,
  KICK_FIRE_T, KICK_STRIKE_END_T,
  KICK_ARM_SWING, KICK_BACK_TILT, KICK_FWD_TILT, KICK_CROUCH_DEPTH,
  KICK_HIP_TWIST_MAX, KICK_SUPPORT_CROUCH,
  AIRKICK_STRIKE_END_T, AIRKICK_BACK_TILT,
  WALK_ELBOW_BEND_MAX, WALK_STANCE_KNEE_BEND, WALK_SWING_KNEE_BEND,
  REST_UPPER_SWAY, REST_THIGH_FORWARD, REST_SHIN_BACK,
} from './tuning.js';
// Re-export the full tuning surface so any consumer that previously
// imported these from curves.js keeps working.
export * from './tuning.js';

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
