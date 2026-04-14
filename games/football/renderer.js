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
import { createField, FIELD_HEIGHT } from './physics.js?v=31';

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
const BALL_GLYPH_SIZE = 24;

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
    const netColor = new THREE.Color('#404040');

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
    const netMat = new THREE.LineBasicMaterial({
      color: netColor,
      transparent: true,
      opacity: 0.45,
    });
    const goalLineMat = new THREE.LineBasicMaterial({
      color: dimColor,
      transparent: true,
      opacity: 0.75,
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

    // Goal frames
    const goalDepth = f.goalLRight - f.goalLLeft;
    const goalWidth = (f.goalMouthYMax - f.goalMouthYMin) * Z_STRETCH;
    const goalHeight = f.goalMouthZMax * 2.25;
    const goalCenterZ = ((f.goalMouthYMin + f.goalMouthYMax) / 2) * Z_STRETCH;

    // Left goal: outer edge on -x, so vertical back wall at centerX - halfD → dir = -1.
    const leftCenterX = (f.goalLLeft + f.goalLRight) / 2;
    this._addGoal(leftCenterX, goalCenterZ, goalDepth, goalWidth, goalHeight, -1, lineMat, netMat, goalLineMat);

    // Right goal: mirror.
    const rightCenterX = (f.goalRLeft + f.goalRRight) / 2;
    this._addGoal(rightCenterX, goalCenterZ, goalDepth, goalWidth, goalHeight, +1, lineMat, netMat, goalLineMat);
  }

  _addGoal(centerX, centerZ, depth, width, height, dir, mat, netMat, goalLineMat) {
    // Both the vertical wall AND the slanted wall are drawn as proper
    // closed 4-edge faces in 3D:
    //
    //   VERTICAL face (outer edge of field)
    //     - 2 vertical posts, 1 crossbar at y=h, 1 bottom at y=0
    //
    //   SLANTED face (midfield side)
    //     - 2 diagonal posts going from (backBotX, 0) to (backTopX, h)
    //     - 1 slant bottom rail at y=0 at x=backBotX
    //     - 1 slant top rail at y=h at x=backTopX
    //
    //   Top and bottom connecting rails between the two faces (the roof
    //   slab and the ground slab of the prism) — drawn grey.
    const halfD = depth / 2;
    const halfW = width / 2;
    const h = height;
    // dir = +1: vertical face on +x side (goal's outer edge for RIGHT goal)
    // dir = -1: vertical face on -x side (goal's outer edge for LEFT goal)
    const vertX = centerX + dir * halfD;          // vertical wall x
    const slantBotX = centerX - dir * halfD;       // slant's bottom edge x
    const zMin = centerZ - halfW;
    const zMax = centerZ + halfW;
    const P = (x, y, z) => new THREE.Vector3(x, y, z);

    // Back wall (slanted): full diagonals from (vertX, 0) at the outer-edge
    // ground up to (backTopX, h), plus top crossbar and bottom rail.
    const backTopX = slantBotX;
    const backGeom = new THREE.BufferGeometry().setFromPoints([
      P(vertX, 0, zMin), P(backTopX, h, zMin),
      P(vertX, 0, zMax), P(backTopX, h, zMax),
      P(backTopX, h, zMin), P(backTopX, h, zMax),
      P(vertX, 0, zMin), P(vertX, 0, zMax),
    ]);
    this.scene.add(new THREE.LineSegments(backGeom, mat));

    // Front mouth: posts offset from vertX along the goal depth axis by
    // 58/52 — empirical values that make the wall look perpendicular in
    // screen space under the current camera tilt.
    const frontWallX = slantBotX - dir * halfD;
    const postABotX = vertX - dir * 58;
    const postBBotX = vertX - dir * 52;
    const frontGeom = new THREE.BufferGeometry().setFromPoints([
      P(postABotX, 0, zMin), P(frontWallX, h, zMin),
      P(postBBotX, 0, zMax), P(frontWallX, h, zMax),
      P(frontWallX, h, zMin), P(frontWallX, h, zMax),
    ]);
    this.scene.add(new THREE.LineSegments(frontGeom, mat));

    // Connecting rails: top (frontWallX → slantBotX) and bottom
    // (vertX → post-bottom on each side).
    const railGeom = new THREE.BufferGeometry().setFromPoints([
      P(frontWallX, h, zMin), P(slantBotX, h, zMin),
      P(frontWallX, h, zMax), P(slantBotX, h, zMax),
      P(vertX, 0, zMin), P(postABotX, 0, zMin),
      P(vertX, 0, zMax), P(postBBotX, 0, zMax),
    ]);
    this.scene.add(new THREE.LineSegments(railGeom, mat));

    // Net: a dull grid overlay on the 4 closed surfaces (back, top, both
    // sides) signalling "ball stops here". Front mouth is intentionally
    // left open.
    const netPoints = [];
    const pushNet = (A, B, C, D, nU, nV) => {
      // A=bottom-start, B=bottom-end, C=top-end, D=top-start. Bilinear
      // grid: nU lines along A→B/D→C direction, nV lines along A→D/B→C.
      for (let i = 1; i < nU; i++) {
        const t = i / nU;
        const p0 = P(
          A.x + (B.x - A.x) * t,
          A.y + (B.y - A.y) * t,
          A.z + (B.z - A.z) * t
        );
        const p1 = P(
          D.x + (C.x - D.x) * t,
          D.y + (C.y - D.y) * t,
          D.z + (C.z - D.z) * t
        );
        netPoints.push(p0, p1);
      }
      for (let j = 1; j < nV; j++) {
        const t = j / nV;
        const p0 = P(
          A.x + (D.x - A.x) * t,
          A.y + (D.y - A.y) * t,
          A.z + (D.z - A.z) * t
        );
        const p1 = P(
          B.x + (C.x - B.x) * t,
          B.y + (C.y - B.y) * t,
          B.z + (C.z - B.z) * t
        );
        netPoints.push(p0, p1);
      }
    };

    // Back wall (slanted): vertX floor → backTopX roof, across full z.
    pushNet(
      P(vertX, 0, zMin),
      P(vertX, 0, zMax),
      P(backTopX, h, zMax),
      P(backTopX, h, zMin),
      6, 4
    );
    // Top slab: frontWallX → backTopX along x, zMin → zMax along z.
    pushNet(
      P(frontWallX, h, zMin),
      P(backTopX, h, zMin),
      P(backTopX, h, zMax),
      P(frontWallX, h, zMax),
      4, 6
    );
    // Side at zMin: trapezoid post-bottom → vert-bottom → back-top → front-top.
    pushNet(
      P(postABotX, 0, zMin),
      P(vertX, 0, zMin),
      P(backTopX, h, zMin),
      P(frontWallX, h, zMin),
      5, 4
    );
    // Side at zMax: same but on the far side.
    pushNet(
      P(postBBotX, 0, zMax),
      P(vertX, 0, zMax),
      P(backTopX, h, zMax),
      P(frontWallX, h, zMax),
      5, 4
    );

    const netGeom = new THREE.BufferGeometry().setFromPoints(netPoints);
    this.scene.add(new THREE.LineSegments(netGeom, netMat));

    // Goal line: dashed segment connecting the bottom-front points of the
    // mouth, marking the scoring threshold. Emitted as discrete short
    // LineSegments (dash + gap) so it reads as "_ _ _".
    const lineA = P(postABotX, 0, zMin);
    const lineB = P(postBBotX, 0, zMax);
    const dashCount = 8;
    const dashRatio = 0.4;
    const goalLinePoints = [];
    for (let i = 0; i < dashCount; i++) {
      const t0 = i / dashCount;
      const t1 = t0 + dashRatio / dashCount;
      goalLinePoints.push(
        P(
          lineA.x + (lineB.x - lineA.x) * t0,
          0,
          lineA.z + (lineB.z - lineA.z) * t0
        ),
        P(
          lineA.x + (lineB.x - lineA.x) * t1,
          0,
          lineA.z + (lineB.z - lineA.z) * t1
        )
      );
    }
    const goalLineGeom = new THREE.BufferGeometry().setFromPoints(goalLinePoints);
    this.scene.add(new THREE.LineSegments(goalLineGeom, goalLineMat));
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
