// Channel catalogue for the animation state machine.
//
// A channel is a single named scalar value that the renderer consumes
// per frame to place a pose (torso tilt in radians, arm-swing
// amplitude, leg angle, etc.). Each channel has a "kind" that
// decides how its value is produced:
//
//   keyframed — value = sample(kf, t) from animation/keyframes.js
//   scaled    — value = sample(kf, t) * scalar(player, state)
//
// Per-state `ikGroups` (declared in keyframes.js) override channels
// for states where an IK solver writes them. Channels not listed in
// a state's keyframe map fall through to the default below.
//
// Adding a new animated joint = add a line here. Keep this file lean.

export const CHANNELS = {
  // Whole-body cosmetic curves driven purely by keyframes.
  torsoTilt:      { kind: 'keyframed', default: 0 },    // radians — forward/back lean of the spine
  hipTwist:       { kind: 'keyframed', default: 0 },    // radians — pelvis Y-axis twist
  bodyY:          { kind: 'keyframed', default: 0 },    // world units — vertical jump/bob offset
  supportCrouch:  { kind: 'keyframed', default: 0 },    // radians — micro-crouch on the planted leg
  headTilt:       { kind: 'keyframed', default: 0 },    // radians — head pitch/nod

  // Arm/leg swing angles (radians). In non-ik states these are
  // `scaled` so walk/run amplitude rides with speed automatically.
  // In kick/push states the IK-group claim overrides whichever side
  // is striking; the other side stays keyframed.
  armL_upper:     { kind: 'scaled', scaleBy: 'speed', default: 0 },
  armR_upper:     { kind: 'scaled', scaleBy: 'speed', default: 0 },
  legL_upper:     { kind: 'scaled', scaleBy: 'speed', default: 0 },
  legR_upper:     { kind: 'scaled', scaleBy: 'speed', default: 0 },

  // Celebration-specific. When the celebrate pose runs, these override
  // the swing channels via the blender (see animation/poses.js).
  celebJumpY:     { kind: 'keyframed', default: 0 },    // world units — jump-cycle vertical travel (crouch → launch → apex → land)
  celebArmSpread: { kind: 'keyframed', default: 0 },    // 0..1 — arms-overhead fraction
  celebLegSpread: { kind: 'keyframed', default: 0 },    // radians — forward/back leg split
};
