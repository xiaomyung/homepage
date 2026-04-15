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
// Per-frame LPF coefficient for smoothing animation state (tilt, amplitude).
// ~0.15 → time constant ≈ 100ms at 60 fps.
const STICKMAN_SMOOTH = 0.15;
// Forward-lean tuning: the run threshold above which the body starts to
// lean in the direction of motion, and the slope + clamp for the lean angle.
const STICKMAN_RUN_THRESHOLD = 1.2;
const STICKMAN_TILT_PER_SPEED = 0.09;
const STICKMAN_TILT_MAX = 0.45;
// Body-local glyph offsets, pre-multiplied by STICKMAN_GLYPH_SIZE so the
// hot path does zero multiplies to materialise them. All measured from
// the hip center, which is itself placed at hipBaseY = 0.10 * s + bob.
const STICKMAN_TORSO_HALF_H = 0.50 * STICKMAN_GLYPH_SIZE;
const STICKMAN_SHOULDER_OFX = 0.15 * STICKMAN_GLYPH_SIZE;
const STICKMAN_SHOULDER_OFY = 0.92 * STICKMAN_GLYPH_SIZE;
const STICKMAN_HIP_OFX      = 0.12 * STICKMAN_GLYPH_SIZE;
const STICKMAN_HEAD_GAP_Y   = 0.23 * STICKMAN_GLYPH_SIZE;
const STICKMAN_LIMB_HALF_H  = 0.45 * STICKMAN_GLYPH_SIZE;
const STICKMAN_LIMB_FULL_H  = STICKMAN_LIMB_HALF_H * 2;
const TWO_PI = Math.PI * 2;

// Celebration pose — jumping-jack with arms straight up.
const CELEB_PHASE_RATE = 0.25;           // rad per tick; ~25 ticks per hop
const CELEB_JUMP_PEAK  = 0.55 * STICKMAN_GLYPH_SIZE;
const CELEB_LEG_SPREAD = 0.55;           // leg outward angle at jump apex (rad)
// Push pose — a spring-loaded boxing-glove jab. Animation is driven
// directly by `anim.pushProgress` (ticks since pushTimer went positive);
// the scripted curves return both arm angle and pivot shift per phase.
// Phases over normalized progress t ∈ [0, 1]:
//   [0,        RAISE_T]     raise:   arms rotate 0 → π/2, pivot 0
//   [RAISE_T,  WINDUP_T]    windup:  arms horizontal, pivot slides 0 → -WINDUP_DIST
//   [WINDUP_T, STRIKE_T]    strike:  arms horizontal, pivot snaps -WINDUP → +STRIKE (explosive)
//   [STRIKE_T, SETTLE_T]    settle:  arms horizontal, pivot +STRIKE → 0
//   [SETTLE_T, LOWER_T]     hold:    arms horizontal, pivot 0
//   [LOWER_T,  1]           lower:   arms rotate π/2 → 0, pivot 0
const PUSH_TOTAL_TICKS    = 18;             // matches physics PUSH_ANIM_MS (300ms / TICK_MS)
const PUSH_RAISE_T        = 0.15;
const PUSH_WINDUP_T       = 0.35;
const PUSH_STRIKE_T       = 0.50;
const PUSH_SETTLE_T       = 0.70;
const PUSH_LOWER_T        = 0.85;
const PUSH_WINDUP_DIST    = 0.70 * STICKMAN_GLYPH_SIZE;  // pivot pull-back
const PUSH_STRIKE_DIST    = 0.55 * STICKMAN_GLYPH_SIZE;  // pivot launch past shoulder
const PUSH_CROUCH_DEPTH   = 0.30 * STICKMAN_GLYPH_SIZE;  // upper body dip during windup
const PUSH_HOP_DIST       = 0.40 * STICKMAN_GLYPH_SIZE;  // whole body hop on strike
const PUSH_FIST_PULSE     = 0.35;                        // fist grows to (1 + pulse)× at strike peak
const PUSH_EXTEND_ANGLE   = Math.PI * 0.5;
const PUSH_FIST_SIZE      = 0.65 * STICKMAN_GLYPH_SIZE;
const PUSH_BACK_TILT      = 0.28;                        // rad — body leans back during windup
const PUSH_FWD_TILT       = 0.42;                        // rad — body leans forward on strike
const BALL_SIZE = 10.206;

// Splash particles for ball bounces. Pool holds up to PARTICLE_POOL slots,
// filled via a rolling index so old particles are recycled automatically.
// Count and velocity per bounce scale with the incoming-velocity magnitude
// (force) so hard hits produce a bigger, faster burst than soft settles.
const PARTICLE_POOL          = 120;
const PARTICLE_BASE_COUNT    = 2;    // minimum particles per bounce
const PARTICLE_FORCE_COUNT   = 1.4;  // extra particles per force unit
const PARTICLE_MAX_COUNT     = 14;
const PARTICLE_BASE_SPEED    = 0.25; // outward speed as fraction of force
const PARTICLE_SPREAD        = 0.6;  // lateral randomness multiplier
const PARTICLE_LIFE_BASE     = 18;   // frames
const PARTICLE_LIFE_VARIANCE = 10;
const PARTICLE_GRAVITY       = 0.28;
const PARTICLE_GROUND_DRAG   = 0.45;
const PARTICLE_SIZE          = 18;

// Thin cylinder radius (world units) for goal-frame bars so they render
// as solid poles. three.js line widths are GPU-dependent, so we use
// actual tube geometry instead.
const GOAL_BAR_RADIUS = 1.2;

const CAMERA_FOV = 60;
const CAMERA_TILT_DEG = 55;

/* ── Shaders ───────────────────────────────────────────────── */

const VERTEX_SHADER = /* glsl */ `
  uniform vec2 uViewOffset;
  uniform float uRotation;
  varying vec2 vUv;

  void main() {
    // Billboarded quad: compute world center, transform to view space,
    // then add view-space offset + vertex position scaled uniformly and
    // (optionally) rotated by uRotation. Rotation lets a single vertical
    // glyph (like the pipe character) act as a limb at any angle, with
    // the visual top anchored to the pivot the caller chose.
    vec3 worldCenter = vec3(modelMatrix[3][0], modelMatrix[3][1], modelMatrix[3][2]);
    vec4 viewCenter = viewMatrix * vec4(worldCenter, 1.0);
    float sx = length(vec3(modelMatrix[0][0], modelMatrix[0][1], modelMatrix[0][2]));
    float c = cos(uRotation);
    float si = sin(uRotation);
    vec2 rotated = vec2(position.x * c - position.y * si, position.x * si + position.y * c);
    viewCenter.xy += uViewOffset + rotated * sx;
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

// Procedural ring shader for the ball — true circle with a centered
// hole at 1/3 of the outer radius. Outer edge fades out past 0.5,
// inner edge fades in past 0.167 (1/3 of 0.5).
const BALL_FRAGMENT_SHADER = /* glsl */ `
  uniform vec3 uColor;
  varying vec2 vUv;
  void main() {
    vec2 p = vUv - 0.5;
    float d = length(p);
    float outer = smoothstep(0.5, 0.47, d);
    float inner = smoothstep(0.15, 0.18, d);
    float alpha = outer * inner;
    if (alpha < 0.01) discard;
    gl_FragColor = vec4(uColor, alpha);
  }
`;

/* ── Palette (matches style.css design tokens) ─────────────── */

const COLOR_TEXT = rgb('#d0d0d0');
const COLOR_WHITE = [1, 1, 1];
const COLOR_GREEN = rgb('#9ece6a');
const COLOR_AMBER = rgb('#e0af68');
const COLOR_RED = rgb('#f7768e');

/* ── Renderer ──────────────────────────────────────────────── */

export class Renderer {
  constructor(canvas, atlas, { fieldWidth = FIELD_WIDTH_REF } = {}) {
    this.atlas = atlas;
    this.fieldWidth = fieldWidth;
    this._field = createField(fieldWidth);
    this._debugCam = null;

    this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio || 1);
    this.renderer.setClearColor(0x000000, 0);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(CAMERA_FOV, 2, 0.1, 4000);
    this._placeCamera();
    // Debug free-camera is always wired up but starts inactive. UI (or
    // any other caller) flips it on/off via setDebugCam().
    this._initDebugCam();

    this._baseMaterial = new THREE.ShaderMaterial({
      uniforms: {
        sdfTexture: { value: atlas.texture },
        uColor: { value: new THREE.Vector3(1, 1, 1) },
        uViewOffset: { value: new THREE.Vector2(0, 0) },
        uRotation: { value: 0 },
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
    this._glyphPipe = this._glyphGeometries.get('|');
    this._glyphFist = this._glyphGeometries.get('O');
    this._glyphSparkA = this._glyphGeometries.get('*');
    this._glyphSparkB = this._glyphGeometries.get("'");
    this._glyphSparkC = this._glyphGeometries.get('.');

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
          uRotation: { value: 0 },
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
      mesh._uRotation = material.uniforms.uRotation;
      this.scene.add(mesh);
      this._pool.push(mesh);
    }
    this._poolCursor = 0;

    // Track static scene objects so dispose() can release them.
    this._staticGeometries = [];
    this._staticMaterials = [];

    // Dedicated ball mesh: a plane billboarded to the camera and filled
    // by a procedural circle shader, so the ball is a true circle instead
    // of the slightly oval `o` glyph.
    const ballGeom = new THREE.PlaneGeometry(1, 1);
    const ballMat = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Vector3(1, 1, 1) },
        uViewOffset: { value: new THREE.Vector2(0, 0) },
        uRotation: { value: 0 },
      },
      vertexShader: VERTEX_SHADER,
      fragmentShader: BALL_FRAGMENT_SHADER,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    this._ballMesh = new THREE.Mesh(ballGeom, ballMat);
    this._ballMesh.frustumCulled = false;
    this._ballUColor = ballMat.uniforms.uColor.value;
    this._ballUViewOffset = ballMat.uniforms.uViewOffset.value;
    this._staticGeometries.push(ballGeom);
    this._staticMaterials.push(ballMat);
    this.scene.add(this._ballMesh);

    // Pre-allocated per-player color buffers so staminaColor can write into
    // a reused array instead of allocating [r,g,b] every frame.
    this._p1Color = [0, 0, 0];
    this._p2Color = [0, 0, 0];

    // Smoothed animation state per player (tilt, amplitude, phase, lastTick).
    // Keyed by the player state object so every stickman on this renderer
    // evolves its own pose without cross-talk. Tilt and amplitude are
    // low-pass filtered toward their speed-derived targets; phase is
    // accumulated with the current swing rate so rate changes never snap.
    this._animByPlayer = new WeakMap();

    // Splash particle pool — ring-buffer allocation, `life === 0` means
    // free. Fields are all numbers so there's zero GC churn per frame.
    this._particles = [];
    for (let i = 0; i < PARTICLE_POOL; i++) {
      this._particles.push({
        x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
        life: 0, maxLife: 0,
      });
    }
    this._particleNext = 0;

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
    const celebrating = state.pauseState === 'celebrate';
    const p1Celebrating = celebrating && state.goalScorer === state.p1;
    const p2Celebrating = celebrating && state.goalScorer === state.p2;
    staminaColorInto(state.p1.stamina, this._p1Color);
    staminaColorInto(state.p2.stamina, this._p2Color);
    this._addStickman(state.p1, this._p1Color, tick, p1Celebrating);
    this._addStickman(state.p2, this._p2Color, tick, p2Celebrating);

    // Ball — dedicated circle-shader mesh, not a font glyph, so it
    // renders as a true circle. Bounce height becomes a view-space y
    // offset so the ball shows up regardless of camera tilt.
    this._ballMesh.position.set(state.ball.x, 0, state.ball.y * Z_STRETCH);
    this._ballMesh.scale.set(BALL_SIZE, BALL_SIZE, 1);
    this._ballUColor.set(COLOR_TEXT[0], COLOR_TEXT[1], COLOR_TEXT[2]);
    this._ballUViewOffset.set(0, (state.ball.z || 0) * 0.5);

    // Consume ball-bounce events and spawn splash particles. Physics
    // clears `state.events` at the top of each tick, so any entries here
    // are brand-new this frame.
    if (state.events) {
      for (let i = 0; i < state.events.length; i++) {
        const ev = state.events[i];
        if (ev.type === 'ball_bounce') this._spawnBounceParticles(ev);
      }
    }
    this._stepParticles();
    this._drawParticles();

    // Hide any meshes that were active last frame but aren't used this frame.
    for (let i = this._poolCursor; i < prevCursor; i++) {
      this._pool[i].visible = false;
    }

    if (this._debugCam && this._debugCam.active) this._stepDebugCam();
    this.renderer.render(this.scene, this.camera);
  }

  /* ── Camera ─────────────────────────────────────────────── */

  _placeCamera() {
    // When debug-cam is active, resize() still updates `camera.aspect` but
    // we leave the pose alone — `_stepDebugCam()` owns position/lookAt.
    if (this._debugCam && this._debugCam.active) return;
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

  /* ── Debug free-camera (runtime-toggleable) ─────────────────
   * Listeners are always attached but short-circuit when inactive.
   * Left-drag orbits yaw/pitch around `target`. WASD pans on the
   * ground plane (camera-relative forward/right). Q/E lower/raise.
   * Mouse wheel zooms distance. R resets to the default showcase
   * pose. setDebugCam(on) flips the `active` flag and restores the
   * canonical pose when turning off. */
  _initDebugCam() {
    const midX = this.fieldWidth / 2;
    const midZ = (FIELD_HEIGHT * Z_STRETCH) / 2;
    const aspect = this.camera.aspect || 4;
    const halfFovVert = (CAMERA_FOV / 2) * Math.PI / 180;
    const tanHalfHoriz = Math.tan(halfFovVert) * aspect;
    const halfFieldWidth = (this.fieldWidth / 2) * HORIZONTAL_MARGIN;
    const distance = halfFieldWidth / tanHalfHoriz;
    const defaultPitch = (90 - CAMERA_TILT_DEG) * Math.PI / 180;
    this._debugCam = {
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
    const canvas = this.renderer.domElement;
    const isTypingTarget = () => {
      const el = document.activeElement;
      if (!el) return false;
      const tag = el.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
    };
    canvas.addEventListener('pointerdown', (e) => {
      if (!this._debugCam.active || e.button !== 0) return;
      this._debugCam.dragging = true;
      this._debugCam.lastPointerX = e.clientX;
      this._debugCam.lastPointerY = e.clientY;
      try { canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    });
    canvas.addEventListener('pointermove', (e) => {
      const dc = this._debugCam;
      if (!dc.active || !dc.dragging) return;
      const dx = e.clientX - dc.lastPointerX;
      const dy = e.clientY - dc.lastPointerY;
      dc.lastPointerX = e.clientX;
      dc.lastPointerY = e.clientY;
      dc.yaw -= dx * 0.005;
      const half = Math.PI / 2 - 0.02;
      dc.pitch = Math.max(-half, Math.min(half, dc.pitch - dy * 0.005));
    });
    const stopDrag = (e) => {
      this._debugCam.dragging = false;
      try { canvas.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    };
    canvas.addEventListener('pointerup', stopDrag);
    canvas.addEventListener('pointercancel', stopDrag);
    canvas.addEventListener('wheel', (e) => {
      const dc = this._debugCam;
      if (!dc.active) return;
      e.preventDefault();
      dc.distance = Math.max(40, Math.min(4000, dc.distance * (1 + e.deltaY * 0.001)));
    }, { passive: false });
    window.addEventListener('keydown', (e) => {
      const dc = this._debugCam;
      if (!dc.active || isTypingTarget()) return;
      const k = e.key.toLowerCase();
      if ('wasdqer'.includes(k)) dc.keys.add(k);
    });
    window.addEventListener('keyup', (e) => {
      this._debugCam.keys.delete(e.key.toLowerCase());
    });
  }

  setDebugCam(on) {
    const dc = this._debugCam;
    if (!dc || dc.active === !!on) return;
    dc.active = !!on;
    if (!dc.active) {
      dc.keys.clear();
      dc.dragging = false;
      this._placeCamera(); // restore showcase pose
    }
  }

  isDebugCamActive() {
    return !!(this._debugCam && this._debugCam.active);
  }

  _stepDebugCam() {
    const dc = this._debugCam;
    if (dc.keys.has('r')) {
      dc.target.copy(dc.defaultTarget);
      dc.distance = dc.defaultDistance;
      dc.yaw = dc.defaultYaw;
      dc.pitch = dc.defaultPitch;
      dc.keys.delete('r');
    }
    const speed = dc.distance * 0.01;
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
    this.camera.position.set(dc.target.x + offX, dc.target.y + offY, dc.target.z + offZ);
    this.camera.lookAt(dc.target.x, dc.target.y, dc.target.z);
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

    // Center circle + center dot.
    const midZ = (zFar + zNear) / 2;
    const centerR = FIELD_HEIGHT * Z_STRETCH * 0.22;  // ~22% of depth radius
    this._addArc(w / 2, midZ, centerR, centerR, 0, TWO_PI, 48, mutedMat);
    this._addArc(w / 2, midZ, centerR * 0.06, centerR * 0.06, 0, TWO_PI, 12, mutedMat);

    // Penalty arcs — half-ellipses whose chord is the goal mouth (z-axis
    // tied to the posts) with the x-semiaxis stretched deeper into the
    // field. Endpoints stay pinned to the goalposts, curve bulges inward
    // without wrapping around into a loop.
    const mouthCenterZ = ((f.goalMouthYMin + f.goalMouthYMax) / 2) * Z_STRETCH;
    const mouthHalfZ   = ((f.goalMouthYMax - f.goalMouthYMin) / 2) * Z_STRETCH;
    const arcDepth = mouthHalfZ * 2;  // x-semiaxis = 2× the chord half
    this._addArc(f.goalLineL, mouthCenterZ, arcDepth, mouthHalfZ, -Math.PI / 2, Math.PI / 2, 48, mutedMat);
    this._addArc(f.goalLineR, mouthCenterZ, arcDepth, mouthHalfZ, Math.PI / 2, 3 * Math.PI / 2, 48, mutedMat);

    const goalWidth = (f.goalMouthYMax - f.goalMouthYMin) * Z_STRETCH;
    const goalHeight = f.goalMouthZMax * 2.25;
    const goalCenterZ = ((f.goalMouthYMin + f.goalMouthYMax) / 2) * Z_STRETCH;

    // Pass the scoring-line x (= f.goalLineL/R) as the front mouth, and
    // the outer box edge as the back — the goal renders as a lean-to
    // between those two x values. This keeps the mouth posts visually
    // aligned with the penalty arcs and the physics scoring boundary.
    this._addGoal(f.goalLineL, f.goalLLeft, goalCenterZ, goalWidth, goalHeight, lineMat, netMat, goalLineMat);
    this._addGoal(f.goalLineR, f.goalRRight, goalCenterZ, goalWidth, goalHeight, lineMat, netMat, goalLineMat);
  }

  _addStatic(obj, geometry) {
    this.scene.add(obj);
    if (geometry) this._staticGeometries.push(geometry);
  }

  /** Add a thin cylinder spanning from point A to point B, used as a
   *  "thick line" for the goal frame bars. Caller supplies the material
   *  so all bars in one goal share a single material instance. */
  _addBar(a, b, material) {
    const dir = b.clone().sub(a);
    const length = dir.length();
    if (length < 1e-6) return;
    const geom = new THREE.CylinderGeometry(GOAL_BAR_RADIUS, GOAL_BAR_RADIUS, length, 8, 1);
    // CylinderGeometry is aligned along +y by default; rotate it so +y
    // points along `dir`, then translate to the midpoint of AB.
    const mesh = new THREE.Mesh(geom, material);
    const up = new THREE.Vector3(0, 1, 0);
    const axis = up.clone().cross(dir.clone().normalize());
    const angle = Math.acos(Math.max(-1, Math.min(1, up.dot(dir.clone().normalize()))));
    if (axis.length() > 1e-6) {
      mesh.setRotationFromAxisAngle(axis.normalize(), angle);
    }
    mesh.position.set((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
    this._addStatic(mesh, geom);
  }

  /** Add an XZ-plane ellipse arc centered at (cx, cz) with x-semiaxis
   *  `rx` and z-semiaxis `rz`, from parametric angle `aStart` to `aEnd`,
   *  sampled with `segments` line segments. Pass `rz = rx` for a circle;
   *  pass `aEnd = aStart + 2π` for a closed loop. */
  _addArc(cx, cz, rx, rz, aStart, aEnd, segments, material) {
    const points = [];
    for (let i = 0; i <= segments; i++) {
      const a = aStart + (i / segments) * (aEnd - aStart);
      points.push(new THREE.Vector3(
        cx + Math.cos(a) * rx,
        0,
        cz + Math.sin(a) * rz,
      ));
    }
    const geom = new THREE.BufferGeometry().setFromPoints(points);
    this._addStatic(new THREE.Line(geom, material), geom);
  }

  _addGoal(goalLineX, backBotX, centerZ, width, height, mat, netMat, goalLineMat) {
    const halfW = width / 2;
    // Lean-to soccer goal side profile (triangle, x-axis):
    //
    //              ____ crossbar @ (goalLineX, height)
    //             /|
    //            / | front posts (vertical, at goalLineX)
    //           /  |
    //          /___|
    //      backBotX goalLineX
    //
    // For the LEFT goal, backBotX < goalLineX (back edge is on -x).
    // For the RIGHT goal, backBotX > goalLineX (back edge is on +x).
    // Orientation is implicit in the caller-supplied x pair.
    const zMin = centerZ - halfW;
    const zMax = centerZ + halfW;
    const P = (x, y, z) => new THREE.Vector3(x, y, z);

    // Goal frame bars — thin cylinders so they read as solid metal poles.
    const barMat = new THREE.MeshBasicMaterial({
      color: mat.color, transparent: true, opacity: mat.opacity ?? 1,
    });
    this._staticMaterials.push(barMat);
    // Front frame — two vertical posts at the goal line + crossbar.
    this._addBar(P(goalLineX, 0, zMin), P(goalLineX, height, zMin), barMat);
    this._addBar(P(goalLineX, 0, zMax), P(goalLineX, height, zMax), barMat);
    this._addBar(P(goalLineX, height, zMin), P(goalLineX, height, zMax), barMat);
    // Slanted back edges from the crossbar down to the outer back bottom.
    this._addBar(P(goalLineX, height, zMin), P(backBotX, 0, zMin), barMat);
    this._addBar(P(goalLineX, height, zMax), P(backBotX, 0, zMax), barMat);
    // Ground rails closing the floor triangle.
    this._addBar(P(backBotX, 0, zMin), P(backBotX, 0, zMax), barMat);
    this._addBar(P(backBotX, 0, zMin), P(goalLineX, 0, zMin), barMat);
    this._addBar(P(backBotX, 0, zMax), P(goalLineX, 0, zMax), barMat);

    // Net grid on the 3 closed surfaces: slanted back + two triangular
    // sides. Front mouth stays open; there is no roof (the crossbar is
    // the apex of the triangle). Bilinear grid — nU lines along A→B /
    // D→C, nV lines along A→D / B→C. For triangles, pass C === D and
    // the j-loop collapses into a point along that collapsed edge.
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
    // Back slanted face — rectangle from ground (backBotX, 0) up to the
    // crossbar (goalLineX, height), spanning full z.
    pushNet(
      P(backBotX,  0,      zMin), P(backBotX,  0,      zMax),
      P(goalLineX, height, zMax), P(goalLineX, height, zMin),
      12, 8,
    );
    // Side triangle zMin — A=front-bot, B=back-bot, C=D=crossbar.
    pushNet(
      P(goalLineX, 0,      zMin), P(backBotX,  0,      zMin),
      P(goalLineX, height, zMin), P(goalLineX, height, zMin),
      10, 8,
    );
    // Side triangle zMax — mirror of zMin.
    pushNet(
      P(goalLineX, 0,      zMax), P(backBotX,  0,      zMax),
      P(goalLineX, height, zMax), P(goalLineX, height, zMax),
      10, 8,
    );

    const netGeom = new THREE.BufferGeometry().setFromPoints(netPoints);
    this._addStatic(new THREE.LineSegments(netGeom, netMat), netGeom);

    // Dashed goal line along the mouth ground edge (z-axis at goalLineX).
    const dashCount = 8;
    const dashRatio = 0.4;
    const goalLinePoints = [];
    for (let i = 0; i < dashCount; i++) {
      const t0 = i / dashCount;
      const t1 = t0 + dashRatio / dashCount;
      goalLinePoints.push(
        P(goalLineX, 0, zMin + (zMax - zMin) * t0),
        P(goalLineX, 0, zMin + (zMax - zMin) * t1),
      );
    }
    const goalLineGeom = new THREE.BufferGeometry().setFromPoints(goalLinePoints);
    this._addStatic(new THREE.LineSegments(goalLineGeom, goalLineMat), goalLineGeom);
  }

  /* ── Stickman & pool ────────────────────────────────────── */

  _addStickman(player, color, tick, isCelebrating) {
    // 6-glyph billboarded figure rendered via one unified pendulum pose,
    // with celebration and push overrides layered on top as smoothed blends.
    // At rest (amplitude → 0) every limb hangs straight, giving a vertical
    // Minecraft-Steve idle; speed ramps amplitude and forward lean in via
    // a per-player low-pass filter, so transitions between standing /
    // walking / running / direction flips / celebrating / pushing never
    // snap.
    let x = player.x + 9;
    const z = player.y;
    const s = STICKMAN_GLYPH_SIZE;

    // Fetch / init smoothed state for this player. Derived velocity comes
    // from the frame-to-frame position delta, so any motion source (NN
    // output, reposition walk, push) feeds the same animation pipeline.
    let anim = this._animByPlayer.get(player);
    if (!anim) {
      anim = {
        tilt: 0, amplitude: 0, phase: 0,
        celebrate: 0, celebratePhase: 0,
        pushing: 0, pushProgress: 0, prevPushTimer: 0,
        lastTick: tick, lastX: player.x, lastY: player.y,
      };
      this._animByPlayer.set(player, anim);
    }
    const dt = tick > anim.lastTick ? tick - anim.lastTick : 0;
    const denom = dt > 0 ? dt : 1;
    const effVx = (player.x - anim.lastX) / denom;
    const effVy = (player.y - anim.lastY) / denom;
    anim.lastTick = tick;
    anim.lastX = player.x;
    anim.lastY = player.y;

    const speed = Math.sqrt(effVx * effVx + effVy * effVy);

    // Targets derived from derived velocity — no hard gates.
    const targetAmplitude = Math.min(speed * 0.2, 1.0);
    const targetTilt = speed > STICKMAN_RUN_THRESHOLD
      ? -Math.sign(effVx) * Math.min(
          (speed - STICKMAN_RUN_THRESHOLD) * STICKMAN_TILT_PER_SPEED,
          STICKMAN_TILT_MAX,
        )
      : 0;
    const swingRate = 0.2 + speed * 0.04;

    const targetCelebrate = isCelebrating ? 1 : 0;
    const targetPushing   = player.pushTimer > 0 ? 1 : 0;

    // Push progress counter: resets on the rising edge of pushTimer and
    // accumulates ticks until it falls back to zero. Drives the scripted
    // 3-phase boxing curve below.
    if (player.pushTimer > 0) {
      if (anim.prevPushTimer <= 0) anim.pushProgress = 0;
      anim.pushProgress += dt;
    } else {
      anim.pushProgress = 0;
    }
    anim.prevPushTimer = player.pushTimer;

    anim.tilt      += (targetTilt      - anim.tilt)      * STICKMAN_SMOOTH;
    anim.amplitude += (targetAmplitude - anim.amplitude) * STICKMAN_SMOOTH;
    anim.celebrate += (targetCelebrate - anim.celebrate) * STICKMAN_SMOOTH;
    // `pushing` is a binary-ish gate: 1 while the scripted curve is
    // active, 0 otherwise. No LPF needed since the curve itself
    // smoothly enters/exits via the raise/lower phases.
    anim.pushing = targetPushing;
    // Wrap phases to keep Math.sin precision stable over long sessions.
    anim.phase          = (anim.phase          + swingRate       * dt) % TWO_PI;
    anim.celebratePhase = (anim.celebratePhase + CELEB_PHASE_RATE * dt) % TWO_PI;

    const amplitude = anim.amplitude;
    const celeb     = anim.celebrate;
    const celebInv  = 1 - celeb;
    const pushing   = anim.pushing;
    const swing     = Math.sin(anim.phase);

    // Jump bob (upward-only half-sine, gated by the celebrate blend).
    const jumpY = Math.max(0, Math.sin(anim.celebratePhase)) * CELEB_JUMP_PEAK * celeb;
    // Walking bob blended out as celebration takes over.
    const bob = Math.abs(swing) * 0.08 * amplitude * celebInv;

    // Push scripted state — one branch, every downstream effect captured.
    // Computed before placement because dip/hop/tilt/pivot/fist all feed
    // into positions below. Zero-valued fall-throughs keep the hot path
    // branchless for the non-push case.
    const pushDir = player.dir;
    let pushArmAngle   = 0;
    let pushPivotShift = 0;
    let pushBodyDip    = 0;
    let pushFistScale  = 1;
    let pushTiltOffset = 0;
    let strikeActive   = false;
    if (pushing > 0) {
      const pushT = Math.min(anim.pushProgress / PUSH_TOTAL_TICKS, 1);
      pushArmAngle   =  pushDir * pushArmAngleAt(pushT);
      pushPivotShift =  pushDir * pushPivotAt(pushT);
      pushBodyDip    =  pushBodyDipAt(pushT);
      pushFistScale  =  pushFistScaleAt(pushT);
      pushTiltOffset = -pushDir * pushBodyTiltAt(pushT);
      x             +=  pushDir * pushHopAt(pushT);
      strikeActive   =  pushT >= PUSH_WINDUP_T && pushT <= PUSH_LOWER_T;
    }

    // Walk tilt applies to the whole figure (running lean carries the
    // hips naturally). Push tilt is upper-body-only so feet stay planted
    // during the strike snap. Hip anchors use walkC/walkS; torso/shoulder/
    // head use tiltC/tiltS from the combined upperTilt.
    const walkTilt  = anim.tilt;
    const upperTilt = walkTilt + pushTiltOffset;
    const walkC = Math.cos(walkTilt);
    const walkS = Math.sin(walkTilt);
    const tiltC = Math.cos(upperTilt);
    const tiltS = Math.sin(upperTilt);

    const hipBaseY  = s * 0.10 + bob * s + jumpY;
    const upperHipY = hipBaseY + pushBodyDip;

    // Torso / shoulders / head rotate around the hip by upperTilt.
    const torsoCX = -STICKMAN_TORSO_HALF_H * tiltS;
    const torsoCY = upperHipY + STICKMAN_TORSO_HALF_H * tiltC;
    this._placeGlyph(this._glyphPipe, x, 0, z, s, color, torsoCX, torsoCY, upperTilt);

    const lShX = -STICKMAN_SHOULDER_OFX * tiltC - STICKMAN_SHOULDER_OFY * tiltS;
    const lShY = upperHipY - STICKMAN_SHOULDER_OFX * tiltS + STICKMAN_SHOULDER_OFY * tiltC;
    const rShX =  STICKMAN_SHOULDER_OFX * tiltC - STICKMAN_SHOULDER_OFY * tiltS;
    const rShY = upperHipY + STICKMAN_SHOULDER_OFX * tiltS + STICKMAN_SHOULDER_OFY * tiltC;

    // Head sits a fixed world-space gap above the neck midpoint so its
    // distance from the body is preserved when the torso leans forward.
    const neckCX = (lShX + rShX) * 0.5;
    const neckCY = (lShY + rShY) * 0.5;
    this._placeGlyph(this._glyphO, x, 0, z, s, color, neckCX, neckCY + STICKMAN_HEAD_GAP_Y, upperTilt);

    // Hip anchors use walk tilt only — push lean doesn't drag the feet.
    const lHipX = -STICKMAN_HIP_OFX * walkC;
    const lHipY = hipBaseY - STICKMAN_HIP_OFX * walkS;
    const rHipX =  STICKMAN_HIP_OFX * walkC;
    const rHipY = hipBaseY + STICKMAN_HIP_OFX * walkS;

    // Normal pendulum limb angles (contralateral pairing).
    const armSwing = swing * 0.85 * amplitude;
    const legSwing = -swing * 0.7  * amplitude;
    let leftArmAngle  =  armSwing;
    let rightArmAngle = -armSwing;
    let leftLegAngle  =  legSwing;
    let rightLegAngle = -legSwing;

    // Celebration override: arms sweep outward to straight up, legs do a
    // symmetric jumping-jack that spreads at jump apex and contracts on
    // the ground. Both values blend in via `celeb`.
    if (celeb > 0.001) {
      const legSpread = Math.max(0, Math.sin(anim.celebratePhase)) * CELEB_LEG_SPREAD;
      leftArmAngle  = leftArmAngle  * celebInv +  Math.PI   * celeb;
      rightArmAngle = rightArmAngle * celebInv + -Math.PI   * celeb;
      leftLegAngle  = leftLegAngle  * celebInv + -legSpread * celeb;
      rightLegAngle = rightLegAngle * celebInv +  legSpread * celeb;
    }

    // Push override: arm angle follows the scripted curve exactly —
    // no LPF smearing of the explosive strike.
    if (pushing > 0) {
      leftArmAngle  = pushArmAngle;
      rightArmAngle = pushArmAngle;
    }

    const lShPushX = lShX + pushPivotShift;
    const rShPushX = rShX + pushPivotShift;

    this._placeLimb(x, z, s, color, lShPushX, lShY,  leftArmAngle);
    this._placeLimb(x, z, s, color, rShPushX, rShY,  rightArmAngle);
    this._placeLimb(x, z, s, color, lHipX,    lHipY, leftLegAngle);
    this._placeLimb(x, z, s, color, rHipX,    rHipY, rightLegAngle);

    // Push fists — visible from windup through lower, covering the
    // whole "glove in motion" window. Two `O` glyphs track the tips of
    // the two extended arms, including the pivot shift. The glyph size
    // pulses larger at strike peak via pushFistScale for impact weight.
    if (strikeActive && pushing > 0) {
      const lSin = Math.sin(leftArmAngle);
      const lCos = Math.cos(leftArmAngle);
      const rSin = Math.sin(rightArmAngle);
      const rCos = Math.cos(rightArmAngle);
      const fistSize = PUSH_FIST_SIZE * pushFistScale;
      this._placeGlyph(this._glyphFist, x, 0, z, fistSize, color,
        lShPushX + lSin * STICKMAN_LIMB_FULL_H,
        lShY     - lCos * STICKMAN_LIMB_FULL_H);
      this._placeGlyph(this._glyphFist, x, 0, z, fistSize, color,
        rShPushX + rSin * STICKMAN_LIMB_FULL_H,
        rShY     - rCos * STICKMAN_LIMB_FULL_H);
    }
  }

  /** Spawn a burst of splash particles at the bounce location. Count and
   *  outward speed both scale with `ev.force`; the `ev.axis` tells us
   *  which velocity component was reversed, so the burst can fan out
   *  perpendicular to the surface that was struck. */
  _spawnBounceParticles(ev) {
    const count = Math.min(
      PARTICLE_MAX_COUNT,
      Math.floor(PARTICLE_BASE_COUNT + ev.force * PARTICLE_FORCE_COUNT),
    );
    const speed = ev.force * PARTICLE_BASE_SPEED;
    const spread = speed * PARTICLE_SPREAD;
    for (let i = 0; i < count; i++) {
      const p = this._particles[this._particleNext];
      this._particleNext = (this._particleNext + 1) % this._particles.length;

      p.x = ev.x;
      p.y = ev.y;
      p.z = ev.z;

      // Surface-normal burst: dominant component is along the struck axis,
      // other two axes get a small lateral kick. axis='z' (ground/ceiling)
      // bursts upward; axis='y' (field walls) bursts back toward center;
      // axis='x' (goal posts) bursts back into the field horizontally.
      const r1 = (Math.random() - 0.5) * 2;
      const r2 = (Math.random() - 0.5) * 2;
      const r3 = Math.random();
      if (ev.axis === 'z') {
        p.vx = r1 * spread;
        p.vy = r2 * spread;
        p.vz = (ev.z > 0 ? -1 : 1) * speed * (0.5 + r3);
      } else if (ev.axis === 'y') {
        const sign = ev.y < FIELD_HEIGHT / 2 ? 1 : -1;
        p.vx = r1 * spread;
        p.vy = sign * speed * (0.5 + r3);
        p.vz = speed * (0.3 + r3 * 0.7);
      } else {
        const sign = ev.x < this.fieldWidth * 0.5 ? 1 : -1;
        p.vx = sign * speed * (0.5 + r3);
        p.vy = r2 * spread;
        p.vz = speed * (0.3 + r3 * 0.7);
      }

      p.maxLife = PARTICLE_LIFE_BASE + Math.floor(Math.random() * PARTICLE_LIFE_VARIANCE);
      p.life = p.maxLife;
    }
  }

  /** Advance all live particles by one frame. Particles fall under light
   *  gravity and lose horizontal speed on ground contact. */
  _stepParticles() {
    for (let i = 0; i < this._particles.length; i++) {
      const p = this._particles[i];
      if (p.life <= 0) continue;
      p.x += p.vx;
      p.y += p.vy;
      p.z += p.vz;
      p.vz -= PARTICLE_GRAVITY;
      if (p.z < 0) {
        p.z = 0;
        p.vz = 0;
        p.vx *= PARTICLE_GROUND_DRAG;
        p.vy *= PARTICLE_GROUND_DRAG;
      }
      p.life--;
    }
  }

  /** Draw all live particles. Glyph fades `*` → `'` → `.` as age grows. */
  _drawParticles() {
    for (let i = 0; i < this._particles.length; i++) {
      const p = this._particles[i];
      if (p.life <= 0) continue;
      const ageFrac = p.life / p.maxLife;
      const glyph = ageFrac > 0.66 ? this._glyphSparkA
                  : ageFrac > 0.33 ? this._glyphSparkB
                  : this._glyphSparkC;
      this._placeGlyph(
        glyph, p.x, 0, p.y, PARTICLE_SIZE * (0.6 + 0.4 * ageFrac), COLOR_WHITE,
        0, p.z * 0.5,
      );
    }
  }

  /** Place a single glyph that represents a limb pivoting at (pivotX,
   *  pivotY). The visual TOP of the glyph stays exactly at the pivot
   *  point — only the character itself changes slant as the swing angle
   *  grows. This mimics a pendulum fixed at the top: the shoulder/hip
   *  attachment never moves, only the bottom of the limb. */
  _placeLimb(x, z, s, color, pivotX, pivotY, angle) {
    // True pendulum: a single pipe glyph rotated in the shader so its
    // visual top is anchored exactly at (pivotX, pivotY) for every angle.
    // Glyph center = pivot + halfH * (sin(angle), -cos(angle)). After
    // rotating a unit quad by `angle` and placing its center there, the
    // rotated (0, +halfH) vertex lands exactly at the pivot.
    const cx = pivotX + Math.sin(angle) * STICKMAN_LIMB_HALF_H;
    const cy = pivotY - Math.cos(angle) * STICKMAN_LIMB_HALF_H;
    this._placeGlyph(this._glyphPipe, x, 0, z, s, color, cx, cy, angle);
  }

  _placeGlyph(geom, x, y, z, scale, color, viewOffsetX, viewOffsetY, rotation = 0) {
    if (!geom || this._poolCursor >= this._pool.length) return;
    const mesh = this._pool[this._poolCursor++];
    mesh.geometry = geom;
    mesh.position.set(x, y, z * Z_STRETCH);
    mesh.scale.set(scale, scale, 1);
    mesh._uColor.set(color[0], color[1], color[2]);
    mesh._uViewOffset.set(viewOffsetX, viewOffsetY);
    mesh._uRotation.value = rotation;
    mesh.visible = true;
  }
}

/* ── Helpers ───────────────────────────────────────────────── */

/**
 * Arm angle curve for the spring-loaded push. Arms rotate from down
 * to horizontal during RAISE, hold horizontal through WINDUP/STRIKE/
 * SETTLE/hold, then rotate back to down during LOWER. Magnitude only —
 * multiply by pushDir outside.
 */
function pushArmAngleAt(t) {
  if (t < PUSH_RAISE_T) {
    const p = t / PUSH_RAISE_T;
    return PUSH_EXTEND_ANGLE * easeInOut(p);
  }
  if (t < PUSH_LOWER_T) return PUSH_EXTEND_ANGLE;
  const p = (t - PUSH_LOWER_T) / (1 - PUSH_LOWER_T);
  return PUSH_EXTEND_ANGLE * (1 - easeInOut(p));
}

/**
 * Shoulder pivot shift curve for the spring-loaded push. 0 during the
 * raise, slides back during windup, springs forward through strike,
 * settles to 0. Magnitude only — multiply by pushDir outside.
 */
function pushPivotAt(t) {
  if (t < PUSH_RAISE_T) return 0;
  if (t < PUSH_WINDUP_T) {
    const p = (t - PUSH_RAISE_T) / (PUSH_WINDUP_T - PUSH_RAISE_T);
    return -PUSH_WINDUP_DIST * easeOut(p);
  }
  if (t < PUSH_STRIKE_T) {
    const p = (t - PUSH_WINDUP_T) / (PUSH_STRIKE_T - PUSH_WINDUP_T);
    const span = PUSH_WINDUP_DIST + PUSH_STRIKE_DIST;
    return -PUSH_WINDUP_DIST + span * (p * p);
  }
  if (t < PUSH_SETTLE_T) {
    const p = (t - PUSH_STRIKE_T) / (PUSH_SETTLE_T - PUSH_STRIKE_T);
    return PUSH_STRIKE_DIST * (1 - easeInOut(p));
  }
  return 0;
}

/**
 * Upper-body crouch depth during push. Body drops while the pivot
 * pulls back, snaps upright during the strike, settles at 0. Negative
 * values are subtracted from the upper body's Y so a negative result
 * means "lower than neutral."
 */
function pushBodyDipAt(t) {
  if (t < PUSH_RAISE_T) return 0;
  if (t < PUSH_WINDUP_T) {
    const p = (t - PUSH_RAISE_T) / (PUSH_WINDUP_T - PUSH_RAISE_T);
    return -PUSH_CROUCH_DEPTH * easeOut(p);
  }
  if (t < PUSH_STRIKE_T) {
    const p = (t - PUSH_WINDUP_T) / (PUSH_STRIKE_T - PUSH_WINDUP_T);
    return -PUSH_CROUCH_DEPTH * (1 - p * p);
  }
  return 0;
}

/**
 * Whole-body horizontal hop during push. 0 during raise/windup, springs
 * forward with quadratic acceleration during strike, decays during settle.
 * Magnitude only — multiply by pushDir outside.
 */
function pushHopAt(t) {
  if (t < PUSH_WINDUP_T) return 0;
  if (t < PUSH_STRIKE_T) {
    const p = (t - PUSH_WINDUP_T) / (PUSH_STRIKE_T - PUSH_WINDUP_T);
    return PUSH_HOP_DIST * p * p;
  }
  if (t < PUSH_SETTLE_T) {
    const p = (t - PUSH_STRIKE_T) / (PUSH_SETTLE_T - PUSH_STRIKE_T);
    return PUSH_HOP_DIST * (1 - easeInOut(p));
  }
  return 0;
}

/**
 * Fist glyph scale multiplier. 1.0 baseline, pulses to (1 + PUSH_FIST_PULSE)
 * linearly through the strike phase, decays back to 1 during settle.
 */
function pushFistScaleAt(t) {
  if (t < PUSH_WINDUP_T) return 1;
  if (t < PUSH_STRIKE_T) {
    const p = (t - PUSH_WINDUP_T) / (PUSH_STRIKE_T - PUSH_WINDUP_T);
    return 1 + PUSH_FIST_PULSE * p;
  }
  if (t < PUSH_SETTLE_T) {
    const p = (t - PUSH_STRIKE_T) / (PUSH_SETTLE_T - PUSH_STRIKE_T);
    return 1 + PUSH_FIST_PULSE * (1 - easeInOut(p));
  }
  return 1;
}

/**
 * Body lean along the push axis as a signed "forward amount":
 * negative = lean away from push dir (back / windup loading),
 * positive = lean toward push dir (forward / strike release).
 * Caller multiplies by player.dir to map into the walk-tilt convention
 * (where negative tilt leans right for dir=+1).
 */
function pushBodyTiltAt(t) {
  if (t < PUSH_RAISE_T) return 0;
  if (t < PUSH_WINDUP_T) {
    const p = (t - PUSH_RAISE_T) / (PUSH_WINDUP_T - PUSH_RAISE_T);
    return -PUSH_BACK_TILT * easeOut(p);
  }
  if (t < PUSH_STRIKE_T) {
    const p = (t - PUSH_WINDUP_T) / (PUSH_STRIKE_T - PUSH_WINDUP_T);
    return -PUSH_BACK_TILT + (PUSH_BACK_TILT + PUSH_FWD_TILT) * (p * p);
  }
  if (t < PUSH_SETTLE_T) {
    const p = (t - PUSH_STRIKE_T) / (PUSH_SETTLE_T - PUSH_STRIKE_T);
    return PUSH_FWD_TILT * (1 - easeInOut(p));
  }
  return 0;
}

function easeInOut(p) {
  return p < 0.5 ? 2 * p * p : 1 - (2 * (1 - p)) * (1 - p);
}

function easeOut(p) {
  return 1 - (1 - p) * (1 - p);
}

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
