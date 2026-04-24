/**
 * Unit tests for the torso stamina clipping-plane math.
 *
 * `updateStaminaClipPlane` writes a plane perpendicular to the hip→neck
 * axis at a position that is `staminaFrac` of the way along the torso,
 * inset by `shellThickness` on each end. Pure JS, no three.js — the
 * test uses a stub plane with a recording `setComponents`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { updateStaminaClipPlane, staminaDiscRadius } from '../renderer-math.js';

function stubPlane() {
  return {
    components: null,
    setComponents(x, y, z, w) { this.components = [x, y, z, w]; },
  };
}
function out() {
  return { cx: 0, cy: 0, cz: 0, dx: 0, dy: 1, dz: 0, axialFromMid: 0 };
}

// Shorthand: vertical torso from y=ay to y=by at x=z=0, no shell inset.
function clipV(plane, ay, by, frac, shell = 0) {
  return updateStaminaClipPlane(plane, 0, ay, 0, 0, by, 0, shell, frac, out());
}

/* ── Plane equation shape for a vertical torso ─────────────── */

test('vertical torso → plane normal is (0, -1, 0)', () => {
  const p = stubPlane();
  clipV(p, 10, 20, 0.5);
  assert.ok(Math.abs(p.components[0]) < 1e-12);
  assert.equal(p.components[1], -1);
  assert.ok(Math.abs(p.components[2]) < 1e-12);
});

/* ── Interpolation along the torso axis ────────────────────── */

test('stamina = 0.5 puts the fill line at the midpoint', () => {
  const p = stubPlane();
  const info = clipV(p, 10, 20, 0.5);
  assert.equal(info.cy, 15);
  assert.equal(p.components[3], 15);
});

test('stamina = 1.0 puts the fill line at the top', () => {
  const p = stubPlane();
  const info = clipV(p, 10, 20, 1.0);
  assert.equal(info.cy, 20);
});

test('stamina = 0 clamps to STAMINA_FLOOR (not the bottom)', () => {
  const p = stubPlane();
  const info = clipV(p, 10, 20, 0);
  assert.ok(info.cy > 10, `expected fill above hip, got ${info.cy}`);
  assert.ok(info.cy < 11, `expected floor sliver <1 unit, got ${info.cy}`);
});

test('negative stamina also clamps to STAMINA_FLOOR', () => {
  const p = stubPlane();
  const info = clipV(p, 10, 20, -5);
  assert.ok(info.cy > 10 && info.cy < 11);
});

test('stamina > 1 clamps to 1.0', () => {
  const p = stubPlane();
  const info = clipV(p, 10, 20, 1.7);
  assert.equal(info.cy, 20);
});

/* ── Tilted torso — plane follows the body axis ────────────── */

test('tilted torso: plane normal points along the reverse hip→neck axis', () => {
  const p = stubPlane();
  // Hip at (0,0,0), neck at (3,4,0) → axis = (0.6, 0.8, 0).
  // Plane normal is -d = (-0.6, -0.8, 0).
  updateStaminaClipPlane(p, 0, 0, 0, 3, 4, 0, 0, 0.5, out());
  assert.ok(Math.abs(p.components[0] - -0.6) < 1e-9);
  assert.ok(Math.abs(p.components[1] - -0.8) < 1e-9);
  assert.ok(Math.abs(p.components[2]) < 1e-12);
});

test('tilted torso: clip point lies ON the axis at `frac` of its length', () => {
  const p = stubPlane();
  const info = updateStaminaClipPlane(p, 0, 0, 0, 6, 8, 0, 0, 0.5, out());
  // axis length = 10, midpoint at (3, 4, 0).
  assert.ok(Math.abs(info.cx - 3) < 1e-9);
  assert.ok(Math.abs(info.cy - 4) < 1e-9);
  assert.equal(info.cz, 0);
});

test('tilted torso: axialFromMid is signed distance along axis', () => {
  const p = stubPlane();
  // stamina 0.75 on a length-10 axis → clip 2.5 units past midpoint.
  const info = updateStaminaClipPlane(p, 0, 0, 0, 6, 8, 0, 0, 0.75, out());
  assert.ok(Math.abs(info.axialFromMid - 2.5) < 1e-9);
});

test('shellThickness insets both endpoints along the axis', () => {
  const p = stubPlane();
  // 10-unit vertical torso, 1-unit shell on each end → effective span 8.
  const info = clipV(p, 0, 10, 0.5, 1);
  // mid of inset span = 1 + 4 = 5. Same as un-inset midpoint here.
  assert.equal(info.cy, 5);
  // stamina 1.0 now caps at 9 (= 1 + 8 * 1.0), not 10.
  const top = clipV(p, 0, 10, 1.0, 1);
  assert.equal(top.cy, 9);
});

/* ── Degenerate input ──────────────────────────────────────── */

test('equal endpoints produce a flat plane at that point', () => {
  const p = stubPlane();
  const info = clipV(p, 17, 17, 0.5);
  assert.equal(info.cy, 17);
});

/* ── Regression: realistic torso span ──────────────────────── */

test('realistic torso span and mid-stamina lands inside the span', () => {
  const p = stubPlane();
  const info = clipV(p, 20, 40, 0.75);
  assert.equal(info.cy, 35);  // 75% of the way up
});

/* ── staminaDiscRadius ─────────────────────────────────────── */

const BODY_HALF = 6.82;
const CAP_R     = 3.3;

test('disc radius equals capRadius in the cylindrical middle', () => {
  assert.equal(staminaDiscRadius(0, BODY_HALF, CAP_R), CAP_R);
  assert.equal(staminaDiscRadius(3, BODY_HALF, CAP_R), CAP_R);
  assert.equal(staminaDiscRadius(-5, BODY_HALF, CAP_R), CAP_R);
  assert.equal(staminaDiscRadius(BODY_HALF, BODY_HALF, CAP_R), CAP_R);
});

test('disc radius shrinks inside the top hemispherical cap', () => {
  const quarterIntoCap = BODY_HALF + CAP_R * 0.25;
  const r = staminaDiscRadius(quarterIntoCap, BODY_HALF, CAP_R);
  const expected = CAP_R * Math.sqrt(1 - 0.25 * 0.25);
  assert.ok(Math.abs(r - expected) < 1e-9, `got ${r}, expected ${expected}`);
});

test('disc radius is symmetric across the torso center', () => {
  const offset = BODY_HALF + CAP_R * 0.5;
  assert.equal(
    staminaDiscRadius(offset, BODY_HALF, CAP_R),
    staminaDiscRadius(-offset, BODY_HALF, CAP_R),
  );
});

test('disc radius is 0 at the capsule tips', () => {
  const tip = BODY_HALF + CAP_R;
  assert.equal(staminaDiscRadius(tip, BODY_HALF, CAP_R), 0);
  assert.equal(staminaDiscRadius(-tip, BODY_HALF, CAP_R), 0);
});

test('disc radius is 0 outside the capsule entirely', () => {
  assert.equal(staminaDiscRadius(BODY_HALF + CAP_R + 1, BODY_HALF, CAP_R), 0);
  assert.equal(staminaDiscRadius(-(BODY_HALF + CAP_R + 2), BODY_HALF, CAP_R), 0);
});

test('disc radius never exceeds capRadius', () => {
  const halfLen = BODY_HALF + CAP_R;
  for (let i = -100; i <= 100; i++) {
    const y = (i / 100) * halfLen * 1.2;
    const r = staminaDiscRadius(y, BODY_HALF, CAP_R);
    assert.ok(r >= 0 && r <= CAP_R, `at y=${y}: r=${r} out of [0, ${CAP_R}]`);
  }
});
