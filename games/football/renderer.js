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

    this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio || 1);
    this.renderer.setClearColor(0x000000, 0);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(CAMERA_FOV, 2, 0.1, 4000);
    this._followCam = null;
    this._placeCamera();
    // Camera modes — both wired up at construction, start inactive.
    // Mutually exclusive: enabling one disables the other.
    this._initDebugCam();
    this._initFollowCam();
    // Debug-collider overlay — fully self-contained module. Pool is
    // built lazily on first enable; renderer just forwards the toggle.
    this._debugOverlay = new DebugOverlay(this.scene);

    // Track static scene objects so dispose() can release them.
    this._staticGeometries = [];
    this._staticMaterials = [];

    // Lighting for the ball sphere and cylindrical stickmen. The
    // rest of the scene is rendered with unlit line / basic materials,
    // so these lights only affect meshes that use a lit material.
    // Low ambient + strong directional gives pronounced terminator
    // shading so the ball and stickmen read as solid 3D objects
    // instead of flat discs / pipes.
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.35));
    const dirLight = new THREE.DirectionalLight(0xffffff, 1.15);
    dirLight.position.set(0.6, 1.0, 0.4);  // from upper-front
    this.scene.add(dirLight);
    // Second dim fill light from the opposite side so the shadow
    // side of the ball doesn't go completely dead — gives a soft
    // rim where the shaded half curves back around.
    const fill = new THREE.DirectionalLight(0xffffff, 0.35);
    fill.position.set(-0.4, 0.3, -0.5);
    this.scene.add(fill);

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

  dispose() {
    if (this._resizeObserver) this._resizeObserver.disconnect();
    if (this._debugKeydown) window.removeEventListener('keydown', this._debugKeydown);
    if (this._debugKeyup) window.removeEventListener('keyup', this._debugKeyup);
    for (const geom of this._staticGeometries) geom.dispose();
    for (const mat of this._staticMaterials) mat.dispose();
    while (this.scene.children.length > 0) this.scene.remove(this.scene.children[0]);
    this.renderer.dispose();
  }

  renderState(state) {
    const tick = state.tick || 0;
    // state.players is the N-player path (any array of player-shaped
    // objects). Falls back to [p1, p2] for the single-match case.
    const players = state.players || [state.p1, state.p2];
    const prevTorsoCursor    = this._stickmanTorsoCursor;
    const prevUpperArmCursor = this._stickmanUpperArmCursor;
    const prevLowerArmCursor = this._stickmanLowerArmCursor;
    const prevLegCursor      = this._stickmanLegCursor;
    const prevSphCursor      = this._stickmanSphCursor;
    const prevPlayerShadowCursor = this._playerShadowCursor;
    const prevBallCursor         = this._ballCursor;
    const prevBallShadowCursor   = this._ballShadowCursor;
    const prevRestStarCursor     = this._restStarCursor;
    this._stickmanTorsoCursor    = 0;
    this._stickmanUpperArmCursor = 0;
    this._stickmanLowerArmCursor = 0;
    this._stickmanLegCursor      = 0;
    this._stickmanSphCursor      = 0;
    this._playerShadowCursor     = 0;
    this._ballCursor             = 0;
    this._ballShadowCursor       = 0;
    this._restStarCursor         = 0;
    // Per-player dead-ball flags. The harness may stamp each player
    // with `_scenePauseState` + `_sceneGoalScorer` + `_sceneWinner` so
    // multiple independent scenarios inside one composite render
    // frame don't cross-contaminate — in that case we read the
    // player's own scenario state instead of the global composite.
    // When those annotations aren't set (live match path), we fall
    // back to the global state.pauseState.
    for (let i = 0; i < players.length; i++) {
      const p = players[i];
      const pPause      = p._scenePauseState !== undefined ? p._scenePauseState : state.pauseState;
      const pGoalScorer = p._sceneGoalScorer !== undefined ? p._sceneGoalScorer : state.goalScorer;
      const pWinner     = p._sceneWinner     !== undefined ? p._sceneWinner     : state.winner;
      const pSide       = p._sceneSide       !== undefined ? p._sceneSide
                         : p === state.p1 ? 'left' : p === state.p2 ? 'right' : null;

      const pCelebrating = pPause === 'celebrate';
      const pMatchend    = pPause === 'matchend';
      const pMatchEndPhase = state.matchEndPhase;

      // Per-player flags drive both pose layers and the heading
      // override in animation/state.js. The matchend cinematic layers
      // its phases onto these existing flags:
      //   reposition phase → walk-back, motion-direction heading
      //   pose phase       → face camera + winner celebrates / loser grieves
      //   neutral phase    → smooth turn back to face-each-other
      let isScorer    = pCelebrating && pGoalScorer === p;
      let isGrieving  = pCelebrating && pGoalScorer && pGoalScorer !== p;
      let isReposition = pPause === 'reposition';
      let faceCameraSmooth = false;
      let faceEachOtherSmooth = false;
      let isMatchendWin = false, isMatchendLose = false;

      if (pMatchend && pWinner && pSide) {
        const isWinner = pSide === pWinner;
        if (pMatchEndPhase === 'reposition') {
          isReposition = true;
        } else if (pMatchEndPhase === 'pose') {
          faceCameraSmooth = true;
          isScorer = isWinner;
          isGrieving = !isWinner;
        } else if (pMatchEndPhase === 'neutral') {
          faceEachOtherSmooth = true;
        } else {
          // Defensive fallback for harness scenarios that set
          // pauseState='matchend' without matchEndPhase — keep the
          // legacy static MATCHEND_WIN/LOSE pose.
          isMatchendWin  = isWinner;
          isMatchendLose = !isWinner;
        }
      }
      this._addStickman(
        p, COLOR_TEXT, tick, isScorer, isGrieving, isReposition,
        isMatchendWin, isMatchendLose, faceCameraSmooth, faceEachOtherSmooth,
      );
      this._placePlayerShadow(p);
    }
    // Player name labels — drives the two billboarded sprites above
    // the heads. Names come from state.matchNames; positions come from
    // each player's last-rendered head pose stashed on player.anim.
    this._updateNameLabels(state, players);
    for (let i = this._stickmanTorsoCursor; i < prevTorsoCursor; i++) {
      this._stickmanTorsoOutline[i].visible = false;
      this._stickmanTorsoFill[i].visible = false;
      this._stickmanTorsoDisc[i].visible = false;
    }
    for (let i = this._stickmanUpperArmCursor; i < prevUpperArmCursor; i++) this._stickmanUpperArm[i].visible = false;
    for (let i = this._stickmanLowerArmCursor; i < prevLowerArmCursor; i++) this._stickmanLowerArm[i].visible = false;
    for (let i = this._stickmanLegCursor; i < prevLegCursor; i++) this._stickmanLeg[i].visible = false;
    for (let i = this._stickmanSphCursor; i < prevSphCursor; i++) this._stickmanSph[i].visible = false;
    for (let i = this._playerShadowCursor; i < prevPlayerShadowCursor; i++) this._playerShadows[i].visible = false;
    for (let i = this._restStarCursor; i < prevRestStarCursor; i++) this._restStars[i].visible = false;

    // Balls — single-ball state.ball path is backward-compatible;
    // state.balls[] is the N-ball path for harnesses/testing.
    // Each ball mesh accumulates its own spin quaternion across
    // frames, so callers must pass balls in stable index order.
    const balls = state.balls || [state.ball];
    const R = BALL_VISUAL_RADIUS;
    for (let bi = 0; bi < balls.length; bi++) {
      const b = balls[bi];
      while (this._ballMeshes.length <= bi) this._mkBall();
      while (this._ballShadows.length <= bi) this._ballShadows.push(this._makeShadow());
      const mesh = this._ballMeshes[bi];
      mesh.visible = true;
      const ballAltitude = b.z || 0;
      mesh.position.set(b.x, ballAltitude + BALL_VISUAL_RADIUS, b.y * Z_STRETCH);
      mesh.scale.set(BALL_VISUAL_RADIUS, BALL_VISUAL_RADIUS, BALL_VISUAL_RADIUS);
      // Rolling-without-slipping spin from linear velocity.
      const omegaX = (b.vy * Z_STRETCH) / R;
      const omegaZ = -b.vx / R;
      const omegaMag = Math.sqrt(omegaX * omegaX + omegaZ * omegaZ);
      if (omegaMag > 1e-5) {
        this._ballSpinAxis.set(omegaX / omegaMag, 0, omegaZ / omegaMag);
        this._ballSpinQuat.setFromAxisAngle(this._ballSpinAxis, omegaMag);
        mesh.quaternion.premultiply(this._ballSpinQuat);
      }
      // Ground shadow for this ball — stays flat on the xz-plane,
      // grows slightly and fades as the ball rises.
      const shadow = this._ballShadows[bi];
      const airH = Math.max(0, b.z || 0);
      const ballShadowR = BALL_VISUAL_RADIUS * (1 + airH * BALL_SHADOW_GROWTH_PER_Z);
      const ballShadowA = SHADOW_ALPHA_BASE / (1 + airH * BALL_SHADOW_FADE_PER_Z);
      shadow.visible = true;
      shadow.position.set(b.x, SHADOW_Y, b.y * Z_STRETCH);
      shadow.scale.set(ballShadowR * 2, ballShadowR * 2, 1);
      shadow._uAlpha.value = ballShadowA;
    }
    this._ballCursor       = balls.length;
    this._ballShadowCursor = balls.length;
    // Hide any ball / ball-shadow slots beyond what this frame used.
    for (let i = this._ballCursor;       i < prevBallCursor;       i++) this._ballMeshes[i].visible = false;
    for (let i = this._ballShadowCursor; i < prevBallShadowCursor; i++) this._ballShadows[i].visible = false;

    // Consume per-frame physics events. `state.events` is cleared at
    // the top of each tick, so anything here is brand-new this frame.
    for (let i = 0; i < state.events.length; i++) {
      const ev = state.events[i];
      if (ev.type === 'ball_bounce') this._spawnBounceParticles(ev);
      else if (ev.type === 'push_contact') this._spawnPushContactParticles(ev);
      else if (ev.type === 'goal') this._spawnGoalBurst(ev.scorer);
    }
    this._stepParticles();
    this._drawParticles();

    this._debugOverlay.update(state, players);

    if (this._followCam && this._followCam.active) this._stepFollowCam(state);
    else if (this._debugCam && this._debugCam.active) this._stepDebugCam();
    this.renderer.render(this.scene, this.camera);
  }

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
   */
  _addStickman(player, color, tick, isCelebrating, isGrieving = false, isReposition = false, isMatchendWin = false, isMatchendLose = false, faceCameraSmooth = false, faceEachOtherSmooth = false) {
    // 1. Fetch / init the smoothed animation state for this player.
    let anim = this._animByPlayer.get(player);
    if (!anim) {
      anim = createAnimState(tick, player);
      this._animByPlayer.set(player, anim);
    }
    // 2. Advance LPFs + phases one frame; derive per-frame snapshot.
    const animSnap = advanceAnimState(
      anim, player, tick, isCelebrating, this._scratchAnimSnap,
      isGrieving, isReposition, isMatchendWin, isMatchendLose,
      faceCameraSmooth, faceEachOtherSmooth,
    );
    // 3. Compose the full pose — walk + kick + push + celebrate all
    //    layered into one flat numeric pose via animation/poses.js.
    const pose = composeStickmanPose(
      animSnap, player, this._scratchPose,
      this._scratchKickPose, this._scratchPushPose,
    );
    // 4. Place the meshes. Torso + head are single-piece; arms and
    //    legs are 2-bone with per-segment angles from the pose.
    this._placeTorso(pose.baseX, pose.upperHipY, pose.baseZ, pose.neckX, pose.neckY, pose.neckZ, color, player.stamina);
    this._placeSph(pose.headX, pose.headY, pose.headZ, STICKMAN_HEAD_RADIUS, color);
    // Stash for the name-label pass.
    anim.lastHeadX = pose.headX;
    anim.lastHeadY = pose.headY;
    anim.lastHeadZ = pose.headZ;
    this._placeArm(pose.lShX, pose.shoulderY, pose.lShZ, pose.lArmUpper, pose.lArmLower, pose.forwardX, pose.forwardZ, color, pose.lArmUpperYaw, pose.lArmLowerYaw);
    this._placeArm(pose.rShX, pose.shoulderY, pose.rShZ, pose.rArmUpper, pose.rArmLower, pose.forwardX, pose.forwardZ, color, pose.rArmUpperYaw, pose.rArmLowerYaw);
    this._placeLeg(pose.lHipX, pose.hipBaseY, pose.lHipZ, pose.lLegUpper, pose.lLegLower, pose.forwardX, pose.forwardZ, color, pose.lLegHipYaw);
    this._placeLeg(pose.rHipX, pose.hipBaseY, pose.rHipZ, pose.rLegUpper, pose.rLegLower, pose.forwardX, pose.forwardZ, color, pose.rLegHipYaw);

    // 5. Footstep dust on walk-cycle zero crossings, gated on speed.
    //    Pure cosmetic — never feeds back into physics or anim state.
    this._maybeFootstepBurst(player, animSnap);

    // 6. Dazed stars orbiting the head while resting (exhausted).
    //    Hidden via the cursor sweep when rest factor is 0.
    if (animSnap.rest > 0.01) {
      this._placeRestStars(pose, animSnap);
    }
  }

  /** Orient `mesh` so its local +y axis points from A toward B and
   *  sets its midpoint position + color. The mesh is assumed to be a
   *  fixed-length capsule whose geometric length equals |B - A|
   *  (torso or limb); no non-uniform scaling is applied so the
   *  hemispherical caps stay perfectly round. */
  _orientBetween(mesh, ax, ay, az, bx, by, bz, color) {
    mesh.visible = true;
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (length < 1e-6) { mesh.visible = false; return; }
    mesh.position.set((ax + bx) * 0.5, (ay + by) * 0.5, (az + bz) * 0.5);
    mesh.scale.set(1, 1, 1);
    this._scratchDir.set(dx / length, dy / length, dz / length);
    this._scratchAxis.crossVectors(this._scratchUp, this._scratchDir);
    const axisLen = this._scratchAxis.length();
    if (axisLen > 1e-6) {
      const dot = this._scratchUp.dot(this._scratchDir);
      mesh.quaternion.setFromAxisAngle(
        this._scratchAxis.divideScalar(axisLen),
        Math.acos(Math.max(-1, Math.min(1, dot))),
      );
    } else if (this._scratchDir.y < 0) {
      mesh.quaternion.set(1, 0, 0, 0);
    } else {
      mesh.quaternion.identity();
    }
    mesh.material.color.setRGB(color[0], color[1], color[2]);
  }

  /** Position both name-label sprites at each player's head with a
   *  small Y offset, set the texture from state.matchNames, and apply
   *  overlap fade based on screen-space label distance. */
  _updateNameLabels(state, players) {
    const names = state.matchNames;
    if (!names || players.length < 2) {
      this._nameLabels.forEach((l) => l.mesh.visible = false);
      return;
    }
    const labels = this._nameLabels;
    const offsetY = STICKMAN_HEAD_RADIUS + NAME_LABEL_HEAD_GAP;
    for (let i = 0; i < 2; i++) {
      const p = players[i];
      const anim = this._animByPlayer.get(p);
      // Fall back to player center if anim hasn't rendered yet.
      const headX = anim?.lastHeadX ?? (p.x + PLAYER_WIDTH / 2);
      const headY = anim?.lastHeadY ?? STICKMAN_LIMB_FULL_H * 2;
      const headZ = anim?.lastHeadZ ?? (p.y * Z_STRETCH);
      labels[i].mesh.position.set(headX, headY + offsetY, headZ);
      labels[i].mesh.visible = true;
      this._setLabelText(labels[i], i === 0 ? names.p1 : names.p2);
    }
    // Overlap fade: project both label positions to screen-space,
    // compute pixel distance, fade alpha to 0 below threshold.
    const camera = this.camera;
    const a = this._nameLabelTmpA.copy(labels[0].mesh.position).project(camera);
    const b = this._nameLabelTmpB.copy(labels[1].mesh.position).project(camera);
    const w = this.renderer.domElement.width / 2;
    const h = this.renderer.domElement.height / 2;
    const dx = (a.x - b.x) * w;
    const dy = (a.y - b.y) * h;
    const pixelDist = Math.hypot(dx, dy);
    let alpha = 1;
    if (pixelDist < NAME_LABEL_FADE_BELOW) {
      alpha = Math.max(0, (pixelDist - NAME_LABEL_FADE_FULL)
                       / (NAME_LABEL_FADE_BELOW - NAME_LABEL_FADE_FULL));
    }
    labels[0].mat.opacity = alpha;
    labels[1].mat.opacity = alpha;
  }

  /** Allocate one billboarded name-label sprite. Returns
   *  { mesh, canvas, ctx, texture, name }. Texture is updated lazily
   *  via _setLabelText. */
  _makeNameLabel() {
    const canvas = document.createElement('canvas');
    canvas.width = NAME_LABEL_CANVAS_W;
    canvas.height = NAME_LABEL_CANVAS_H;
    const ctx = canvas.getContext('2d');
    const texture = new THREE.CanvasTexture(canvas);
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    const mat = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    const mesh = new THREE.Sprite(mat);
    // World-space scale tuned so labels read as small floating tags
    // at the camera's working distance without overpowering the figure.
    mesh.scale.set(NAME_LABEL_SCALE_X, NAME_LABEL_SCALE_Y, 1);
    mesh.renderOrder = 999;
    this.scene.add(mesh);
    return { mesh, canvas, ctx, texture, mat, name: '' };
  }

  _setLabelText(label, rawName) {
    const name = (rawName || '').toLowerCase();
    if (label.name === name) return;
    label.name = name;
    const { ctx, canvas, texture } = label;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.font = NAME_LABEL_FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = NAME_LABEL_TEXT_COLOR;
    ctx.shadowColor = NAME_LABEL_SHADOW_COLOR;
    ctx.shadowBlur = NAME_LABEL_SHADOW_BLUR;
    ctx.fillText(name, canvas.width / 2, canvas.height / 2);
    texture.needsUpdate = true;
  }

  /** Place the next shadow from the player-shadow pool under
   *  `player`, growing the pool on demand. Pooled so harnesses can
   *  render N players without a fixed ceiling. */
  _placePlayerShadow(player) {
    const idx = this._playerShadowCursor++;
    while (this._playerShadows.length <= idx) this._playerShadows.push(this._makeShadow());
    const shadow = this._playerShadows[idx];
    shadow.position.set(player.x + PLAYER_WIDTH / 2, SHADOW_Y, player.y * Z_STRETCH);
    shadow.scale.set(PLAYER_SHADOW_RADIUS * 2, PLAYER_SHADOW_RADIUS * 2, 1);
    shadow.visible = true;
  }

  /** Place 3 dazed stars in a horizontal ring above the head, rotating
   *  around the player's vertical axis. Phase comes from `animSnap.restPhase`
   *  multiplied by REST_STAR_COUNTER_SPIN so the ring counter-rotates
   *  faster than the body's own wobble, exaggerating the dizzy read.
   *  Opacity = animSnap.rest, so stars fade in/out with the LPF factor. */
  _placeRestStars(pose, animSnap) {
    const ringRadius = STICKMAN_HEAD_RADIUS * REST_STAR_RADIUS_FRAC;
    const ringHeight = STICKMAN_HEAD_RADIUS * REST_STAR_HEIGHT_FRAC;
    const cy = pose.headY + ringHeight;
    const opacity = Math.min(1, animSnap.rest);
    const scale = REST_STAR_SCALE_BASE + REST_STAR_SCALE_OPACITY * opacity;
    const spin = animSnap.restPhase * REST_STAR_COUNTER_SPIN;
    for (let i = 0; i < 3; i++) {
      const idx = this._restStarCursor++;
      while (this._restStars.length <= idx) this._mkRestStar();
      const mesh = this._restStars[idx];
      const theta = spin + (i * (Math.PI * 2 / 3));
      mesh.position.set(
        pose.headX + Math.cos(theta) * ringRadius,
        cy + Math.sin(theta * 1.7) * (STICKMAN_HEAD_RADIUS * 0.18),
        pose.headZ + Math.sin(theta) * ringRadius,
      );
      // Each star also tumbles around its own axis so it's not a flat
      // billboard — gives a metallic twinkle.
      mesh.rotation.set(theta * REST_STAR_TUMBLE_FRAC, theta, 0);
      mesh.scale.set(scale, scale, scale);
      mesh.material.opacity = opacity;
      mesh.visible = true;
    }
  }

  /** Pull a torso capsule triple (outline + fill + disc) from the
   *  pool, orient the outline+fill between hip and neck, update the
   *  fill mesh's clipping plane so the solid fill covers the bottom
   *  `staminaFrac` of the torso, and size the cut disc so it never
   *  pokes out of the capsule's hemispherical caps. The outline stays
   *  in the monochrome body color; the fill + disc are tinted with a
   *  red→amber→green gradient driven by `staminaFrac`. */
  _placeTorso(ax, ay, az, bx, by, bz, color, staminaFrac) {
    const idx = this._stickmanTorsoCursor;
    while (this._stickmanTorsoOutline.length <= idx) {
      this._mkTorsoOutline();
      this._mkTorsoFill();
      this._mkTorsoDisc();
    }
    this._stickmanTorsoCursor++;
    const outline = this._stickmanTorsoOutline[idx];
    const fill    = this._stickmanTorsoFill[idx];
    const plane   = this._stickmanTorsoFillPlanes[idx];

    const tint = staminaColorInto(this._staminaColorBuf, staminaFrac);
    this._orientBetween(outline, ax, ay, az, bx, by, bz, color);
    this._orientBetween(fill,    ax, ay, az, bx, by, bz, tint);
    // Clip plane perpendicular to the torso axis at the stamina
    // fraction. The fill capsule is inset by shell thickness on both
    // caps (its ends sit `shellThickness` inside the outline), so the
    // helper shrinks the range it maps 0/1 over accordingly.
    const info = updateStaminaClipPlane(
      plane, ax, ay, az, bx, by, bz,
      STICKMAN_TORSO_SHELL_THICKNESS, staminaFrac, this._staminaClipOut,
    );

    const disc = this._stickmanTorsoDisc[idx];
    const discR = staminaDiscRadius(
      info.axialFromMid,
      this._fillBodyHalf,
      this._fillCapRadius,
    );
    if (discR > 0) {
      disc.visible = true;
      disc.position.set(info.cx, info.cy, info.cz);
      // Orient the flat disc so its normal tracks the torso axis —
      // otherwise an inclined torso would have a horizontal lid
      // poking sideways through the shell.
      this._scratchDiscDir.set(info.dx, info.dy, info.dz);
      disc.quaternion.setFromUnitVectors(this._discLocalY, this._scratchDiscDir);
      const s = (discR / this._fillCapRadius) * 0.995;
      disc.scale.set(s, 1, s);
      disc.material.color.setRGB(tint[0], tint[1], tint[2]);
    } else {
      disc.visible = false;
    }
  }

  /** Pull a limb capsule from the given pool and pivot it at
   *  (px, py, pz) with the given swing angle. The limb extends by
   *  LIMB_FULL_H along (forwardX*sin(angle), -cos(angle),
   *  forwardZ*sin(angle)), where (forwardX, forwardZ) is the player's
   *  heading-based forward unit vector in world xz. Arms and legs use
   *  separate pools (different capsule radii) but the placement math
   *  is identical. */
  _placeLimbFromPool(pool, cursorKey, px, py, pz, angle, forwardX, forwardZ, color) {
    if (this[cursorKey] >= pool.length) return;
    const mesh = pool[this[cursorKey]++];
    const L = STICKMAN_LIMB_FULL_H;
    const sinA = Math.sin(angle);
    const ex = px + forwardX * L * sinA;
    const ey = py - L * Math.cos(angle);
    const ez = pz + forwardZ * L * sinA;
    this._orientBetween(mesh, px, py, pz, ex, ey, ez, color);
  }

  /** Two-segment arm with an elbow. `upperAngle` is the shoulder
   *  swing angle (0 = straight down, +π/2 = forward, +π = straight
   *  up). `lowerAngle` is the forearm's world-space swing angle
   *  (not relative to the upper arm). Both capsules meet at the
   *  elbow, where a slightly-undersized `STICKMAN_ELBOW_RADIUS`
   *  sphere is drawn (a small joint bump, not a growth). Upper arm
   *  is 15 % thicker than the forearm, matching rough human
   *  proportions. */
  _placeArm(px, py, pz, upperAngle, lowerAngle, forwardX, forwardZ, color, upperYaw = 0, lowerYaw = 0) {
    const U = STICKMAN_UPPER_ARM;
    const L = STICKMAN_LOWER_ARM;
    // `upperYaw` / `lowerYaw` rotate the per-segment forward direction
    // around the vertical axis independently, so a hook (horizontal arc)
    // and uppercut (vertical arc) can both be expressed in the same rig.
    const uyc = Math.cos(upperYaw), uys = Math.sin(upperYaw);
    const uFwdX = forwardX * uyc - forwardZ * uys;
    const uFwdZ = forwardX * uys + forwardZ * uyc;
    const lyc = Math.cos(lowerYaw), lys = Math.sin(lowerYaw);
    const lFwdX = forwardX * lyc - forwardZ * lys;
    const lFwdZ = forwardX * lys + forwardZ * lyc;

    const upperSin = Math.sin(upperAngle);
    const elbowX = px + uFwdX * U * upperSin;
    const elbowY = py - U * Math.cos(upperAngle);
    const elbowZ = pz + uFwdZ * U * upperSin;
    const lowerSin = Math.sin(lowerAngle);
    const handX = elbowX + lFwdX * L * lowerSin;
    const handY = elbowY - L * Math.cos(lowerAngle);
    const handZ = elbowZ + lFwdZ * L * lowerSin;

    // Upper segment (thicker): shoulder → elbow.
    while (this._stickmanUpperArm.length <= this._stickmanUpperArmCursor) this._mkUpperArm();
    const upperMesh = this._stickmanUpperArm[this._stickmanUpperArmCursor++];
    this._orientBetween(upperMesh, px, py, pz, elbowX, elbowY, elbowZ, color);
    // Lower segment (thinner): elbow → hand.
    while (this._stickmanLowerArm.length <= this._stickmanLowerArmCursor) this._mkLowerArm();
    const lowerMesh = this._stickmanLowerArm[this._stickmanLowerArmCursor++];
    this._orientBetween(lowerMesh, elbowX, elbowY, elbowZ, handX, handY, handZ, color);
    // Elbow sphere — reads as a joint bump even when the arm is
    // straight and the two capsules are collinear.
    this._placeSph(elbowX, elbowY, elbowZ, STICKMAN_ELBOW_RADIUS, color);
  }

  /** Two-segment leg with a knee. `upperAngle` is the hip-swing
   *  angle (0 = straight down, +π/2 = forward, +π = straight up).
   *  `lowerAngle` is the shin's world-space swing angle (not
   *  relative to the upper leg). The two capsules meet at the
   *  knee, with a kneecap sphere drawn over the join. Passing
   *  `lowerAngle === upperAngle` produces a straight leg. */
  _placeLeg(px, py, pz, upperAngle, lowerAngle, forwardX, forwardZ, color, hipYaw = 0) {
    const U = STICKMAN_UPPER_LEG;
    const L = STICKMAN_LOWER_LEG;
    // hipYaw rotates the leg's forward axis around the vertical hip axis
    // — used by the kick to hook the foot toward an off-axis ball. Same
    // yaw applies to upper and lower segments so the leg stays straight
    // through the knee; the foot translates along the rotated axis.
    const yc = Math.cos(hipYaw), ys = Math.sin(hipYaw);
    const fwdX = forwardX * yc - forwardZ * ys;
    const fwdZ = forwardX * ys + forwardZ * yc;
    const upperSin = Math.sin(upperAngle);
    const kneeX = px + fwdX * U * upperSin;
    const kneeY = py - U * Math.cos(upperAngle);
    const kneeZ = pz + fwdZ * U * upperSin;
    const lowerSin = Math.sin(lowerAngle);
    const footX = kneeX + fwdX * L * lowerSin;
    const footY = kneeY - L * Math.cos(lowerAngle);
    const footZ = kneeZ + fwdZ * L * lowerSin;

    // Upper segment: hip → knee.
    while (this._stickmanLeg.length <= this._stickmanLegCursor) this._mkLeg();
    const upperMesh = this._stickmanLeg[this._stickmanLegCursor++];
    this._orientBetween(upperMesh, px, py, pz, kneeX, kneeY, kneeZ, color);

    // Lower segment: knee → foot.
    while (this._stickmanLeg.length <= this._stickmanLegCursor) this._mkLeg();
    const lowerMesh = this._stickmanLeg[this._stickmanLegCursor++];
    this._orientBetween(lowerMesh, kneeX, kneeY, kneeZ, footX, footY, footZ, color);

    // Kneecap sphere at the joint — slightly under the leg shaft
    // radius so it reads as joint detail rather than a growth, even
    // when the leg is straight and the two capsules are collinear.
    this._placeSph(kneeX, kneeY, kneeZ, STICKMAN_KNEE_RADIUS, color);
  }

  /** Pull a sphere from the pool and place it at a world point with
   *  the given radius and color. */
  _placeSph(cx, cy, cz, radius, color) {
    while (this._stickmanSph.length <= this._stickmanSphCursor) this._mkSph();
    const mesh = this._stickmanSph[this._stickmanSphCursor++];
    mesh.visible = true;
    mesh.position.set(cx, cy, cz);
    mesh.scale.set(radius, radius, radius);
    mesh.material.color.setRGB(color[0], color[1], color[2]);
  }

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
