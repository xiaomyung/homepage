/**
 * Football v2 — three.js renderer.
 *
 * Single-pass instanced glyph renderer. All drawable characters (field
 * borders, stickmen, ball) share one InstancedBufferGeometry + one
 * RawShaderMaterial that samples the SDF atlas. Each frame the main loop
 * calls renderer.renderState(state), which clears the instance list and
 * re-packs glyphs based on current positions.
 *
 * Coordinate system (three.js world = physics world):
 *   x: field horizontal, [0 .. field.width]
 *   y: ball height (z in physics), 0 = ground
 *   z: field depth, [0 .. FIELD_HEIGHT]
 * Physics uses (x, y, z) where y is depth and z is height; this module
 * swaps them for three.js's y-up convention.
 */

import * as THREE from './vendor/three.module.js';
import { FIELD_HEIGHT } from './physics.js';

const MAX_INSTANCES = 512;

// Physics width that the camera is framed around. Real matches may use a
// different width; the camera adapts via renderer.resize().
const DEFAULT_FIELD_WIDTH = 900;

// Default glyph world size. Each stickman is a few of these tall.
const GLYPH_WORLD_SIZE = 2.4;

const VERTEX_SHADER = /* glsl */ `
  precision mediump float;

  attribute vec3 position;
  attribute vec2 uv;

  // Per-instance attributes
  attribute vec3 instancePosition;
  attribute float instanceScale;
  attribute vec3 instanceColor;
  attribute vec4 instanceGlyphUV; // u, v, w, h in atlas space

  uniform mat4 projectionMatrix;
  uniform mat4 modelViewMatrix;

  varying vec2 vAtlasUV;
  varying vec3 vColor;

  void main() {
    // Billboard: transform the instance position to view space, then add
    // the quad corner in view-space XY (screen-aligned right/up). The quad
    // always faces the camera regardless of camera tilt/rotation.
    vec4 viewPos = modelViewMatrix * vec4(instancePosition, 1.0);
    viewPos.xy += position.xy * instanceScale;
    gl_Position = projectionMatrix * viewPos;

    vAtlasUV = instanceGlyphUV.xy + instanceGlyphUV.zw * uv;
    vColor = instanceColor;
  }
`;

const FRAGMENT_SHADER = /* glsl */ `
  precision mediump float;

  uniform sampler2D sdfTexture;

  varying vec2 vAtlasUV;
  varying vec3 vColor;

  // tiny-sdf encodes:
  //   data = round(255 * (1 - cutoff) - (255 / radius) * signed_distance)
  // With default cutoff=0.25, the glyph edge is at value 255 * 0.75 ≈ 191,
  // which is ~0.75 in normalized [0, 1]. Values > 0.75 are inside the
  // glyph, < 0.75 are outside.
  const float EDGE = 0.75;
  const float AA = 0.02; // antialias half-width (thinner = crisper)

  void main() {
    float dist = texture2D(sdfTexture, vAtlasUV).g;
    float alpha = smoothstep(EDGE - AA, EDGE + AA, dist);
    if (alpha < 0.01) discard;
    gl_FragColor = vec4(vColor, alpha);
  }
`;

/* ── Glyph palette colors (match style.css tokens) ─────────── */

const COLOR_TEXT = rgb('#d0d0d0');
const COLOR_DIM = rgb('#707070');
const COLOR_MUTED = rgb('#505050');
const COLOR_GREEN = rgb('#9ece6a');
const COLOR_AMBER = rgb('#e0af68');
const COLOR_RED = rgb('#f7768e');

/* ── Renderer ──────────────────────────────────────────────── */

export class Renderer {
  constructor(canvas, atlas, { fieldWidth = DEFAULT_FIELD_WIDTH } = {}) {
    this.atlas = atlas;
    this.fieldWidth = fieldWidth;

    // three.js plumbing
    this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio || 1);
    this.renderer.setClearColor(0x000000, 0);

    this.scene = new THREE.Scene();

    // Perspective camera with a ~25° tilt above midfield
    this.camera = new THREE.PerspectiveCamera(42, 2, 0.1, 2000);
    this._placeCamera();

    // Instanced geometry shared by all glyphs
    this._buildInstancedMesh();

    // Static field geometry built once and cached so we don't re-add it
    // every frame. The render loop just re-adds stickmen and ball on top.
    this._fieldGlyphs = [];
    this._buildField();

    this._resizeObserver = null;
  }

  /** Attach a ResizeObserver to auto-resize when the canvas changes. */
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
    this.glyphMesh.geometry.dispose();
    this.glyphMesh.material.dispose();
    this.renderer.dispose();
  }

  /**
   * Render one frame for the given physics state. Mutates the instance
   * buffer and draws.
   */
  renderState(state) {
    this._resetInstances();

    // Static field (pre-built glyph list)
    for (const g of this._fieldGlyphs) {
      this._pushGlyph(g.char, g.x, g.y, g.z, g.scale, g.color);
    }

    // Stickmen
    this._addStickman(state.p1, staminaColor(state.p1.stamina));
    this._addStickman(state.p2, staminaColor(state.p2.stamina));

    // Ball
    const ballY = (state.ball.z || 0) + 1.2;
    this._pushGlyph('o', state.ball.x, ballY, state.ball.y, 1.1, COLOR_TEXT);

    this._commitInstances();
    this.renderer.render(this.scene, this.camera);
  }

  /* ── Internals ───────────────────────────────────────── */

  _placeCamera() {
    // Adaptive camera: tilts ~22° from straight down over the midfield and
    // sits far enough back that the whole field fits horizontally for the
    // current canvas aspect ratio.
    const midX = this.fieldWidth / 2;
    const midZ = FIELD_HEIGHT / 2;
    const aspect = this.camera.aspect || 4;

    const fovDeg = 60;
    const halfFovVert = (fovDeg / 2) * Math.PI / 180;
    const tanHalfHoriz = Math.tan(halfFovVert) * aspect;

    // Distance so half the field width fits horizontally with a small margin
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

  _buildInstancedMesh() {
    // Base quad: XY plane, centered on origin, unit size
    const baseGeom = new THREE.BufferGeometry();
    baseGeom.setAttribute(
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
    baseGeom.setAttribute(
      'uv',
      new THREE.BufferAttribute(
        new Float32Array([
          0, 1,  1, 1,  1, 0,  0, 0,
        ]),
        2
      )
    );
    baseGeom.setIndex([0, 1, 2, 0, 2, 3]);

    const instGeom = new THREE.InstancedBufferGeometry();
    instGeom.index = baseGeom.index;
    instGeom.setAttribute('position', baseGeom.getAttribute('position'));
    instGeom.setAttribute('uv', baseGeom.getAttribute('uv'));

    this._positions = new Float32Array(MAX_INSTANCES * 3);
    this._scales = new Float32Array(MAX_INSTANCES);
    this._colors = new Float32Array(MAX_INSTANCES * 3);
    this._glyphUVs = new Float32Array(MAX_INSTANCES * 4);

    instGeom.setAttribute(
      'instancePosition',
      new THREE.InstancedBufferAttribute(this._positions, 3)
    );
    instGeom.setAttribute(
      'instanceScale',
      new THREE.InstancedBufferAttribute(this._scales, 1)
    );
    instGeom.setAttribute(
      'instanceColor',
      new THREE.InstancedBufferAttribute(this._colors, 3)
    );
    instGeom.setAttribute(
      'instanceGlyphUV',
      new THREE.InstancedBufferAttribute(this._glyphUVs, 4)
    );

    const material = new THREE.RawShaderMaterial({
      uniforms: {
        sdfTexture: { value: this.atlas.texture },
      },
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });

    this.glyphMesh = new THREE.Mesh(instGeom, material);
    this.glyphMesh.frustumCulled = false;
    this.scene.add(this.glyphMesh);

    this._instGeom = instGeom;
    this._count = 0;
  }

  _buildField() {
    const w = this.fieldWidth;
    const h = FIELD_HEIGHT;
    const c = COLOR_DIM;

    // Long edges (horizontal lines at z=0 and z=h)
    const stepX = 12;
    for (let x = 0; x <= w; x += stepX) {
      this._fieldGlyphs.push({ char: '─', x, y: 0, z: 0, scale: GLYPH_WORLD_SIZE, color: c });
      this._fieldGlyphs.push({ char: '─', x, y: 0, z: h, scale: GLYPH_WORLD_SIZE, color: c });
    }
    // Short edges (vertical lines at x=0 and x=w)
    const stepZ = 6;
    for (let z = 0; z <= h; z += stepZ) {
      this._fieldGlyphs.push({ char: '│', x: 0, y: 0, z, scale: GLYPH_WORLD_SIZE, color: c });
      this._fieldGlyphs.push({ char: '│', x: w, y: 0, z, scale: GLYPH_WORLD_SIZE, color: c });
    }
    // Corner markers
    this._fieldGlyphs.push({ char: '┌', x: 0, y: 0, z: 0, scale: GLYPH_WORLD_SIZE, color: c });
    this._fieldGlyphs.push({ char: '┐', x: w, y: 0, z: 0, scale: GLYPH_WORLD_SIZE, color: c });
    this._fieldGlyphs.push({ char: '└', x: 0, y: 0, z: h, scale: GLYPH_WORLD_SIZE, color: c });
    this._fieldGlyphs.push({ char: '┘', x: w, y: 0, z: h, scale: GLYPH_WORLD_SIZE, color: c });
    // Midfield divider
    for (let z = 0; z <= h; z += stepZ) {
      this._fieldGlyphs.push({ char: '┊', x: w / 2, y: 0, z, scale: GLYPH_WORLD_SIZE, color: COLOR_MUTED });
    }
  }

  _addStickman(player, color) {
    // A simple 3-row stickman centered on the player's (x, y) in physics
    // coords. Physics y = field depth = three.js z. Physics stamina affects
    // color, not shape.
    const x = player.x + 9; // +playerWidth/2 to center on player anchor
    const z = player.y;
    const scale = GLYPH_WORLD_SIZE;
    const y0 = 0;
    // Head / body / legs, stacked vertically in three.js y
    this._pushGlyph('o', x, y0 + scale * 2.2, z, scale, color);
    this._pushGlyph('|', x, y0 + scale * 1.2, z, scale, color);
    this._pushGlyph('A', x, y0 + scale * 0.2, z, scale, color);
  }

  _resetInstances() {
    this._count = 0;
  }

  _pushGlyph(ch, x, y, z, scale, color) {
    if (this._count >= MAX_INSTANCES) return;
    const g = this.atlas.glyphs.get(ch);
    if (!g) return; // glyph not in atlas — silently drop

    const i = this._count;
    this._positions[i * 3 + 0] = x;
    this._positions[i * 3 + 1] = y;
    this._positions[i * 3 + 2] = z;
    this._scales[i] = scale;
    this._colors[i * 3 + 0] = color[0];
    this._colors[i * 3 + 1] = color[1];
    this._colors[i * 3 + 2] = color[2];
    this._glyphUVs[i * 4 + 0] = g.u;
    this._glyphUVs[i * 4 + 1] = g.v;
    this._glyphUVs[i * 4 + 2] = g.w;
    this._glyphUVs[i * 4 + 3] = g.h;

    this._count++;
  }

  _commitInstances() {
    this._instGeom.getAttribute('instancePosition').needsUpdate = true;
    this._instGeom.getAttribute('instanceScale').needsUpdate = true;
    this._instGeom.getAttribute('instanceColor').needsUpdate = true;
    this._instGeom.getAttribute('instanceGlyphUV').needsUpdate = true;
    this._instGeom.instanceCount = this._count;
  }
}

/* ── Color helpers ───────────────────────────────────────── */

function rgb(hex) {
  // '#rrggbb' → [r, g, b] in [0, 1]
  const h = hex.replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16) / 255,
    parseInt(h.slice(2, 4), 16) / 255,
    parseInt(h.slice(4, 6), 16) / 255,
  ];
}

/** Stamina-to-color gradient: green (full) → amber (tired) → red (exhausted). */
function staminaColor(stamina) {
  const s = Math.max(0, Math.min(1, stamina));
  if (s >= 0.5) {
    const t = (s - 0.5) * 2; // [0, 1]
    return lerp(COLOR_AMBER, COLOR_GREEN, t);
  } else {
    const t = s * 2; // [0, 1]
    return lerp(COLOR_RED, COLOR_AMBER, t);
  }
}

function lerp(a, b, t) {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
}
