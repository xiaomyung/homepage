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

/**
 * Write a stamina-fill clipping plane perpendicular to the torso axis
 * (hip → neck), at a position that is `staminaFrac` of the way along
 * the capsule (inset by `shellThickness` on each end so the fill
 * capsule — which is shorter than the outline — maps 0/1 to its own
 * bottom/top, not the outline's).
 *
 * The plane is perpendicular to the torso axis, NOT horizontal — so a
 * tilted torso (incline during a slump, grieve, or kick body-english)
 * still has its fill and cap disc aligned with the body instead of
 * shearing through the shell.
 *
 * Fills and returns `out` with:
 *   cx, cy, cz          — clip point in world space
 *   dx, dy, dz          — normalised hip→neck axis (disc's surface normal)
 *   axialFromMid        — signed axial distance from capsule midpoint to
 *                         clip point, for `staminaDiscRadius(...)`.
 */
export function updateStaminaClipPlane(
  plane, ax, ay, az, bx, by, bz, shellThickness, staminaFrac, out,
) {
  const rx = bx - ax, ry = by - ay, rz = bz - az;
  const len = Math.sqrt(rx * rx + ry * ry + rz * rz);
  // Degenerate case — zero-length torso. Fall back to world-up.
  const dx = len > 0 ? rx / len : 0;
  const dy = len > 0 ? ry / len : 1;
  const dz = len > 0 ? rz / len : 0;
  // Clamp fraction to the allowed range.
  const clamped = staminaFrac < STAMINA_FLOOR ? STAMINA_FLOOR
                : staminaFrac > 1 ? 1 : staminaFrac;
  // Step from hip along d by `shellThickness`, then `insetLen * clamped`.
  const insetAx = ax + dx * shellThickness;
  const insetAy = ay + dy * shellThickness;
  const insetAz = az + dz * shellThickness;
  const insetLen = len - 2 * shellThickness;
  const cx = insetAx + dx * insetLen * clamped;
  const cy = insetAy + dy * insetLen * clamped;
  const cz = insetAz + dz * insetLen * clamped;
  // Plane equation: `-d · p + (d · c) = 0`. three.js treats points
  // with `n·p + w ≥ 0` as visible, so the "hip side" (d·p ≤ d·c)
  // stays rendered and the part past the clip point is hidden.
  const dc = dx * cx + dy * cy + dz * cz;
  plane.setComponents(-dx, -dy, -dz, dc);
  // Axial offset from capsule midpoint — used by `staminaDiscRadius`.
  const midX = (ax + bx) * 0.5, midY = (ay + by) * 0.5, midZ = (az + bz) * 0.5;
  const axialFromMid = (cx - midX) * dx + (cy - midY) * dy + (cz - midZ) * dz;
  out.cx = cx; out.cy = cy; out.cz = cz;
  out.dx = dx; out.dy = dy; out.dz = dz;
  out.axialFromMid = axialFromMid;
  return out;
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

