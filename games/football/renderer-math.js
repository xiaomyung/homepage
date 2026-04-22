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

