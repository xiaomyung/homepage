/**
 * Football v2 — three.js renderer.
 *
 * Everything is solid 3D geometry: goals are cylinders, stickmen are
 * capsules + sphere heads, ball is a sphere, particles are instanced
 * spheres, field lines are THREE.Line segments, ground shadows are
 * shader-filled planes.
 *
 * Coordinate mapping:
 *   physics.x → three.js.x  (field horizontal)
 *   physics.z → three.js.y  (ball height / up)
 *   physics.y → three.js.z  (field depth)
 */

import * as THREE from 'https://unpkg.com/three@0.164.0/build/three.module.js';
import {
  FIELD_WIDTH_REF,
  STICKMAN_LEG_RADIUS,
  STICKMAN_LOWER_ARM,
  STICKMAN_LOWER_ARM_RADIUS,
  STICKMAN_SHOULDER_OFY,
  STICKMAN_TORSO_RADIUS,
  STICKMAN_UPPER_ARM,
  STICKMAN_UPPER_ARM_RADIUS,
  STICKMAN_UPPER_LEG,
  createField,
} from '../physics/index.js';
import { DebugOverlay } from '../debug/overlay.js';
import { createPoseScratch } from '../animation/poses.js';
import {
  placeCamera, setCameraFocus,
  initDebugCam, setDebugCam, isDebugCamActive,
  initFollowCam, setFollowCam, isFollowCamActive,
} from './camera.js';
import { buildFieldLines } from './field.js';
import { makeNameLabel } from './scoreboard.js';
import { renderState as renderStateImpl } from './update-loop.js';
import { initScene, disposeScene } from './scene.js';
import { initBallPool, initShadowFactory } from './ball.js';
import {
  STICKMAN_TORSO_SHELL_THICKNESS, STICKMAN_TORSO_FILL_RADIUS,
  STICKMAN_SPH_POOL, STAMINA_OUTLINE_OPACITY, PARTICLE_POOL,
} from './tuning.js';

/* ── Renderer ──────────────────────────────────────────────── */

export class Renderer {
  constructor(canvas, { fieldWidth = FIELD_WIDTH_REF } = {}) {
    this.fieldWidth = fieldWidth;
    this._field = createField(fieldWidth);
    this._debugCam = null;
    this._followCam = null;

    // Track static scene objects so dispose() can release them. Set
    // up BEFORE initScene because initScene reads from no static
    // arrays but later constructor steps push into them.
    this._staticGeometries = [];
    this._staticMaterials = [];

    // Three.js renderer + scene + camera + lights all live in
    // renderer/scene.js.
    initScene(this, canvas);
    // Camera modes — both wired up at construction, start inactive.
    // Mutually exclusive: enabling one disables the other.
    this._initDebugCam();
    this._initFollowCam();
    // Debug-collider overlay — fully self-contained module. Pool is
    // built lazily on first enable; renderer just forwards the toggle.
    this._debugOverlay = new DebugOverlay(this.scene);

    // Ball mesh pool + spin scratch + shadow factory all live in
    // renderer/ball.js. initShadowFactory must come before the
    // pre-created player-shadow pool below since `_makeShadow` is
    // required to allocate them.
    initBallPool(this);
    initShadowFactory(this);

    // Pool of player shadows, grown on demand via placePlayerShadow
    // (renderer/player-rig.js).
    // Two pre-created for the common case of two players (zero extra
    // cost vs the original _p1Shadow / _p2Shadow).
    this._playerShadows = [this._makeShadow(), this._makeShadow()];
    this._playerShadowCursor = 0;

    // Player name labels — one billboarded sprite per side. Texture
    // regenerated on name change; position pushed each frame from the
    // head bone. Overlap-fade computed from screen-space distance.
    this._nameLabels = [this._makeNameLabel(), this._makeNameLabel()];
    this._nameLabels.forEach((l) => l.mesh.visible = false);
    this._nameLabelTmpA = new THREE.Vector3();
    this._nameLabelTmpB = new THREE.Vector3();

    // Torso is drawn as three co-located meshes (outline shell + opaque
    // fill clipped at the stamina line + flat disc capping the fill).
    // All three materials are MeshLambertMaterial so the figure reads
    // as one monochrome unit under the same lighting.
    const torsoBodyLen = STICKMAN_SHOULDER_OFY - 2 * STICKMAN_TORSO_RADIUS;
    // Fill reuses the outline's body length so the shell thickness is
    // uniform on every side (radially AND on the hemispherical caps).
    // The fill's total end-to-end length is therefore
    // `2 * STICKMAN_TORSO_SHELL_THICKNESS` shorter than the outline's,
    // so `placeTorso` insets the clipping range accordingly.
    const torsoFillBodyLen = torsoBodyLen;
    // Arms split at the elbow — upper arm is 15% thicker than the
    // forearm. Both halves have body_len = UPPER_ARM − 2·radius so
    // the overlapping caps at the elbow meet at the same world point
    // as the (slightly-undersized) elbow sphere drawn there.
    const upperArmBodyLen = STICKMAN_UPPER_ARM - 2 * STICKMAN_UPPER_ARM_RADIUS;
    const lowerArmBodyLen = STICKMAN_LOWER_ARM - 2 * STICKMAN_LOWER_ARM_RADIUS;
    // Leg is drawn as TWO half-length capsules meeting at the knee,
    // so the mesh geometry's span is UPPER_LEG (= LOWER_LEG), not the
    // full limb height. The knee sphere drawn over the join hides
    // any seam from non-collinear bend angles.
    const halfLegBodyLen = STICKMAN_UPPER_LEG - 2 * STICKMAN_LEG_RADIUS;
    const stickmanTorsoGeom      = new THREE.CapsuleGeometry(STICKMAN_TORSO_RADIUS,      torsoBodyLen,     4, 12);
    const stickmanTorsoFillGeom  = new THREE.CapsuleGeometry(STICKMAN_TORSO_FILL_RADIUS, torsoFillBodyLen, 4, 12);
    const stickmanUpperArmGeom   = new THREE.CapsuleGeometry(STICKMAN_UPPER_ARM_RADIUS,  upperArmBodyLen,  4, 10);
    const stickmanLowerArmGeom   = new THREE.CapsuleGeometry(STICKMAN_LOWER_ARM_RADIUS,  lowerArmBodyLen,  4, 10);
    const stickmanLegGeom        = new THREE.CapsuleGeometry(STICKMAN_LEG_RADIUS,        halfLegBodyLen,   4, 10);
    this._staticGeometries.push(stickmanTorsoGeom, stickmanTorsoFillGeom, stickmanUpperArmGeom, stickmanLowerArmGeom, stickmanLegGeom);

    // Fill-capsule dimensions drive the disc scaling math in placeTorso
    // (the disc caps the FILL, not the outline).
    this._fillBodyHalf  = torsoFillBodyLen / 2;
    this._fillCapRadius = STICKMAN_TORSO_FILL_RADIUS;

    // Stamina indicator needs per-material clipping planes, which
    // three.js only honors when local clipping is enabled globally.
    this.renderer.localClippingEnabled = true;
    this._stickmanTorsoOutline = [];
    this._stickmanTorsoFill = [];
    this._stickmanTorsoDisc = [];
    this._stickmanTorsoFillPlanes = [];
    this._stickmanUpperArm = [];
    this._stickmanLowerArm = [];
    this._stickmanLeg = [];

    // Water-surface disc geometry — circle in the XZ plane, sized to
    // the fill capsule's cap radius. Each disc mesh scales this at
    // frame time to match the capsule's cross-section at the current
    // fill height. Re-used by all pooled disc meshes.
    const discGeom = new THREE.CircleGeometry(STICKMAN_TORSO_FILL_RADIUS, 18);
    discGeom.rotateX(-Math.PI / 2);
    this._staticGeometries.push(discGeom);

    // Mesh factories on `this` so pools can grow on demand from the
    // place* helpers (renderer/player-rig.js) when harnesses drive
    // N > 2 players.
    this._mkUpperArm = () => {
      const mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
      const mesh = new THREE.Mesh(stickmanUpperArmGeom, mat);
      mesh.visible = false;
      mesh.frustumCulled = false;
      this._staticMaterials.push(mat);
      this.scene.add(mesh);
      this._stickmanUpperArm.push(mesh);
    };
    this._mkLowerArm = () => {
      const mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
      const mesh = new THREE.Mesh(stickmanLowerArmGeom, mat);
      mesh.visible = false;
      mesh.frustumCulled = false;
      this._staticMaterials.push(mat);
      this.scene.add(mesh);
      this._stickmanLowerArm.push(mesh);
    };
    this._mkLeg = () => {
      const mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
      const mesh = new THREE.Mesh(stickmanLegGeom, mat);
      mesh.visible = false;
      mesh.frustumCulled = false;
      this._staticMaterials.push(mat);
      this.scene.add(mesh);
      this._stickmanLeg.push(mesh);
    };
    this._mkTorsoOutline = () => {
      const mat = new THREE.MeshLambertMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: STAMINA_OUTLINE_OPACITY,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(stickmanTorsoGeom, mat);
      mesh.visible = false;
      mesh.frustumCulled = false;
      // Draw outline AFTER fill so the transparent shell alpha-blends
      // over the opaque fill below the stamina line.
      mesh.renderOrder = 2;
      this._staticMaterials.push(mat);
      this.scene.add(mesh);
      this._stickmanTorsoOutline.push(mesh);
    };
    this._mkTorsoFill = () => {
      // Each fill mesh gets its own clipping plane instance so
      // pooled torsos have independent fill levels.
      const plane = new THREE.Plane(new THREE.Vector3(0, -1, 0), 0);
      const mat = new THREE.MeshLambertMaterial({
        color: 0xffffff,
        clippingPlanes: [plane],
      });
      const mesh = new THREE.Mesh(stickmanTorsoFillGeom, mat);
      mesh.visible = false;
      mesh.frustumCulled = false;
      mesh.renderOrder = 1;
      this._staticMaterials.push(mat);
      this.scene.add(mesh);
      this._stickmanTorsoFill.push(mesh);
      this._stickmanTorsoFillPlanes.push(plane);
    };
    this._mkTorsoDisc = () => {
      const mat = new THREE.MeshLambertMaterial({
        color: 0xffffff,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(discGeom, mat);
      mesh.visible = false;
      mesh.frustumCulled = false;
      mesh.renderOrder = 1;
      this._staticMaterials.push(mat);
      this.scene.add(mesh);
      this._stickmanTorsoDisc.push(mesh);
    };
    // Initial pool sizes for the common 2-player match case.
    for (let i = 0; i < 4; i++) {
      this._mkTorsoOutline();
      this._mkTorsoFill();
      this._mkTorsoDisc();
    }
    for (let i = 0; i < 8; i++) { this._mkUpperArm(); this._mkLowerArm(); }
    for (let i = 0; i < 16; i++) this._mkLeg();
    this._stickmanTorsoCursor = 0;
    this._stickmanUpperArmCursor = 0;
    this._stickmanLowerArmCursor = 0;
    this._stickmanLegCursor = 0;

    // Stickman sphere pool — used for heads, elbows, knees.
    // One shared unit sphere geometry, per-mesh Lambert material.
    const stickmanSph = new THREE.SphereGeometry(1, 14, 10);
    this._staticGeometries.push(stickmanSph);
    this._stickmanSph = [];
    this._mkSph = () => {
      const mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
      const mesh = new THREE.Mesh(stickmanSph, mat);
      mesh.visible = false;
      mesh.frustumCulled = false;
      this._staticMaterials.push(mat);
      this.scene.add(mesh);
      this._stickmanSph.push(mesh);
    };
    for (let i = 0; i < STICKMAN_SPH_POOL; i++) this._mkSph();
    this._stickmanSphCursor = 0;

    // "Dazed" stars that orbit the head when a player is resting
    // (exhausted, regenerating stamina). Three stars per resting
    // stickman, placed in a horizontal ring above the head with
    // a per-frame phase offset so they spin around. The pool grows
    // on demand so multi-player harnesses don't need a hard ceiling.
    const starShape = new THREE.Shape();
    {
      const N = 5;
      const outer = 1.6;
      const inner = 0.7;
      for (let i = 0; i < N * 2; i++) {
        const r = (i % 2 === 0) ? outer : inner;
        const theta = (i / (N * 2)) * Math.PI * 2 - Math.PI / 2;
        const sx = Math.cos(theta) * r;
        const sy = Math.sin(theta) * r;
        if (i === 0) starShape.moveTo(sx, sy);
        else starShape.lineTo(sx, sy);
      }
      starShape.closePath();
    }
    const starGeom = new THREE.ExtrudeGeometry(starShape, {
      depth: 0.4, bevelEnabled: false, curveSegments: 1,
    });
    starGeom.translate(0, 0, -0.2); // centre on extrusion axis
    this._staticGeometries.push(starGeom);
    this._restStars = [];
    this._mkRestStar = () => {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 1,
      });
      const mesh = new THREE.Mesh(starGeom, mat);
      mesh.visible = false;
      mesh.frustumCulled = false;
      this._staticMaterials.push(mat);
      this.scene.add(mesh);
      this._restStars.push(mesh);
    };
    this._restStarCursor = 0;

    // Smoothed animation state per player (LPF factors, phase
    // accumulators, heading history). Keyed by the player state
    // object so every stickman on this renderer evolves its own pose
    // without cross-talk. See animation/state.js::createAnimState
    // for the full schema.
    this._animByPlayer = new WeakMap();
    // Per-player previous walk-cycle swing value, used to detect
    // sin(phase) zero-crossings (foot strikes) and spawn dust bursts.
    this._lastFootSwing = new WeakMap();

    // Scratch buffers for per-frame IK solves; reused across both
    // players so the hot draw path never allocates.
    this._scratchKickPose = { upperAngle: 0, lowerAngle: 0 };
    this._scratchPushPose = { upperAngle: 0, lowerAngle: 0, upperYaw: 0, lowerYaw: 0 };
    // Reused snapshot + pose objects so the per-frame pose pipeline
    // (advanceAnimState → composeStickmanPose) never allocates.
    this._scratchAnimSnap = {};
    this._scratchPose = createPoseScratch();

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

    // Single InstancedMesh draws all live particles in one draw call.
    // Low-poly sphere (6×4) is more than enough at the visual size.
    // Per-instance matrix handles position + age-scaled size; per-
    // instance color encodes the age fade (rgb → 0 as the particle
    // dies). `.count` is set each frame to the number of live
    // particles so dead slots don't render.
    const particleGeom = new THREE.SphereGeometry(1, 6, 4);
    const particleMat = new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 1,
    });
    this._particleMesh = new THREE.InstancedMesh(particleGeom, particleMat, PARTICLE_POOL);
    this._particleMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this._particleMesh.count = 0;
    this._particleMesh.frustumCulled = false;
    this._staticGeometries.push(particleGeom);
    this._staticMaterials.push(particleMat);
    this.scene.add(this._particleMesh);
    // Scratch matrix reused when writing instance transforms.
    this._scratchMat = new THREE.Matrix4();
    this._scratchScaleVec = new THREE.Vector3();
    this._scratchZeroQ = new THREE.Quaternion();
    this._scratchPos = new THREE.Vector3();
    // Per-instance color buffer (r, g, b as floats). Instanced color
    // attribute gives us age fading without a shader rewrite.
    this._particleColorArr = new Float32Array(PARTICLE_POOL * 3);
    this._particleColorAttr = new THREE.InstancedBufferAttribute(this._particleColorArr, 3);
    this._particleColorAttr.setUsage(THREE.DynamicDrawUsage);
    this._particleMesh.instanceColor = this._particleColorAttr;

    // Reusable scratch Vector3s for orientBetween — used by the stickman
    // hot path AND by buildFieldLines' goal bars (addBar orients through
    // orientBetween), so they must exist BEFORE buildFieldLines runs.
    this._scratchDir = new THREE.Vector3();
    this._scratchAxis = new THREE.Vector3();
    this._scratchUp = new THREE.Vector3(0, 1, 0);

    buildFieldLines(this);

    // Scratch [r,g,b] buffer for the per-frame stamina gradient. Reused
    // across both stickmen since each frame's writes are consumed
    // before the next placeTorso call overwrites it.
    this._staminaColorBuf = [0, 0, 0];
    // Scratch state for updateStaminaClipPlane + disc orientation. Each
    // call fills `_staminaClipOut` in place; _discLocalY is the static
    // up-vector the disc geometry was pre-rotated to face.
    this._staminaClipOut = { cx:0, cy:0, cz:0, dx:0, dy:1, dz:0, axialFromMid:0 };
    this._discLocalY = new THREE.Vector3(0, 1, 0);
    this._scratchDiscDir = new THREE.Vector3();

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
    this.renderer.setPixelRatio(window.devicePixelRatio || 1);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
    this._placeCamera();
  }

  /** Release every tracked geometry / material, drop scene children,
   *  detach the WebGL context. Implementation in renderer/scene.js. */
  dispose() { return disposeScene(this); }

  /** Per-frame entry — implementation lives in renderer/update-loop.js. */
  renderState(state) { return renderStateImpl(this, state); }

  /* ── Camera (implementations live in renderer/camera.js) ── */
  _placeCamera()                                { return placeCamera(this); }
  setCameraFocus(tx, ty, tz, dist, pitch, yaw)  { return setCameraFocus(this, tx, ty, tz, dist, pitch, yaw); }
  _initDebugCam()                               { return initDebugCam(this); }
  setDebugCam(on)                               { return setDebugCam(this, on); }
  isDebugCamActive()                            { return isDebugCamActive(this); }
  _initFollowCam()                              { return initFollowCam(this); }
  setFollowCam(on)                              { return setFollowCam(this, on); }
  isFollowCamActive()                           { return isFollowCamActive(this); }
  setDebugMode(on)                              { return this._debugOverlay.setEnabled(on); }
  isDebugModeActive()                           { return this._debugOverlay.isEnabled(); }

  /* ── Static world lives in renderer/field.js (constructor calls
   * buildFieldLines(this) directly — no public method needed). */

  /* ── Name label (constructor calls this twice for p1/p2; the
   * per-frame update path — updateNameLabels/setLabelText — is
   * called directly from renderer/update-loop.js, not through this
   * class). Implementation lives in renderer/scoreboard.js. */
  _makeNameLabel()                            { return makeNameLabel(this); }

  /* ── Stickman placement lives in renderer/player-rig.js and the
   * particle subsystem in renderer/particles.js. Both are called
   * directly from renderer/update-loop.js, not through this class. */
}
