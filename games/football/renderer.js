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
  BALL_RADIUS,
  FIELD_HEIGHT,
  FIELD_WIDTH_REF,
  GOAL_POST_RADIUS,
  MAX_PLAYER_SPEED,
  PLAYER_WIDTH,
  STICKMAN_HEAD_RADIUS,
  STICKMAN_LEG_RADIUS,
  STICKMAN_LIMB_FULL_H,
  STICKMAN_LOWER_ARM,
  STICKMAN_LOWER_ARM_RADIUS,
  STICKMAN_LOWER_LEG,
  STICKMAN_SHOULDER_OFY,
  STICKMAN_TORSO_RADIUS,
  STICKMAN_UPPER_ARM,
  STICKMAN_UPPER_ARM_RADIUS,
  STICKMAN_UPPER_LEG,
  Z_STRETCH,
  createField,
} from './physics.js';
import { DebugOverlay } from './debug/overlay.js';
import { advanceAnimState, createAnimState } from './animation/state.js';
import { composeStickmanPose, createPoseScratch } from './animation/poses.js';
import {
  staminaDiscRadius,
  updateStaminaClipPlane,
} from './util/renderer-math.js';
import { rgb, staminaColorInto, buildBallTexture } from './renderer/materials.js';
import {
  spawnBounceParticles, spawnFootstepParticles,
  spawnPushContactParticles, spawnGoalBurst,
  maybeFootstepBurst, stepParticles, drawParticles,
} from './renderer/particles.js';
import {
  computeDistance, placeCamera, setCameraFocus,
  initDebugCam, setDebugCam, isDebugCamActive, stepDebugCam,
  initFollowCam, setFollowCam, isFollowCamActive, stepFollowCam,
} from './renderer/camera.js';
import { buildFieldLines } from './renderer/field.js';
import {
  addStickman, orientBetween, placePlayerShadow, placeRestStars,
  placeTorso, placeArm, placeLeg, placeSph, placeLimbFromPool,
} from './renderer/player-rig.js';
import {
  updateNameLabels, makeNameLabel, setLabelText,
} from './renderer/scoreboard.js';
import { renderState as renderStateImpl } from './renderer/update-loop.js';
import { initScene, disposeScene } from './renderer/scene.js';
import {
  HORIZONTAL_MARGIN,
  STICKMAN_TORSO_SHELL_THICKNESS, STICKMAN_TORSO_FILL_RADIUS,
  STICKMAN_KNEE_RADIUS, STICKMAN_ELBOW_RADIUS, STICKMAN_SPH_POOL,
  TWO_PI, BALL_VISUAL_RADIUS, STAMINA_OUTLINE_OPACITY,
  PARTICLE_POOL, PARTICLE_BASE_COUNT, PARTICLE_FORCE_COUNT, PARTICLE_MAX_COUNT,
  PARTICLE_BASE_SPEED, PARTICLE_SPREAD, PARTICLE_LIFE_BASE, PARTICLE_LIFE_VARIANCE,
  PARTICLE_GRAVITY, PARTICLE_GROUND_DRAG, PARTICLE_VISUAL_RADIUS,
  FOOTSTEP_MIN_SPEED, FOOTSTEP_BASE_COUNT, FOOTSTEP_FORCE_COUNT,
  FOOTSTEP_MAX_COUNT, FOOTSTEP_SPEED, FOOTSTEP_BACK_OFFSET,
  PUSH_CONTACT_BASE_COUNT, PUSH_CONTACT_FORCE_COUNT, PUSH_CONTACT_MAX_COUNT,
  PUSH_CONTACT_SPEED, PUSH_CONTACT_LIFT_BIAS,
  GOAL_BURST_COUNT, GOAL_BURST_SPEED, GOAL_BURST_LIFT,
  GOAL_BURST_LIFE_BASE, GOAL_BURST_LIFE_VAR,
  CAMERA_FOV, CAMERA_TILT_DEG,
  FOLLOW_ZOOM_LIVE, FOLLOW_ZOOM_DEAD, FOLLOW_LEAD_FRACTION,
  NAME_LABEL_HEAD_GAP, NAME_LABEL_CANVAS_W, NAME_LABEL_CANVAS_H,
  NAME_LABEL_FONT, NAME_LABEL_TEXT_COLOR, NAME_LABEL_SHADOW_COLOR,
  NAME_LABEL_SHADOW_BLUR, NAME_LABEL_SCALE_X, NAME_LABEL_SCALE_Y,
  NAME_LABEL_FADE_BELOW, NAME_LABEL_FADE_FULL,
  BALL_SHADOW_GROWTH_PER_Z, BALL_SHADOW_FADE_PER_Z,
  DEBUG_CAM_DRAG_SENS, DEBUG_CAM_PAN_FRAC, DEBUG_CAM_WHEEL_SENS,
  DEBUG_CAM_DIST_MIN, DEBUG_CAM_DIST_MAX,
  REST_STAR_RADIUS_FRAC, REST_STAR_HEIGHT_FRAC, REST_STAR_SCALE_BASE,
  REST_STAR_SCALE_OPACITY, REST_STAR_TUMBLE_FRAC, REST_STAR_COUNTER_SPIN,
  SHADOW_VERTEX_SHADER, SHADOW_FRAGMENT_SHADER,
  PLAYER_SHADOW_RADIUS, SHADOW_ALPHA_BASE, SHADOW_Y,
  COLOR_TEXT, COLOR_STAM_LOW, COLOR_STAM_MID, COLOR_STAM_HIGH,
} from './renderer/tuning.js';

// Stamina gradient (COLOR_STAM_LOW/MID/HIGH) for the torso fill + disc —
// red at empty, amber at half, green at full. Hex values mirror
// style.css `--red`, `--amber`, `--green` exactly. Imported from
// renderer/tuning.js as pre-converted [r,g,b] triples.

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

    // Dedicated ball mesh: a real 3D sphere in world space at
    // (ball.x, ball.z, ball.y * Z_STRETCH). Visual radius equals
    // BALL_RADIUS so the rendered sphere and the collision envelope
    // can't drift apart. A procedurally-generated CanvasTexture
    // paints ~12 dark panels at icosahedron-vertex positions so the
    // rotation (applied from the ball's velocity each frame) is
    // visible at a glance.
    const ballGeom = new THREE.SphereGeometry(1, 24, 16);
    const ballMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.55,
      metalness: 0.05,
      map: buildBallTexture(),
    });
    this._staticGeometries.push(ballGeom);
    this._staticMaterials.push(ballMat);
    if (ballMat.map) this._staticMaterials.push(ballMat.map);
    // Pooled ball meshes so harnesses can render N physics worlds.
    // Each mesh's quaternion accumulates spin independently across
    // frames — the caller must pass balls in stable order for
    // rotation continuity.
    this._ballGeom = ballGeom;
    this._ballMat = ballMat;
    this._ballMeshes = [];
    this._ballCursor = 0;
    this._mkBall = () => {
      const mesh = new THREE.Mesh(this._ballGeom, this._ballMat);
      mesh.frustumCulled = false;
      mesh.visible = false;
      this.scene.add(mesh);
      this._ballMeshes.push(mesh);
      return mesh;
    };
    this._mkBall();  // pre-create the common single-ball slot
    // Ball-spin scratch objects (shared across pool — spin integration
    // is applied to the currently-indexed mesh's quaternion).
    this._ballSpinAxis = new THREE.Vector3();
    this._ballSpinQuat = new THREE.Quaternion();

    // Ground shadows — a soft dark disc per entity, laid flat on the
    // xz-plane just above y=0 so it doesn't z-fight the field lines.
    // One shared plane geometry, each mesh gets its own material so
    // uAlpha can be animated per-entity (ball fades as it rises).
    const shadowGeom = new THREE.PlaneGeometry(1, 1);
    this._staticGeometries.push(shadowGeom);
    this._shadowGeom = shadowGeom;
    this._makeShadow = () => {
      const mat = new THREE.ShaderMaterial({
        uniforms: { uAlpha: { value: SHADOW_ALPHA_BASE } },
        vertexShader: SHADOW_VERTEX_SHADER,
        fragmentShader: SHADOW_FRAGMENT_SHADER,
        transparent: true,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(this._shadowGeom, mat);
      mesh.rotation.x = -Math.PI / 2;  // lay flat on xz plane
      mesh.frustumCulled = false;
      mesh._uAlpha = mat.uniforms.uAlpha;
      this._staticMaterials.push(mat);
      this.scene.add(mesh);
      return mesh;
    };
    // Pool of player shadows, grown on demand via _placePlayerShadow.
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
    // Pool of ball shadows — one per ball mesh (matched by index).
    this._ballShadows = [this._makeShadow()];
    this._ballShadowCursor = 0;

    // Stickman pipe parts — torsos, arms, and legs each use their own
    // fixed-length CapsuleGeometry so the hemispherical caps stay
    // perfectly round (no stretching). Joint-to-joint distances are
    // constant per part type by construction, so meshes are placed
    // at midpoints and rotated but never scaled along their length.
    // Every stickman part uses the same monochrome color (COLOR_TEXT).
    //
    // The torso is drawn as THREE co-located meshes per stickman:
    //   outline — semi-transparent shell at the outer radius, always
    //             visible, DoubleSide so the inner capsule wall shows
    //             through for a readable 3D "glass shell" depth cue.
    //   fill    — opaque solid at a smaller radius (inset inward, so
    //             the outline shell reads as having real wall
    //             thickness), clipped above the stamina-height plane.
    //             FrontSide so only the outer shell of the fill
    //             capsule is lit, matching the head/limb lighting.
    //   disc    — a flat horizontal disc at the fill cut, sized to the
    //             fill capsule's internal cross-section radius so it
    //             caps the hollow without ever poking outside the
    //             hemispherical caps.
    // All three materials are MeshLambertMaterial so every lit part of
    // the stickman — head, arms, legs, torso shell, torso fill, disc —
    // shares the same lighting response and reads as one monochrome
    // figure.
    const torsoBodyLen = STICKMAN_SHOULDER_OFY - 2 * STICKMAN_TORSO_RADIUS;
    // Fill capsule reuses the outline's body length exactly — only the
    // radius shrinks. This produces a uniform shell of thickness
    // `STICKMAN_TORSO_SHELL_THICKNESS` on every side: radially, AND on
    // the top + bottom hemispherical caps. The fill's total end-to-end
    // length is therefore `2 * STICKMAN_TORSO_SHELL_THICKNESS` shorter
    // than the outline's, so `_placeTorso` insets the clipping range
    // accordingly (otherwise stamina=0/1 would map outside the fill).
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

    // Fill-capsule dimensions drive the disc scaling math in _placeTorso
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

    // Mesh factories stored on `this` so pools can grow on demand in
    // the _place* helpers (harnesses/tests can drive N > 2 players).
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
    // Initial pools — sized for the common 2-player match case so the
    // first frame has no allocation. _place* helpers grow on demand.
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

    buildFieldLines(this);

    // Reusable scratch Vector3 objects for the stickman hot path so
    // per-frame animation doesn't allocate.
    this._scratchDir = new THREE.Vector3();
    this._scratchAxis = new THREE.Vector3();
    this._scratchUp = new THREE.Vector3(0, 1, 0);
    // Scratch [r,g,b] buffer for the per-frame stamina gradient. Reused
    // across both stickmen since each frame's writes are consumed
    // before the next _placeTorso call overwrites it.
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
  _computeDistance(zoom)                        { return computeDistance(this, zoom); }
  setCameraFocus(tx, ty, tz, dist, pitch, yaw)  { return setCameraFocus(this, tx, ty, tz, dist, pitch, yaw); }
  _initDebugCam()                               { return initDebugCam(this); }
  setDebugCam(on)                               { return setDebugCam(this, on); }
  isDebugCamActive()                            { return isDebugCamActive(this); }
  _stepDebugCam()                               { return stepDebugCam(this); }
  _initFollowCam()                              { return initFollowCam(this); }
  setFollowCam(on)                              { return setFollowCam(this, on); }
  isFollowCamActive()                           { return isFollowCamActive(this); }
  _stepFollowCam(state)                         { return stepFollowCam(this, state); }
  setDebugMode(on)                              { return this._debugOverlay.setEnabled(on); }
  isDebugModeActive()                           { return this._debugOverlay.isEnabled(); }

  /* ── Static world lives in renderer/field.js (constructor calls
   * buildFieldLines(this) directly — no public method needed). */

  /* ── Stickman ────────────────────────────────────────────
   *
   * 3D capsule figure: torso + two arms + two legs as fixed-length
   * CapsuleGeometry, head + elbows + knees as spheres, all
   * positioned in world space. Per-frame state advances via
   * advanceAnimState (animation/state.js); pose layout is built by
   * composeStickmanPose (animation/poses.js); this method only
   * places the meshes.
   *
   * Limbs swing in a (forward, up) plane where (forwardX, forwardZ)
   * is the player's heading-derived world-xz unit vector supplied
   * by the pose layer. Per-segment angle conventions: 0 hangs
   * straight down, +π/2 points forward, +π points straight up
   * (celebration).
   *
   * Implementations in renderer/player-rig.js + renderer/scoreboard.js.
   */
  _addStickman(...args)                       { return addStickman(this, ...args); }
  _orientBetween(mesh, ax, ay, az, bx, by, bz, color) { return orientBetween(this, mesh, ax, ay, az, bx, by, bz, color); }
  _placePlayerShadow(player)                  { return placePlayerShadow(this, player); }
  _placeRestStars(pose, snap)                 { return placeRestStars(this, pose, snap); }
  _placeTorso(ax, ay, az, bx, by, bz, c, sf)  { return placeTorso(this, ax, ay, az, bx, by, bz, c, sf); }
  _placeArm(...args)                          { return placeArm(this, ...args); }
  _placeLeg(...args)                          { return placeLeg(this, ...args); }
  _placeSph(cx, cy, cz, r, color)             { return placeSph(this, cx, cy, cz, r, color); }
  _placeLimbFromPool(...args)                 { return placeLimbFromPool(this, ...args); }
  _updateNameLabels(state, players)           { return updateNameLabels(this, state, players); }
  _makeNameLabel()                            { return makeNameLabel(this); }
  _setLabelText(label, name)                  { return setLabelText(label, name); }

  // Particle subsystem — implementations live in renderer/particles.js.
  _spawnBounceParticles(ev)            { return spawnBounceParticles(this, ev); }
  _maybeFootstepBurst(player, snap)    { return maybeFootstepBurst(this, player, snap); }
  _spawnFootstepParticles(player, sp)  { return spawnFootstepParticles(this, player, sp); }
  _spawnPushContactParticles(ev)       { return spawnPushContactParticles(this, ev); }
  _spawnGoalBurst(scorer)              { return spawnGoalBurst(this, scorer); }
  _stepParticles()                     { return stepParticles(this); }
  _drawParticles()                     { return drawParticles(this); }
}

/* ── Helpers ───────────────────────────────────────────────── */

// Body-english curves (pushBodyDipAt, kickTiltAt, airkickTiltAt, …)
