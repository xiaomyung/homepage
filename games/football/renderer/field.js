/**
 * Football v2 — one-time static-world construction.
 *
 * Field outline + midline, centre circle, penalty + goal areas, the
 * D-shaped penalty arcs, corner arcs, and the trapezoidal goal frame
 * with net grid. All meshes added to the scene during the constructor;
 * geometry / material refs collected for `dispose()` to free.
 *
 * ctx-style: every function takes the Renderer instance.
 */

import * as THREE from 'https://unpkg.com/three@0.164.0/build/three.module.js';
import { TWO_PI } from './tuning.js';
import { FIELD_HEIGHT, GOAL_POST_RADIUS, ROOF_FRACTION, Z_STRETCH } from '../physics/index.js';

export function buildFieldLines(ctx) {
  const w = ctx.fieldWidth;
  const zFar = 0;
  const zNear = FIELD_HEIGHT * Z_STRETCH;
  const f = ctx._field;

  const dimColor = new THREE.Color('#707070');
  const mutedColor = new THREE.Color('#505050');
  const netColor = new THREE.Color('#404040');

  const lineMat = new THREE.LineBasicMaterial({ color: dimColor, transparent: true, opacity: 0.8 });
  const mutedMat = new THREE.LineBasicMaterial({ color: mutedColor, transparent: true, opacity: 0.5 });
  const netMat = new THREE.LineBasicMaterial({ color: netColor, transparent: true, opacity: 0.45 });
  const goalLineMat = new THREE.LineBasicMaterial({ color: dimColor, transparent: true, opacity: 0.75 });
  ctx._staticMaterials.push(lineMat, mutedMat, netMat, goalLineMat);

  const outlineGeom = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 0, zFar),
    new THREE.Vector3(w, 0, zFar),
    new THREE.Vector3(w, 0, zNear),
    new THREE.Vector3(0, 0, zNear),
  ]);
  addStatic(ctx, new THREE.LineLoop(outlineGeom, lineMat), outlineGeom);

  const midGeom = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(w / 2, 0, zFar),
    new THREE.Vector3(w / 2, 0, zNear),
  ]);
  addStatic(ctx, new THREE.Line(midGeom, mutedMat), midGeom);

  // Center circle + center dot.
  const midZ = (zFar + zNear) / 2;
  const centerR = FIELD_HEIGHT * Z_STRETCH * 0.22;
  addArc(ctx, w / 2, midZ, centerR, centerR, 0, TWO_PI, 48, mutedMat);
  addArc(ctx, w / 2, midZ, centerR * 0.06, centerR * 0.06, 0, TWO_PI, 12, mutedMat);

  const mouthCenterZ = ((f.goalMouthYMin + f.goalMouthYMax) / 2) * Z_STRETCH;
  const mouthHalfZ   = ((f.goalMouthYMax - f.goalMouthYMin) / 2) * Z_STRETCH;

  // Penalty area (18-yard box) + 6-yard goal area, both as LineLoops.
  // Sizes tuned so the penalty box fits inside the touchlines of this
  // (much wider-than-real) mouth/field proportion.
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
    addStatic(ctx, new THREE.LineLoop(pen, mutedMat), pen);
    const ga = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(lineX,     0, goalAreaZMin),
      new THREE.Vector3(goalAreaX, 0, goalAreaZMin),
      new THREE.Vector3(goalAreaX, 0, goalAreaZMax),
      new THREE.Vector3(lineX,     0, goalAreaZMax),
    ]);
    addStatic(ctx, new THREE.LineLoop(ga, mutedMat), ga);
  };
  drawBox(f.goalLineL, +1);
  drawBox(f.goalLineR, -1);

  // Penalty arcs — the classic "D". Centred on the penalty spot,
  // radius chosen so only the forward portion peeks outside the
  // penalty box.
  const spotFraction = 0.67;
  const arcRadius    = penaltyDepth * 0.50;
  const dxSpotToFront = penaltyDepth * (1 - spotFraction);
  const arcHalfChord = Math.sqrt(
    Math.max(0, arcRadius * arcRadius - dxSpotToFront * dxSpotToFront),
  );
  const alpha = Math.atan2(arcHalfChord, dxSpotToFront);
  const spotLX = f.goalLineL + penaltyDepth * spotFraction;
  addArc(ctx, spotLX, mouthCenterZ, arcRadius, arcRadius, -alpha, alpha, 24, mutedMat);
  const spotRX = f.goalLineR - penaltyDepth * spotFraction;
  addArc(ctx, spotRX, mouthCenterZ, arcRadius, arcRadius, Math.PI - alpha, Math.PI + alpha, 24, mutedMat);

  // Penalty spot marks.
  const spotR = mouthHalfZ * 0.04;
  addArc(ctx, spotLX, mouthCenterZ, spotR, spotR, 0, TWO_PI, 10, mutedMat);
  addArc(ctx, spotRX, mouthCenterZ, spotR, spotR, 0, TWO_PI, 10, mutedMat);

  // Corner arcs.
  const cornerR = mouthHalfZ * 0.12;
  addArc(ctx, 0, zFar,  cornerR, cornerR, 0,                Math.PI / 2,     12, mutedMat);
  addArc(ctx, w, zFar,  cornerR, cornerR, Math.PI / 2,      Math.PI,         12, mutedMat);
  addArc(ctx, w, zNear, cornerR, cornerR, Math.PI,          3 * Math.PI / 2, 12, mutedMat);
  addArc(ctx, 0, zNear, cornerR, cornerR, 3 * Math.PI / 2,  TWO_PI,          12, mutedMat);

  const goalWidth = (f.goalMouthYMax - f.goalMouthYMin) * Z_STRETCH;
  const goalHeight = f.goalMouthZMax;
  const goalCenterZ = ((f.goalMouthYMin + f.goalMouthYMax) / 2) * Z_STRETCH;

  addGoal(ctx, f.goalLineL, f.goalLLeft,  goalCenterZ, goalWidth, goalHeight, lineMat, netMat, goalLineMat);
  addGoal(ctx, f.goalLineR, f.goalRRight, goalCenterZ, goalWidth, goalHeight, lineMat, netMat, goalLineMat);
}

function addStatic(ctx, obj, geometry) {
  ctx.scene.add(obj);
  if (geometry) ctx._staticGeometries.push(geometry);
}

/** Add a thin cylinder spanning from point A to point B, used as a
 *  "thick line" for the goal frame bars. */
function addBar(ctx, a, b, material) {
  const dir = b.clone().sub(a);
  const length = dir.length();
  if (length < 1e-6) return;
  const geom = new THREE.CylinderGeometry(GOAL_POST_RADIUS, GOAL_POST_RADIUS, length, 8, 1);
  const mesh = new THREE.Mesh(geom, material);
  const up = new THREE.Vector3(0, 1, 0);
  const dirUnit = dir.clone().normalize();
  const axis = up.clone().cross(dirUnit);
  const angle = Math.acos(Math.max(-1, Math.min(1, up.dot(dirUnit))));
  if (axis.length() > 1e-6) {
    mesh.setRotationFromAxisAngle(axis.normalize(), angle);
  }
  mesh.position.set((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
  addStatic(ctx, mesh, geom);
}

/** Add an XZ-plane ellipse arc centered at (cx, cz). */
function addArc(ctx, cx, cz, rx, rz, aStart, aEnd, segments, material) {
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
  addStatic(ctx, new THREE.Line(geom, material), geom);
}

/**
 * Trapezoidal soccer-goal side profile: front mouth (vertical posts +
 * crossbar) → flat roof for the first ROOF_FRACTION of the depth →
 * slanted back net to the outer ground. Caller decides orientation
 * via the (mouthX, backBotX) pair.
 */
function addGoal(ctx, mouthX, backBotX, centerZ, width, height, mat, netMat, goalLineMat) {
  const halfW = width / 2;
  const backTopX = mouthX + (backBotX - mouthX) * ROOF_FRACTION;
  const zMin = centerZ - halfW;
  const zMax = centerZ + halfW;
  const P = (x, y, z) => new THREE.Vector3(x, y, z);

  // Goal frame bars — thin cylinders so they read as solid metal poles.
  const barMat = new THREE.MeshBasicMaterial({
    color: mat.color, transparent: true, opacity: mat.opacity ?? 1,
  });
  ctx._staticMaterials.push(barMat);
  // Front mouth — two vertical posts + crossbar at the goal line.
  addBar(ctx, P(mouthX, 0,      zMin), P(mouthX, height, zMin), barMat);
  addBar(ctx, P(mouthX, 0,      zMax), P(mouthX, height, zMax), barMat);
  addBar(ctx, P(mouthX, height, zMin), P(mouthX, height, zMax), barMat);
  // Roof rails running back from the mouth to the back slope start.
  addBar(ctx, P(mouthX,   height, zMin), P(backTopX, height, zMin), barMat);
  addBar(ctx, P(mouthX,   height, zMax), P(backTopX, height, zMax), barMat);
  addBar(ctx, P(backTopX, height, zMin), P(backTopX, height, zMax), barMat);
  // Slanted back rails from the roof-back down to the outer ground.
  addBar(ctx, P(backTopX, height, zMin), P(backBotX, 0, zMin), barMat);
  addBar(ctx, P(backTopX, height, zMax), P(backBotX, 0, zMax), barMat);
  // Ground rails closing the floor quad.
  addBar(ctx, P(backBotX, 0, zMin), P(backBotX, 0, zMax), barMat);
  addBar(ctx, P(backBotX, 0, zMin), P(mouthX,   0, zMin), barMat);
  addBar(ctx, P(backBotX, 0, zMax), P(mouthX,   0, zMax), barMat);

  // Net grid on the 4 closed faces: roof, slanted back, two trapezoidal
  // sides. Front mouth stays open. pushNet does a bilinear grid between
  // 4 corners — nU lines along A→B / D→C and nV along A→D / B→C.
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
  // Slanted back net — rectangle from (backTopX, height) down to (backBotX, 0).
  pushNet(
    P(backTopX, height, zMin), P(backBotX, 0,      zMin),
    P(backBotX, 0,      zMax), P(backTopX, height, zMax),
    10, 12,
  );
  // Side trapezoid zMin.
  pushNet(
    P(mouthX,   0,      zMin), P(backBotX, 0,      zMin),
    P(backTopX, height, zMin), P(mouthX,   height, zMin),
    10, 8,
  );
  // Side trapezoid zMax.
  pushNet(
    P(mouthX,   0,      zMax), P(backBotX, 0,      zMax),
    P(backTopX, height, zMax), P(mouthX,   height, zMax),
    10, 8,
  );

  const netGeom = new THREE.BufferGeometry().setFromPoints(netPoints);
  addStatic(ctx, new THREE.LineSegments(netGeom, netMat), netGeom);

  // Dashed goal line along the mouth ground edge.
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
  addStatic(ctx, new THREE.LineSegments(goalLineGeom, goalLineMat), goalLineGeom);
}
