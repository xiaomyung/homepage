/**
 * Unit tests for the torso stamina clipping-plane math.
 *
 * `updateStaminaClipPlane` interpolates between the two torso
 * endpoint y-values according to the stamina fraction, clamps the
 * fraction to [STAMINA_FLOOR, 1], and writes the result into the
 * clipping plane's components. Pure JS, no three.js needed — the
 * test uses a stub plane with a recording `setComponents`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { updateStaminaClipPlane, staminaDiscRadius } from '../renderer.js';

function stubPlane() {
  return {
    components: null,
    setComponents(x, y, z, w) { this.components = [x, y, z, w]; },
  };
}

/* ── Plane equation shape ──────────────────────────────────── */

test('plane uses world-horizontal normal (0, -1, 0)', () => {
  const p = stubPlane();
  updateStaminaClipPlane(p, 10, 20, 0.5);
  assert.equal(p.components[0], 0);
  assert.equal(p.components[1], -1);
  assert.equal(p.components[2], 0);
});

/* ── Interpolation ─────────────────────────────────────────── */

test('stamina = 0.5 puts fill line at the midpoint', () => {
  const p = stubPlane();
  const fillY = updateStaminaClipPlane(p, 10, 20, 0.5);
  assert.equal(fillY, 15);
  assert.equal(p.components[3], 15);
});

test('stamina = 1.0 puts fill line at the top', () => {
  const p = stubPlane();
  const fillY = updateStaminaClipPlane(p, 10, 20, 1.0);
  assert.equal(fillY, 20);
});

test('stamina = 0 clamps to STAMINA_FLOOR (not the bottom)', () => {
  // STAMINA_FLOOR is a small positive sliver so exhausted players
  // still show a tiny cap of solid fill at the hip. The exact floor
  // is a tuning constant inside renderer.js; the behavioral
  // contract this test pins is "stamina=0 never lands at the bottom".
  const p = stubPlane();
  const fillY = updateStaminaClipPlane(p, 10, 20, 0);
  assert.ok(fillY > 10, `expected fill above hip, got ${fillY}`);
  assert.ok(fillY < 11, `expected floor sliver <1 unit, got ${fillY}`);
});

test('negative stamina clamps to STAMINA_FLOOR', () => {
  const p = stubPlane();
  const fillY = updateStaminaClipPlane(p, 10, 20, -5);
  assert.ok(fillY > 10 && fillY < 11);
});

test('stamina > 1 clamps to 1.0', () => {
  const p = stubPlane();
  const fillY = updateStaminaClipPlane(p, 10, 20, 1.7);
  assert.equal(fillY, 20);
});

/* ── Endpoint order doesn't matter ─────────────────────────── */

test('inverted ay/by (torso upside down) still interpolates correctly', () => {
  const p = stubPlane();
  // Pass neck-Y first, hip-Y second. Function auto-sorts.
  const fillY = updateStaminaClipPlane(p, 20, 10, 0.5);
  assert.equal(fillY, 15);
});

test('equal endpoints produce a flat plane at that y', () => {
  const p = stubPlane();
  const fillY = updateStaminaClipPlane(p, 17, 17, 0.5);
  assert.equal(fillY, 17);
});

/* ── Return value ──────────────────────────────────────────── */

test('returns the computed fillWorldY for caller inspection', () => {
  const p = stubPlane();
  const ret = updateStaminaClipPlane(p, 0, 100, 0.3);
  assert.equal(ret, 30);
});

/* ── Regression: real torso scale ──────────────────────────── */

test('realistic torso span and mid-stamina lands inside the span', () => {
  // The in-game torso runs roughly from hipBaseY (~hips in world y)
  // to hipBaseY + SHOULDER_OFY (~neck). Typical values during a
  // standing pose are hipY≈20, neckY≈40. This test just pins the
  // obvious expected behavior for a mid-field upright stickman.
  const p = stubPlane();
  const fillY = updateStaminaClipPlane(p, 20, 40, 0.75);
  assert.equal(fillY, 35);  // 75% of the way up
});

/* ── staminaDiscRadius ─────────────────────────────────────── */

// For the torso: bodyHalf = half the cylindrical body length,
// capRadius = hemispherical cap radius. Numbers below are the
// in-game values (SHOULDER_OFY=20.24 split into bodyHalf+capRadius).
const BODY_HALF = 6.82;
const CAP_R     = 3.3;

test('disc radius equals capRadius in the cylindrical middle', () => {
  assert.equal(staminaDiscRadius(0, BODY_HALF, CAP_R), CAP_R);
  assert.equal(staminaDiscRadius(3, BODY_HALF, CAP_R), CAP_R);
  assert.equal(staminaDiscRadius(-5, BODY_HALF, CAP_R), CAP_R);
  assert.equal(staminaDiscRadius(BODY_HALF, BODY_HALF, CAP_R), CAP_R);
});

test('disc radius shrinks inside the top hemispherical cap', () => {
  // At bodyHalf the cross-section is still capRadius (cylinder→cap
  // join). At bodyHalf + capRadius it's 0 (very tip). Quarter way
  // into the cap: sqrt(r² - (r/4)²) = r * sqrt(15/16) ≈ 0.968 * r.
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
  // Sweep the whole axis at 100 samples; radius must stay in [0, capR].
  const halfLen = BODY_HALF + CAP_R;
  for (let i = -100; i <= 100; i++) {
    const y = (i / 100) * halfLen * 1.2; // slightly past tips
    const r = staminaDiscRadius(y, BODY_HALF, CAP_R);
    assert.ok(r >= 0 && r <= CAP_R, `at y=${y}: r=${r} out of [0, ${CAP_R}]`);
  }
});
