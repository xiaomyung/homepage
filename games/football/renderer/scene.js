/**
 * Football v2 — three.js scene + camera + lights setup, plus the
 * ResizeObserver lifecycle.
 *
 * The Renderer class calls `initScene(this, canvas)` once during
 * construction and `disposeScene(this)` from its dispose() method.
 * Static geometries / materials accumulated by the rest of the
 * renderer are tracked on `ctx._staticGeometries` / `_staticMaterials`
 * so they all release together.
 */

import * as THREE from 'https://unpkg.com/three@0.164.0/build/three.module.js';
import { CAMERA_FOV } from './tuning.js';
import { placeCamera } from './camera.js';

/** Wire up the WebGLRenderer + perspective camera + ambient/directional
 *  /fill lights. Adds the lights to the scene immediately. */
export function initScene(ctx, canvas) {
  ctx.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  ctx.renderer.setPixelRatio(window.devicePixelRatio || 1);
  ctx.renderer.setClearColor(0x000000, 0);

  ctx.scene = new THREE.Scene();
  ctx.camera = new THREE.PerspectiveCamera(CAMERA_FOV, 2, 0.1, 4000);
  placeCamera(ctx);

  // Lighting for the ball sphere and cylindrical stickmen. The rest of
  // the scene is rendered with unlit line / basic materials, so these
  // lights only affect meshes that use a lit material. Low ambient +
  // strong directional gives pronounced terminator shading so the ball
  // and stickmen read as solid 3D objects instead of flat discs / pipes.
  ctx.scene.add(new THREE.AmbientLight(0xffffff, 0.35));
  const dirLight = new THREE.DirectionalLight(0xffffff, 1.15);
  dirLight.position.set(0.6, 1.0, 0.4);
  ctx.scene.add(dirLight);
  // Second dim fill light from the opposite side so the shadow side of
  // the ball doesn't go completely dead.
  const fill = new THREE.DirectionalLight(0xffffff, 0.35);
  fill.position.set(-0.4, 0.3, -0.5);
  ctx.scene.add(fill);
}

/** Release every tracked geometry / material, drop scene children,
 *  detach the WebGL context. Idempotent — safe to call multiple times
 *  but later calls are no-ops once the renderer is gone. */
export function disposeScene(ctx) {
  if (ctx._resizeObserver) ctx._resizeObserver.disconnect();
  if (ctx._debugKeydown) window.removeEventListener('keydown', ctx._debugKeydown);
  if (ctx._debugKeyup) window.removeEventListener('keyup', ctx._debugKeyup);
  for (const geom of ctx._staticGeometries) geom.dispose();
  for (const mat of ctx._staticMaterials) mat.dispose();
  while (ctx.scene.children.length > 0) ctx.scene.remove(ctx.scene.children[0]);
  ctx.renderer.dispose();
}

