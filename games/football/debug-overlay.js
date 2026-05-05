/**
 * Football debug-collider overlay.
 *
 * Owns a pool of translucent meshes that mirror every physics
 * collider exactly — body capsule, head sphere, pair-collision disc,
 * kick reach + face cone + lateral cap, foot sphere, push range +
 * face cone, goal box / posts / crossbar, field touchlines, and
 * ground / ceiling. Every position and dimension is read live from
 * state.field and the player records each frame; constants come
 * directly from physics.js's exports. Edit a constant in physics.js
 * and the overlay reflects it on next reload — no hardcoded values.
 *
 * Lifecycle:
 *   const overlay = new DebugOverlay(scene);   // pool not allocated yet
 *   overlay.setEnabled(true);                  // pool built lazily
 *   overlay.update(state, players);            // per frame; no-op if disabled
 *   overlay.dispose();                         // remove from scene + free
 *
 * The class is fully self-contained — the only thing the renderer
 * does is forward `setEnabled` / `isEnabled` and call `update` once
 * per frame.
 */

import * as THREE from 'https://unpkg.com/three@0.164.0/build/three.module.js';
import {
  FIELD_HEIGHT,
  FOOT_LATERAL_REACH,
  FOOT_RADIUS,
  GOAL_POST_RADIUS,
  HEAD_CENTER_Z,
  HIP_BASE_Z,
  KICK_FACE_TOL,
  KICK_REACH_MAX,
  PLAYER_WIDTH,
  PUSH_FACE_TOL,
  PUSH_RANGE_X,
  PUSH_RANGE_Y,
  SHOULDER_Z,
  STICKMAN_HEAD_RADIUS,
  STICKMAN_TORSO_RADIUS,
  Z_STRETCH,
  ikFootWorld,
} from './physics.js';

// Render-order priority — overlay sits on top of the regular scene.
const OVERLAY_RENDER_ORDER = 1000;

// Translucent materials — colour + opacity per collider class.
const COLOR_BODY        = 0xff5555;   // red — torso capsule
const COLOR_HEAD        = 0xff9944;   // orange — head sphere
const COLOR_PAIR        = 0xffd866;   // yellow — pair-collision disc
const COLOR_KICK        = 0x66dd88;   // green — kick reach + face cone + lateral cap
const COLOR_FOOT        = 0xee66ff;   // magenta — foot sphere
const COLOR_PUSH        = 0x66bbff;   // blue — push range + face cone
const COLOR_GOAL_BOX    = 0xff77cc;   // pink — goal interior planes
const COLOR_GOAL_BAR    = 0xcc44dd;   // purple — posts + crossbar
const COLOR_TOUCHLINE   = 0x66eedd;   // cyan — field touchline walls
const COLOR_GROUND_SKY  = 0xcccccc;   // grey — ground + ceiling

const OPACITY_BODY      = 0.22;
const OPACITY_HEAD      = 0.22;
const OPACITY_PAIR      = 0.18;
const OPACITY_KICK_BUDGET = 0.10;     // bounding sphere (looser)
const OPACITY_KICK_CONE = 0.18;
const OPACITY_FOOT      = 0.55;
const OPACITY_PUSH_PLATE = 0.14;
const OPACITY_PUSH_CONE = 0.22;
const OPACITY_GOAL_BOX  = 0.18;
const OPACITY_GOAL_BAR  = 0.45;
const OPACITY_TOUCHLINE = 0.04;       // environmental — barely there
const OPACITY_GROUND    = 0.025;
const OPACITY_LATERAL   = 0.55;       // line slab

const SLAB_LIFT_Y       = 0.07;       // tiny ground lift to avoid z-fight
const PUSH_PLATE_LIFT_Y = 0.05;
const PUSH_CONE_LIFT_Y  = 0.08;
const PAIR_DISC_LIFT_Y  = 0.06;
const KICK_CONE_LIFT_Y  = 0.07;
const GROUND_LIFT_Y     = 0.02;

function makeFillMat(color, opacity) {
  return new THREE.MeshBasicMaterial({
    color, transparent: true, opacity,
    depthWrite: false, side: THREE.DoubleSide,
  });
}

function makeLineMat(color, opacity) {
  return new THREE.LineBasicMaterial({ color, transparent: true, opacity });
}

export class DebugOverlay {
  constructor(scene) {
    this.scene = scene;
    this._enabled = false;
    this._meshes = null;
    // Scratch for ikFootWorld() — avoids per-frame allocation.
    this._footScratch = { x: 0, y: 0, z: 0 };
    // Cache key for goal-box / field dimensions; geometry rebuild only
    // fires when the cached key changes (it never does in production).
    this._lastFieldKey = null;
  }

  /** Toggle the overlay. Pool is allocated on first enable. */
  setEnabled(on) {
    this._enabled = !!on;
    if (this._meshes && !this._enabled) this._hideAll();
  }

  isEnabled() {
    return this._enabled;
  }

  /** Per-frame update. No-op when disabled. */
  update(state, players) {
    if (!this._enabled) return;
    if (!this._meshes) this._initMeshes();
    this._drawPlayers(players);
    this._drawField(state);
  }

  /** Tear down: remove every mesh from the scene and free GPU
   *  resources. Idempotent. */
  dispose() {
    if (!this._meshes) return;
    for (const m of this._meshes.allMeshes) {
      this.scene.remove(m);
      if (m.geometry) m.geometry.dispose();
      if (m.material) m.material.dispose();
    }
    this._meshes = null;
  }

  // ────────────────────────────────────────────────────────────
  // Internals
  // ────────────────────────────────────────────────────────────

  /** Lazy one-shot allocator for the mesh pool. Geometry that depends
   *  only on physics constants is built once here; geometry that
   *  depends on state.field (goal box, touchlines, ground/ceiling)
   *  is rebuilt by `_drawField` when the field changes. */
  _initMeshes() {
    const m = {};

    // Body capsule — segment from `airZ` to `SHOULDER_Z + airZ`,
    // radius STICKMAN_TORSO_RADIUS. CapsuleGeometry's "length"
    // parameter is the segment between cap centres, which is
    // exactly SHOULDER_Z.
    const bodyGeom = new THREE.CapsuleGeometry(STICKMAN_TORSO_RADIUS, SHOULDER_Z, 4, 16);
    const bodyMat = makeFillMat(COLOR_BODY, OPACITY_BODY);
    m.bodyCapsules = [new THREE.Mesh(bodyGeom, bodyMat), new THREE.Mesh(bodyGeom, bodyMat)];

    // Head sphere — separate sphere collider in resolveBallVsBodyCapsule.
    const headGeom = new THREE.SphereGeometry(STICKMAN_HEAD_RADIUS, 18, 12);
    const headMat = makeFillMat(COLOR_HEAD, OPACITY_HEAD);
    m.headSpheres = [new THREE.Mesh(headGeom, headMat), new THREE.Mesh(headGeom, headMat)];

    // Pair-collision filled disc. Resolver compares 2D X-Z distance
    // only; render as a flat circle on the ground plane.
    const pairGeom = new THREE.CircleGeometry(STICKMAN_HEAD_RADIUS * 2, 32);
    const pairMat = makeFillMat(COLOR_PAIR, OPACITY_PAIR);
    m.pairDiscs = [new THREE.Mesh(pairGeom, pairMat), new THREE.Mesh(pairGeom, pairMat)];
    for (const mesh of m.pairDiscs) mesh.rotation.x = -Math.PI / 2;

    // Kick reach — bounding sphere @ live hipAnchor, radius KICK_REACH_MAX.
    const kickGeom = new THREE.SphereGeometry(KICK_REACH_MAX, 24, 16);
    const kickMat = makeFillMat(COLOR_KICK, OPACITY_KICK_BUDGET);
    m.kickReachSpheres = [new THREE.Mesh(kickGeom, kickMat), new THREE.Mesh(kickGeom, kickMat)];

    // Kick facing cone — flat wedge, 2 * KICK_FACE_TOL angular span.
    const kickConeGeom = new THREE.CircleGeometry(KICK_REACH_MAX, 24, -KICK_FACE_TOL, 2 * KICK_FACE_TOL);
    const kickConeMat = makeFillMat(COLOR_KICK, OPACITY_KICK_CONE);
    m.kickCones = [new THREE.Mesh(kickConeGeom, kickConeMat), new THREE.Mesh(kickConeGeom, kickConeMat)];
    for (const mesh of m.kickCones) mesh.rotation.x = -Math.PI / 2;

    // Lateral foot-reach slab — two parallel green lines on the
    // ground at perpendicular ±FOOT_LATERAL_REACH from the player
    // along heading. Visualises the |local.perp| > FOOT_LATERAL_REACH
    // rejection that bounds the kick gate sideways.
    m.lateralSlabs = [];
    for (let i = 0; i < 2; i++) {
      const buf = new THREE.BufferGeometry();
      buf.setAttribute('position', new THREE.BufferAttribute(new Float32Array(12), 3));
      m.lateralSlabs.push(new THREE.LineSegments(buf, makeLineMat(COLOR_KICK, OPACITY_LATERAL)));
    }

    // Foot sphere — visible only during kick.active. Position read
    // each frame from ikFootWorld, which is what testFootContact
    // actually compares the ball against.
    const footGeom = new THREE.SphereGeometry(FOOT_RADIUS, 12, 8);
    const footMat = makeFillMat(COLOR_FOOT, OPACITY_FOOT);
    m.footSpheres = [new THREE.Mesh(footGeom, footMat), new THREE.Mesh(footGeom, footMat)];

    // Push range — axis-aligned plate. Width = 2 * PUSH_RANGE_X,
    // depth = 2 * PUSH_RANGE_Y * Z_STRETCH (physics-y → world-z).
    const pushGeom = new THREE.PlaneGeometry(PUSH_RANGE_X * 2, PUSH_RANGE_Y * 2 * Z_STRETCH);
    const pushMat = makeFillMat(COLOR_PUSH, OPACITY_PUSH_PLATE);
    m.pushPlates = [new THREE.Mesh(pushGeom, pushMat), new THREE.Mesh(pushGeom, pushMat)];
    for (const mesh of m.pushPlates) mesh.rotation.x = -Math.PI / 2;

    // Push facing cone.
    const pushConeGeom = new THREE.CircleGeometry(PUSH_RANGE_X, 24, -PUSH_FACE_TOL, 2 * PUSH_FACE_TOL);
    const pushConeMat = makeFillMat(COLOR_PUSH, OPACITY_PUSH_CONE);
    m.pushCones = [new THREE.Mesh(pushConeGeom, pushConeMat), new THREE.Mesh(pushConeGeom, pushConeMat)];
    for (const mesh of m.pushCones) mesh.rotation.x = -Math.PI / 2;

    // Field-driven geometry — rebuilt by _drawField when state.field changes.
    const goalMat = makeFillMat(COLOR_GOAL_BOX, OPACITY_GOAL_BOX);
    m.goalPlanes = []; // back, side-near, side-far, top — × 2 goals
    for (let i = 0; i < 8; i++) {
      m.goalPlanes.push(new THREE.Mesh(new THREE.PlaneGeometry(1, 1), goalMat));
    }
    const barMat = makeFillMat(COLOR_GOAL_BAR, OPACITY_GOAL_BAR);
    m.goalPosts = []; // 2 per goal × 2 goals
    for (let i = 0; i < 4; i++) {
      m.goalPosts.push(new THREE.Mesh(new THREE.CylinderGeometry(GOAL_POST_RADIUS, GOAL_POST_RADIUS, 1, 16), barMat));
    }
    m.crossbars = []; // 1 per goal
    for (let i = 0; i < 2; i++) {
      m.crossbars.push(new THREE.Mesh(new THREE.CylinderGeometry(GOAL_POST_RADIUS, GOAL_POST_RADIUS, 1, 16), barMat));
    }
    const wallMat = makeFillMat(COLOR_TOUCHLINE, OPACITY_TOUCHLINE);
    m.touchlines = [
      new THREE.Mesh(new THREE.PlaneGeometry(1, 1), wallMat),
      new THREE.Mesh(new THREE.PlaneGeometry(1, 1), wallMat),
    ];
    const skyMat = makeFillMat(COLOR_GROUND_SKY, OPACITY_GROUND);
    m.ground  = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), skyMat);
    m.ceiling = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), skyMat);

    m.allMeshes = [
      ...m.bodyCapsules, ...m.headSpheres, ...m.pairDiscs,
      ...m.kickReachSpheres, ...m.kickCones, ...m.lateralSlabs,
      ...m.footSpheres, ...m.pushPlates, ...m.pushCones,
      ...m.goalPlanes, ...m.goalPosts, ...m.crossbars,
      ...m.touchlines, m.ground, m.ceiling,
    ];
    for (const mesh of m.allMeshes) {
      mesh.visible = false;
      mesh.renderOrder = OVERLAY_RENDER_ORDER;
      this.scene.add(mesh);
    }
    this._meshes = m;
  }

  _hideAll() {
    if (!this._meshes) return;
    for (const mesh of this._meshes.allMeshes) mesh.visible = false;
  }

  /** Update per-player meshes. All collider centres now share one
   *  convention — `p.y * Z_STRETCH` for world-z — matching the body
   *  capsule, kick gate, hip anchor, push gate, pair-collision
   *  resolver, and the rendered figure. */
  _drawPlayers(players) {
    const m = this._meshes;
    for (let i = 0; i < players.length && i < 2; i++) {
      const p = players[i];
      const airZ = p.airZ || 0;
      const hipX = p.x + PLAYER_WIDTH / 2;
      const hipY = HIP_BASE_Z + airZ;
      const hipZ = p.y * Z_STRETCH;
      const torsoMidY = airZ + SHOULDER_Z / 2;
      const headY = HEAD_CENTER_Z + airZ;

      m.bodyCapsules[i].position.set(hipX, torsoMidY, hipZ);
      m.bodyCapsules[i].visible = true;

      m.headSpheres[i].position.set(hipX, headY, hipZ);
      m.headSpheres[i].visible = true;

      m.pairDiscs[i].position.set(hipX, PAIR_DISC_LIFT_Y, hipZ);
      m.pairDiscs[i].visible = true;

      m.kickReachSpheres[i].position.set(hipX, hipY, hipZ);
      m.kickReachSpheres[i].visible = true;

      m.kickCones[i].position.set(hipX, KICK_CONE_LIFT_Y, hipZ);
      m.kickCones[i].rotation.set(-Math.PI / 2, 0, -p.heading);
      m.kickCones[i].visible = true;

      m.pushCones[i].position.set(hipX, PUSH_CONE_LIFT_Y, hipZ);
      m.pushCones[i].rotation.set(-Math.PI / 2, 0, -p.heading);
      m.pushCones[i].visible = true;

      m.pushPlates[i].position.set(hipX, PUSH_PLATE_LIFT_Y, hipZ);
      m.pushPlates[i].visible = true;

      // Foot sphere — only when actively kicking.
      if (p.kick && p.kick.active) {
        const fw = ikFootWorld(p, this._footScratch);
        m.footSpheres[i].position.set(fw.x, fw.y, fw.z);
        m.footSpheres[i].visible = true;
      } else {
        m.footSpheres[i].visible = false;
      }

      // Lateral foot-reach slab — two segments parallel to heading
      // at perpendicular offset ±FOOT_LATERAL_REACH. Length along
      // heading = KICK_REACH_MAX so the slab lines up with the cone.
      const ux = Math.cos(p.heading), uz = Math.sin(p.heading);
      const perpX = -uz, perpZ = ux;
      const arr = m.lateralSlabs[i].geometry.attributes.position.array;
      arr[0]  = hipX - perpX * FOOT_LATERAL_REACH;
      arr[1]  = SLAB_LIFT_Y;
      arr[2]  = hipZ - perpZ * FOOT_LATERAL_REACH;
      arr[3]  = arr[0] + ux * KICK_REACH_MAX;
      arr[4]  = SLAB_LIFT_Y;
      arr[5]  = arr[2] + uz * KICK_REACH_MAX;
      arr[6]  = hipX + perpX * FOOT_LATERAL_REACH;
      arr[7]  = SLAB_LIFT_Y;
      arr[8]  = hipZ + perpZ * FOOT_LATERAL_REACH;
      arr[9]  = arr[6] + ux * KICK_REACH_MAX;
      arr[10] = SLAB_LIFT_Y;
      arr[11] = arr[8] + uz * KICK_REACH_MAX;
      m.lateralSlabs[i].geometry.attributes.position.needsUpdate = true;
      m.lateralSlabs[i].visible = true;
    }
    // Hide any unused player slots (harness scenarios may pass <2 players).
    for (let i = players.length; i < 2; i++) {
      m.bodyCapsules[i].visible = false;
      m.headSpheres[i].visible = false;
      m.pairDiscs[i].visible = false;
      m.kickReachSpheres[i].visible = false;
      m.kickCones[i].visible = false;
      m.lateralSlabs[i].visible = false;
      m.footSpheres[i].visible = false;
      m.pushPlates[i].visible = false;
      m.pushCones[i].visible = false;
    }
  }

  /** Update field-driven geometry — goal boxes, posts/crossbars,
   *  touchlines, ground/ceiling. Geometry is rebuilt only when the
   *  cached field key changes. Positions update every frame. */
  _drawField(state) {
    const m = this._meshes;
    const f = state.field;
    const goals = [f.goalBoxLeft, f.goalBoxRight];
    const fieldKey = `${goals[0].minX}|${goals[0].maxX}|${goals[1].minX}|${goals[1].maxX}|${goals[0].minY}|${goals[0].maxY}|${goals[0].maxZ}|${f.width}|${f.ceiling}`;
    const rebuild = this._lastFieldKey !== fieldKey;
    if (rebuild) this._lastFieldKey = fieldKey;

    for (let gi = 0; gi < 2; gi++) {
      const box = goals[gi];
      const xMin = box.minX, xMax = box.maxX;
      const zMin = box.minY * Z_STRETCH;
      const zMax = box.maxY * Z_STRETCH;
      const yMax = box.maxZ;
      const xMid = (xMin + xMax) / 2;
      const zMid = (zMin + zMax) / 2;
      const xSpan = xMax - xMin;
      const zSpan = zMax - zMin;
      const isLeft = gi === 0;
      const backX  = isLeft ? xMin : xMax;
      // Mouth-edge X — matches resolveBallVsGoalBars: `mouthX = isLeft ? maxX : minX`.
      const mouthX = isLeft ? xMax : xMin;

      // Back, side-near, side-far, top (4 planes per goal).
      const back = m.goalPlanes[gi * 4 + 0];
      if (rebuild) {
        back.geometry.dispose();
        back.geometry = new THREE.PlaneGeometry(zSpan, yMax);
      }
      back.position.set(backX, yMax / 2, zMid);
      back.rotation.set(0, isLeft ? Math.PI / 2 : -Math.PI / 2, 0);
      back.visible = true;

      const sideNear = m.goalPlanes[gi * 4 + 1];
      const sideFar  = m.goalPlanes[gi * 4 + 2];
      if (rebuild) {
        sideNear.geometry.dispose();
        sideFar.geometry.dispose();
        sideNear.geometry = new THREE.PlaneGeometry(xSpan, yMax);
        sideFar.geometry  = new THREE.PlaneGeometry(xSpan, yMax);
      }
      sideNear.position.set(xMid, yMax / 2, zMin);
      sideFar.position.set(xMid, yMax / 2, zMax);
      sideNear.rotation.set(0, 0, 0);
      sideFar.rotation.set(0, 0, 0);
      sideNear.visible = true;
      sideFar.visible = true;

      const top = m.goalPlanes[gi * 4 + 3];
      if (rebuild) {
        top.geometry.dispose();
        top.geometry = new THREE.PlaneGeometry(xSpan, zSpan);
      }
      top.position.set(xMid, yMax, zMid);
      top.rotation.set(-Math.PI / 2, 0, 0);
      top.visible = true;

      // Posts — vertical cylinders at the mouth corners.
      const postNear = m.goalPosts[gi * 2 + 0];
      const postFar  = m.goalPosts[gi * 2 + 1];
      if (rebuild) {
        postNear.geometry.dispose();
        postFar.geometry.dispose();
        postNear.geometry = new THREE.CylinderGeometry(GOAL_POST_RADIUS, GOAL_POST_RADIUS, yMax, 16);
        postFar.geometry  = new THREE.CylinderGeometry(GOAL_POST_RADIUS, GOAL_POST_RADIUS, yMax, 16);
      }
      postNear.position.set(mouthX, yMax / 2, zMin);
      postFar.position.set(mouthX, yMax / 2, zMax);
      postNear.rotation.set(0, 0, 0);
      postFar.rotation.set(0, 0, 0);
      postNear.visible = true;
      postFar.visible = true;

      // Crossbar — horizontal cylinder along world-z at mouth top.
      const crossbar = m.crossbars[gi];
      if (rebuild) {
        crossbar.geometry.dispose();
        crossbar.geometry = new THREE.CylinderGeometry(GOAL_POST_RADIUS, GOAL_POST_RADIUS, zSpan, 16);
      }
      crossbar.position.set(mouthX, yMax, zMid);
      // Default cylinder axis is +Y; rotate -90° around X so it
      // lies along world-z.
      crossbar.rotation.set(Math.PI / 2, 0, 0);
      crossbar.visible = true;
    }

    // Field touchlines + ground / ceiling — environmental walls.
    const fieldZSpan = FIELD_HEIGHT * Z_STRETCH;
    const fieldXSpan = f.width;
    const ceilingY   = f.ceiling;
    if (rebuild) {
      for (const w of m.touchlines) {
        w.geometry.dispose();
        w.geometry = new THREE.PlaneGeometry(fieldXSpan, ceilingY);
      }
      m.ground.geometry.dispose();
      m.ceiling.geometry.dispose();
      m.ground.geometry  = new THREE.PlaneGeometry(fieldXSpan, fieldZSpan);
      m.ceiling.geometry = new THREE.PlaneGeometry(fieldXSpan, fieldZSpan);
    }
    m.touchlines[0].position.set(fieldXSpan / 2, ceilingY / 2, 0);
    m.touchlines[0].rotation.set(0, 0, 0);
    m.touchlines[0].visible = true;
    m.touchlines[1].position.set(fieldXSpan / 2, ceilingY / 2, fieldZSpan);
    m.touchlines[1].rotation.set(0, 0, 0);
    m.touchlines[1].visible = true;

    m.ground.position.set(fieldXSpan / 2, GROUND_LIFT_Y, fieldZSpan / 2);
    m.ground.rotation.set(-Math.PI / 2, 0, 0);
    m.ground.visible = true;
    m.ceiling.position.set(fieldXSpan / 2, ceilingY, fieldZSpan / 2);
    m.ceiling.rotation.set(-Math.PI / 2, 0, 0);
    m.ceiling.visible = true;
  }
}
