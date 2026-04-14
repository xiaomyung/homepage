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
 * Camera: perspective, ~22° tilt above midfield, framed to fit the whole
 * field width for the current canvas aspect ratio.
 */

import * as THREE from './vendor/three.module.js';
import { FIELD_HEIGHT } from './physics.js';

const DEFAULT_FIELD_WIDTH = 900;
const POOL_SIZE = 400;

// Per-element world sizes in physics units. Tuned so a ~30px tall
// stickman appears on a 900×225 canvas with the default camera.
const FIELD_GLYPH_SIZE = 8;
const STICKMAN_GLYPH_SIZE = 14;
const BALL_GLYPH_SIZE = 11;

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

    // Pre-compute static field glyphs once; re-pushed each frame via pool
    this._fieldGlyphs = [];
    this._buildFieldGlyphs();

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

    // Static field borders
    for (const g of this._fieldGlyphs) {
      this._placeGlyph(g.char, g.x, 0, g.z, g.scale, g.color, 0, 0);
    }

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
    // Adaptive camera — frames the full field width for the current aspect
    // ratio with a ~22° tilt from vertical.
    const midX = this.fieldWidth / 2;
    const midZ = FIELD_HEIGHT / 2;
    const aspect = this.camera.aspect || 4;

    const fovDeg = 60;
    const halfFovVert = (fovDeg / 2) * Math.PI / 180;
    const tanHalfHoriz = Math.tan(halfFovVert) * aspect;

    const halfFieldWidth = (this.fieldWidth / 2) * 1.08;
    const distance = halfFieldWidth / tanHalfHoriz;

    const tiltRad = 22 * Math.PI / 180;
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

  _buildFieldGlyphs() {
    const w = this.fieldWidth;
    const h = FIELD_HEIGHT;
    const c = COLOR_DIM;
    const s = FIELD_GLYPH_SIZE;

    const stepX = 24;
    for (let x = stepX; x < w; x += stepX) {
      this._fieldGlyphs.push({ char: '─', x, y: 0, z: 0, scale: s, color: c });
      this._fieldGlyphs.push({ char: '─', x, y: 0, z: h, scale: s, color: c });
    }
    const stepZ = 10;
    for (let z = stepZ; z < h; z += stepZ) {
      this._fieldGlyphs.push({ char: '│', x: 0, y: 0, z, scale: s, color: c });
      this._fieldGlyphs.push({ char: '│', x: w, y: 0, z, scale: s, color: c });
    }
    // Corners
    this._fieldGlyphs.push({ char: '┌', x: 0, y: 0, z: 0, scale: s, color: c });
    this._fieldGlyphs.push({ char: '┐', x: w, y: 0, z: 0, scale: s, color: c });
    this._fieldGlyphs.push({ char: '└', x: 0, y: 0, z: h, scale: s, color: c });
    this._fieldGlyphs.push({ char: '┘', x: w, y: 0, z: h, scale: s, color: c });
    // Midfield divider (vertical bars at low intensity)
    for (let z = stepZ; z < h; z += stepZ) {
      this._fieldGlyphs.push({ char: '│', x: w / 2, y: 0, z, scale: s * 0.85, color: COLOR_MUTED });
    }
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
    this._placeGlyph('o', x, 0, z, s, color, 0, s * 1.0);

    // Arms + body row
    this._placeGlyph('/', x, 0, z, s, color, -s * 0.45, s * 0.5);
    this._placeGlyph('|', x, 0, z, s, color, 0, s * 0.5);
    this._placeGlyph('\\', x, 0, z, s, color, s * 0.45, s * 0.5);

    // Legs row — walking animation when player is moving
    const speed = Math.sqrt(player.vx * player.vx + player.vy * player.vy);
    const moving = speed > 0.3;
    const walkFrame = moving ? Math.floor(tick / 6) % 2 : 0;
    if (walkFrame === 0) {
      // Legs spread
      this._placeGlyph('/', x, 0, z, s, color, -s * 0.22, 0);
      this._placeGlyph('\\', x, 0, z, s, color, s * 0.22, 0);
    } else {
      // Legs straight / mid-stride
      this._placeGlyph('|', x, 0, z, s, color, -s * 0.14, 0);
      this._placeGlyph('|', x, 0, z, s, color, s * 0.14, 0);
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
    mesh.position.set(x, y, z);
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
