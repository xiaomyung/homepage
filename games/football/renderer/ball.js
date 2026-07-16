/**
 * Football v2 — ball + shadow mesh init.
 *
 * Builds the shared ball SphereGeometry + MeshStandardMaterial (with
 * the procedural Telstar-pattern texture) and the soft drop-shadow
 * disc factory, then exposes both as ctx-bound mesh-pool factories.
 *
 * The ball mesh placement / spin integration / shadow scale + fade per
 * frame lives inside `renderer/update-loop.js` (it works against the
 * pools allocated here). Spawning extra balls beyond the pre-created
 * single slot grows the pool lazily via ctx._mkBall().
 */

import * as THREE from 'https://unpkg.com/three@0.164.0/build/three.module.js';
import {
  SHADOW_ALPHA_BASE,
  SHADOW_VERTEX_SHADER, SHADOW_FRAGMENT_SHADER,
} from './tuning.js';
import { buildBallTexture } from './materials.js';

/** Build the ball mesh pool + spin scratch objects. Pre-creates the
 *  common single-ball slot. Pushes the geometry/material into the
 *  ctx's static-disposal arrays. */
export function initBallPool(ctx) {
  // Dedicated ball mesh: a real 3D sphere in world space at
  // (ball.x, ball.z, ball.y * Z_STRETCH). Visual radius equals
  // BALL_RADIUS so the rendered sphere and the collision envelope
  // can't drift apart. A procedurally-generated CanvasTexture paints
  // ~12 dark panels at icosahedron-vertex positions.
  const ballGeom = new THREE.SphereGeometry(1, 24, 16);
  const ballMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.55,
    metalness: 0.05,
    map: buildBallTexture(),
  });
  ctx._staticGeometries.push(ballGeom);
  ctx._staticMaterials.push(ballMat);
  ctx._staticMaterials.push(ballMat.map);
  // Pooled meshes so harnesses can render N physics worlds. Each mesh's
  // quaternion accumulates spin independently across frames — callers
  // must pass balls in stable order for rotation continuity.
  ctx._ballGeom = ballGeom;
  ctx._ballMat = ballMat;
  ctx._ballMeshes = [];
  ctx._ballCursor = 0;
  ctx._mkBall = () => {
    const mesh = new THREE.Mesh(ctx._ballGeom, ctx._ballMat);
    mesh.frustumCulled = false;
    mesh.visible = false;
    ctx.scene.add(mesh);
    ctx._ballMeshes.push(mesh);
    return mesh;
  };
  ctx._mkBall();  // pre-create the common single-ball slot
  // Ball-spin scratch objects (shared across pool — spin integration is
  // applied to the currently-indexed mesh's quaternion).
  ctx._ballSpinAxis = new THREE.Vector3();
  ctx._ballSpinQuat = new THREE.Quaternion();
}

/** Build the shared shadow geometry + a per-instance material factory.
 *  Each shadow mesh gets its own material so `uAlpha` can be animated
 *  per-entity (ball fades as it rises). */
export function initShadowFactory(ctx) {
  const shadowGeom = new THREE.PlaneGeometry(1, 1);
  ctx._staticGeometries.push(shadowGeom);
  ctx._shadowGeom = shadowGeom;
  ctx._makeShadow = () => {
    const mat = new THREE.ShaderMaterial({
      uniforms: { uAlpha: { value: SHADOW_ALPHA_BASE } },
      vertexShader: SHADOW_VERTEX_SHADER,
      fragmentShader: SHADOW_FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(ctx._shadowGeom, mat);
    mesh.rotation.x = -Math.PI / 2;  // lay flat on xz plane
    mesh.frustumCulled = false;
    mesh._uAlpha = mat.uniforms.uAlpha;
    ctx._staticMaterials.push(mat);
    ctx.scene.add(mesh);
    return mesh;
  };
  // Pool of ball shadows — one per ball mesh (matched by index).
  ctx._ballShadows = [ctx._makeShadow()];
  ctx._ballShadowCursor = 0;
}
