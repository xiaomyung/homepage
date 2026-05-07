// Keyframe data per animation sub-stage. Each top-level entry is a
// kick / airkick / push sub-stage; channels not listed fall through
// to the `default` in channels.js. Authoring scaffolding for the
// future visual editor — composeStickmanPose still evaluates
// curves.js polynomials directly. animation-keyframes.test.mjs
// asserts boundary continuity (±2% over 200 samples) against curves.

import {
  KICK_CROUCH_DEPTH, PUSH_CROUCH_DEPTH, PUSH_HOP_DIST,
  KICK_BACK_TILT, KICK_FWD_TILT, KICK_ARM_SWING,
  KICK_HIP_TWIST_MAX, KICK_SUPPORT_CROUCH,
  AIRKICK_BACK_TILT, PUSH_BACK_TILT, PUSH_FWD_TILT,
} from './tuning.js';

// Each state's `t` runs 0..1 over its own stage. The keyframes
// encode the portions of the polynomial curves that apply inside
// that stage, re-normalized.

export const KEYFRAMES = {
  // ─── Kick — ground ──────────────────────────────────────────
  KICK_WIND: {
    // During windup the torso tilts BACK (negative = backwards lean
    // in the heading-relative forward/up frame), body dips
    // (supportCrouch starts at 0 — the planted-leg crouch only
    // appears in STRIKE). Counter-arm swings forward.
    torsoTilt:     [{ t: 0, v: 0 }, { t: 1, v: -KICK_BACK_TILT, ease: 'out' }],
    bodyY:         [{ t: 0, v: 0 }, { t: 1, v: -KICK_CROUCH_DEPTH, ease: 'out' }],
    hipTwist:      [{ t: 0, v: 0 }, { t: 1, v: +KICK_HIP_TWIST_MAX }],
    armR_upper:    [{ t: 0, v: 0 }, { t: 1, v: +KICK_ARM_SWING }],
    supportCrouch: [{ t: 0, v: 0 }, { t: 1, v: 0 }],
  },
  KICK_STRIKE: {
    // Striking leg is IK-driven toward the ball; other channels
    // snap from windup-loaded to strike-released.
    ikGroups: [
      { solver: 'kickLeg', target: 'kick.footTarget',
        channels: ['legR_upper'] },
    ],
    torsoTilt:     [{ t: 0, v: -KICK_BACK_TILT }, { t: 1, v: +KICK_FWD_TILT }],
    bodyY:         [{ t: 0, v: -KICK_CROUCH_DEPTH }, { t: 1, v: 0 }],
    hipTwist:      [{ t: 0, v: +KICK_HIP_TWIST_MAX }, { t: 1, v: -KICK_HIP_TWIST_MAX }],
    armR_upper:    [{ t: 0, v: +KICK_ARM_SWING }, { t: 1, v: +KICK_ARM_SWING }],
    supportCrouch: [{ t: 0, v: 0 }, { t: 1, v: +KICK_SUPPORT_CROUCH }],
  },
  KICK_RECOVER: {
    torsoTilt:     [{ t: 0, v: +KICK_FWD_TILT }, { t: 1, v: 0 }],
    bodyY:         [{ t: 0, v: 0 }, { t: 1, v: 0 }],
    hipTwist:      [{ t: 0, v: -KICK_HIP_TWIST_MAX }, { t: 1, v: 0 }],
    armR_upper:    [{ t: 0, v: +KICK_ARM_SWING }, { t: 1, v: 0 }],
    supportCrouch: [{ t: 0, v: +KICK_SUPPORT_CROUCH }, { t: 1, v: 0 }],
  },

  // ─── Airkick ────────────────────────────────────────────────
  // AIRKICK_LEAP corresponds to 0..AIRKICK_PEAK_FRAC of the airkick
  // (body leans way back, player rises on airZ). AIRKICK_STRIKE is
  // the volley contact window. AIRKICK_LAND is the descent.
  AIRKICK_LEAP: {
    torsoTilt:  [{ t: 0, v: 0 }, { t: 1, v: -AIRKICK_BACK_TILT, ease: 'out' }],
    hipTwist:   [{ t: 0, v: 0 }, { t: 1, v: +KICK_HIP_TWIST_MAX }],
    armR_upper: [{ t: 0, v: 0 }, { t: 1, v: +KICK_ARM_SWING }],
  },
  AIRKICK_STRIKE: {
    ikGroups: [
      { solver: 'kickLeg', target: 'kick.footTarget',
        channels: ['legR_upper'] },
    ],
    // Back tilt holds through the contact window — cleaner than
    // snapping forward and back mid-volley.
    torsoTilt:  [{ t: 0, v: -AIRKICK_BACK_TILT }, { t: 1, v: -AIRKICK_BACK_TILT }],
    hipTwist:   [{ t: 0, v: +KICK_HIP_TWIST_MAX }, { t: 1, v: -KICK_HIP_TWIST_MAX }],
    armR_upper: [{ t: 0, v: +KICK_ARM_SWING }, { t: 1, v: +KICK_ARM_SWING }],
  },
  AIRKICK_LAND: {
    torsoTilt:  [{ t: 0, v: -AIRKICK_BACK_TILT }, { t: 1, v: 0 }],
    hipTwist:   [{ t: 0, v: -KICK_HIP_TWIST_MAX }, { t: 1, v: 0 }],
    armR_upper: [{ t: 0, v: +KICK_ARM_SWING }, { t: 1, v: 0 }],
  },

  // ─── Push ───────────────────────────────────────────────────
  // The original push curve has 4 sub-stages (RAISE / WINDUP /
  // STRIKE / SETTLE). We collapse to 3 FSM sub-states with natural
  // stage boundaries.
  PUSH_WIND: {
    torsoTilt: [{ t: 0, v: 0 }, { t: 1, v: -PUSH_BACK_TILT, ease: 'out' }],
    bodyY:     [{ t: 0, v: 0 }, { t: 1, v: -PUSH_CROUCH_DEPTH, ease: 'out' }],
  },
  PUSH_STRIKE: {
    // Striking arm is IK-driven toward the push target; other
    // channels flip from windup-back to strike-forward.
    ikGroups: [
      { solver: 'pushArm', target: 'pushTarget',
        channels: ['armR_upper'] },
    ],
    torsoTilt: [{ t: 0, v: -PUSH_BACK_TILT }, { t: 1, v: +PUSH_FWD_TILT }],
    bodyY:     [{ t: 0, v: -PUSH_CROUCH_DEPTH }, { t: 1, v: 0 }],
    // hipTwist channel carries forward-hop distance here (deliberate
    // unit mismatch with channels.js until a dedicated bodyHop channel
    // is added).
    hipTwist:  [{ t: 0, v: 0 }, { t: 1, v: +PUSH_HOP_DIST }],
  },
  PUSH_RECOVER: {
    torsoTilt: [{ t: 0, v: +PUSH_FWD_TILT }, { t: 1, v: 0 }],
    hipTwist:  [{ t: 0, v: +PUSH_HOP_DIST }, { t: 1, v: 0 }],
  },
};
