// Stickman pose composer.
//
// Takes the per-frame animation snapshot (from state.js) plus the
// physics player and produces a flat pose object the renderer
// consumes to place meshes. Pure — no DOM, no three.js.
//
// This function is the single source of truth for how walk / run /
// kick / airkick / push / celebrate poses combine. The layered
// model reproduces the renderer's previous inline behaviour exactly:
//
//   1. Walk cycle always runs in the background; amplitude scales
//      with smoothed speed.
//   2. Push body-english (dip / tilt / hop) is added on top; the
//      striking arm is IK-solved (pushArmPose).
//   3. Kick body-english (dip / tilt / hip twist / support crouch /
//      counter-arm swing) is added on top; the kicking leg is
//      IK-solved (kickLegPose).
//   4. Celebrate linearly interpolates arms + legs toward the
//      jumping-jack extremes, weighted by the smoothed celebrate
//      factor.
//
// Physics guarantees kick and push never overlap, so their
// body-english contributions simply sum via upperTilt + pushBodyDip +
// kickBodyDip. Celebrate overrides everything through the celeb
// smoother.

import {
  PLAYER_WIDTH,
  Z_STRETCH,
  STICKMAN_GLYPH_SIZE,
  STICKMAN_LIMB_FULL_H,
  STICKMAN_SHOULDER_OFY,
  STICKMAN_SHOULDER_OFX,
  STICKMAN_HIP_OFX,
  STICKMAN_HEAD_GAP_Y,
  STICKMAN_HEAD_RADIUS,
  KICK_DURATION_MS,
  AIRKICK_MS,
  kickLegPose,
  pushArmPose,
} from '../physics.js';
import { shinAngleFor, forearmAngleFor } from '../renderer-math.js';
import {
  KICK_ARM_OPP_FRAC, KICK_SUPPORT_SHIN_RATIO,
  PUSH_TOTAL_TICKS,
  kickArmAngleAt, kickDipAt, kickTiltAt, airkickTiltAt,
  kickHipTwistAt, kickSupportCrouchAt,
  pushBodyDipAt, pushHopAt, pushBodyTiltAt,
} from './curves.js';

// Celebration shape — jumping-jack height + leg spread. Imported
// here so the pose composer stays self-contained.
const CELEB_JUMP_PEAK  = 0.55 * STICKMAN_GLYPH_SIZE;
const CELEB_LEG_SPREAD = 0.55;

// Grieve (anti-celebration) shape — the loser falls to his knees,
// hunches forward with both hands in front of his face, rocks
// gently back and forth like he's crying.
//
// Kneel geometry: both shins lie FLAT on the ground pointing back
// (parallel to ground), thighs lean forward 30° so the hip sits
// over-and-ahead of the knees. That gives a 60° interior knee
// bend while keeping the shins on the ground — so the figure
// rests on both knees and shins, not teetering on the knee joint.
//
// Hip height above ground = U · cos(30°) ≈ 12.12.
const GRIEVE_KNEEL_DROP = 7.88;     // standing hipBaseY=20 → kneeling hipBaseY≈12.12
const GRIEVE_BASE_TILT  = 0.45;     // rad — forward body lean
const GRIEVE_ROCK_AMP   = 0.10;     // rad — gentle sway back and forth
// Leg angles (world-space in the forward-up plane):
//   0 = straight down, +π/2 = forward, −π/2 = backward
const GRIEVE_LEG_UPPER = Math.PI / 6;     // +30° — thigh tilted forward (hip forward of knee)
const GRIEVE_LEG_LOWER = -Math.PI / 2;    // shin horizontal backward, parallel to ground

// Arm angles for fists-on-face. Solved analytically so the hand
// target lands at roughly (forward=+4, up=+5) from the shoulder —
// the head's front surface sits at (forward≈0.44, up≈4.9) plus
// HEAD_RADIUS forward. Upper arm angle 1.22 rad puts the elbow
// forward-and-slightly-below shoulder; lower arm angle −2.57
// folds the forearm back up to the face. Yaw rotates each arm's
// plane inward so the elbows pinch together and the fists
// converge on the centre of the face.
const GRIEVE_ARM_UPPER     = 1.22;    // 70° — upper arm forward, slight down
const GRIEVE_ARM_LOWER     = -2.57;   // −147° — forearm bent back-and-up to face
const GRIEVE_ARM_UPPER_YAW = 0.05;    // inward tilt of the upper-arm plane — elbows closer
const GRIEVE_ARM_LOWER_YAW = 1.0;    // strong inward yaw on the forearms → fists meet at the face centre

/** Allocate a reusable pose scratch object. Store one on each
 *  renderer and pass it to composeStickmanPose each frame. */
export function createPoseScratch() {
  return {
    // Body positions
    baseX: 0, baseZ: 0,
    hipBaseY: 0, upperHipY: 0,
    neckX: 0, neckY: 0, neckZ: 0,
    headX: 0, headY: 0, headZ: 0,
    shoulderY: 0,
    lShX: 0, lShZ: 0,
    rShX: 0, rShZ: 0,
    lHipX: 0, lHipZ: 0,
    rHipX: 0, rHipZ: 0,
    // Limb angles (upper + lower for 2-bone legs and arms; yaw on
    // arms only, set by the punch IK).
    lArmUpper: 0, lArmLower: 0, lArmUpperYaw: 0, lArmLowerYaw: 0,
    rArmUpper: 0, rArmLower: 0, rArmUpperYaw: 0, rArmLowerYaw: 0,
    lLegUpper: 0, lLegLower: 0,
    rLegUpper: 0, rLegLower: 0,
    // Heading unit vector pass-through for the renderer's _placeArm
    // / _placeLeg (they orient capsules along forward/up).
    forwardX: 0, forwardZ: 0,
  };
}

/**
 * Fill `pose` with every world-space number the renderer needs to
 * place the stickman's meshes for one frame.
 *
 *  animSnap         — output of advanceAnimState(…)
 *  player           — physics player (position, heading, kick, push,
 *                     airZ, stamina, pushArm, …)
 *  pose             — scratch pose (createPoseScratch); mutated in
 *                     place.
 *  scratchKickPose  — `{upperAngle, lowerAngle}` scratch for kick IK.
 *  scratchPushPose  — `{upperAngle, lowerAngle, upperYaw, lowerYaw}`
 *                     scratch for push IK.
 */
export function composeStickmanPose(animSnap, player, pose, scratchKickPose, scratchPushPose) {
  const forwardX = animSnap.forwardX;
  const forwardZ = animSnap.forwardZ;
  const lateralX = -forwardZ;
  const lateralZ =  forwardX;

  // Base hip-centre in world xz — starts at the player's physics
  // (x, y) mapped to the camera frame, gets shifted by the push
  // hop below.
  let baseX = player.x + PLAYER_WIDTH / 2;
  let baseZ = player.y * Z_STRETCH;

  const swing     = animSnap.swing;
  const amplitude = animSnap.amplitude;
  const celeb     = animSnap.celebrate;
  const celebInv  = 1 - celeb;
  const grieve    = animSnap.grieve || 0;
  const grieveInv = 1 - grieve;
  const grievePhase = animSnap.grievePhase || 0;
  const pushing   = animSnap.pushing;
  const isKicking = animSnap.isKicking;
  const isAirkick = animSnap.isAirkick;
  const airLift   = animSnap.airLift;
  const kick      = animSnap.kick;
  const celebratePhase = animSnap.celebratePhase;
  const pushProgress   = animSnap.pushProgress;
  const walkTilt       = animSnap.walkTilt;

  const jumpY = Math.max(0, Math.sin(celebratePhase)) * CELEB_JUMP_PEAK * celeb;
  const bob   = Math.abs(swing) * 0.08 * amplitude * celebInv;

  // ── Push body-english ────────────────────────────────────
  let pushBodyDip    = 0;
  let pushTiltOffset = 0;
  if (pushing > 0) {
    const pushT = Math.min(pushProgress / PUSH_TOTAL_TICKS, 1);
    pushBodyDip    = pushBodyDipAt(pushT);
    pushTiltOffset = pushBodyTiltAt(pushT);
    const hop = pushHopAt(pushT);
    baseX += forwardX * hop;
    baseZ += forwardZ * hop;
  }

  // ── Kick body-english ────────────────────────────────────
  let kickArmAngle      = 0;
  let kickBodyDip       = 0;
  let kickTiltOffset    = 0;
  let kickHipTwist      = 0;
  let kickSupportCrouch = 0;
  if (isKicking) {
    const totalMs = isAirkick ? AIRKICK_MS : KICK_DURATION_MS;
    const kickT   = Math.min(kick.timer / totalMs, 1);
    kickTiltOffset    = isAirkick ? airkickTiltAt(kickT) : kickTiltAt(kickT);
    kickArmAngle      = kickArmAngleAt(kickT);
    kickBodyDip       = kickDipAt(kickT);
    kickHipTwist      = kickHipTwistAt(kickT);
    kickSupportCrouch = kickSupportCrouchAt(kickT);
  }

  // ── Body anchors (hip → neck → head) ─────────────────────
  const upperTilt = walkTilt + pushTiltOffset + kickTiltOffset;
  const tiltC = Math.cos(upperTilt);
  const tiltS = Math.sin(upperTilt);

  const hipBaseY  = STICKMAN_LIMB_FULL_H + bob * STICKMAN_GLYPH_SIZE + jumpY + airLift;
  const upperHipY = hipBaseY + pushBodyDip + kickBodyDip;

  const torsoH     = STICKMAN_SHOULDER_OFY;
  const neckFwdOfs = torsoH * tiltS;
  const neckX = baseX + forwardX * neckFwdOfs;
  const neckZ = baseZ + forwardZ * neckFwdOfs;
  const neckY = upperHipY + torsoH * tiltC;

  const headFwdOfs = STICKMAN_HEAD_GAP_Y * tiltS;
  const headX = neckX + forwardX * headFwdOfs;
  const headZ = neckZ + forwardZ * headFwdOfs;
  const headY = neckY + STICKMAN_HEAD_GAP_Y * tiltC + STICKMAN_HEAD_RADIUS;

  // Shoulders: lateral from neck. Hips: lateral from hip centre,
  // rotated around the vertical axis by kickHipTwist during a kick.
  const lShX = neckX - lateralX * STICKMAN_SHOULDER_OFX;
  const lShZ = neckZ - lateralZ * STICKMAN_SHOULDER_OFX;
  const rShX = neckX + lateralX * STICKMAN_SHOULDER_OFX;
  const rShZ = neckZ + lateralZ * STICKMAN_SHOULDER_OFX;

  const twistSin = Math.sin(kickHipTwist);
  const twistCos = Math.cos(kickHipTwist);
  const twistedRightX = lateralX * twistCos - forwardX * twistSin;
  const twistedRightZ = lateralZ * twistCos - forwardZ * twistSin;
  const rHipX = baseX + twistedRightX * STICKMAN_HIP_OFX;
  const rHipZ = baseZ + twistedRightZ * STICKMAN_HIP_OFX;
  const lHipX = baseX - twistedRightX * STICKMAN_HIP_OFX;
  const lHipZ = baseZ - twistedRightZ * STICKMAN_HIP_OFX;

  // ── Walk swing base (arms contralateral, legs contralateral) ─
  const armSwing = swing * 0.85 * amplitude;
  const legSwing = -swing * 0.7  * amplitude;
  let leftArmAngle  =  armSwing;
  let rightArmAngle = -armSwing;
  let leftLegAngle  =  legSwing;
  let rightLegAngle = -legSwing;

  // Celebrate interp: arms → ±π, legs → ±legSpread (jumping jack).
  if (celeb > 0.001) {
    const legSpread = Math.max(0, Math.sin(celebratePhase)) * CELEB_LEG_SPREAD;
    leftArmAngle  = leftArmAngle  * celebInv +  Math.PI   * celeb;
    rightArmAngle = rightArmAngle * celebInv + -Math.PI   * celeb;
    leftLegAngle  = leftLegAngle  * celebInv + -legSpread * celeb;
    rightLegAngle = rightLegAngle * celebInv +  legSpread * celeb;
  }

  // ── Per-leg (upper, lower) base: cosmetic knee follow-through ─
  let leftUpperAngle  = leftLegAngle;
  let leftLowerAngle  = shinAngleFor(leftLegAngle);
  let rightUpperAngle = rightLegAngle;
  let rightLowerAngle = shinAngleFor(rightLegAngle);

  // Kick override: right leg → IK to kick.footTarget; support leg
  // (left) micro-crouches; arms swap to the kick counter-swing.
  // Celebrate outranks the kick override (celeb > 0.001 skips this).
  if (isKicking && celeb < 0.001) {
    kickLegPose(kick, rHipX, hipBaseY, rHipZ, forwardX, forwardZ, scratchKickPose);
    rightUpperAngle = scratchKickPose.upperAngle;
    rightLowerAngle = scratchKickPose.lowerAngle;
    leftUpperAngle = leftLegAngle + kickSupportCrouch;
    leftLowerAngle = shinAngleFor(leftLegAngle) - KICK_SUPPORT_SHIN_RATIO * kickSupportCrouch;
    leftArmAngle  = kickArmAngle;
    rightArmAngle = -kickArmAngle * KICK_ARM_OPP_FRAC;
  }

  // ── Per-arm (upper, lower) base: cosmetic elbow follow-through ─
  let leftUpperArmAngle  = leftArmAngle;
  let leftLowerArmAngle  = forearmAngleFor(leftArmAngle);
  let rightUpperArmAngle = rightArmAngle;
  let rightLowerArmAngle = forearmAngleFor(rightArmAngle);
  let leftUpperYaw = 0, leftLowerYaw = 0;
  let rightUpperYaw = 0, rightLowerYaw = 0;

  // Push override: striking arm → IK to player.pushTarget via the
  // variant-specific scripted trajectory. Only overrides the
  // striking side; the other arm keeps its cosmetic swing.
  const shoulderY = upperHipY + torsoH * tiltC;
  if (player.pushTimer > 0 && celeb < 0.001) {
    pushArmPose(player, scratchPushPose);
    if (player.pushArm === 'right') {
      rightUpperArmAngle = scratchPushPose.upperAngle;
      rightLowerArmAngle = scratchPushPose.lowerAngle;
      rightUpperYaw      = scratchPushPose.upperYaw;
      rightLowerYaw      = scratchPushPose.lowerYaw;
    } else {
      leftUpperArmAngle = scratchPushPose.upperAngle;
      leftLowerArmAngle = scratchPushPose.lowerAngle;
      leftUpperYaw      = scratchPushPose.upperYaw;
      leftLowerYaw      = scratchPushPose.lowerYaw;
    }
  }

  // ── Grieve (anti-celebration) override ──────────────────
  // Non-scorer during a goal celebration. Overrides walk/kick/push
  // poses proportionally to the smoothed `grieve` factor so the
  // switch fades in cleanly. Celebrate (`celeb`) still outranks
  // grieve if both ever fire (they shouldn't — physics makes only
  // the scorer celebrate — but the interp keeps the transition
  // safe).
  if (grieve > 0.001 && celeb < 0.001) {
    // Rocking body lean: baseline forward tilt + small sinusoidal
    // sway. Multiplied by `grieve` so the lean eases in from the
    // previous pose.
    const rock = Math.sin(grievePhase) * GRIEVE_ROCK_AMP;
    const grieveTilt = (GRIEVE_BASE_TILT + rock) * grieve;
    // Recompute torso anchors using the grieve tilt blended over
    // whatever upperTilt produced for the non-grieve layer.
    const blendedTilt = upperTilt * grieveInv + grieveTilt * grieve;
    const gTiltC = Math.cos(blendedTilt);
    const gTiltS = Math.sin(blendedTilt);

    // Drop hip toward kneeling height. Blend from current hipBaseY
    // (standing) toward STICKMAN_LIMB_FULL_H − GRIEVE_KNEEL_DROP.
    const kneelHipY = STICKMAN_LIMB_FULL_H - GRIEVE_KNEEL_DROP;
    const blendedHipBaseY = hipBaseY * grieveInv + kneelHipY * grieve;
    const blendedUpperHipY = blendedHipBaseY;  // no dip/push on the loser

    // Rebuild neck / head / shoulders / hips anchored to the new hip height.
    const bNeckX = baseX + forwardX * (torsoH * gTiltS);
    const bNeckZ = baseZ + forwardZ * (torsoH * gTiltS);
    const bNeckY = blendedUpperHipY + torsoH * gTiltC;
    const bHeadX = bNeckX + forwardX * (STICKMAN_HEAD_GAP_Y * gTiltS);
    const bHeadZ = bNeckZ + forwardZ * (STICKMAN_HEAD_GAP_Y * gTiltS);
    const bHeadY = bNeckY + STICKMAN_HEAD_GAP_Y * gTiltC + STICKMAN_HEAD_RADIUS;
    const bShoulderY = blendedUpperHipY + torsoH * gTiltC;
    const blShX = bNeckX - lateralX * STICKMAN_SHOULDER_OFX;
    const blShZ = bNeckZ - lateralZ * STICKMAN_SHOULDER_OFX;
    const brShX = bNeckX + lateralX * STICKMAN_SHOULDER_OFX;
    const brShZ = bNeckZ + lateralZ * STICKMAN_SHOULDER_OFX;
    const blHipX = baseX - lateralX * STICKMAN_HIP_OFX;
    const blHipZ = baseZ - lateralZ * STICKMAN_HIP_OFX;
    const brHipX = baseX + lateralX * STICKMAN_HIP_OFX;
    const brHipZ = baseZ + lateralZ * STICKMAN_HIP_OFX;

    // Blend hipBaseY + anchors by grieve factor — at grieve≈1 we
    // fully land on the kneel pose; in between we cross-fade.
    pose.baseX = baseX; pose.baseZ = baseZ;
    pose.hipBaseY = blendedHipBaseY;
    pose.upperHipY = blendedUpperHipY;
    pose.neckX = neckX * grieveInv + bNeckX * grieve;
    pose.neckY = neckY * grieveInv + bNeckY * grieve;
    pose.neckZ = neckZ * grieveInv + bNeckZ * grieve;
    pose.headX = headX * grieveInv + bHeadX * grieve;
    pose.headY = headY * grieveInv + bHeadY * grieve;
    pose.headZ = headZ * grieveInv + bHeadZ * grieve;
    pose.shoulderY = shoulderY * grieveInv + bShoulderY * grieve;
    pose.lShX = lShX * grieveInv + blShX * grieve;
    pose.lShZ = lShZ * grieveInv + blShZ * grieve;
    pose.rShX = rShX * grieveInv + brShX * grieve;
    pose.rShZ = rShZ * grieveInv + brShZ * grieve;
    pose.lHipX = lHipX * grieveInv + blHipX * grieve;
    pose.lHipZ = lHipZ * grieveInv + blHipZ * grieve;
    pose.rHipX = rHipX * grieveInv + brHipX * grieve;
    pose.rHipZ = rHipZ * grieveInv + brHipZ * grieve;
    // Arms bent up with elbows pinched together and forearms
    // converging so fists meet on the front of the face.
    //   Upper yaw POSITIVE for left / NEGATIVE for right — rotates
    //   each upper arm's forward around the vertical axis inward
    //   toward the body centreline, pulling the elbows in.
    //   Lower yaw has the opposite sign per side because the
    //   forearm extends from the elbow in −forward direction
    //   (sin(lowerAngle) is negative): flipping the sign brings
    //   the fists toward centre instead of away from it.
    pose.lArmUpper    = leftUpperArmAngle  * grieveInv +  GRIEVE_ARM_UPPER  * grieve;
    pose.lArmLower    = leftLowerArmAngle  * grieveInv +  GRIEVE_ARM_LOWER  * grieve;
    pose.lArmUpperYaw = leftUpperYaw       * grieveInv + (+GRIEVE_ARM_UPPER_YAW) * grieve;
    pose.lArmLowerYaw = leftLowerYaw       * grieveInv + (-GRIEVE_ARM_LOWER_YAW) * grieve;
    pose.rArmUpper    = rightUpperArmAngle * grieveInv +  GRIEVE_ARM_UPPER  * grieve;
    pose.rArmLower    = rightLowerArmAngle * grieveInv +  GRIEVE_ARM_LOWER  * grieve;
    pose.rArmUpperYaw = rightUpperYaw      * grieveInv + (-GRIEVE_ARM_UPPER_YAW) * grieve;
    pose.rArmLowerYaw = rightLowerYaw      * grieveInv + (+GRIEVE_ARM_LOWER_YAW) * grieve;
    // Kneeling legs — thighs forward, shins straight down tucked under.
    pose.lLegUpper = leftUpperAngle  * grieveInv + GRIEVE_LEG_UPPER * grieve;
    pose.lLegLower = leftLowerAngle  * grieveInv + GRIEVE_LEG_LOWER * grieve;
    pose.rLegUpper = rightUpperAngle * grieveInv + GRIEVE_LEG_UPPER * grieve;
    pose.rLegLower = rightLowerAngle * grieveInv + GRIEVE_LEG_LOWER * grieve;
    pose.forwardX = forwardX; pose.forwardZ = forwardZ;
    return pose;
  }

  // Fill pose scratch.
  pose.baseX = baseX; pose.baseZ = baseZ;
  pose.hipBaseY = hipBaseY; pose.upperHipY = upperHipY;
  pose.neckX = neckX; pose.neckY = neckY; pose.neckZ = neckZ;
  pose.headX = headX; pose.headY = headY; pose.headZ = headZ;
  pose.shoulderY = shoulderY;
  pose.lShX = lShX; pose.lShZ = lShZ;
  pose.rShX = rShX; pose.rShZ = rShZ;
  pose.lHipX = lHipX; pose.lHipZ = lHipZ;
  pose.rHipX = rHipX; pose.rHipZ = rHipZ;
  pose.lArmUpper = leftUpperArmAngle; pose.lArmLower = leftLowerArmAngle;
  pose.lArmUpperYaw = leftUpperYaw;   pose.lArmLowerYaw = leftLowerYaw;
  pose.rArmUpper = rightUpperArmAngle; pose.rArmLower = rightLowerArmAngle;
  pose.rArmUpperYaw = rightUpperYaw;   pose.rArmLowerYaw = rightLowerYaw;
  pose.lLegUpper = leftUpperAngle; pose.lLegLower = leftLowerAngle;
  pose.rLegUpper = rightUpperAngle; pose.rLegLower = rightLowerAngle;
  pose.forwardX = forwardX; pose.forwardZ = forwardZ;
  return pose;
}
