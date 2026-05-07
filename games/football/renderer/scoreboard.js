/**
 * Football v2 — in-3D player name labels (renderer-side).
 *
 * Billboarded sprites that float above each stickman's head with a
 * small Y offset, with overlap-fade so the two names don't smush
 * together at low camera angles. Texture is rebuilt only when the
 * label text changes.
 *
 * ctx-style: every function takes the Renderer instance.
 */

import * as THREE from 'https://unpkg.com/three@0.164.0/build/three.module.js';
import {
  NAME_LABEL_HEAD_GAP, NAME_LABEL_CANVAS_W, NAME_LABEL_CANVAS_H,
  NAME_LABEL_FONT, NAME_LABEL_TEXT_COLOR,
  NAME_LABEL_SHADOW_COLOR, NAME_LABEL_SHADOW_BLUR,
  NAME_LABEL_SCALE_X, NAME_LABEL_SCALE_Y,
  NAME_LABEL_FADE_BELOW, NAME_LABEL_FADE_FULL,
} from './tuning.js';
import {
  PLAYER_WIDTH, STICKMAN_HEAD_RADIUS, STICKMAN_LIMB_FULL_H, Z_STRETCH,
} from '../physics/index.js';

/** Position both name-label sprites at each player's head with a small
 *  Y offset, set the texture from `state.matchNames`, apply overlap
 *  fade based on screen-space label distance. */
export function updateNameLabels(ctx, state, players) {
  const names = state.matchNames;
  if (!names || players.length < 2) {
    ctx._nameLabels.forEach((l) => l.mesh.visible = false);
    return;
  }
  const labels = ctx._nameLabels;
  const offsetY = STICKMAN_HEAD_RADIUS + NAME_LABEL_HEAD_GAP;
  for (let i = 0; i < 2; i++) {
    const p = players[i];
    const anim = ctx._animByPlayer.get(p);
    // Fall back to player center if anim hasn't rendered yet.
    const headX = anim?.lastHeadX ?? (p.x + PLAYER_WIDTH / 2);
    const headY = anim?.lastHeadY ?? STICKMAN_LIMB_FULL_H * 2;
    const headZ = anim?.lastHeadZ ?? (p.y * Z_STRETCH);
    labels[i].mesh.position.set(headX, headY + offsetY, headZ);
    labels[i].mesh.visible = true;
    setLabelText(labels[i], i === 0 ? names.p1 : names.p2);
  }
  // Overlap fade — project both label positions to screen space.
  const camera = ctx.camera;
  const a = ctx._nameLabelTmpA.copy(labels[0].mesh.position).project(camera);
  const b = ctx._nameLabelTmpB.copy(labels[1].mesh.position).project(camera);
  const w = ctx.renderer.domElement.width / 2;
  const h = ctx.renderer.domElement.height / 2;
  const dx = (a.x - b.x) * w;
  const dy = (a.y - b.y) * h;
  const pixelDist = Math.hypot(dx, dy);
  let alpha = 1;
  if (pixelDist < NAME_LABEL_FADE_BELOW) {
    alpha = Math.max(0, (pixelDist - NAME_LABEL_FADE_FULL)
                     / (NAME_LABEL_FADE_BELOW - NAME_LABEL_FADE_FULL));
  }
  labels[0].mat.opacity = alpha;
  labels[1].mat.opacity = alpha;
}

/** Allocate one billboarded name-label sprite. Returns
 *  { mesh, canvas, ctx, texture, mat, name }. Texture is updated lazily
 *  via setLabelText. */
export function makeNameLabel(ctx) {
  const canvas = document.createElement('canvas');
  canvas.width = NAME_LABEL_CANVAS_W;
  canvas.height = NAME_LABEL_CANVAS_H;
  const canvasCtx = canvas.getContext('2d');
  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  const mat = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
  const mesh = new THREE.Sprite(mat);
  // World-space scale tuned so labels read as small floating tags at
  // the camera's working distance without overpowering the figure.
  mesh.scale.set(NAME_LABEL_SCALE_X, NAME_LABEL_SCALE_Y, 1);
  mesh.renderOrder = 999;
  ctx.scene.add(mesh);
  return { mesh, canvas, ctx: canvasCtx, texture, mat, name: '' };
}

export function setLabelText(label, rawName) {
  const name = (rawName || '').toLowerCase();
  if (label.name === name) return;
  label.name = name;
  const { ctx, canvas, texture } = label;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.font = NAME_LABEL_FONT;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = NAME_LABEL_TEXT_COLOR;
  ctx.shadowColor = NAME_LABEL_SHADOW_COLOR;
  ctx.shadowBlur = NAME_LABEL_SHADOW_BLUR;
  ctx.fillText(name, canvas.width / 2, canvas.height / 2);
  texture.needsUpdate = true;
}
