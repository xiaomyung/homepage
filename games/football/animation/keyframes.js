// Keyframe data per animation sub-stage.
//
// Each top-level entry is a kick / airkick / push sub-stage
// (WIND / STRIKE / RECOVER / LEAP / LAND) — finer granularity than
// the state.js FSM labels (KICK_GROUND / KICK_AIR / PUSH).
// Inside each entry:
//   ikGroups  — optional list of IK claims; future use only. The
//               composer in poses.js currently ignores this and
//               calls kickLegPose / pushArmPose directly.
//   <channel> — keyframe arrays, one per keyframed (or scaled)
//               channel. Channels not listed fall through to the
//               `default` in channels.js.
//
// THIS FILE IS DEAD DATA TODAY. composeStickmanPose still evaluates
// curves.js polynomials directly; keyframes.js exists as authoring
// scaffolding for a future visual editor. Keep values in sync with
// curves.js — animation-keyframes.test.mjs asserts the boundary
// continuity within ±2% over 200 samples.

// ── Constants mirrored from animation/curves.js ───────────────
// Kept local so this file stays import-cycle-free. Resync if the
// curves.js values drift; the boundary-continuity test will catch
// any divergence.
const STICKMAN_GLYPH_SIZE = 22;
const KICK_CROUCH_DEPTH   = 0.18 * STICKMAN_GLYPH_SIZE;
const PUSH_CROUCH_DEPTH   = 0.30 * STICKMAN_GLYPH_SIZE;
const PUSH_HOP_DIST       = 0.40 * STICKMAN_GLYPH_SIZE;
const KICK_BACK_TILT      = 0.18;
const KICK_FWD_TILT       = 0.30;
const KICK_ARM_SWING      = Math.PI * 0.45;
const KICK_HIP_TWIST_MAX  = Math.PI * 0.11;
const KICK_SUPPORT_CROUCH = 0.35;
const AIRKICK_BACK_TILT   = 0.55;
const PUSH_BACK_TILT      = 0.28;
const PUSH_FWD_TILT       = 0.42;

// Composite-kick stage boundaries (fraction of full kick duration).
// KICK_WIND   : 0      .. KICK_FIRE_T
// KICK_STRIKE : KICK_FIRE_T .. KICK_STRIKE_END_T
// KICK_RECOVER: KICK_STRIKE_END_T .. 1
// Stage boundaries are derived from physics constants (KICK_WINDUP_MS /
// KICK_DURATION_MS / AIRKICK_PEAK_FRAC), so the exact fractions move
// when those tune. See `animation/curves.js` for the live values.

// Each state's `t` runs 0..1 over its own stage. The keyframes
// below encode the portions of the existing polynomial curves that
// apply inside that stage, re-normalized.

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
    // HACK — overload the hipTwist channel to carry the forward hop
    // distance until a dedicated bodyHop channel is added. channels.js
    // declares hipTwist as radians, so this is a deliberate type
    // mismatch parked here for the future composer migration.
    hipTwist:  [{ t: 0, v: 0 }, { t: 1, v: +PUSH_HOP_DIST }],
  },
  PUSH_RECOVER: {
    torsoTilt: [{ t: 0, v: +PUSH_FWD_TILT }, { t: 1, v: 0 }],
    hipTwist:  [{ t: 0, v: +PUSH_HOP_DIST }, { t: 1, v: 0 }],
  },

  // ─── Locomotion / dead-ball / misc — not yet authored ───────
  // IDLE / WALK / RUN / TURN / STOP / CELEBRATE / GRIEVE /
  // MATCHEND_WIN / MATCHEND_LOSE / REPOSITION / WAITING / EXHAUSTED
  // Locomotion + dead-ball are still driven by curves + smoothed
  // factors in animation/poses.js; migrating each to a keyframe
  // block is a future phase.
};
