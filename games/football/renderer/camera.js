/**
 * Football v2 — camera.
 *
 * Three modes:
 *   default — fixed isometric showcase view (placeCamera)
 *   debug-cam — runtime-toggled freecam (orbit + WASDQE pan + wheel zoom)
 *   follow-cam — runtime-toggled spring-loaded action tracker
 *
 * Mutually exclusive: setting one off restores the showcase pose.
 * ctx-style — every function takes the Renderer instance as `ctx`.
 */

import * as THREE from 'https://unpkg.com/three@0.164.0/build/three.module.js';
import {
  CAMERA_FOV, CAMERA_TILT_DEG, HORIZONTAL_MARGIN,
  FOLLOW_ZOOM_LIVE, FOLLOW_ZOOM_DEAD, FOLLOW_LEAD_FRACTION,
  DEBUG_CAM_DRAG_SENS, DEBUG_CAM_PAN_FRAC, DEBUG_CAM_WHEEL_SENS,
  DEBUG_CAM_DIST_MIN, DEBUG_CAM_DIST_MAX,
} from './tuning.js';
import { FIELD_HEIGHT, Z_STRETCH } from '../physics/index.js';

/** Compute the camera height / back-offset for a zoom multiplier
 *  `zoom` (1.0 = default showcase fit). Smaller zoom = closer. */
export function computeDistance(ctx, zoom) {
  const aspect = ctx.camera.aspect || 4;
  const halfFovVert = (CAMERA_FOV / 2) * Math.PI / 180;
  const tanHalfHoriz = Math.tan(halfFovVert) * aspect;
  const halfFieldWidth = (ctx.fieldWidth / 2) * HORIZONTAL_MARGIN;
  const distance = (halfFieldWidth / tanHalfHoriz) * zoom;
  const tiltRad = CAMERA_TILT_DEG * Math.PI / 180;
  return {
    distance,
    height: distance * Math.cos(tiltRad),
    backOff: distance * Math.sin(tiltRad),
  };
}

export function placeCamera(ctx) {
  // Debug-cam OR follow-cam owns the pose when active; resize() still
  // updates camera.aspect but we leave the pose alone.
  if (ctx._debugCam && ctx._debugCam.active) return;
  if (ctx._followCam && ctx._followCam.active) return;
  const midX = ctx.fieldWidth / 2;
  const midZ = (FIELD_HEIGHT * Z_STRETCH) / 2;

  const { height, backOff } = computeDistance(ctx, 1.0);
  ctx.camera.position.set(midX, height, midZ + backOff);
  ctx.camera.lookAt(midX, 0, midZ);
  ctx.camera.updateProjectionMatrix();
}

/** Force a fixed close-up camera pose. Used by the renderer diagnostic
 *  page to frame individual stickmen at full size. */
export function setCameraFocus(ctx, targetX, targetY, targetZ, distance, pitchDeg = 35, yawDeg = 0) {
  if (!ctx._debugCam) return;
  const dc = ctx._debugCam;
  dc.active = true;
  dc.target.set(targetX, targetY, targetZ);
  dc.distance = distance;
  dc.yaw = (yawDeg * Math.PI) / 180;
  dc.pitch = (pitchDeg * Math.PI) / 180;
  dc.keys.clear();
  dc.dragging = false;
}

/* ── Debug free-camera ─────────────────────────────────────────
 * Listeners always attached; short-circuit when inactive.
 * Left-drag orbits yaw/pitch around `target`. WASD pans on the
 * ground plane (camera-relative). Q/E lower/raise. Wheel zooms.
 * R resets to default pose. */
export function initDebugCam(ctx) {
  const midX = ctx.fieldWidth / 2;
  const midZ = (FIELD_HEIGHT * Z_STRETCH) / 2;
  const aspect = ctx.camera.aspect || 4;
  const halfFovVert = (CAMERA_FOV / 2) * Math.PI / 180;
  const tanHalfHoriz = Math.tan(halfFovVert) * aspect;
  const halfFieldWidth = (ctx.fieldWidth / 2) * HORIZONTAL_MARGIN;
  const distance = halfFieldWidth / tanHalfHoriz;
  const defaultPitch = (90 - CAMERA_TILT_DEG) * Math.PI / 180;
  ctx._debugCam = {
    active: false,
    target: new THREE.Vector3(midX, 0, midZ),
    defaultTarget: new THREE.Vector3(midX, 0, midZ),
    distance, defaultDistance: distance,
    yaw: 0, defaultYaw: 0,
    pitch: defaultPitch, defaultPitch,
    keys: new Set(),
    dragging: false,
    lastPointerX: 0,
    lastPointerY: 0,
  };
  const canvas = ctx.renderer.domElement;
  const isTypingTarget = () => {
    const el = document.activeElement;
    if (!el) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
  };
  canvas.addEventListener('pointerdown', (e) => {
    if (!ctx._debugCam.active || e.button !== 0) return;
    ctx._debugCam.dragging = true;
    ctx._debugCam.lastPointerX = e.clientX;
    ctx._debugCam.lastPointerY = e.clientY;
    try { canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  });
  canvas.addEventListener('pointermove', (e) => {
    const dc = ctx._debugCam;
    if (!dc.active || !dc.dragging) return;
    const dx = e.clientX - dc.lastPointerX;
    const dy = e.clientY - dc.lastPointerY;
    dc.lastPointerX = e.clientX;
    dc.lastPointerY = e.clientY;
    dc.yaw -= dx * DEBUG_CAM_DRAG_SENS;
    const half = Math.PI / 2 - 0.02;
    dc.pitch = Math.max(-half, Math.min(half, dc.pitch - dy * DEBUG_CAM_DRAG_SENS));
  });
  const stopDrag = (e) => {
    ctx._debugCam.dragging = false;
    try { canvas.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  };
  canvas.addEventListener('pointerup', stopDrag);
  canvas.addEventListener('pointercancel', stopDrag);
  canvas.addEventListener('wheel', (e) => {
    const dc = ctx._debugCam;
    if (!dc.active) return;
    e.preventDefault();
    dc.distance = Math.max(DEBUG_CAM_DIST_MIN,
      Math.min(DEBUG_CAM_DIST_MAX, dc.distance * (1 + e.deltaY * DEBUG_CAM_WHEEL_SENS)));
  }, { passive: false });
  ctx._debugKeydown = (e) => {
    const dc = ctx._debugCam;
    if (!dc.active || isTypingTarget()) return;
    const k = e.key.toLowerCase();
    if ('wasdqer'.includes(k)) dc.keys.add(k);
  };
  ctx._debugKeyup = (e) => {
    ctx._debugCam.keys.delete(e.key.toLowerCase());
  };
  window.addEventListener('keydown', ctx._debugKeydown);
  window.addEventListener('keyup', ctx._debugKeyup);
}

export function setDebugCam(ctx, on) {
  const dc = ctx._debugCam;
  if (!dc || dc.active === !!on) return;
  if (on && ctx._followCam && ctx._followCam.active) {
    setFollowCam(ctx, false);
  }
  dc.active = !!on;
  if (!dc.active) {
    dc.keys.clear();
    dc.dragging = false;
    placeCamera(ctx);
  }
}

export function isDebugCamActive(ctx) {
  return !!(ctx._debugCam && ctx._debugCam.active);
}

export function stepDebugCam(ctx) {
  const dc = ctx._debugCam;
  if (dc.keys.has('r')) {
    dc.target.copy(dc.defaultTarget);
    dc.distance = dc.defaultDistance;
    dc.yaw = dc.defaultYaw;
    dc.pitch = dc.defaultPitch;
    dc.keys.delete('r');
  }
  const speed = dc.distance * DEBUG_CAM_PAN_FRAC;
  const forwardX = -Math.sin(dc.yaw);
  const forwardZ = -Math.cos(dc.yaw);
  const rightX = Math.cos(dc.yaw);
  const rightZ = -Math.sin(dc.yaw);
  if (dc.keys.has('w')) { dc.target.x += forwardX * speed; dc.target.z += forwardZ * speed; }
  if (dc.keys.has('s')) { dc.target.x -= forwardX * speed; dc.target.z -= forwardZ * speed; }
  if (dc.keys.has('d')) { dc.target.x += rightX * speed; dc.target.z += rightZ * speed; }
  if (dc.keys.has('a')) { dc.target.x -= rightX * speed; dc.target.z -= rightZ * speed; }
  if (dc.keys.has('e')) { dc.target.y += speed; }
  if (dc.keys.has('q')) { dc.target.y -= speed; }

  const cosP = Math.cos(dc.pitch);
  const sinP = Math.sin(dc.pitch);
  const offX = Math.sin(dc.yaw) * cosP * dc.distance;
  const offY = sinP * dc.distance;
  const offZ = Math.cos(dc.yaw) * cosP * dc.distance;
  ctx.camera.position.set(dc.target.x + offX, dc.target.y + offY, dc.target.z + offZ);
  ctx.camera.lookAt(dc.target.x, dc.target.y, dc.target.z);
  ctx.camera.updateProjectionMatrix();
}

/* ── Follow camera (runtime-toggleable) ─────────────────────
 * Slides along a horizontal x-rail at fixed height + z-offset,
 * smoothly tracking a weighted action center (ball + both players
 * with ball weighted 2x). Critically-damped spring so fast ball
 * movement never snaps the camera. LookAt lags independently and
 * is biased by a signed lead offset so the action sits around the
 * 1/3 line of the screen with the goal side showing more space. */
export function initFollowCam(ctx) {
  ctx._followCam = {
    active: false,
    initialized: false,
    posX: 0,     velX: 0,
    lookX: 0,    lookVX: 0,
    leadX: 0,    leadVX: 0,
    zoom: FOLLOW_ZOOM_LIVE, zoomV: 0,
  };
}

export function setFollowCam(ctx, on) {
  const fc = ctx._followCam;
  if (!fc || fc.active === !!on) return;
  if (on && ctx._debugCam && ctx._debugCam.active) {
    setDebugCam(ctx, false);
  }
  fc.active = !!on;
  if (!fc.active) {
    placeCamera(ctx);
  } else {
    fc.initialized = false; // snap to first target on next step
  }
}

export function isFollowCamActive(ctx) {
  return !!(ctx._followCam && ctx._followCam.active);
}

export function stepFollowCam(ctx, state) {
  const fc = ctx._followCam;
  const ballX = state.ball.x;
  const p1X = state.p1.x;
  const p2X = state.p2.x;
  // Weighted action center — ball gets 2x weight.
  const actionX = (ballX * 2 + p1X + p2X) / 4;
  const midX = ctx.fieldWidth / 2;
  const ballSide = ballX > midX ? 1 : (ballX < midX ? -1 : 0);

  // Dead-ball: celebrate / matchend / reposition / waiting / grace / matchOver.
  // Zoom widens to FOLLOW_ZOOM_DEAD; rail/lookAt retarget to centred showcase.
  const deadBall = state.matchOver
    || state.pauseState !== null
    || state.graceFrames > 0;
  // Matchend 'pose' phase tightens back to LIVE for a cinematic dolly-in.
  const matchendDollyIn = state.pauseState === 'matchend'
    && state.matchEndPhase === 'pose';
  const zoomTarget   = matchendDollyIn ? FOLLOW_ZOOM_LIVE
                     : deadBall        ? FOLLOW_ZOOM_DEAD
                     :                   FOLLOW_ZOOM_LIVE;
  const posTarget    = deadBall ? midX : actionX;
  const lookTarget   = deadBall ? midX : actionX;
  const sideForLead  = deadBall ? 0 : ballSide;

  // Critically-damped spring coefficients (per frame @ 60Hz).
  const K_POS  = 0.012;
  const C_POS  = 2 * Math.sqrt(K_POS);
  const K_LOOK = 0.020;
  const C_LOOK = 2 * Math.sqrt(K_LOOK);
  const K_LEAD = 0.008;
  const C_LEAD = 2 * Math.sqrt(K_LEAD);
  const K_ZOOM = 0.004;
  const C_ZOOM = 2 * Math.sqrt(K_ZOOM);

  if (!fc.initialized) {
    fc.posX = posTarget;
    fc.velX = 0;
    fc.lookX = lookTarget;
    fc.lookVX = 0;
    fc.zoom = zoomTarget;
    fc.zoomV = 0;
    const { distance: d0 } = computeDistance(ctx, fc.zoom);
    fc.leadX = sideForLead * d0 * FOLLOW_LEAD_FRACTION;
    fc.leadVX = 0;
    fc.initialized = true;
  }

  const stepSpring = (pos, vel, target, k, c) => {
    const accel = (target - pos) * k - vel * c;
    const newVel = vel + accel;
    return [pos + newVel, newVel];
  };
  [fc.zoom, fc.zoomV] = stepSpring(fc.zoom, fc.zoomV, zoomTarget, K_ZOOM, C_ZOOM);

  // Compute distance from the *smoothed* zoom so the whole view pans
  // out together.
  const { distance, height, backOff } = computeDistance(ctx, fc.zoom);
  const leadTarget = sideForLead * distance * FOLLOW_LEAD_FRACTION;

  [fc.posX,  fc.velX]  = stepSpring(fc.posX,  fc.velX,  posTarget,  K_POS,  C_POS);
  [fc.lookX, fc.lookVX] = stepSpring(fc.lookX, fc.lookVX, lookTarget, K_LOOK, C_LOOK);
  [fc.leadX, fc.leadVX] = stepSpring(fc.leadX, fc.leadVX, leadTarget, K_LEAD, C_LEAD);

  const midZ = (FIELD_HEIGHT * Z_STRETCH) / 2;
  ctx.camera.position.set(fc.posX, height, midZ + backOff);
  ctx.camera.lookAt(fc.lookX + fc.leadX, 0, midZ);
  ctx.camera.updateProjectionMatrix();
}
