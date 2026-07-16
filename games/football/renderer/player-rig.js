/**
 * Football v2 — stickman rig placement.
 *
 * Per-frame mesh placement for the 3D capsule figure: torso outline +
 * fill + clip plane (stamina indicator), head, both arms (2-bone +
 * elbow joint), both legs (2-bone + kneecap), shadow disc, and the
 * dazed rest-stars ring. Layered on top of `composeStickmanPose` from
 * animation/poses.js — this module only translates pose numbers into
 * mesh positions / orientations.
 *
 * ctx-style: every function takes the Renderer instance as `ctx`.
 */

import {
  STICKMAN_HEAD_RADIUS,
  STICKMAN_LOWER_ARM, STICKMAN_UPPER_ARM,
  STICKMAN_LOWER_LEG, STICKMAN_UPPER_LEG,
  PLAYER_WIDTH, Z_STRETCH,
} from '../physics/index.js';
import {
  STICKMAN_KNEE_RADIUS, STICKMAN_ELBOW_RADIUS,
  STICKMAN_TORSO_SHELL_THICKNESS,
  PLAYER_SHADOW_RADIUS, SHADOW_Y,
  REST_STAR_RADIUS_FRAC, REST_STAR_HEIGHT_FRAC,
  REST_STAR_SCALE_BASE, REST_STAR_SCALE_OPACITY,
  REST_STAR_TUMBLE_FRAC, REST_STAR_COUNTER_SPIN,
} from './tuning.js';
import { staminaColorInto } from './materials.js';
import { staminaDiscRadius, updateStaminaClipPlane } from '../util/renderer-math.js';
import { advanceAnimState, createAnimState } from '../animation/state.js';
import { composeStickmanPose } from '../animation/poses.js';
import { maybeFootstepBurst } from './particles.js';

export function addStickman(ctx, player, color, tick, isCelebrating, isGrieving = false, isReposition = false, isMatchendWin = false, isMatchendLose = false, faceCameraSmooth = false, faceEachOtherSmooth = false) {
  // 1. Fetch / init the smoothed animation state for this player.
  let anim = ctx._animByPlayer.get(player);
  if (!anim) {
    anim = createAnimState(tick, player);
    ctx._animByPlayer.set(player, anim);
  }
  // 2. Advance LPFs + phases one frame; derive per-frame snapshot.
  const animSnap = advanceAnimState(
    anim, player, tick, isCelebrating, ctx._scratchAnimSnap,
    isGrieving, isReposition, isMatchendWin, isMatchendLose,
    faceCameraSmooth, faceEachOtherSmooth,
  );
  // 3. Compose the full pose — walk + kick + push + celebrate all
  //    layered into one flat numeric pose via animation/poses.js.
  const pose = composeStickmanPose(
    animSnap, player, ctx._scratchPose,
    ctx._scratchKickPose, ctx._scratchPushPose,
  );
  // 4. Place the meshes.
  placeTorso(ctx, pose.baseX, pose.upperHipY, pose.baseZ, pose.neckX, pose.neckY, pose.neckZ, color, player.stamina);
  placeSph(ctx, pose.headX, pose.headY, pose.headZ, STICKMAN_HEAD_RADIUS, color);
  // Stash for the name-label pass.
  anim.lastHeadX = pose.headX;
  anim.lastHeadY = pose.headY;
  anim.lastHeadZ = pose.headZ;
  placeArm(ctx, pose.lShX, pose.shoulderY, pose.lShZ, pose.lArmUpper, pose.lArmLower, pose.forwardX, pose.forwardZ, color, pose.lArmUpperYaw, pose.lArmLowerYaw);
  placeArm(ctx, pose.rShX, pose.shoulderY, pose.rShZ, pose.rArmUpper, pose.rArmLower, pose.forwardX, pose.forwardZ, color, pose.rArmUpperYaw, pose.rArmLowerYaw);
  placeLeg(ctx, pose.lHipX, pose.hipBaseY, pose.lHipZ, pose.lLegUpper, pose.lLegLower, pose.forwardX, pose.forwardZ, color, pose.lLegHipYaw);
  placeLeg(ctx, pose.rHipX, pose.hipBaseY, pose.rHipZ, pose.rLegUpper, pose.rLegLower, pose.forwardX, pose.forwardZ, color, pose.rLegHipYaw);

  // 5. Footstep dust on walk-cycle zero crossings.
  maybeFootstepBurst(ctx, player, animSnap);

  // 6. Dazed stars orbiting the head while resting.
  if (animSnap.rest > 0.01) {
    placeRestStars(ctx, pose, animSnap);
  }
}

/** Orient `mesh` so its local +y axis points from A toward B. The mesh
 *  is assumed to be a fixed-length capsule whose geometric length
 *  equals |B - A|; no non-uniform scaling is applied so the
 *  hemispherical caps stay perfectly round. Optional `color` [r,g,b]
 *  tints the material; omit it to keep the mesh's existing colour
 *  (static goal bars pass no colour). */
export function orientBetween(ctx, mesh, ax, ay, az, bx, by, bz, color = null) {
  mesh.visible = true;
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (length < 1e-6) { mesh.visible = false; return; }
  mesh.position.set((ax + bx) * 0.5, (ay + by) * 0.5, (az + bz) * 0.5);
  mesh.scale.set(1, 1, 1);
  ctx._scratchDir.set(dx / length, dy / length, dz / length);
  ctx._scratchAxis.crossVectors(ctx._scratchUp, ctx._scratchDir);
  const axisLen = ctx._scratchAxis.length();
  if (axisLen > 1e-6) {
    const dot = ctx._scratchUp.dot(ctx._scratchDir);
    mesh.quaternion.setFromAxisAngle(
      ctx._scratchAxis.divideScalar(axisLen),
      Math.acos(Math.max(-1, Math.min(1, dot))),
    );
  } else if (ctx._scratchDir.y < 0) {
    mesh.quaternion.set(1, 0, 0, 0);
  } else {
    mesh.quaternion.identity();
  }
  if (color) mesh.material.color.setRGB(color[0], color[1], color[2]);
}

/** Place the next shadow from the player-shadow pool under `player`.
 *  Pool grows on demand so harnesses can render N players without a
 *  fixed ceiling. */
export function placePlayerShadow(ctx, player) {
  const idx = ctx._playerShadowCursor++;
  while (ctx._playerShadows.length <= idx) ctx._playerShadows.push(ctx._makeShadow());
  const shadow = ctx._playerShadows[idx];
  shadow.position.set(player.x + PLAYER_WIDTH / 2, SHADOW_Y, player.y * Z_STRETCH);
  shadow.scale.set(PLAYER_SHADOW_RADIUS * 2, PLAYER_SHADOW_RADIUS * 2, 1);
  shadow.visible = true;
}

/** Place 3 dazed stars in a horizontal ring above the head, rotating
 *  around the player's vertical axis. */
export function placeRestStars(ctx, pose, animSnap) {
  const ringRadius = STICKMAN_HEAD_RADIUS * REST_STAR_RADIUS_FRAC;
  const ringHeight = STICKMAN_HEAD_RADIUS * REST_STAR_HEIGHT_FRAC;
  const cy = pose.headY + ringHeight;
  const opacity = Math.min(1, animSnap.rest);
  const scale = REST_STAR_SCALE_BASE + REST_STAR_SCALE_OPACITY * opacity;
  const spin = animSnap.restPhase * REST_STAR_COUNTER_SPIN;
  for (let i = 0; i < 3; i++) {
    const idx = ctx._restStarCursor++;
    while (ctx._restStars.length <= idx) ctx._mkRestStar();
    const mesh = ctx._restStars[idx];
    const theta = spin + (i * (Math.PI * 2 / 3));
    mesh.position.set(
      pose.headX + Math.cos(theta) * ringRadius,
      cy + Math.sin(theta * 1.7) * (STICKMAN_HEAD_RADIUS * 0.18),
      pose.headZ + Math.sin(theta) * ringRadius,
    );
    // Each star also tumbles around its own axis so it's not a flat
    // billboard — gives a metallic twinkle.
    mesh.rotation.set(theta * REST_STAR_TUMBLE_FRAC, theta, 0);
    mesh.scale.set(scale, scale, scale);
    mesh.material.opacity = opacity;
    mesh.visible = true;
  }
}

/** Pull a torso capsule triple (outline + fill + disc) from the pool,
 *  orient + tint by stamina, update the fill clip plane, size the cut
 *  disc so it never pokes out of the capsule's hemispherical caps. */
export function placeTorso(ctx, ax, ay, az, bx, by, bz, color, staminaFrac) {
  const idx = ctx._stickmanTorsoCursor;
  while (ctx._stickmanTorsoOutline.length <= idx) {
    ctx._mkTorsoOutline();
    ctx._mkTorsoFill();
    ctx._mkTorsoDisc();
  }
  ctx._stickmanTorsoCursor++;
  const outline = ctx._stickmanTorsoOutline[idx];
  const fill    = ctx._stickmanTorsoFill[idx];
  const plane   = ctx._stickmanTorsoFillPlanes[idx];

  const tint = staminaColorInto(ctx._staminaColorBuf, staminaFrac);
  orientBetween(ctx, outline, ax, ay, az, bx, by, bz, color);
  orientBetween(ctx, fill,    ax, ay, az, bx, by, bz, tint);
  // Clip plane perpendicular to the torso axis at the stamina fraction.
  // The fill capsule is inset by shell thickness on both caps.
  const info = updateStaminaClipPlane(
    plane, ax, ay, az, bx, by, bz,
    STICKMAN_TORSO_SHELL_THICKNESS, staminaFrac, ctx._staminaClipOut,
  );

  const disc = ctx._stickmanTorsoDisc[idx];
  const discR = staminaDiscRadius(
    info.axialFromMid,
    ctx._fillBodyHalf,
    ctx._fillCapRadius,
  );
  if (discR > 0) {
    disc.visible = true;
    disc.position.set(info.cx, info.cy, info.cz);
    // Orient the flat disc so its normal tracks the torso axis.
    ctx._scratchDiscDir.set(info.dx, info.dy, info.dz);
    disc.quaternion.setFromUnitVectors(ctx._discLocalY, ctx._scratchDiscDir);
    const s = (discR / ctx._fillCapRadius) * 0.995;
    disc.scale.set(s, 1, s);
    disc.material.color.setRGB(tint[0], tint[1], tint[2]);
  } else {
    disc.visible = false;
  }
}

/* ── Pooled-mesh getters for the two 2-bone limbs. Arms draw the upper
 * and lower segments from two separate pools; legs draw both bones from
 * one shared pool. Passed by reference into place2Bone so the hot path
 * never allocates a per-call closure. ── */
function pullUpperArm(ctx) {
  while (ctx._stickmanUpperArm.length <= ctx._stickmanUpperArmCursor) ctx._mkUpperArm();
  return ctx._stickmanUpperArm[ctx._stickmanUpperArmCursor++];
}
function pullLowerArm(ctx) {
  while (ctx._stickmanLowerArm.length <= ctx._stickmanLowerArmCursor) ctx._mkLowerArm();
  return ctx._stickmanLowerArm[ctx._stickmanLowerArmCursor++];
}
function pullLeg(ctx) {
  while (ctx._stickmanLeg.length <= ctx._stickmanLegCursor) ctx._mkLeg();
  return ctx._stickmanLeg[ctx._stickmanLegCursor++];
}

/** Shared two-bone limb placement. Yaw-rotates the forward axis per
 *  segment, swings the upper bone from the root (px,py,pz) to the mid
 *  joint and the lower bone from the joint to the end point, orients
 *  both capsules, and drops a joint sphere at the bend. `upperYaw` /
 *  `lowerYaw` rotate the two segments' forward axes independently (arms
 *  pass distinct yaws for hook vs uppercut arcs; legs pass one hip yaw
 *  for both). `pullUpper` / `pullLower` fetch the next pooled capsule
 *  for each segment (module-scope fns, so no per-frame allocation). */
function place2Bone(ctx, px, py, pz, upperAngle, lowerAngle, forwardX, forwardZ, upperYaw, lowerYaw, U, L, jointRadius, color, pullUpper, pullLower) {
  const uyc = Math.cos(upperYaw), uys = Math.sin(upperYaw);
  const uFwdX = forwardX * uyc - forwardZ * uys;
  const uFwdZ = forwardX * uys + forwardZ * uyc;
  const lyc = Math.cos(lowerYaw), lys = Math.sin(lowerYaw);
  const lFwdX = forwardX * lyc - forwardZ * lys;
  const lFwdZ = forwardX * lys + forwardZ * lyc;

  const upperSin = Math.sin(upperAngle);
  const jointX = px + uFwdX * U * upperSin;
  const jointY = py - U * Math.cos(upperAngle);
  const jointZ = pz + uFwdZ * U * upperSin;
  const lowerSin = Math.sin(lowerAngle);
  const endX = jointX + lFwdX * L * lowerSin;
  const endY = jointY - L * Math.cos(lowerAngle);
  const endZ = jointZ + lFwdZ * L * lowerSin;

  // Upper segment: root → joint.
  const upperMesh = pullUpper(ctx);
  orientBetween(ctx, upperMesh, px, py, pz, jointX, jointY, jointZ, color);
  // Lower segment: joint → end.
  const lowerMesh = pullLower(ctx);
  orientBetween(ctx, lowerMesh, jointX, jointY, jointZ, endX, endY, endZ, color);
  // Joint sphere — elbow / kneecap bump.
  placeSph(ctx, jointX, jointY, jointZ, jointRadius, color);
}

/** Two-segment arm with an elbow. `upperAngle` is the shoulder swing
 *  angle (0 = straight down, +π/2 = forward, +π = straight up).
 *  `lowerAngle` is the forearm's world-space swing angle (not relative
 *  to the upper arm). Per-segment yaw rotates the forward axis
 *  independently, supporting both hooks (horizontal arc) and
 *  uppercuts (vertical arc) on the same rig. */
export function placeArm(ctx, px, py, pz, upperAngle, lowerAngle, forwardX, forwardZ, color, upperYaw = 0, lowerYaw = 0) {
  place2Bone(
    ctx, px, py, pz, upperAngle, lowerAngle, forwardX, forwardZ,
    upperYaw, lowerYaw, STICKMAN_UPPER_ARM, STICKMAN_LOWER_ARM,
    STICKMAN_ELBOW_RADIUS, color, pullUpperArm, pullLowerArm,
  );
}

/** Two-segment leg with a knee. `upperAngle` is the hip-swing angle.
 *  `lowerAngle` is the shin's world-space swing (not relative to the
 *  upper leg). `hipYaw` rotates the leg's forward axis around the
 *  vertical hip axis — used by the kick to hook the foot toward an
 *  off-axis ball. Both bones share the single hip yaw. */
export function placeLeg(ctx, px, py, pz, upperAngle, lowerAngle, forwardX, forwardZ, color, hipYaw = 0) {
  place2Bone(
    ctx, px, py, pz, upperAngle, lowerAngle, forwardX, forwardZ,
    hipYaw, hipYaw, STICKMAN_UPPER_LEG, STICKMAN_LOWER_LEG,
    STICKMAN_KNEE_RADIUS, color, pullLeg, pullLeg,
  );
}

/** Pull a sphere from the pool and place it at a world point with the
 *  given radius and color. */
export function placeSph(ctx, cx, cy, cz, radius, color) {
  while (ctx._stickmanSph.length <= ctx._stickmanSphCursor) ctx._mkSph();
  const mesh = ctx._stickmanSph[ctx._stickmanSphCursor++];
  mesh.visible = true;
  mesh.position.set(cx, cy, cz);
  mesh.scale.set(radius, radius, radius);
  mesh.material.color.setRGB(color[0], color[1], color[2]);
}
