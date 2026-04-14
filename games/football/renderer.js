/**
 * Football v2 — three.js renderer (non-instanced, pooled-mesh version).
 *
 * Design: one Mesh per visible glyph. Each character in the atlas has
 * its own pre-built unit-quad geometry with UVs baked into the atlas
 * cell. At runtime a fixed pool of Meshes is reused — each frame we hide
 * them all, then assign geometry, position, scale, and color on the ones
 * we need. No instanced attributes, no custom binding logic, no shader
 * attribute surprises. 130 draw calls per frame is well within three.js's
 * capacity.
 *
 * Coordinate system:
 *   Physics x → three.js x (field horizontal)
 *   Physics z (ball height) → three.js y (up)
 *   Physics y (field depth)  → three.js z
 *
 * Camera: perspective, ~55° tilt from vertical above midfield, framed to
 * fit the whole field width for the current canvas aspect ratio. The field
 * depth (world z) is stretched by Z_STRETCH so the genuinely-very-wide
 * 21:1 physics field fills more of the canvas vertically.
 */

import * as THREE from './vendor/three.module.js';
import { createField, FIELD_HEIGHT } from './physics.js';

const DEFAULT_FIELD_WIDTH = 900;
const POOL_SIZE = 400;

// Physics field depth (42) is ~21× narrower than its width (900), so a
// straight 1:1 projection renders the field as a thin horizontal strip.
// Multiply z by this in render space so the field fills more of the
// canvas vertically. Physics stays unchanged; only visuals are stretched.
const Z_STRETCH = 4.7;

// Small margin so the field edges don't touch the canvas boundary
const HORIZONTAL_MARGIN = 1.15;

// Per-element view-space sizes. The shader applies scale in view space,
// so these are effectively "world units at the projected distance".
const STICKMAN_GLYPH_SIZE = 22;
const BALL_GLYPH_SIZE = 16;

/* ── Shaders ─────────────────────────────────────────────── */

const VERTEX_SHADER = /* glsl */ `
  // Built-in uniforms auto-injected by ShaderMaterial:
  //   mat4 modelMatrix, modelViewMatrix, viewMatrix, projectionMatrix
  // Built-in attributes: vec3 position, vec2 uv

  uniform vec2 uViewOffset;

  varying vec2 vUv;

  void main() {
    // Billboarded quad: take the mesh's world-space translation, transform
    // to view space, then add (a) a per-mesh VIEW-SPACE offset and (b) the
    // vertex's (x, y) scaled by the mesh's uniform scale. Both (a) and (b)
    // are in view XY (screen-aligned), so they're not affected by camera
    // pitch — this lets us stack stickman parts in screen space rather
    // than world space.
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

  // tiny-sdf encoding: glyph edge at 255 * (1 - cutoff) = 255 * 0.75 ≈ 191,
  // which is ~0.75 in normalized [0, 1]. Values above = inside the glyph,
  // below = outside.
  const float EDGE = 0.75;
  const float AA = 0.02;

  void main() {
    float dist = texture2D(sdfTexture, vUv).g;
    float alpha = smoothstep(EDGE - AA, EDGE + AA, dist);
    if (alpha < 0.01) discard;
    gl_FragColor = vec4(uColor, alpha);
  }
`;

/* ── Palette (matches style.css design tokens) ─────────── */

const COLOR_TEXT = rgb('#d0d0d0');
const COLOR_DIM = rgb('#707070');
const COLOR_MUTED = rgb('#505050');
const COLOR_GREEN = rgb('#9ece6a');
const COLOR_AMBER = rgb('#e0af68');
const COLOR_RED = rgb('#f7768e');

/* ── Renderer ──────────────────────────────────────────── */

export class Renderer {
  constructor(canvas, atlas, { fieldWidth = DEFAULT_FIELD_WIDTH } = {}) {
    this.atlas = atlas;
    this.fieldWidth = fieldWidth;
    this._field = createField(fieldWidth);

    this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio || 1);
    this.renderer.setClearColor(0x000000, 0);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(60, 2, 0.1, 4000);
    this._placeCamera();

    // Base (shared) material — we clone it per pool mesh so each has its
    // own uColor / uViewOffset uniforms.
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

    // Pre-build one BufferGeometry per character in the atlas. All
    // geometries are unit quads; only the UVs differ.
    this._glyphGeometries = new Map();
    for (const [ch, g] of atlas.glyphs) {
      this._glyphGeometries.set(ch, this._buildGlyphGeometry(g));
    }

    // Pool of Meshes. Each has its own cloned material with fresh uniforms
    // so changes to one mesh don't bleed into others.
    this._pool = [];
    const defaultGeom = this._glyphGeometries.values().next().value;
    for (let i = 0; i < POOL_SIZE; i++) {
      const material = this._baseMaterial.clone();
      material.uniforms = {
        sdfTexture: { value: atlas.texture },
        uColor: { value: new THREE.Vector3(1, 1, 1) },
        uViewOffset: { value: new THREE.Vector2(0, 0) },
      };
      const mesh = new THREE.Mesh(defaultGeom, material);
      mesh.visible = false;
      mesh.frustumCulled = false;
      this.scene.add(mesh);
      this._pool.push(mesh);
    }
    this._poolCursor = 0;

    // Static field lines (rectangle outline, midfield divider, goal frames)
    // — added to the scene once at init, never updated per frame
    this._buildFieldLines();

    this._resizeObserver = null;
  }

  autoResize() {
    const canvas = this.renderer.domElement;
    const observer = new ResizeObserver(() => this.resize());
    observer.observe(canvas);
    this._resizeObserver = observer;
    this.resize();
  }

  resize() {
    const canvas = this.renderer.domElement;
    const w = canvas.clientWidth || 900;
    const h = canvas.clientHeight || 220;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
    this._placeCamera();
  }

  dispose() {
    if (this._resizeObserver) this._resizeObserver.disconnect();
    for (const mesh of this._pool) {
      mesh.material.dispose();
    }
    for (const geom of this._glyphGeometries.values()) {
      geom.dispose();
    }
    this._baseMaterial.dispose();
    this.renderer.dispose();
  }

  renderState(state) {
    this._resetPool();

    // Stickmen (walk-anim driven by tick + movement)
    const tick = state.tick || 0;
    this._addStickman(state.p1, staminaColor(state.p1.stamina), tick);
    this._addStickman(state.p2, staminaColor(state.p2.stamina), tick);

    // Ball — bounce height translates to a view-space y offset so the
    // bounce is visible on screen regardless of camera tilt
    const bounceViewY = (state.ball.z || 0) * 0.5;
    this._placeGlyph(
      'o',
      state.ball.x,
      0,
      state.ball.y,
      BALL_GLYPH_SIZE,
      COLOR_TEXT,
      0,
      bounceViewY
    );

    this.renderer.render(this.scene, this.camera);
  }

  /* ── Internals ──────────────────────────────────── */

  _placeCamera() {
    // Adaptive camera — frames the full field width edge-to-edge for
    // the current canvas aspect ratio, with a ~22° tilt from vertical.
    // Render-space z is stretched by Z_STRETCH so the field's apparent
    // depth matches the canvas aspect better.
    const midX = this.fieldWidth / 2;
    const midZ = (FIELD_HEIGHT * Z_STRETCH) / 2;
    const aspect = this.camera.aspect || 4;

    const fovDeg = 60;
    const halfFovVert = (fovDeg / 2) * Math.PI / 180;
    const tanHalfHoriz = Math.tan(halfFovVert) * aspect;

    // Small horizontal margin so the field doesn't sit flush against
    // the canvas edge (which clips 1px lines at the boundary)
    const halfFieldWidth = (this.fieldWidth / 2) * HORIZONTAL_MARGIN;
    const distance = halfFieldWidth / tanHalfHoriz;

    // Tilt 55° from vertical — each +5° brings the camera closer to a
    // side view. Cos(55°) ≈ 0.574 vs cos(50°) ≈ 0.643, so height drops
    // another ~11% at constant Euclidean distance.
    const tiltRad = 55 * Math.PI / 180;
    const height = distance * Math.cos(tiltRad);
    const backOff = distance * Math.sin(tiltRad);

    this.camera.fov = fovDeg;
    this.camera.position.set(midX, height, midZ + backOff);
    this.camera.lookAt(midX, 0, midZ);
    this.camera.updateProjectionMatrix();
  }

  /** Build a unit-quad BufferGeometry with UVs baked into the atlas cell. */
  _buildGlyphGeometry(glyph) {
    const g = new THREE.BufferGeometry();
    // Vertices: unit quad in xy plane, centered on origin
    g.setAttribute(
      'position',
      new THREE.BufferAttribute(
        new Float32Array([
          -0.5, -0.5, 0,
           0.5, -0.5, 0,
           0.5,  0.5, 0,
          -0.5,  0.5, 0,
        ]),
        3
      )
    );
    // UVs: rectangle pointing at the glyph's atlas cell. Using three.js
    // convention (UV origin bottom-left, v=1 = top of original image with
    // flipY=true), the TOP vertices of the quad should sample the TOP of
    // the cell in the canvas image, which corresponds to the higher v.
    const u0 = glyph.u;
    const u1 = glyph.u + glyph.w;
    const vTop = 1 - glyph.v;                  // top of cell in canvas = high v in UV
    const vBot = 1 - (glyph.v + glyph.h);      // bottom of cell in canvas = low v in UV
    g.setAttribute(
      'uv',
      new THREE.BufferAttribute(
        new Float32Array([
          u0, vBot,  // bottom-left vertex → bottom of glyph cell
          u1, vBot,  // bottom-right
          u1, vTop,  // top-right
          u0, vTop,  // top-left
        ]),
        2
      )
    );
    g.setIndex([0, 1, 2, 0, 2, 3]);
    return g;
  }

  _buildFieldLines() {
    // Draw the field outline, midfield divider, and goal frames as
    // three.js Line primitives in world space. Lines are NOT billboarded
    // so the camera's perspective projection naturally makes far edges
    // appear smaller than near edges — the perspective "does its job"
    // automatically.
    const w = this.fieldWidth;
    const zFar = 0;                         // far edge (away from camera)
    const zNear = FIELD_HEIGHT * Z_STRETCH; // near edge (closer to camera)
    const f = this._field;

    const dimColor = new THREE.Color('#707070');
    const mutedColor = new THREE.Color('#505050');

    const lineMat = new THREE.LineBasicMaterial({
      color: dimColor,
      transparent: true,
      opacity: 0.8,
    });
    const mutedMat = new THREE.LineBasicMaterial({
      color: mutedColor,
      transparent: true,
      opacity: 0.5,
    });

    // Main field outline — closed rectangle on the ground plane
    const fieldOutline = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0, zFar),
        new THREE.Vector3(w, 0, zFar),
        new THREE.Vector3(w, 0, zNear),
        new THREE.Vector3(0, 0, zNear),
      ]),
      lineMat
    );
    this.scene.add(fieldOutline);

    // Midfield divider
    const midDivider = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(w / 2, 0, zFar),
        new THREE.Vector3(w / 2, 0, zNear),
      ]),
      mutedMat
    );
    this.scene.add(midDivider);

    // Unified goal geometry — built once, reused as two LineSegments
    // instances positioned at each end of the field. The second instance
    // is rotated 180° around y so its front faces the opposite direction.
    //
    // Local coordinate system (origin at the center of the goal's base):
    //   +x = FRONT (mouth side)
    //   -x = BACK
    //   +y = UP
    //   ±z = the two sides (goal width along field depth)
    //
    // Shape (side profile, z fixed):
    //
    //            ┌───────┐   ← top rectangle (depth/2)
    //           ╱        │
    //          ╱         │
    //         ╱          │   ← front post (vertical, full height)
    //        ╱           │
    //       ╱            │
    //      ╱_____________│
    //    back          front
    //  (-depth/2)    (+depth/2)
    //
    //  • Bottom rectangle: full depth × full width at y=0
    //  • Top rectangle: half depth × full width at y=h
    //    (sits over the front half, from x=0 to x=+depth/2)
    //  • Front posts: vertical at x=+depth/2
    //  • Back stays: inclined from (-depth/2, 0) to (0, h)
    const goalDepth = f.goalLRight - f.goalLLeft;
    const goalWidth = (f.goalMouthYMax - f.goalMouthYMin) * Z_STRETCH;
    const goalHeight = f.goalMouthZMax * 2.25; // 1.5× × 1.5× the physics crossbar

    const goalGeom = buildGoalGeometry(goalDepth, goalWidth, goalHeight);

    // Left goal: rotated 180° so the geometry's local +x direction (where
    // the vertical front posts live) points AWAY from midfield, and the
    // inclined part faces midfield.
    const leftGoal = new THREE.LineSegments(goalGeom, lineMat);
    leftGoal.position.set(
      (f.goalLLeft + f.goalLRight) / 2,
      0,
      ((f.goalMouthYMin + f.goalMouthYMax) / 2) * Z_STRETCH
    );
    leftGoal.rotation.y = Math.PI;
    this.scene.add(leftGoal);

    // Right goal: no rotation — its local +x faces world +x (away from
    // midfield), inclined part faces -x (toward midfield).
    const rightGoal = new THREE.LineSegments(goalGeom, lineMat);
    rightGoal.position.set(
      (f.goalRLeft + f.goalRRight) / 2,
      0,
      ((f.goalMouthYMin + f.goalMouthYMax) / 2) * Z_STRETCH
    );
    this.scene.add(rightGoal);
  }

  _addStickman(player, color, tick) {
    // 6-glyph stickman billboarded so the parts always stack on-screen
    // regardless of camera tilt. All parts share the same world anchor;
    // their relative positions come from per-mesh view-space offsets:
    //
    //     o           head
    //    /|\          arm-L, body, arm-R
    //    / \          leg-L, leg-R   (walking anim alternates)
    //
    const x = player.x + 9; // center on player anchor
    const z = player.y;
    const s = STICKMAN_GLYPH_SIZE;

    // Head
    this._placeGlyph('o', x, 0, z, s, color, 0, s * 1.4);

    // Arms + body row
    this._placeGlyph('/', x, 0, z, s, color, -s * 0.55, s * 0.6);
    this._placeGlyph('|', x, 0, z, s, color, 0, s * 0.6);
    this._placeGlyph('\\', x, 0, z, s, color, s * 0.55, s * 0.6);

    // Legs row — walking animation when player is moving
    const speed = Math.sqrt(player.vx * player.vx + player.vy * player.vy);
    const moving = speed > 0.3;
    const walkFrame = moving ? Math.floor(tick / 6) % 2 : 0;
    if (walkFrame === 0) {
      // Legs spread
      this._placeGlyph('/', x, 0, z, s, color, -s * 0.28, -s * 0.25);
      this._placeGlyph('\\', x, 0, z, s, color, s * 0.28, -s * 0.25);
    } else {
      // Legs mid-stride (vertical)
      this._placeGlyph('|', x, 0, z, s, color, -s * 0.16, -s * 0.25);
      this._placeGlyph('|', x, 0, z, s, color, s * 0.16, -s * 0.25);
    }
  }

  _resetPool() {
    // Hide every mesh — any we want active will be re-shown in _placeGlyph
    for (let i = 0; i < this._poolCursor; i++) {
      this._pool[i].visible = false;
    }
    this._poolCursor = 0;
  }

  _placeGlyph(char, x, y, z, scale, color, viewOffsetX = 0, viewOffsetY = 0) {
    const geom = this._glyphGeometries.get(char);
    if (!geom) return;
    if (this._poolCursor >= this._pool.length) return;
    const mesh = this._pool[this._poolCursor++];
    mesh.geometry = geom;
    // Apply Z_STRETCH so stickmen/ball positions match the stretched
    // field geometry drawn by _buildFieldLines.
    mesh.position.set(x, y, z * Z_STRETCH);
    mesh.scale.set(scale, scale, 1);
    const col = mesh.material.uniforms.uColor.value;
    col.set(color[0], color[1], color[2]);
    mesh.material.uniforms.uViewOffset.value.set(viewOffsetX, viewOffsetY);
    mesh.visible = true;
  }
}

/* ── Goal geometry builder ─────────────────────────────── */

/**
 * Build a unified goal-frame BufferGeometry centered at origin.
 *
 * Local coordinates:
 *   +x = FRONT (mouth, facing the field)
 *   -x = BACK
 *   +y = up
 *   ±z = the two sides (goal width along field depth)
 *
 * Shape (side profile, front on the right):
 *
 *                  ___________        ← back top rail (half-depth top)
 *                  \            ╲      top at y=h, spans from back
 *                   \            ╲     of goal box to midpoint
 *                    \            ╲
 *                     \            |
 *                      \           |   front post — vertical
 *                       \          |   at +halfD, from ground to
 *                        \         |   y=h (the front edge of the top)
 *                         \________|
 *                   -halfD         +halfD
 *                    back          front
 *
 * • Front posts: vertical bars at +halfD
 * • Top rectangle: depth = halfD (half of bottom depth), spans from
 *   x=0 (back edge) to x=+halfD (front edge — where the front posts meet it)
 * • Back stays: inclined bars from the back-bottom corners at -halfD
 *   up and forward to the top rectangle's back edge at x=0
 * • Bottom: full-depth rectangle on the ground
 */
function buildGoalGeometry(depth, width, height) {
  const halfD = depth / 2;
  const halfW = width / 2;
  const h = height;

  // Top rectangle back edge = midpoint between front and back (x=0)
  const xTopBack = 0;

  const P = (x, y, z) => new THREE.Vector3(x, y, z);

  const points = [
    // Bottom rectangle (full depth, y=0)
    P(-halfD, 0, -halfW), P(+halfD, 0, -halfW),
    P(+halfD, 0, -halfW), P(+halfD, 0, +halfW),
    P(+halfD, 0, +halfW), P(-halfD, 0, +halfW),
    P(-halfD, 0, +halfW), P(-halfD, 0, -halfW),

    // Top rectangle (half depth, y=h, from x=0 to x=+halfD)
    P(+halfD, h, -halfW), P(+halfD, h, +halfW),  // front crossbar
    P(+halfD, h, +halfW), P(xTopBack, h, +halfW), // top rail, +z side
    P(xTopBack, h, +halfW), P(xTopBack, h, -halfW), // back-top rail
    P(xTopBack, h, -halfW), P(+halfD, h, -halfW), // top rail, -z side

    // Front posts (vertical at +halfD)
    P(+halfD, 0, -halfW), P(+halfD, h, -halfW),
    P(+halfD, 0, +halfW), P(+halfD, h, +halfW),

    // Back stays (inclined: from back-bottom (-halfD, 0) up-and-forward
    // to the back-top-rail at (0, h))
    P(-halfD, 0, -halfW), P(xTopBack, h, -halfW),
    P(-halfD, 0, +halfW), P(xTopBack, h, +halfW),
  ];

  return new THREE.BufferGeometry().setFromPoints(points);
}

/* ── Color helpers ─────────────────────────────────────── */

function rgb(hex) {
  const h = hex.replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16) / 255,
    parseInt(h.slice(2, 4), 16) / 255,
    parseInt(h.slice(4, 6), 16) / 255,
  ];
}

function staminaColor(stamina) {
  const s = Math.max(0, Math.min(1, stamina));
  if (s >= 0.5) {
    const t = (s - 0.5) * 2;
    return lerp(COLOR_AMBER, COLOR_GREEN, t);
  }
  const t = s * 2;
  return lerp(COLOR_RED, COLOR_AMBER, t);
}

function lerp(a, b, t) {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
}
