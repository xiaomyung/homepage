/**
 * Football v2 — three.js renderer.
 *
 * Everything is solid 3D geometry: goals are cylinders, stickmen are
 * capsules + sphere heads, ball is a sphere, particles are instanced
 * spheres, field lines are THREE.Line segments, ground shadows are
 * shader-filled planes. No glyph / SDF atlas / font — the old
 * billboarded-ASCII pipeline is gone.
 *
 * Coordinate mapping:
 *   physics.x → three.js.x  (field horizontal)
 *   physics.z → three.js.y  (ball height / up)
 *   physics.y → three.js.z  (field depth)
 */

import * as THREE from 'https://unpkg.com/three@0.164.0/build/three.module.js';
import {
  STAMINA_FLOOR,
  staminaDiscRadius,
  updateStaminaClipPlane,
} from './renderer-math.js';
import {
  createField,
  FIELD_HEIGHT,
  FIELD_WIDTH_REF,
  KICK_WINDUP_MS,
  KICK_DURATION_MS,
  AIRKICK_MS,
  AIRKICK_PEAK_FRAC,
  Z_STRETCH as PHYSICS_Z_STRETCH,
} from './physics.js?v=47';

// Physics field depth (42) is ~21× narrower than its width (900); stretch
// render-space z so the field fills more of the canvas vertically. Re-
// exported from physics.js as PHYSICS_Z_STRETCH; assertion below guards
// against accidental drift between the two copies.
const Z_STRETCH = 4.7;
if (PHYSICS_Z_STRETCH !== Z_STRETCH) {
  throw new Error(`Z_STRETCH drift: renderer ${Z_STRETCH} vs physics ${PHYSICS_Z_STRETCH}`);
}

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
const STICKMAN_SHOULDER_OFX = 0.216 * STICKMAN_GLYPH_SIZE;
const STICKMAN_SHOULDER_OFY = 0.92 * STICKMAN_GLYPH_SIZE;
const STICKMAN_HIP_OFX      = 0.12 * STICKMAN_GLYPH_SIZE;
const STICKMAN_HEAD_GAP_Y   = 0.13041 * STICKMAN_GLYPH_SIZE;
const STICKMAN_LIMB_HALF_H  = 0.45 * STICKMAN_GLYPH_SIZE;
const STICKMAN_LIMB_FULL_H  = STICKMAN_LIMB_HALF_H * 2;
// Thickness of the stickman's 3D pipe parts, in world units.
const STICKMAN_LEG_RADIUS   = 2.2;
// Arms are thinner than legs — 20% reduction from the leg radius.
const STICKMAN_ARM_RADIUS   = STICKMAN_LEG_RADIUS * 0.8;
const STICKMAN_TORSO_RADIUS = 3.3;
// Stamina fill capsule is inset inside the outline shell, creating a
// visible "shell wall" (the outline appears thicker inward while the
// outer silhouette is unchanged). Delta is in world units.
const STICKMAN_TORSO_SHELL_THICKNESS = 1.0;
const STICKMAN_TORSO_FILL_RADIUS = STICKMAN_TORSO_RADIUS - STICKMAN_TORSO_SHELL_THICKNESS;
const STICKMAN_HEAD_RADIUS  = 4.0;
const STICKMAN_FIST_RADIUS  = 3.0;
// Sphere pool for heads + push fists: 1 head + up to 2 fists per
// stickman × 2 stickmen + spare. (Torso and limb pools are sized
// inline alongside their geometries.)
const STICKMAN_SPH_POOL     = 8;
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

// Kick pose — a windup → whip-through → follow-through curve on the
// kicking leg, with a counter-balance arm swing and a small body
// dip/lean. Animation is driven by `player.kick.timer` read directly
// from the physics state.
//
// Phases over normalized progress t ∈ [0, 1] for a ground kick:
//   [0,         KICK_FIRE_T]    windup:   kicking leg rotates 0 → KICK_WINDUP_ANGLE
//                                         (behind the player, loading the swing)
//   [KICK_FIRE_T, KICK_STRIKE_END_T]  strike: leg whips through
//                                         KICK_WINDUP_ANGLE → KICK_STRIKE_ANGLE
//                                         (explosive, short window)
//   [KICK_STRIKE_END_T, 1]      recovery: leg eases back to 0
//
// KICK_FIRE_T is the physics fire fraction — impact is applied at
// this exact point in the animation so ball launch and foot contact
// are visually synchronised.
const KICK_FIRE_T         = KICK_WINDUP_MS / KICK_DURATION_MS;
const KICK_STRIKE_SPAN_T  = 0.15;
const KICK_STRIKE_END_T   = Math.min(0.95, KICK_FIRE_T + KICK_STRIKE_SPAN_T);
const KICK_WINDUP_ANGLE   = -Math.PI * 0.28;             // rad — leg rotated behind body
const KICK_STRIKE_ANGLE   =  Math.PI * 0.55;             // rad — foot past vertical forward
const KICK_ARM_SWING      =  Math.PI * 0.45;             // rad — counter-arm forward throw
const KICK_ARM_OPP_FRAC   = 0.35;                        // same-side arm small back-swing
const KICK_BACK_TILT      = 0.12;                        // rad — body lean back during windup
const KICK_FWD_TILT       = 0.22;                        // rad — body lean forward on strike
const KICK_CROUCH_DEPTH   = 0.12 * STICKMAN_GLYPH_SIZE;  // body dip during windup

// Airkick: the player leaps (player.airZ supplies the world-y lift)
// and the leg swings through a steeper arc. Fire point comes from
// physics.AIRKICK_PEAK_FRAC so the visual strike syncs with the
// moment the physics applies force to the ball.
const AIRKICK_STRIKE_SPAN_T = 0.20;
const AIRKICK_STRIKE_END_T = Math.min(0.95, AIRKICK_PEAK_FRAC + AIRKICK_STRIKE_SPAN_T);
const AIRKICK_WINDUP_ANGLE = -Math.PI * 0.22;            // smaller windup, more time in the air
const AIRKICK_STRIKE_ANGLE =  Math.PI * 0.80;            // foot near horizontal-forward (bicycle kick)
const AIRKICK_BACK_TILT    = 0.55;                        // rad — body leans way back on volley
// Visual radius of the 3D ball sphere, in world units. Physics
// BALL_RADIUS is bumped alongside this so the hitbox scales with the
// visual; visual is still larger than the physics hitbox for
// readability, same tradeoff as the stickman glyph being bigger
// than PLAYER_WIDTH.
const BALL_VISUAL_RADIUS = 4.224;

// Stamina indicator tuning — see the three-mesh breakdown in the
// torso-pool construction block below for how these values are used.
const STAMINA_OUTLINE_OPACITY = 0.55;
// Keep a sliver visible at stamina=0 so exhausted players don't
// vanish completely into the outline.
// STAMINA_FLOOR imported from renderer-math.js

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
// World-space radius of a new particle sphere, scaled down as it ages.
const PARTICLE_VISUAL_RADIUS = 0.9;
// Goal-scored burst — much bigger and longer-lived than a bounce.
// Particles spawn inside the mouth and fan outward toward the field.
const GOAL_BURST_COUNT       = 42;
const GOAL_BURST_SPEED       = 1.8;
const GOAL_BURST_LIFT        = 1.6;   // upward kick
const GOAL_BURST_LIFE_BASE   = 35;
const GOAL_BURST_LIFE_VAR    = 20;

// Thin cylinder radius (world units) for goal-frame bars so they render
// as solid poles. three.js line widths are GPU-dependent, so we use
// actual tube geometry instead.
const GOAL_BAR_RADIUS = 1.2;

const CAMERA_FOV = 60;
const CAMERA_TILT_DEG = 55;

// Follow-cam zoom multipliers — smaller = closer. The cam smoothly
// interpolates between LIVE (tight tracking) and DEAD (whole-field
// overview) when the game enters a celebration / OOB / match-end
// pause, and back to LIVE when play resumes.
const FOLLOW_ZOOM_LIVE = 0.60;
const FOLLOW_ZOOM_DEAD = 1.00;

/* ── Shaders ───────────────────────────────────────────────── */

// Soft drop-shadow disc, drawn flat on the xz plane under players and
// the ball. World-space geometry (not view-space) so perspective
// foreshortens it correctly from any camera angle. Center is opaque
// black, fading to transparent at the edge.
const SHADOW_VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
// Fragment outputs a dim gray, not pure black — on the black page
// background a true black shadow is invisible (alpha-composited black
// over black is still black). The gray reads as a subtle
// ground-contact disc instead.
const SHADOW_FRAGMENT_SHADER = /* glsl */ `
  uniform float uAlpha;
  varying vec2 vUv;
  void main() {
    vec2 p = vUv - 0.5;
    float d = length(p);
    float falloff = smoothstep(0.5, 0.15, d);
    float a = falloff * uAlpha;
    if (a < 0.01) discard;
    gl_FragColor = vec4(0.22, 0.22, 0.24, a);
  }
`;
const PLAYER_SHADOW_RADIUS = 12; // world units — fits under stickman glyph
const SHADOW_ALPHA_BASE    = 0.55;

/* ── Palette (matches style.css design tokens) ─────────────── */

const COLOR_TEXT  = rgb('#d0d0d0');
// Stamina gradient for the torso fill + disc — red at empty, amber
// at half, green at full. Hex values mirror style.css `--red`,
// `--amber`, `--green` exactly.
const COLOR_STAM_LOW  = rgb('#f7768e');
const COLOR_STAM_MID  = rgb('#e0af68');
const COLOR_STAM_HIGH = rgb('#9ece6a');

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
    // (ball.x, ball.z, ball.y * Z_STRETCH). Physics collision uses
    // BALL_RADIUS; visual sphere is larger for readability. A
    // procedurally-generated CanvasTexture paints ~12 dark panels
    // at icosahedron-vertex positions so the rotation (applied from
    // the ball's velocity each frame) is visible at a glance.
    const ballGeom = new THREE.SphereGeometry(1, 24, 16);
    const ballMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.55,
      metalness: 0.05,
      map: buildBallTexture(),
    });
    this._ballMesh = new THREE.Mesh(ballGeom, ballMat);
    this._ballMesh.frustumCulled = false;
    this._staticGeometries.push(ballGeom);
    this._staticMaterials.push(ballMat);
    if (ballMat.map) this._staticMaterials.push(ballMat.map);
    this.scene.add(this._ballMesh);
    // Ball orientation is integrated per frame from linear velocity
    // (rolling without slipping on the ground). Reused scratch
    // objects avoid per-frame allocation.
    this._ballSpinAxis = new THREE.Vector3();
    this._ballSpinQuat = new THREE.Quaternion();

    // Ground shadows — a soft dark disc per entity, laid flat on the
    // xz-plane just above y=0 so it doesn't z-fight the field lines.
    // One shared plane geometry, each mesh gets its own material so
    // uAlpha can be animated per-entity (ball fades as it rises).
    const shadowGeom = new THREE.PlaneGeometry(1, 1);
    this._staticGeometries.push(shadowGeom);
    const makeShadow = () => {
      const mat = new THREE.ShaderMaterial({
        uniforms: { uAlpha: { value: SHADOW_ALPHA_BASE } },
        vertexShader: SHADOW_VERTEX_SHADER,
        fragmentShader: SHADOW_FRAGMENT_SHADER,
        transparent: true,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(shadowGeom, mat);
      mesh.rotation.x = -Math.PI / 2;  // lay flat on xz plane
      mesh.frustumCulled = false;
      mesh._uAlpha = mat.uniforms.uAlpha;
      this._staticMaterials.push(mat);
      this.scene.add(mesh);
      return mesh;
    };
    this._p1Shadow   = makeShadow();
    this._p2Shadow   = makeShadow();
    this._ballShadow = makeShadow();

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
    const armBodyLen = STICKMAN_LIMB_FULL_H - 2 * STICKMAN_ARM_RADIUS;
    const legBodyLen = STICKMAN_LIMB_FULL_H - 2 * STICKMAN_LEG_RADIUS;
    const stickmanTorsoGeom     = new THREE.CapsuleGeometry(STICKMAN_TORSO_RADIUS,      torsoBodyLen,     4, 12);
    const stickmanTorsoFillGeom = new THREE.CapsuleGeometry(STICKMAN_TORSO_FILL_RADIUS, torsoFillBodyLen, 4, 12);
    const stickmanArmGeom       = new THREE.CapsuleGeometry(STICKMAN_ARM_RADIUS,        armBodyLen,       4, 10);
    const stickmanLegGeom       = new THREE.CapsuleGeometry(STICKMAN_LEG_RADIUS,        legBodyLen,       4, 10);
    this._staticGeometries.push(stickmanTorsoGeom, stickmanTorsoFillGeom, stickmanArmGeom, stickmanLegGeom);

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
    this._stickmanArm = [];
    this._stickmanLeg = [];

    // Water-surface disc geometry — circle in the XZ plane, sized to
    // the fill capsule's cap radius. Each disc mesh scales this at
    // frame time to match the capsule's cross-section at the current
    // fill height. Re-used by all pooled disc meshes.
    const discGeom = new THREE.CircleGeometry(STICKMAN_TORSO_FILL_RADIUS, 18);
    discGeom.rotateX(-Math.PI / 2);
    this._staticGeometries.push(discGeom);

    const makeArmMesh = () => {
      const mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
      const mesh = new THREE.Mesh(stickmanArmGeom, mat);
      mesh.visible = false;
      mesh.frustumCulled = false;
      this._staticMaterials.push(mat);
      this.scene.add(mesh);
      this._stickmanArm.push(mesh);
    };
    const makeLegMesh = () => {
      const mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
      const mesh = new THREE.Mesh(stickmanLegGeom, mat);
      mesh.visible = false;
      mesh.frustumCulled = false;
      this._staticMaterials.push(mat);
      this.scene.add(mesh);
      this._stickmanLeg.push(mesh);
    };
    const makeTorsoOutlineMesh = () => {
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
    const makeTorsoFillMesh = () => {
      // Each fill mesh gets its own clipping plane instance so the
      // four pooled torsos can have independent fill levels.
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
    const makeTorsoDiscMesh = () => {
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
    for (let i = 0; i < 4; i++) {
      makeTorsoOutlineMesh();
      makeTorsoFillMesh();
      makeTorsoDiscMesh();
    }
    // Two players × 2 arms/legs = 4 of each on screen. Pool of 8
    // leaves headroom for future multi-stickman scenes.
    for (let i = 0; i < 8; i++) makeArmMesh();
    for (let i = 0; i < 8; i++) makeLegMesh();
    this._stickmanTorsoCursor = 0;
    this._stickmanArmCursor = 0;
    this._stickmanLegCursor = 0;

    // Stickman sphere pool — used for heads and fists. One shared
    // unit sphere geometry, per-mesh Lambert material for color.
    const stickmanSph = new THREE.SphereGeometry(1, 14, 10);
    this._staticGeometries.push(stickmanSph);
    this._stickmanSph = [];
    for (let i = 0; i < STICKMAN_SPH_POOL; i++) {
      const mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
      const mesh = new THREE.Mesh(stickmanSph, mat);
      mesh.visible = false;
      mesh.frustumCulled = false;
      this._staticMaterials.push(mat);
      this.scene.add(mesh);
      this._stickmanSph.push(mesh);
    }
    this._stickmanSphCursor = 0;


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

    this._buildFieldLines();

    // Reusable scratch Vector3 objects for the stickman hot path so
    // per-frame animation doesn't allocate.
    this._scratchDir = new THREE.Vector3();
    this._scratchAxis = new THREE.Vector3();
    this._scratchUp = new THREE.Vector3(0, 1, 0);
    // Scratch [r,g,b] buffer for the per-frame stamina gradient. Reused
    // across both stickmen since each frame's writes are consumed
    // before the next _placeTorso call overwrites it.
    this._staminaColorBuf = [0, 0, 0];

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
    const celebrating = state.pauseState === 'celebrate';
    const p1Celebrating = celebrating && state.goalScorer === state.p1;
    const p2Celebrating = celebrating && state.goalScorer === state.p2;
    const prevTorsoCursor = this._stickmanTorsoCursor;
    const prevArmCursor   = this._stickmanArmCursor;
    const prevLegCursor   = this._stickmanLegCursor;
    const prevSphCursor   = this._stickmanSphCursor;
    this._stickmanTorsoCursor = 0;
    this._stickmanArmCursor   = 0;
    this._stickmanLegCursor   = 0;
    this._stickmanSphCursor   = 0;
    this._addStickman(state.p1, COLOR_TEXT, tick, p1Celebrating);
    this._addStickman(state.p2, COLOR_TEXT, tick, p2Celebrating);
    for (let i = this._stickmanTorsoCursor; i < prevTorsoCursor; i++) {
      this._stickmanTorsoOutline[i].visible = false;
      this._stickmanTorsoFill[i].visible = false;
      this._stickmanTorsoDisc[i].visible = false;
    }
    for (let i = this._stickmanArmCursor; i < prevArmCursor; i++) {
      this._stickmanArm[i].visible = false;
    }
    for (let i = this._stickmanLegCursor; i < prevLegCursor; i++) {
      this._stickmanLeg[i].visible = false;
    }
    for (let i = this._stickmanSphCursor; i < prevSphCursor; i++) {
      this._stickmanSph[i].visible = false;
    }

    // Ball — real 3D sphere in world space. Altitude comes straight
    // from physics ball.z; gravity, bounce, and all collisions live
    // in physics.js and are unaffected by the visual change.
    const ballAltitude = state.ball.z || 0;
    this._ballMesh.position.set(
      state.ball.x,
      ballAltitude + BALL_VISUAL_RADIUS,
      state.ball.y * Z_STRETCH,
    );
    this._ballMesh.scale.set(BALL_VISUAL_RADIUS, BALL_VISUAL_RADIUS, BALL_VISUAL_RADIUS);
    // Ball rotation: rolling-without-slipping angular velocity from
    // linear velocity. For a ball on the ground moving with velocity
    // v, the no-slip condition gives ω = (v_z / R, 0, -v_x / R)
    // where world_z is field-depth (physics y scaled by Z_STRETCH)
    // and world_x is physics x. In the air the same formula is used
    // so the ball keeps spinning visibly — physically it's wrong but
    // reads as motion. Integrated per frame (dt = 1 tick).
    const R = BALL_VISUAL_RADIUS;
    const omegaX = (state.ball.vy * Z_STRETCH) / R;
    const omegaZ = -state.ball.vx / R;
    const omegaMag = Math.sqrt(omegaX * omegaX + omegaZ * omegaZ);
    if (omegaMag > 1e-5) {
      this._ballSpinAxis.set(omegaX / omegaMag, 0, omegaZ / omegaMag);
      this._ballSpinQuat.setFromAxisAngle(this._ballSpinAxis, omegaMag);
      this._ballMesh.quaternion.premultiply(this._ballSpinQuat);
    }

    // Ground shadows — stamped on the xz-plane, sized per-entity.
    // Ball shadow is anchored to the ball's x/y (physics plane) so it
    // stays put on the ground as the sphere rises on ball.z; radius
    // grows slightly and alpha fades with altitude, reading as height.
    const SHADOW_Y = 0.2;   // tiny offset above ground to avoid z-fight
    this._p1Shadow.position.set(state.p1.x + 9, SHADOW_Y, state.p1.y * Z_STRETCH);
    this._p1Shadow.scale.set(PLAYER_SHADOW_RADIUS * 2, PLAYER_SHADOW_RADIUS * 2, 1);
    this._p2Shadow.position.set(state.p2.x + 9, SHADOW_Y, state.p2.y * Z_STRETCH);
    this._p2Shadow.scale.set(PLAYER_SHADOW_RADIUS * 2, PLAYER_SHADOW_RADIUS * 2, 1);
    const airH = Math.max(0, state.ball.z || 0);
    const ballShadowR = BALL_VISUAL_RADIUS * (1 + airH * 0.04);
    const ballShadowA = SHADOW_ALPHA_BASE / (1 + airH * 0.06);
    this._ballShadow.position.set(state.ball.x, SHADOW_Y, state.ball.y * Z_STRETCH);
    this._ballShadow.scale.set(ballShadowR * 2, ballShadowR * 2, 1);
    this._ballShadow._uAlpha.value = ballShadowA;

    // Consume per-frame physics events. `state.events` is cleared at
    // the top of each tick, so anything here is brand-new this frame.
    if (state.events) {
      for (let i = 0; i < state.events.length; i++) {
        const ev = state.events[i];
        if (ev.type === 'ball_bounce') this._spawnBounceParticles(ev);
        else if (ev.type === 'goal') this._spawnGoalBurst(ev.scorer);
      }
    }
    this._stepParticles();
    this._drawParticles();

    if (this._followCam && this._followCam.active) this._stepFollowCam(state);
    else if (this._debugCam && this._debugCam.active) this._stepDebugCam();
    this.renderer.render(this.scene, this.camera);
  }

  /* ── Camera ─────────────────────────────────────────────── */

  _placeCamera() {
    // When debug-cam OR follow-cam is active, resize() still updates
    // `camera.aspect` but we leave the pose alone — the active cam
    // step function owns position/lookAt.
    if (this._debugCam && this._debugCam.active) return;
    if (this._followCam && this._followCam.active) return;
    const midX = this.fieldWidth / 2;
    const midZ = (FIELD_HEIGHT * Z_STRETCH) / 2;

    const { height, backOff } = this._computeDistance(1.0);
    this.camera.position.set(midX, height, midZ + backOff);
    this.camera.lookAt(midX, 0, midZ);
    this.camera.updateProjectionMatrix();
  }

  /** Force a fixed close-up camera pose: look at (targetX, targetY,
   *  targetZ) from `distance` world units away, tilted down by
   *  `pitchDeg` (degrees above horizontal, 0 = dead-level, 90 =
   *  straight down) and rotated around the vertical axis by
   *  `yawDeg` (0 = directly behind target in +z, positive rotates
   *  to the right). Used by the renderer diagnostic page to frame
   *  individual stickmen at full size without running the full
   *  follow-cam spring. Flips the debug cam's `active` flag so the
   *  default autoResize placement leaves this pose alone. */
  setCameraFocus(targetX, targetY, targetZ, distance, pitchDeg = 35, yawDeg = 0) {
    if (!this._debugCam) return;
    const dc = this._debugCam;
    dc.active = true;
    dc.target.set(targetX, targetY, targetZ);
    dc.distance = distance;
    dc.yaw = (yawDeg * Math.PI) / 180;
    dc.pitch = (pitchDeg * Math.PI) / 180;
    dc.keys.clear();
    dc.dragging = false;
  }

  /** Compute the camera height / back-offset for a zoom multiplier
   *  `zoom` (1.0 = default showcase fit). Smaller zoom = closer. */
  _computeDistance(zoom) {
    const aspect = this.camera.aspect || 4;
    const halfFovVert = (CAMERA_FOV / 2) * Math.PI / 180;
    const tanHalfHoriz = Math.tan(halfFovVert) * aspect;
    const halfFieldWidth = (this.fieldWidth / 2) * HORIZONTAL_MARGIN;
    const distance = (halfFieldWidth / tanHalfHoriz) * zoom;
    const tiltRad = CAMERA_TILT_DEG * Math.PI / 180;
    return {
      distance,
      height: distance * Math.cos(tiltRad),
      backOff: distance * Math.sin(tiltRad),
    };
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
    this._debugKeydown = (e) => {
      const dc = this._debugCam;
      if (!dc.active || isTypingTarget()) return;
      const k = e.key.toLowerCase();
      if ('wasdqer'.includes(k)) dc.keys.add(k);
    };
    this._debugKeyup = (e) => {
      this._debugCam.keys.delete(e.key.toLowerCase());
    };
    window.addEventListener('keydown', this._debugKeydown);
    window.addEventListener('keyup', this._debugKeyup);
  }

  setDebugCam(on) {
    const dc = this._debugCam;
    if (!dc || dc.active === !!on) return;
    if (on && this._followCam && this._followCam.active) {
      this.setFollowCam(false);
    }
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

  /* ── Follow camera (runtime-toggleable) ─────────────────────
   * Slides along a horizontal x-rail at a fixed height + z-offset,
   * smoothly tracking a weighted action center (ball + both players
   * with ball weighted 2x). Uses a critically-damped spring so fast
   * ball movement never snaps the camera — it accelerates and
   * decelerates. LookAt lags independently and is biased by a
   * signed lead offset (based on which half of the field the ball
   * is in) so the action sits around the 1/3 line of the screen
   * with the goal side showing more space. Zoom is tighter than
   * the showcase view so both players + ball fill the frame. */
  _initFollowCam() {
    this._followCam = {
      active: false,
      initialized: false,
      posX: 0,     velX: 0,  // rail position
      lookX: 0,    lookVX: 0, // lookAt target x
      leadX: 0,    leadVX: 0, // smoothed lead offset (sign = ball's half)
      zoom: FOLLOW_ZOOM_LIVE, zoomV: 0, // smoothed zoom (dead-ball widens)
    };
  }

  setFollowCam(on) {
    const fc = this._followCam;
    if (!fc || fc.active === !!on) return;
    if (on && this._debugCam && this._debugCam.active) {
      this.setDebugCam(false);
    }
    fc.active = !!on;
    if (!fc.active) {
      this._placeCamera(); // restore showcase pose
    } else {
      fc.initialized = false; // snap to first target on next step
    }
  }

  isFollowCamActive() {
    return !!(this._followCam && this._followCam.active);
  }

  _stepFollowCam(state) {
    const fc = this._followCam;
    const ballX = state.ball.x;
    const p1X = state.p1.x;
    const p2X = state.p2.x;
    // Weighted action center — ball gets 2x weight so the camera
    // follows it more tightly than the players' midpoint.
    const actionX = (ballX * 2 + p1X + p2X) / 4;
    // Lead sign: +1 when ball is past mid-field on the right half,
    // -1 on the left half. Magnitude scales with camera distance so
    // the visible screen fraction is stable regardless of zoom.
    const midX = this.fieldWidth / 2;
    const ballSide = ballX > midX ? 1 : (ballX < midX ? -1 : 0);

    // Dead-ball detection: celebrate / matchend / reposition / waiting
    // pauses, plus the OOB respawn grace window, plus the terminal
    // matchOver flag. During any of these the zoom widens smoothly
    // toward FOLLOW_ZOOM_DEAD AND the rail/lookAt springs are retargeted
    // to the centered showcase pose. When play resumes, everything
    // springs back to the live action target.
    const deadBall = state.matchOver
      || state.pauseState !== null
      || (state.graceFrames | 0) > 0;
    const zoomTarget   = deadBall ? FOLLOW_ZOOM_DEAD : FOLLOW_ZOOM_LIVE;
    const posTarget    = deadBall ? midX : actionX;
    const lookTarget   = deadBall ? midX : actionX;
    const sideForLead  = deadBall ? 0 : ballSide;

    // Critically-damped spring coefficients (per frame @ 60Hz).
    // stiffness k → response time; c = 2*sqrt(k) for critical
    // damping, which prevents overshoot and gives a smooth
    // accel/decel curve across direction flips.
    const K_POS  = 0.012;
    const C_POS  = 2 * Math.sqrt(K_POS);
    const K_LOOK = 0.020;
    const C_LOOK = 2 * Math.sqrt(K_LOOK);
    const K_LEAD = 0.008;
    const C_LEAD = 2 * Math.sqrt(K_LEAD);
    // Zoom transitions slower than position — about 1.5–2s to fully
    // widen on a goal, then the same to tighten back when play resumes.
    const K_ZOOM = 0.004;
    const C_ZOOM = 2 * Math.sqrt(K_ZOOM);

    if (!fc.initialized) {
      fc.posX = posTarget;
      fc.velX = 0;
      fc.lookX = lookTarget;
      fc.lookVX = 0;
      // Snap-start the zoom & lead from the current target so the
      // first frame doesn't pop.
      fc.zoom = zoomTarget;
      fc.zoomV = 0;
      const { distance: d0 } = this._computeDistance(fc.zoom);
      fc.leadX = sideForLead * d0 * 0.22;
      fc.leadVX = 0;
      fc.initialized = true;
    }

    // Spring integration — accel toward target, friction proportional
    // to velocity, damping ratio = 1 (critically damped).
    const stepSpring = (pos, vel, target, k, c) => {
      const accel = (target - pos) * k - vel * c;
      const newVel = vel + accel;
      return [pos + newVel, newVel];
    };
    [fc.zoom, fc.zoomV] = stepSpring(fc.zoom, fc.zoomV, zoomTarget, K_ZOOM, C_ZOOM);

    // Compute distance from the *smoothed* zoom so the whole view
    // (position, lead magnitude) pans out together.
    const { distance, height, backOff } = this._computeDistance(fc.zoom);
    const LEAD_FRACTION = 0.22;
    const leadTarget = sideForLead * distance * LEAD_FRACTION;

    [fc.posX,  fc.velX]  = stepSpring(fc.posX,  fc.velX,  posTarget,  K_POS,  C_POS);
    [fc.lookX, fc.lookVX] = stepSpring(fc.lookX, fc.lookVX, lookTarget, K_LOOK, C_LOOK);
    [fc.leadX, fc.leadVX] = stepSpring(fc.leadX, fc.leadVX, leadTarget, K_LEAD, C_LEAD);

    const midZ = (FIELD_HEIGHT * Z_STRETCH) / 2;
    this.camera.position.set(fc.posX, height, midZ + backOff);
    this.camera.lookAt(fc.lookX + fc.leadX, 0, midZ);
    this.camera.updateProjectionMatrix();
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

    const mouthCenterZ = ((f.goalMouthYMin + f.goalMouthYMax) / 2) * Z_STRETCH;
    const mouthHalfZ   = ((f.goalMouthYMax - f.goalMouthYMin) / 2) * Z_STRETCH;

    // Penalty area (18-yard box) — closed rectangle on the ground in
    // front of each goal, with the back edge along the goal line.
    // 6-yard goal area nested inside. Both are drawn as LineLoop so
    // all four sides render (the old open Line left the back edge
    // floating). Sizes are tuned so the penalty box fits inside the
    // touchlines of this (much wider-than-real) mouth/field
    // proportion.
    const penaltyHalfY  = mouthHalfZ * 1.35;
    const penaltyDepth  = mouthHalfZ * 1.55;
    const goalAreaHalfY = mouthHalfZ * 1.12;
    const goalAreaDepth = mouthHalfZ * 0.55;
    const drawBox = (lineX, inward) => {
      const penaltyInX = lineX + inward * penaltyDepth;
      const goalAreaX  = lineX + inward * goalAreaDepth;
      const penaltyZMin = mouthCenterZ - penaltyHalfY;
      const penaltyZMax = mouthCenterZ + penaltyHalfY;
      const goalAreaZMin = mouthCenterZ - goalAreaHalfY;
      const goalAreaZMax = mouthCenterZ + goalAreaHalfY;
      const pen = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(lineX,      0, penaltyZMin),
        new THREE.Vector3(penaltyInX, 0, penaltyZMin),
        new THREE.Vector3(penaltyInX, 0, penaltyZMax),
        new THREE.Vector3(lineX,      0, penaltyZMax),
      ]);
      this._addStatic(new THREE.LineLoop(pen, mutedMat), pen);
      const ga = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(lineX,     0, goalAreaZMin),
        new THREE.Vector3(goalAreaX, 0, goalAreaZMin),
        new THREE.Vector3(goalAreaX, 0, goalAreaZMax),
        new THREE.Vector3(lineX,     0, goalAreaZMax),
      ]);
      this._addStatic(new THREE.LineLoop(ga, mutedMat), ga);
    };
    drawBox(f.goalLineL, +1);
    drawBox(f.goalLineR, -1);

    // Penalty arcs — the classic "D". A circle centered on the
    // penalty spot (inside the penalty box) with radius chosen so
    // only the forward portion of the circle peeks outside the
    // penalty box; we draw exactly that portion, the two endpoints
    // tangent to the front edge of the penalty box. This matches
    // real football AND never crosses the goal area rectangle
    // because the arc is entirely outside the penalty box.
    const spotFraction = 0.67;   // penalty spot at 67% of penaltyDepth
    const arcRadius    = penaltyDepth * 0.50;
    const dxSpotToFront = penaltyDepth * (1 - spotFraction);
    // z of the point where the arc meets the penalty box front edge:
    //   z² = arcRadius² - dxSpotToFront²
    const arcHalfChord = Math.sqrt(
      Math.max(0, arcRadius * arcRadius - dxSpotToFront * dxSpotToFront),
    );
    // Half-angle subtended from the penalty spot to an endpoint,
    // measured off the direction pointing INTO the field.
    const alpha = Math.atan2(arcHalfChord, dxSpotToFront);
    // LEFT goal: spot is +inward of goal line, arc bulges toward +x.
    //   angle 0 = +x direction = outward. Sweep [-α, +α].
    const spotLX = f.goalLineL + penaltyDepth * spotFraction;
    this._addArc(spotLX, mouthCenterZ, arcRadius, arcRadius, -alpha, alpha, 24, mutedMat);
    // RIGHT goal: spot is -inward of goal line, arc bulges toward -x.
    //   angle π = -x direction. Sweep [π-α, π+α].
    const spotRX = f.goalLineR - penaltyDepth * spotFraction;
    this._addArc(spotRX, mouthCenterZ, arcRadius, arcRadius, Math.PI - alpha, Math.PI + alpha, 24, mutedMat);

    // Penalty spot marks — tiny circles at each penalty spot.
    const spotR = mouthHalfZ * 0.04;
    this._addArc(spotLX, mouthCenterZ, spotR, spotR, 0, TWO_PI, 10, mutedMat);
    this._addArc(spotRX, mouthCenterZ, spotR, spotR, 0, TWO_PI, 10, mutedMat);

    // Corner arcs — tiny quarter-circles at the 4 touchline corners,
    // sweeping into the field. _addArc uses (x,z) ellipse parameters
    // with angle 0 = +x, π/2 = +z. For each corner we pick the 90°
    // sweep that goes "inward" toward the field.
    const cornerR = mouthHalfZ * 0.12;
    this._addArc(0, zFar,  cornerR, cornerR, 0,                Math.PI / 2,     12, mutedMat);
    this._addArc(w, zFar,  cornerR, cornerR, Math.PI / 2,      Math.PI,         12, mutedMat);
    this._addArc(w, zNear, cornerR, cornerR, Math.PI,          3 * Math.PI / 2, 12, mutedMat);
    this._addArc(0, zNear, cornerR, cornerR, 3 * Math.PI / 2,  TWO_PI,          12, mutedMat);

    const goalWidth = (f.goalMouthYMax - f.goalMouthYMin) * Z_STRETCH;
    const goalHeight = f.goalMouthZMax * 2.25;
    const goalCenterZ = ((f.goalMouthYMin + f.goalMouthYMax) / 2) * Z_STRETCH;

    // Visible mouth = physics scoring line (f.goalLineL/R). Back of
    // the goal box = outer field edge (f.goalLLeft / f.goalRRight).
    // _addGoal builds a trapezoidal side profile between them:
    // horizontal roof behind the crossbar, slanted back net down to
    // the outer ground.
    this._addGoal(f.goalLineL, f.goalLLeft,  goalCenterZ, goalWidth, goalHeight, lineMat, netMat, goalLineMat);
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

  _addGoal(mouthX, backBotX, centerZ, width, height, mat, netMat, goalLineMat) {
    const halfW = width / 2;
    // Classical trapezoidal soccer-goal side profile (x-axis):
    //
    //             ______________ roof (horizontal)
    //            |              \
    //            |               \   <- slanted back net
    //            |                \
    //            |_________________\
    //          mouthX             backBotX
    //          (front)             (ground)
    //
    // Depth = |backBotX - mouthX|. The horizontal roof covers the first
    // ~35% of the depth from the mouth; the slanted back net covers the
    // remaining ~65%. The front mouth is a rectangle (vertical posts +
    // crossbar). Caller decides orientation via the x-value pair —
    // mouthX > backBotX for the LEFT goal, the reverse for the RIGHT.
    const ROOF_FRACTION = 0.35;
    const backTopX = mouthX + (backBotX - mouthX) * ROOF_FRACTION;
    const zMin = centerZ - halfW;
    const zMax = centerZ + halfW;
    const P = (x, y, z) => new THREE.Vector3(x, y, z);

    // Goal frame bars — thin cylinders so they read as solid metal poles.
    const barMat = new THREE.MeshBasicMaterial({
      color: mat.color, transparent: true, opacity: mat.opacity ?? 1,
    });
    this._staticMaterials.push(barMat);
    // Front mouth — two vertical posts + crossbar at the goal line.
    this._addBar(P(mouthX, 0,      zMin), P(mouthX, height, zMin), barMat);
    this._addBar(P(mouthX, 0,      zMax), P(mouthX, height, zMax), barMat);
    this._addBar(P(mouthX, height, zMin), P(mouthX, height, zMax), barMat);
    // Roof rails running back from the mouth to where the back slope starts.
    this._addBar(P(mouthX,   height, zMin), P(backTopX, height, zMin), barMat);
    this._addBar(P(mouthX,   height, zMax), P(backTopX, height, zMax), barMat);
    this._addBar(P(backTopX, height, zMin), P(backTopX, height, zMax), barMat);
    // Slanted back rails from the roof-back down to the outer ground.
    this._addBar(P(backTopX, height, zMin), P(backBotX, 0, zMin), barMat);
    this._addBar(P(backTopX, height, zMax), P(backBotX, 0, zMax), barMat);
    // Ground rails closing the floor quad.
    this._addBar(P(backBotX, 0, zMin), P(backBotX, 0, zMax), barMat);
    this._addBar(P(backBotX, 0, zMin), P(mouthX,   0, zMin), barMat);
    this._addBar(P(backBotX, 0, zMax), P(mouthX,   0, zMax), barMat);

    // Net grid on the 4 closed faces: roof, slanted back, and two
    // trapezoidal sides. Front mouth stays open. pushNet does a bilinear
    // grid between 4 corners — nU lines along A→B / D→C and nV lines
    // along A→D / B→C.
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
    // Roof — horizontal rectangle at y = height between mouthX and backTopX.
    pushNet(
      P(mouthX,   height, zMin), P(backTopX, height, zMin),
      P(backTopX, height, zMax), P(mouthX,   height, zMax),
      8, 12,
    );
    // Slanted back net — rectangle from (backTopX, height) down to
    // (backBotX, 0), spanning full z.
    pushNet(
      P(backTopX, height, zMin), P(backBotX, 0,      zMin),
      P(backBotX, 0,      zMax), P(backTopX, height, zMax),
      10, 12,
    );
    // Side trapezoid zMin — 4 corners: mouth-bot, back-bot, back-top, mouth-top.
    pushNet(
      P(mouthX,   0,      zMin), P(backBotX, 0,      zMin),
      P(backTopX, height, zMin), P(mouthX,   height, zMin),
      10, 8,
    );
    // Side trapezoid zMax — mirror of zMin at zMax.
    pushNet(
      P(mouthX,   0,      zMax), P(backBotX, 0,      zMax),
      P(backTopX, height, zMax), P(mouthX,   height, zMax),
      10, 8,
    );

    const netGeom = new THREE.BufferGeometry().setFromPoints(netPoints);
    this._addStatic(new THREE.LineSegments(netGeom, netMat), netGeom);

    // Dashed goal line along the mouth ground edge (z-axis at mouthX).
    const dashCount = 8;
    const dashRatio = 0.4;
    const goalLinePoints = [];
    for (let i = 0; i < dashCount; i++) {
      const t0 = i / dashCount;
      const t1 = t0 + dashRatio / dashCount;
      goalLinePoints.push(
        P(mouthX, 0, zMin + (zMax - zMin) * t0),
        P(mouthX, 0, zMin + (zMax - zMin) * t1),
      );
    }
    const goalLineGeom = new THREE.BufferGeometry().setFromPoints(goalLinePoints);
    this._addStatic(new THREE.LineSegments(goalLineGeom, goalLineMat), goalLineGeom);
  }

  /* ── Stickman ────────────────────────────────────────────
   *
   * 3D pipe figure: torso + two arms + two legs as thin cylinders,
   * head + fists as spheres, all positioned in world space. The
   * animation pipeline is identical to the previous billboard
   * version — walk/push/celebrate/tilt/amplitude/phase are all
   * smoothed the same way — only the render primitive changed.
   *
   * Local frame for each stickman:
   *   +x = forward (toward opposing goal; facing = +1 for left
   *        team, -1 for right)
   *   +y = up
   *   +z = lateral right of the body
   *
   * Limbs swing in the (forward, up) plane: angle 0 hangs straight
   * down, angle π/2 points forward, angle π points straight up
   * (celebration). World positions are produced by scaling local.x
   * by `facing` and adding the player's world base (x, 0, z).
   */
  _addStickman(player, color, tick, isCelebrating) {
    // Player world position — x along the field, z across the depth.
    // Both are mutable because push-hop shifts the whole figure in
    // the heading direction (which has both x and z components).
    let baseX = player.x + 9;
    let baseZ = player.y * Z_STRETCH;
    const s = STICKMAN_GLYPH_SIZE;

    // Heading = physics-space angle (0 = +x). Forward unit vector
    // lives in world xz, perpendicular lateral vector is the left-
    // hand rotation of forward. All shoulder / hip / limb / tilt
    // offsets are built on this local frame.
    const heading = player.heading ?? 0;
    const forwardX = Math.cos(heading);
    const forwardZ = Math.sin(heading);
    const lateralX = -forwardZ;
    const lateralZ =  forwardX;

    // Fetch / init smoothed state for this player (same as before).
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

    const targetAmplitude = Math.min(speed * 0.2, 1.0);
    // Walk tilt — sign from the component of motion along the
    // player's current heading, so "moving forward" leans in,
    // "moving backward" leans the opposite way. Heading-frame
    // decomposition uses the same Z_STRETCH as the physics-side
    // target heading so motion direction and facing stay consistent.
    const effVworldZ = effVy * Z_STRETCH;
    const forwardSpeed = effVx * forwardX + effVworldZ * forwardZ;
    const targetTilt = speed > STICKMAN_RUN_THRESHOLD
      ? Math.sign(forwardSpeed) * Math.min(
          (speed - STICKMAN_RUN_THRESHOLD) * STICKMAN_TILT_PER_SPEED,
          STICKMAN_TILT_MAX,
        )
      : 0;
    const swingRate = 0.2 + speed * 0.04;

    const targetCelebrate = isCelebrating ? 1 : 0;
    const targetPushing   = player.pushTimer > 0 ? 1 : 0;

    if (player.pushTimer > 0) {
      if (anim.prevPushTimer <= 0) anim.pushProgress = 0;
      anim.pushProgress += dt;
    } else {
      anim.pushProgress = 0;
    }
    anim.prevPushTimer = player.pushTimer;

    // Kick animation reads physics state directly — no smoothing, no
    // local timer. `player.kick` is the authoritative source for
    // active/phase/timer, and `player.airZ` is the airborne lift
    // already computed by the physics tick for the airkick phase.
    const kick = player.kick;
    const isKicking = !!(kick && kick.active);
    const isAirkick = isKicking && kick.phase === 'airkick';
    const airLift   = player.airZ || 0;

    anim.tilt      += (targetTilt      - anim.tilt)      * STICKMAN_SMOOTH;
    anim.amplitude += (targetAmplitude - anim.amplitude) * STICKMAN_SMOOTH;
    anim.celebrate += (targetCelebrate - anim.celebrate) * STICKMAN_SMOOTH;
    anim.pushing = targetPushing;
    anim.phase          = (anim.phase          + swingRate       * dt) % TWO_PI;
    anim.celebratePhase = (anim.celebratePhase + CELEB_PHASE_RATE * dt) % TWO_PI;

    const amplitude = anim.amplitude;
    const celeb     = anim.celebrate;
    const celebInv  = 1 - celeb;
    const pushing   = anim.pushing;
    const swing     = Math.sin(anim.phase);

    const jumpY = Math.max(0, Math.sin(anim.celebratePhase)) * CELEB_JUMP_PEAK * celeb;
    const bob = Math.abs(swing) * 0.08 * amplitude * celebInv;

    // Push scripted state — in the local (forward, up) frame. The
    // forward transform (forwardX, forwardZ) applies when mixing
    // into world space.
    let pushArmAngle   = 0;
    let pushBodyDip    = 0;
    let pushFistScale  = 1;
    let pushTiltOffset = 0;
    let strikeActive   = false;
    if (pushing > 0) {
      const pushT = Math.min(anim.pushProgress / PUSH_TOTAL_TICKS, 1);
      pushArmAngle   =  pushArmAngleAt(pushT);
      pushBodyDip    =  pushBodyDipAt(pushT);
      pushFistScale  =  pushFistScaleAt(pushT);
      pushTiltOffset =  pushBodyTiltAt(pushT);
      const hop       =  pushHopAt(pushT);
      baseX          +=  forwardX * hop;
      baseZ          +=  forwardZ * hop;
      strikeActive   =  pushT >= PUSH_WINDUP_T && pushT <= PUSH_LOWER_T;
    }

    // Kick scripted state — the kicking leg (right leg by convention)
    // and the contralateral arm (left arm) drive the swing, with a
    // body dip + tilt to sell the weight transfer.
    let kickLegAngle   = 0;
    let kickArmAngle   = 0;
    let kickBodyDip    = 0;
    let kickTiltOffset = 0;
    if (isKicking) {
      const totalMs = isAirkick ? AIRKICK_MS : KICK_DURATION_MS;
      const kickT   = Math.min(kick.timer / totalMs, 1);
      if (isAirkick) {
        kickLegAngle   = airkickLegAngleAt(kickT);
        kickTiltOffset = airkickTiltAt(kickT);
      } else {
        kickLegAngle   = kickLegAngleAt(kickT);
        kickTiltOffset = kickTiltAt(kickT);
      }
      kickArmAngle = kickArmAngleAt(kickT);
      kickBodyDip  = kickDipAt(kickT);
    }

    const walkTilt  = anim.tilt;
    const upperTilt = walkTilt + pushTiltOffset + kickTiltOffset;
    const tiltC = Math.cos(upperTilt);
    const tiltS = Math.sin(upperTilt);

    // Feet-on-ground clearance — straight legs land on y=0. airLift
    // raises the whole figure during the airkick leap (legs trail
    // the body upward because hipBaseY lifts with the rest).
    const hipBaseY  = STICKMAN_LIMB_FULL_H + bob * s + jumpY + airLift;
    const upperHipY = hipBaseY + pushBodyDip + kickBodyDip;

    // Neck (top of torso) is one torso-length above the hip, rotated
    // forward by upperTilt in the (forward, up) plane. "Forward" is
    // the heading-space xz vector (forwardX, forwardZ).
    const torsoH      = STICKMAN_SHOULDER_OFY;
    const neckFwdOfs  = torsoH * tiltS;
    const neckX       = baseX + forwardX * neckFwdOfs;
    const neckZ       = baseZ + forwardZ * neckFwdOfs;
    const neckY       = upperHipY + torsoH * tiltC;

    // Shoulders: lateral to neck along (lateralX, lateralZ).
    const shoulderHalfWidth = STICKMAN_SHOULDER_OFX;
    const lShX = neckX - lateralX * shoulderHalfWidth;
    const lShZ = neckZ - lateralZ * shoulderHalfWidth;
    const rShX = neckX + lateralX * shoulderHalfWidth;
    const rShZ = neckZ + lateralZ * shoulderHalfWidth;

    // Torso: capsule from hip center to neck (both move with baseX/Z).
    this._placeTorso(baseX, upperHipY, baseZ, neckX, neckY, neckZ, color, player.stamina);

    // Head: sphere a fixed gap above the neck, following the tilt so
    // it stays anchored to the torso top.
    const headGap     = STICKMAN_HEAD_GAP_Y;
    const headFwdOfs  = headGap * tiltS;
    const headCenterX = neckX + forwardX * headFwdOfs;
    const headCenterZ = neckZ + forwardZ * headFwdOfs;
    const headCenterY = neckY + headGap * tiltC + STICKMAN_HEAD_RADIUS;
    this._placeSph(headCenterX, headCenterY, headCenterZ, STICKMAN_HEAD_RADIUS, color);

    // Hips: lateral to hip center along the same lateral vector.
    const hipHalfWidth = STICKMAN_HIP_OFX;
    const lHipX = baseX - lateralX * hipHalfWidth;
    const lHipZ = baseZ - lateralZ * hipHalfWidth;
    const rHipX = baseX + lateralX * hipHalfWidth;
    const rHipZ = baseZ + lateralZ * hipHalfWidth;

    // Limb angles — contralateral walk swing + celebration override
    // (arms sweep to π = straight up, legs spread forward-back) +
    // push override (both arms scripted to the punch curve).
    const armSwing = swing * 0.85 * amplitude;
    const legSwing = -swing * 0.7  * amplitude;
    let leftArmAngle  =  armSwing;
    let rightArmAngle = -armSwing;
    let leftLegAngle  =  legSwing;
    let rightLegAngle = -legSwing;

    if (celeb > 0.001) {
      const legSpread = Math.max(0, Math.sin(anim.celebratePhase)) * CELEB_LEG_SPREAD;
      leftArmAngle  = leftArmAngle  * celebInv +  Math.PI   * celeb;
      rightArmAngle = rightArmAngle * celebInv + -Math.PI   * celeb;
      leftLegAngle  = leftLegAngle  * celebInv + -legSpread * celeb;
      rightLegAngle = rightLegAngle * celebInv +  legSpread * celeb;
    }

    if (pushing > 0) {
      leftArmAngle  = pushArmAngle;
      rightArmAngle = pushArmAngle;
    }

    // Kick takes precedence over walk swing (but not push — physics
    // guarantees the two never overlap). The right leg is the kicking
    // leg; the left arm counter-swings forward; the right arm pulls
    // slightly back. Celebration still overrides everything.
    if (isKicking && celeb < 0.001) {
      rightLegAngle = kickLegAngle;
      leftArmAngle  = kickArmAngle;
      rightArmAngle = -kickArmAngle * KICK_ARM_OPP_FRAC;
    }

    // Draw the four limbs — each is a fixed-length capsule pivoted
    // at its joint and rotated by the swing angle in the (forward,
    // up) plane. The forward unit vector is the heading-based
    // (forwardX, forwardZ), so at angle=0 the limb hangs straight
    // down and at angle=π/2 it points along +forward.
    const shoulderY = upperHipY + torsoH * tiltC;
    this._placeArm(lShX, shoulderY, lShZ, leftArmAngle,  forwardX, forwardZ, color);
    this._placeArm(rShX, shoulderY, rShZ, rightArmAngle, forwardX, forwardZ, color);
    this._placeLeg(lHipX, hipBaseY, lHipZ, leftLegAngle,  forwardX, forwardZ, color);
    this._placeLeg(rHipX, hipBaseY, rHipZ, rightLegAngle, forwardX, forwardZ, color);

    // Push fists — spheres at the end of each extended arm during the
    // strike window. Size pulses larger at strike peak via pushFistScale.
    if (strikeActive && pushing > 0) {
      const fistR = STICKMAN_FIST_RADIUS * pushFistScale;
      const L = STICKMAN_LIMB_FULL_H;
      const lSin = Math.sin(leftArmAngle);
      const lCos = Math.cos(leftArmAngle);
      const rSin = Math.sin(rightArmAngle);
      const rCos = Math.cos(rightArmAngle);
      this._placeSph(
        lShX + forwardX * L * lSin, shoulderY - L * lCos, lShZ + forwardZ * L * lSin,
        fistR, color,
      );
      this._placeSph(
        rShX + forwardX * L * rSin, shoulderY - L * rCos, rShZ + forwardZ * L * rSin,
        fistR, color,
      );
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

  /** Pull a torso capsule triple (outline + fill + disc) from the
   *  pool, orient the outline+fill between hip and neck, update the
   *  fill mesh's clipping plane so the solid fill covers the bottom
   *  `staminaFrac` of the torso, and size the cut disc so it never
   *  pokes out of the capsule's hemispherical caps. The outline stays
   *  in the monochrome body color; the fill + disc are tinted with a
   *  red→amber→green gradient driven by `staminaFrac`. */
  _placeTorso(ax, ay, az, bx, by, bz, color, staminaFrac) {
    const idx = this._stickmanTorsoCursor;
    if (idx >= this._stickmanTorsoOutline.length) return;
    this._stickmanTorsoCursor++;
    const outline = this._stickmanTorsoOutline[idx];
    const fill    = this._stickmanTorsoFill[idx];
    const plane   = this._stickmanTorsoFillPlanes[idx];

    const tint = staminaColorInto(this._staminaColorBuf, staminaFrac);
    this._orientBetween(outline, ax, ay, az, bx, by, bz, color);
    this._orientBetween(fill,    ax, ay, az, bx, by, bz, tint);
    // The fill capsule is inset by the shell thickness on both caps,
    // so its y-extent is shorter than the hip→neck distance. Clip the
    // stamina range over the fill's actual range, not the outline's,
    // so stamina=0 maps to the fill's bottom and stamina=1 maps to
    // its top.
    const hipY  = ay < by ? ay : by;
    const neckY = ay < by ? by : ay;
    const insetHipY  = hipY  + STICKMAN_TORSO_SHELL_THICKNESS;
    const insetNeckY = neckY - STICKMAN_TORSO_SHELL_THICKNESS;
    const fillWorldY = updateStaminaClipPlane(plane, insetHipY, insetNeckY, staminaFrac);

    const disc = this._stickmanTorsoDisc[idx];
    const midY = (ay + by) * 0.5;
    const discR = staminaDiscRadius(
      fillWorldY - midY,
      this._fillBodyHalf,
      this._fillCapRadius,
    );
    if (discR > 0) {
      disc.visible = true;
      disc.position.set((ax + bx) * 0.5, fillWorldY, (az + bz) * 0.5);
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

  _placeArm(px, py, pz, angle, forwardX, forwardZ, color) {
    this._placeLimbFromPool(this._stickmanArm, '_stickmanArmCursor', px, py, pz, angle, forwardX, forwardZ, color);
  }

  _placeLeg(px, py, pz, angle, forwardX, forwardZ, color) {
    this._placeLimbFromPool(this._stickmanLeg, '_stickmanLegCursor', px, py, pz, angle, forwardX, forwardZ, color);
  }

  /** Pull a sphere from the pool and place it at a world point with
   *  the given radius and color. */
  _placeSph(cx, cy, cz, radius, color) {
    if (this._stickmanSphCursor >= this._stickmanSph.length) return;
    const mesh = this._stickmanSph[this._stickmanSphCursor++];
    mesh.visible = true;
    mesh.position.set(cx, cy, cz);
    mesh.scale.set(radius, radius, radius);
    mesh.material.color.setRGB(color[0], color[1], color[2]);
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

  /** Spawn a big burst of particles when a goal is scored. Spawns inside
   *  the scored goal's mouth across the full mouth width (y axis) and
   *  shoots outward toward the field (+x for the LEFT goal, -x for the
   *  RIGHT goal) with a strong upward lift. `scorer` is 'p1' or 'p2':
   *  p1 scored = ball into RIGHT goal; p2 scored = ball into LEFT goal. */
  _spawnGoalBurst(scorer) {
    const f = this._field;
    // scorer='p1' scored means ball went into the RIGHT goal, so the
    // burst origin is f.goalLineR and it fans toward -x (into field).
    // scorer='p2' means LEFT goal, fans toward +x.
    const isRight = scorer === 'p1';
    const mouthX = isRight ? f.goalLineR : f.goalLineL;
    const outSign = isRight ? -1 : 1;
    const mouthYMin = f.goalMouthYMin;
    const mouthYMax = f.goalMouthYMax;
    const mouthYSpan = mouthYMax - mouthYMin;
    const mouthZMax = f.goalMouthZMax || 26;

    for (let i = 0; i < GOAL_BURST_COUNT; i++) {
      const p = this._particles[this._particleNext];
      this._particleNext = (this._particleNext + 1) % this._particles.length;

      // Spawn across the full mouth opening so the burst looks like it
      // comes out of the goal, not a single point.
      p.x = mouthX;
      p.y = mouthYMin + Math.random() * mouthYSpan;
      p.z = Math.random() * mouthZMax * 0.8;

      // Outward velocity (into the field) plus side spread and upward
      // lift. Random magnitude so the burst isn't a uniform shell.
      const r1 = Math.random();
      const r2 = (Math.random() - 0.5) * 2;
      const r3 = Math.random();
      p.vx = outSign * GOAL_BURST_SPEED * (0.6 + r1 * 0.8);
      p.vy = r2 * GOAL_BURST_SPEED * 0.5;
      p.vz = GOAL_BURST_LIFT * (0.7 + r3 * 0.6);

      p.maxLife = GOAL_BURST_LIFE_BASE + Math.floor(Math.random() * GOAL_BURST_LIFE_VAR);
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

  /** Write live particles into the InstancedMesh. Position maps
   *  physics (x, y, z) → world (x, z, y*Z_STRETCH); per-instance
   *  color fades the rgb channels from full to black as the
   *  particle ages. Size shrinks slightly with age too. Dead
   *  particles are packed to the front so .count skips the tail. */
  _drawParticles() {
    const q = this._scratchZeroQ;
    const pos = this._scratchPos;
    const scl = this._scratchScaleVec;
    const mat = this._scratchMat;
    const colors = this._particleColorArr;
    let n = 0;
    for (let i = 0; i < this._particles.length; i++) {
      const p = this._particles[i];
      if (p.life <= 0) continue;
      const ageFrac = p.life / p.maxLife;
      const size = PARTICLE_VISUAL_RADIUS * (0.4 + 0.6 * ageFrac);
      pos.set(p.x, Math.max(0, p.z) + size, p.y * Z_STRETCH);
      scl.set(size, size, size);
      mat.compose(pos, q, scl);
      this._particleMesh.setMatrixAt(n, mat);
      // Age fade: bright near spawn, dim toward end of life.
      const c = ageFrac;
      const idx = n * 3;
      colors[idx + 0] = c;
      colors[idx + 1] = c;
      colors[idx + 2] = c;
      n++;
    }
    this._particleMesh.count = n;
    if (n > 0) {
      this._particleMesh.instanceMatrix.needsUpdate = true;
      this._particleColorAttr.needsUpdate = true;
    }
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
 * Body lean along the player's heading as a signed "forward amount":
 * negative = lean back (windup loading), positive = lean forward
 * (strike release). Added directly to the walk-tilt term because
 * both live in the same heading-relative (forward, up) frame.
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

/* ── Kick curves ───────────────────────────────────────────── */

/**
 * Three-phase swing curve: windup eases the leg from 0 back to
 * startAngle, strike whips it through to endAngle at the physics fire
 * point, recovery eases it back to 0. Shared by ground kick and
 * airkick with different angle magnitudes / phase boundaries.
 */
function swingCurve(t, fireT, strikeEndT, startAngle, endAngle) {
  if (t < fireT) {
    const p = t / fireT;
    return startAngle * easeInOut(p);
  }
  if (t < strikeEndT) {
    const p = (t - fireT) / (strikeEndT - fireT);
    return startAngle + (endAngle - startAngle) * easeInOut(p);
  }
  const p = (t - strikeEndT) / (1 - strikeEndT);
  return endAngle * (1 - easeInOut(p));
}

function kickLegAngleAt(t) {
  return swingCurve(t, KICK_FIRE_T, KICK_STRIKE_END_T, KICK_WINDUP_ANGLE, KICK_STRIKE_ANGLE);
}

function airkickLegAngleAt(t) {
  return swingCurve(t, AIRKICK_PEAK_FRAC, AIRKICK_STRIKE_END_T, AIRKICK_WINDUP_ANGLE, AIRKICK_STRIKE_ANGLE);
}

/**
 * Counter-balance arm swing: forward during windup + strike, returns
 * to 0 during recovery. Same shape for ground and airkick — the arm
 * doesn't need airkick-specific tuning because it isn't the load-
 * bearing limb.
 */
function kickArmAngleAt(t) {
  if (t < KICK_FIRE_T) {
    const p = t / KICK_FIRE_T;
    return KICK_ARM_SWING * easeInOut(p);
  }
  if (t < KICK_STRIKE_END_T) return KICK_ARM_SWING;
  const p = (t - KICK_STRIKE_END_T) / (1 - KICK_STRIKE_END_T);
  return KICK_ARM_SWING * (1 - easeInOut(p));
}

/**
 * Body dip: crouch into the windup, spring back up on strike, settle
 * during recovery. Negative values lower the upper body.
 */
function kickDipAt(t) {
  if (t < KICK_FIRE_T) {
    const p = t / KICK_FIRE_T;
    return -KICK_CROUCH_DEPTH * easeOut(p);
  }
  if (t < KICK_STRIKE_END_T) {
    const p = (t - KICK_FIRE_T) / (KICK_STRIKE_END_T - KICK_FIRE_T);
    return -KICK_CROUCH_DEPTH * (1 - p * p);
  }
  return 0;
}

/**
 * Body tilt during ground kick: lean back during windup, flip forward
 * through strike, settle during recovery.
 */
function kickTiltAt(t) {
  if (t < KICK_FIRE_T) {
    const p = t / KICK_FIRE_T;
    return -KICK_BACK_TILT * easeOut(p);
  }
  if (t < KICK_STRIKE_END_T) {
    const p = (t - KICK_FIRE_T) / (KICK_STRIKE_END_T - KICK_FIRE_T);
    return -KICK_BACK_TILT + (KICK_BACK_TILT + KICK_FWD_TILT) * (p * p);
  }
  const p = (t - KICK_STRIKE_END_T) / (1 - KICK_STRIKE_END_T);
  return KICK_FWD_TILT * (1 - easeInOut(p));
}

/**
 * Body tilt during airkick: big back lean that holds through the
 * leap, settles as the player lands.
 */
function airkickTiltAt(t) {
  if (t < AIRKICK_PEAK_FRAC) {
    const p = t / AIRKICK_PEAK_FRAC;
    return -AIRKICK_BACK_TILT * easeOut(p);
  }
  if (t < AIRKICK_STRIKE_END_T) return -AIRKICK_BACK_TILT;
  const p = (t - AIRKICK_STRIKE_END_T) / (1 - AIRKICK_STRIKE_END_T);
  return -AIRKICK_BACK_TILT * (1 - easeInOut(p));
}

/**
 * Cross-section radius of the torso capsule at a given local-y
 * offset from its center. Returns:
 *   - `capRadius` throughout the cylindrical middle (|y| <= bodyHalf)
 *   - shrinks to 0 at the tips inside the hemispherical caps
 *   - 0 if the offset is outside the capsule entirely
 *
 * Used by `_placeTorso` to size the fill-surface disc so it never
 * pokes out of the capsule silhouette. Exported for unit tests so
 * the cap region math can be validated without instantiating a
 * Renderer.
 */
// staminaDiscRadius and updateStaminaClipPlane imported from renderer-math.js
export { staminaDiscRadius, updateStaminaClipPlane };

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

/**
 * Blend LOW → MID → HIGH as `t` goes 0 → 0.5 → 1. Writes the result
 * into `out` (length-3 [r,g,b] array) to avoid per-frame allocation.
 * `t` is clamped to [0, 1].
 */
function staminaColorInto(out, t) {
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
 * Build a procedural CanvasTexture for the soccer ball — off-white
 * base with ~12 dark circles placed at icosahedron-vertex (u, v)
 * coordinates so the pattern roughly tiles the sphere the way a
 * real football's panels do. Used for rolling-spin visibility; the
 * exact icosahedron distortion doesn't matter, only that rotation
 * is readable at a glance.
 */
function buildBallTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ececec';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#222222';
  // 12 icosahedron-ish positions in UV space: 2 poles + 5 upper ring
  // + 5 lower ring. Equirectangular mapping distorts near the poles
  // but the rolling spin stays clearly visible.
  const verts = [
    [0.50, 0.97],                    // north pole
    [0.50, 0.03],                    // south pole
    [0.05, 0.70], [0.25, 0.70], [0.45, 0.70], [0.65, 0.70], [0.85, 0.70],
    [0.15, 0.30], [0.35, 0.30], [0.55, 0.30], [0.75, 0.30], [0.95, 0.30],
  ];
  const r = 30;
  for (const [u, v] of verts) {
    const x = u * canvas.width;
    const y = (1 - v) * canvas.height;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}
