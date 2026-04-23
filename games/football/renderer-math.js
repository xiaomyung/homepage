/**
 * Pure-math helpers used by the renderer's stamina visualisation.
 *
 * Extracted so unit tests can exercise them without importing three.js
 * (Node's ESM loader rejects the CDN https: URL).
 */

export const STAMINA_FLOOR = 0.04;

export function staminaDiscRadius(yLocalOffset, bodyHalf, capRadius) {
  const absY = yLocalOffset < 0 ? -yLocalOffset : yLocalOffset;
  if (absY >= bodyHalf + capRadius) return 0;
  if (absY <= bodyHalf) return capRadius;
  const distInCap = absY - bodyHalf;
  const rSq = capRadius * capRadius - distInCap * distInCap;
  return rSq > 0 ? Math.sqrt(rSq) : 0;
}

export function updateStaminaClipPlane(plane, ay, by, staminaFrac) {
  const hipY  = ay < by ? ay : by;
  const neckY = ay < by ? by : ay;
  const clamped = staminaFrac < STAMINA_FLOOR ? STAMINA_FLOOR
                : staminaFrac > 1 ? 1 : staminaFrac;
  const fillWorldY = hipY + (neckY - hipY) * clamped;
  plane.setComponents(0, -1, 0, fillWorldY);
  return fillWorldY;
}

// Easing helpers. Normalized domain/range (0..1 → 0..1).
export function easeInOut(p) {
  return p < 0.5 ? 2 * p * p : 1 - (2 * (1 - p)) * (1 - p);
}
export function easeOut(p) {
  return 1 - (1 - p) * (1 - p);
}

// Knee flex for cosmetic (non-IK) walk/celebrate/idle leg swings.
// Straight-down thigh → straight-down shin. Larger swing magnitudes
// bend the knee +forward regardless of swing sign (knees hinge one
// way). Kicking leg bypasses this via real 2-bone IK in
// physics.js::kickLegPose.
export const STICKMAN_KNEE_FLEX_MAX   = 0.5;
export const STICKMAN_KNEE_FLEX_SLOPE = 0.4;
export function shinAngleFor(thighAngle) {
  const flex = Math.min(STICKMAN_KNEE_FLEX_MAX, STICKMAN_KNEE_FLEX_SLOPE * Math.abs(thighAngle));
  return thighAngle * (1 - flex);
}

// Elbow flex for cosmetic (non-IK) arm swings. Peaks at |angle|=π/2
// (arms horizontal) and tapers to 0 at both 0 (neutral) and ±π
// (celebrate — arms straight overhead). Punch poses bypass via
// physics.js::pushArmPose.
export const STICKMAN_ELBOW_FLEX_MAX = 0.45;
export function forearmAngleFor(upperArmAngle) {
  const mag = Math.min(Math.abs(upperArmAngle), Math.PI);
  const flex = STICKMAN_ELBOW_FLEX_MAX * Math.sin(mag);
  return upperArmAngle * (1 - flex);
}

