/**
 * Football v2 — three.js renderer (non-instanced, pooled-mesh version).
 *
 * One Mesh per visible glyph. Each atlas character has its own pre-built
 * unit-quad geometry with UVs baked in. Each frame we hide the trailing
 * range of the pool, then assign geometry/position/scale/color/offset to
 * the ~14 meshes we actually need. ~14 draw calls per frame for dynamic
 * content, plus ~12 static calls for the field and goals.
 *
 * Coordinate mapping:
 *   physics.x → three.js.x  (field horizontal)
 *   physics.z → three.js.y  (ball height / up)
 *   physics.y → three.js.z  (field depth)
 */

import * as THREE from './vendor/three.module.js';
import { createField, FIELD_HEIGHT, FIELD_WIDTH_REF } from './physics.js?v=31';

const POOL_SIZE = 400;

// Physics field depth (42) is ~21× narrower than its width (900); stretch
// render-space z so the field fills more of the canvas vertically.
const Z_STRETCH = 4.7;

// Small margin so field edges don't touch the canvas boundary.
const HORIZONTAL_MARGIN = 1.15;

const STICKMAN_GLYPH_SIZE = 22;
const BALL_GLYPH_SIZE = 24;
const WALK_ANIM_SPEED_THRESHOLD = 0.3;
const WALK_ANIM_SPEED_THRESHOLD_SQ = WALK_ANIM_SPEED_THRESHOLD * WALK_ANIM_SPEED_THRESHOLD;

const CAMERA_FOV = 60;
const CAMERA_TILT_DEG = 55;

/* ── Shaders ───────────────────────────────────────────────── */

const VERTEX_SHADER = /* glsl */ `
  uniform vec2 uViewOffset;
  varying vec2 vUv;

  void main() {
    // Billboarded quad: compute world center, transform to view space,
    // then add view-space offset + vertex position scaled uniformly.
    // Stackable in screen space regardless of camera pitch.
    vec3 worldCenter = vec3(modelMatrix[3][0], modelMatrix[3][1], modelMatrix[3][2]);
    vec4 viewCenter = viewMatrix * vec4(worldCenter, 1.0);
    float sx = length(vec3(modelMatrix[0][0], modelMatrix[0][1], modelMatrix[0][2]));
    viewCenter.xy += uViewOffset + position.xy * sx;
    gl_Position = projectionMatrix * viewCenter;
    vUv = uv;
  }
`;

const FRAGMENT_SHADER = /* glsl */ `
  uniform sampler2D sdfTexture;
  uniform vec3 uColor;
  varying vec2 vUv;

  // tiny-sdf edge sits at ~0.75 normalized (cutoff 0.25).
  const float EDGE = 0.75;
  const float AA = 0.02;

  void main() {
    float dist = texture2D(sdfTexture, vUv).g;
    float alpha = smoothstep(EDGE - AA, EDGE + AA, dist);
    if (alpha < 0.01) discard;
    gl_FragColor = vec4(uColor, alpha);
  }
`;

/* ── Palette (matches style.css design tokens) ─────────────── */

const COLOR_TEXT = rgb('#d0d0d0');
const COLOR_GREEN = rgb('#9ece6a');
const COLOR_AMBER = rgb('#e0af68');
const COLOR_RED = rgb('#f7768e');

/* ── Renderer ──────────────────────────────────────────────── */

export class Renderer {
  constructor(canvas, atlas, { fieldWidth = FIELD_WIDTH_REF } = {}) {
    this.atlas = atlas;
    this.fieldWidth = fieldWidth;
    this._field = createField(fieldWidth);

    this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio || 1);
    this.renderer.setClearColor(0x000000, 0);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(CAMERA_FOV, 2, 0.1, 4000);
    this._placeCamera();

    this._baseMaterial = new THREE.ShaderMaterial({
      uniforms: {
        sdfTexture: { value: atlas.texture },
        uColor: { value: new THREE.Vector3(1, 1, 1) },
        uViewOffset: { value: new THREE.Vector2(0, 0) },
      },
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });

    // Pre-build one BufferGeometry per atlas character (unit quads, UVs differ).
    this._glyphGeometries = new Map();
    for (const [ch, g] of atlas.glyphs) {
      this._glyphGeometries.set(ch, this._buildGlyphGeometry(g));
    }

    // Pre-resolve the fixed characters the renderer actually uses each frame
    // so the hot path avoids a Map lookup per glyph.
    this._glyphO = this._glyphGeometries.get('o');
    this._glyphSlash = this._glyphGeometries.get('/');
    this._glyphBackslash = this._glyphGeometries.get('\\');
    this._glyphPipe = this._glyphGeometries.get('|');
    this._glyphLParen = this._glyphGeometries.get('(');
    this._glyphRParen = this._glyphGeometries.get(')');

    // Pool of meshes, each with its own cloned material + cached uniform refs
    // so the hot path writes via `mesh._uColor.set(...)` directly.
    this._pool = [];
    const defaultGeom = this._glyphO || this._glyphGeometries.values().next().value;
    for (let i = 0; i < POOL_SIZE; i++) {
      const material = new THREE.ShaderMaterial({
        uniforms: {
          sdfTexture: { value: atlas.texture },
          uColor: { value: new THREE.Vector3(1, 1, 1) },
          uViewOffset: { value: new THREE.Vector2(0, 0) },
        },
        vertexShader: VERTEX_SHADER,
        fragmentShader: FRAGMENT_SHADER,
        transparent: true,
        depthTest: false,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(defaultGeom, material);
      mesh.visible = false;
      mesh.frustumCulled = false;
      mesh._uColor = material.uniforms.uColor.value;
      mesh._uViewOffset = material.uniforms.uViewOffset.value;
      this.scene.add(mesh);
      this._pool.push(mesh);
    }
    this._poolCursor = 0;

    // Pre-allocated per-player color buffers so staminaColor can write into
    // a reused array instead of allocating [r,g,b] every frame.
    this._p1Color = [0, 0, 0];
    this._p2Color = [0, 0, 0];

    // Track static scene objects so dispose() can release them.
    this._staticGeometries = [];
    this._staticMaterials = [];

    this._buildFieldLines();

    this._resizeObserver = null;
    this._lastW = 0;
    this._lastH = 0;
  }

  autoResize() {
    const observer = new ResizeObserver(() => this.resize());
    observer.observe(this.renderer.domElement);
    this._resizeObserver = observer;
    this.resize();
  }

  resize() {
    const canvas = this.renderer.domElement;
    const w = canvas.clientWidth || 900;
    const h = canvas.clientHeight || 220;
    if (w === this._lastW && h === this._lastH) return;
    this._lastW = w;
    this._lastH = h;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
    this._placeCamera();
  }

  dispose() {
    if (this._resizeObserver) this._resizeObserver.disconnect();
    for (const mesh of this._pool) mesh.material.dispose();
    for (const geom of this._glyphGeometries.values()) geom.dispose();
    for (const geom of this._staticGeometries) geom.dispose();
    for (const mat of this._staticMaterials) mat.dispose();
    this._baseMaterial.dispose();
    this.renderer.dispose();
  }

  renderState(state) {
    const prevCursor = this._poolCursor;
    this._poolCursor = 0;

    const tick = state.tick || 0;
    staminaColorInto(state.p1.stamina, this._p1Color);
    staminaColorInto(state.p2.stamina, this._p2Color);
    this._addStickman(state.p1, this._p1Color, tick);
    this._addStickman(state.p2, this._p2Color, tick);

    // Ball — bounce height becomes a view-space y offset so it shows up
    // regardless of camera tilt.
    this._placeGlyph(
      this._glyphO,
      state.ball.x, 0, state.ball.y,
      BALL_GLYPH_SIZE,
      COLOR_TEXT,
      0, (state.ball.z || 0) * 0.5
    );

    // Hide any meshes that were active last frame but aren't used this frame.
    for (let i = this._poolCursor; i < prevCursor; i++) {
      this._pool[i].visible = false;
    }

    this.renderer.render(this.scene, this.camera);
  }

  /* ── Camera ─────────────────────────────────────────────── */

  _placeCamera() {
    const midX = this.fieldWidth / 2;
    const midZ = (FIELD_HEIGHT * Z_STRETCH) / 2;
    const aspect = this.camera.aspect || 4;

    const halfFovVert = (CAMERA_FOV / 2) * Math.PI / 180;
    const tanHalfHoriz = Math.tan(halfFovVert) * aspect;
    const halfFieldWidth = (this.fieldWidth / 2) * HORIZONTAL_MARGIN;
    const distance = halfFieldWidth / tanHalfHoriz;

    const tiltRad = CAMERA_TILT_DEG * Math.PI / 180;
    const height = distance * Math.cos(tiltRad);
    const backOff = distance * Math.sin(tiltRad);

    this.camera.position.set(midX, height, midZ + backOff);
    this.camera.lookAt(midX, 0, midZ);
    this.camera.updateProjectionMatrix();
  }

  /* ── Glyph geometry ─────────────────────────────────────── */

  _buildGlyphGeometry(glyph) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
      -0.5, -0.5, 0,
       0.5, -0.5, 0,
       0.5,  0.5, 0,
      -0.5,  0.5, 0,
    ]), 3));
    // Atlas cell UVs. canvas flipY=true → v=1 is the top of the cell image,
    // so top vertices sample the higher v.
    const u0 = glyph.u;
    const u1 = glyph.u + glyph.w;
    const vTop = 1 - glyph.v;
    const vBot = 1 - (glyph.v + glyph.h);
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([
      u0, vBot,
      u1, vBot,
      u1, vTop,
      u0, vTop,
    ]), 2));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    return g;
  }

  /* ── Static world (field outline, midfield, goals) ──────── */

  _buildFieldLines() {
    const w = this.fieldWidth;
    const zFar = 0;
    const zNear = FIELD_HEIGHT * Z_STRETCH;
    const f = this._field;

    const dimColor = new THREE.Color('#707070');
    const mutedColor = new THREE.Color('#505050');
    const netColor = new THREE.Color('#404040');

    const lineMat = new THREE.LineBasicMaterial({ color: dimColor, transparent: true, opacity: 0.8 });
    const mutedMat = new THREE.LineBasicMaterial({ color: mutedColor, transparent: true, opacity: 0.5 });
    const netMat = new THREE.LineBasicMaterial({ color: netColor, transparent: true, opacity: 0.45 });
    const goalLineMat = new THREE.LineBasicMaterial({ color: dimColor, transparent: true, opacity: 0.75 });
    this._staticMaterials.push(lineMat, mutedMat, netMat, goalLineMat);

    const outlineGeom = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, zFar),
      new THREE.Vector3(w, 0, zFar),
      new THREE.Vector3(w, 0, zNear),
      new THREE.Vector3(0, 0, zNear),
    ]);
    this._addStatic(new THREE.LineLoop(outlineGeom, lineMat), outlineGeom);

    const midGeom = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(w / 2, 0, zFar),
      new THREE.Vector3(w / 2, 0, zNear),
    ]);
    this._addStatic(new THREE.Line(midGeom, mutedMat), midGeom);

    const goalDepth = f.goalLRight - f.goalLLeft;
    const goalWidth = (f.goalMouthYMax - f.goalMouthYMin) * Z_STRETCH;
    const goalHeight = f.goalMouthZMax * 2.25;
    const goalCenterZ = ((f.goalMouthYMin + f.goalMouthYMax) / 2) * Z_STRETCH;

    // Left goal: outer edge on -x (dir = -1). Right goal: mirror.
    const leftCenterX = (f.goalLLeft + f.goalLRight) / 2;
    const rightCenterX = (f.goalRLeft + f.goalRRight) / 2;
    this._addGoal(leftCenterX, goalCenterZ, goalDepth, goalWidth, goalHeight, -1, lineMat, netMat, goalLineMat);
    this._addGoal(rightCenterX, goalCenterZ, goalDepth, goalWidth, goalHeight, +1, lineMat, netMat, goalLineMat);
  }

  _addStatic(obj, geometry) {
    this.scene.add(obj);
    if (geometry) this._staticGeometries.push(geometry);
  }

  _addGoal(centerX, centerZ, depth, width, height, dir, mat, netMat, goalLineMat) {
    const halfD = depth / 2;
    const halfW = width / 2;
    // dir = +1: back wall on +x side (RIGHT goal); dir = -1: back wall on -x (LEFT).
    const vertX = centerX + dir * halfD;
    const backTopX = centerX - dir * halfD;
    const frontWallX = backTopX - dir * halfD;
    // Empirical front-post offsets: make the front wall look perpendicular
    // in screen space under the current 55° camera tilt.
    const postABotX = vertX - dir * 58;
    const postBBotX = vertX - dir * 52;
    const zMin = centerZ - halfW;
    const zMax = centerZ + halfW;
    const P = (x, y, z) => new THREE.Vector3(x, y, z);

    // Back wall (slanted): diagonals + top crossbar + bottom rail.
    const backGeom = new THREE.BufferGeometry().setFromPoints([
      P(vertX, 0, zMin), P(backTopX, height, zMin),
      P(vertX, 0, zMax), P(backTopX, height, zMax),
      P(backTopX, height, zMin), P(backTopX, height, zMax),
      P(vertX, 0, zMin), P(vertX, 0, zMax),
    ]);
    this._addStatic(new THREE.LineSegments(backGeom, mat), backGeom);

    // Front mouth: 2 posts + top crossbar.
    const frontGeom = new THREE.BufferGeometry().setFromPoints([
      P(postABotX, 0, zMin), P(frontWallX, height, zMin),
      P(postBBotX, 0, zMax), P(frontWallX, height, zMax),
      P(frontWallX, height, zMin), P(frontWallX, height, zMax),
    ]);
    this._addStatic(new THREE.LineSegments(frontGeom, mat), frontGeom);

    // Connecting rails: top (front↔back) and bottom (vertX↔post-bottom).
    const railGeom = new THREE.BufferGeometry().setFromPoints([
      P(frontWallX, height, zMin), P(backTopX, height, zMin),
      P(frontWallX, height, zMax), P(backTopX, height, zMax),
      P(vertX, 0, zMin), P(postABotX, 0, zMin),
      P(vertX, 0, zMax), P(postBBotX, 0, zMax),
    ]);
    this._addStatic(new THREE.LineSegments(railGeom, mat), railGeom);

    // Net grid on the 4 closed surfaces (back, top, left side, right side).
    // Front mouth stays open. Bilinear grid — nU lines along A→B / D→C and
    // nV lines along A→D / B→C.
    const netPoints = [];
    const pushNet = (A, B, C, D, nU, nV) => {
      for (let i = 1; i < nU; i++) {
        const t = i / nU;
        netPoints.push(
          P(A.x + (B.x - A.x) * t, A.y + (B.y - A.y) * t, A.z + (B.z - A.z) * t),
          P(D.x + (C.x - D.x) * t, D.y + (C.y - D.y) * t, D.z + (C.z - D.z) * t),
        );
      }
      for (let j = 1; j < nV; j++) {
        const t = j / nV;
        netPoints.push(
          P(A.x + (D.x - A.x) * t, A.y + (D.y - A.y) * t, A.z + (D.z - A.z) * t),
          P(B.x + (C.x - B.x) * t, B.y + (C.y - B.y) * t, B.z + (C.z - B.z) * t),
        );
      }
    };
    pushNet(P(vertX, 0, zMin),      P(vertX, 0, zMax),      P(backTopX, height, zMax),   P(backTopX, height, zMin),   6, 4); // back
    pushNet(P(frontWallX, height, zMin), P(backTopX, height, zMin), P(backTopX, height, zMax), P(frontWallX, height, zMax), 4, 6); // top
    pushNet(P(postABotX, 0, zMin),  P(vertX, 0, zMin),      P(backTopX, height, zMin),   P(frontWallX, height, zMin), 5, 4); // side zMin
    pushNet(P(postBBotX, 0, zMax),  P(vertX, 0, zMax),      P(backTopX, height, zMax),   P(frontWallX, height, zMax), 5, 4); // side zMax

    const netGeom = new THREE.BufferGeometry().setFromPoints(netPoints);
    this._addStatic(new THREE.LineSegments(netGeom, netMat), netGeom);

    // Goal line: dashed "_ _ _" along the bottom-front of the mouth.
    const dashCount = 8;
    const dashRatio = 0.4;
    const axBot = postABotX, azBot = zMin;
    const bxBot = postBBotX, bzBot = zMax;
    const dxBot = bxBot - axBot;
    const dzBot = bzBot - azBot;
    const goalLinePoints = [];
    for (let i = 0; i < dashCount; i++) {
      const t0 = i / dashCount;
      const t1 = t0 + dashRatio / dashCount;
      goalLinePoints.push(
        P(axBot + dxBot * t0, 0, azBot + dzBot * t0),
        P(axBot + dxBot * t1, 0, azBot + dzBot * t1),
      );
    }
    const goalLineGeom = new THREE.BufferGeometry().setFromPoints(goalLinePoints);
    this._addStatic(new THREE.LineSegments(goalLineGeom, goalLineMat), goalLineGeom);
  }

  /* ── Stickman & pool ────────────────────────────────────── */

  _addStickman(player, color, tick) {
    // 6-glyph billboarded figure. Walk cycle is 4 frames (plant-R, lift,
    // plant-L, lift) × 7 ticks each = ~450ms per cycle. Head bobs up on
    // lift frames, arms swap their back/forward slash on plant frames.
    const x = player.x + 9;
    const z = player.y;
    const s = STICKMAN_GLYPH_SIZE;

    const speedSq = player.vx * player.vx + player.vy * player.vy;
    const walking = speedSq > WALK_ANIM_SPEED_THRESHOLD_SQ;
    const frame = walking ? Math.floor(tick / 7) % 4 : -1;
    const lifted = frame === 1 || frame === 3;
    // Legs stay planted; the head+body rise on lift frames so the figure
    // visibly grows taller mid-stride.
    const bob = lifted ? 0.10 : 0;

    const headY = s * (1.4 + bob);
    const bodyY = s * (0.6 + bob);
    const legY  = s * -0.25;

    // Head
    this._placeGlyph(this._glyphO, x, 0, z, s, color, 0, headY);

    // Arms + body row. Plant frames swap one side's slash for a paren to
    // suggest the arm swinging back; lift/idle frames are symmetric `/|\`.
    let armL = this._glyphSlash;
    let armR = this._glyphBackslash;
    if (frame === 0) {
      // Right leg planted forward → right arm swung back, left arm forward
      armL = this._glyphLParen;
      armR = this._glyphBackslash;
    } else if (frame === 2) {
      // Left leg planted forward → left arm swung back, right arm forward
      armL = this._glyphSlash;
      armR = this._glyphRParen;
    }
    this._placeGlyph(armL,            x, 0, z, s, color, -s * 0.55, bodyY);
    this._placeGlyph(this._glyphPipe, x, 0, z, s, color,  0,        bodyY);
    this._placeGlyph(armR,            x, 0, z, s, color,  s * 0.55, bodyY);

    // Legs
    if (frame === 0) {
      // Plant-R: right leg out wide, left leg planted straight
      this._placeGlyph(this._glyphPipe,      x, 0, z, s, color, -s * 0.14, legY);
      this._placeGlyph(this._glyphBackslash, x, 0, z, s, color,  s * 0.32, legY);
    } else if (frame === 2) {
      // Plant-L: left leg out wide, right leg planted straight
      this._placeGlyph(this._glyphSlash,     x, 0, z, s, color, -s * 0.32, legY);
      this._placeGlyph(this._glyphPipe,      x, 0, z, s, color,  s * 0.14, legY);
    } else if (frame === 1 || frame === 3) {
      // Lift: legs together under the hips (mid-stride)
      this._placeGlyph(this._glyphPipe, x, 0, z, s, color, -s * 0.12, legY);
      this._placeGlyph(this._glyphPipe, x, 0, z, s, color,  s * 0.12, legY);
    } else {
      // Idle: legs spread symmetrically
      this._placeGlyph(this._glyphSlash,     x, 0, z, s, color, -s * 0.28, legY);
      this._placeGlyph(this._glyphBackslash, x, 0, z, s, color,  s * 0.28, legY);
    }
  }

  _placeGlyph(geom, x, y, z, scale, color, viewOffsetX, viewOffsetY) {
    if (!geom || this._poolCursor >= this._pool.length) return;
    const mesh = this._pool[this._poolCursor++];
    mesh.geometry = geom;
    mesh.position.set(x, y, z * Z_STRETCH);
    mesh.scale.set(scale, scale, 1);
    mesh._uColor.set(color[0], color[1], color[2]);
    mesh._uViewOffset.set(viewOffsetX, viewOffsetY);
    mesh.visible = true;
  }
}

/* ── Helpers ───────────────────────────────────────────────── */

function rgb(hex) {
  const h = hex.replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16) / 255,
    parseInt(h.slice(2, 4), 16) / 255,
    parseInt(h.slice(4, 6), 16) / 255,
  ];
}

function staminaColorInto(stamina, out) {
  const s = stamina < 0 ? 0 : (stamina > 1 ? 1 : stamina);
  if (s >= 0.5) {
    const t = (s - 0.5) * 2;
    lerpInto(COLOR_AMBER, COLOR_GREEN, t, out);
    return;
  }
  const t = s * 2;
  lerpInto(COLOR_RED, COLOR_AMBER, t, out);
}

function lerpInto(a, b, t, out) {
  out[0] = a[0] + (b[0] - a[0]) * t;
  out[1] = a[1] + (b[1] - a[1]) * t;
  out[2] = a[2] + (b[2] - a[2]) * t;
}
