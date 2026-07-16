/**
 * Football v2 — pure renderer helpers (no `ctx`, no class state).
 *
 * Colour conversion + interpolation, and the procedural soccer-ball
 * texture builder. Everything here is allocation-light and side-
 * effect-free aside from the texture canvas. Imported by renderer/
 * scene.js + renderer/player-rig.js + renderer/ball.js.
 *
 * Visual constants (COLOR_*, shaders) live in renderer/tuning.js.
 */

import * as THREE from 'https://unpkg.com/three@0.164.0/build/three.module.js';
import {
  COLOR_STAM_LOW, COLOR_STAM_MID, COLOR_STAM_HIGH,
} from './tuning.js';

/**
 * Blend LOW → MID → HIGH as `t` goes 0 → 0.5 → 1. Writes the result
 * into `out` (length-3 [r,g,b] array) to avoid per-frame allocation.
 * `t` is clamped to [0, 1].
 */
export function staminaColorInto(out, t) {
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
  let a, b, k;
  if (clamped < 0.5) {
    a = COLOR_STAM_LOW; b = COLOR_STAM_MID; k = clamped * 2;
  } else {
    a = COLOR_STAM_MID; b = COLOR_STAM_HIGH; k = (clamped - 0.5) * 2;
  }
  out[0] = a[0] + (b[0] - a[0]) * k;
  out[1] = a[1] + (b[1] - a[1]) * k;
  out[2] = a[2] + (b[2] - a[2]) * k;
  return out;
}

/**
 * Procedural soccer-ball texture. Per-pixel computation: each texel's
 * (u, v) is mapped to a 3D direction on the unit sphere, and we colour
 * it based on the angular distance to the nearest icosahedron vertex.
 * This places ~12 uniform-looking dark panels on the rendered sphere
 * (Telstar-pattern equivalent) without the equirectangular smearing
 * that a fixed-pixel-radius painter produced near the poles.
 *
 * Spot edge is softened by a thin band where the angle is between
 * SPOT_INNER and SPOT_OUTER, giving subpixel anti-aliasing.
 */
export function buildBallTexture() {
  const W = 512, H = 256;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  // 12 icosahedron vertices on the unit sphere.
  const t = (1 + Math.sqrt(5)) / 2;
  const raw = [
    [-1,  t,  0], [ 1,  t,  0], [-1, -t,  0], [ 1, -t,  0],
    [ 0, -1,  t], [ 0,  1,  t], [ 0, -1, -t], [ 0,  1, -t],
    [ t,  0, -1], [ t,  0,  1], [-t,  0, -1], [-t,  0,  1],
  ];
  const verts = raw.map(([x, y, z]) => {
    const len = Math.hypot(x, y, z);
    return [x / len, y / len, z / len];
  });

  // Spot geometry: angular radius (in radians from spot centre).
  // ~22° matches the apparent size of a Telstar pentagon.
  const SPOT_INNER = Math.cos(0.32);
  const SPOT_OUTER = Math.cos(0.36);
  const BG = 245, FG = 26;

  const img = ctx.createImageData(W, H);
  const data = img.data;
  for (let py = 0; py < H; py++) {
    const v = py / (H - 1);
    const lat = (0.5 - v) * Math.PI;
    const cosLat = Math.cos(lat);
    const sinLat = Math.sin(lat);
    for (let px = 0; px < W; px++) {
      const u = px / W;
      const lon = (u - 0.5) * 2 * Math.PI;
      const dx = cosLat * Math.cos(lon);
      const dy = sinLat;
      const dz = cosLat * Math.sin(lon);
      let bestDot = -1;
      for (let k = 0; k < 12; k++) {
        const e = verts[k];
        const d = dx * e[0] + dy * e[1] + dz * e[2];
        if (d > bestDot) bestDot = d;
      }
      let c;
      if (bestDot >= SPOT_INNER) {
        c = FG;
      } else if (bestDot >= SPOT_OUTER) {
        const k = (bestDot - SPOT_OUTER) / (SPOT_INNER - SPOT_OUTER);
        c = Math.round(BG + (FG - BG) * k);
      } else {
        c = BG;
      }
      const i = (py * W + px) * 4;
      data[i] = c;
      data[i + 1] = c;
      data[i + 2] = c;
      data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}
