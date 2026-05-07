/**
 * Football v2 — body-vs-body / body-vs-field collisions.
 *
 * Player-vs-field clamps, player-vs-goal-box AABB push, player-pair
 * swept-circle collision, and ball-vs-player body capsule + head
 * sphere. Ball-vs-static-world geometry (cylinders, goal exterior /
 * interior) lives in geometry.js.
 */

import {
  BALL_RADIUS, BODY_TANG_RETAIN,
  TUNNEL_CORRECTION_MIN_SPEED, TUNNEL_CORRECTION_BEHIND_DOT,
  STUCK_ON_TOP_NORMAL_THRESHOLD, STUCK_ON_TOP_TANG_THRESHOLD, STUCK_ON_TOP_SLIDE_SPEED,
  FIELD_HEIGHT, PLAYER_HEIGHT, PLAYER_WIDTH, Z_STRETCH,
  STICKMAN_HEAD_RADIUS, STICKMAN_TORSO_RADIUS, SHOULDER_Z, HEAD_CENTER_Z,
  PLAYER_PAIR_SEPARATION_GAP, PLAYER_PAIR_STUCK_TICKS, PLAYER_PAIR_STUCK_IMPULSE,
} from './tuning.js';
import { closestPointOnSegment } from './geometry.js';

// Module-level scratch AABBs reused by the collision resolvers.
// Physics runs synchronously per tick — a single shared scratch is safe
// because the caller consumes the result before the next call.
const _scratchEnt2D = { minX: 0, maxX: 0, minY: 0, maxY: 0 };
const _scratchPush  = { axis: 'x', delta: 0 };
const _scratchClosest = { x: 0, y: 0, z: 0 };

/** Goal box AABB for one side, in physics units. Returns the
 *  precomputed object stored on the field at creation time. */
export function goalBox(f, side) {
  return side === 'left' ? f.goalBoxLeft : f.goalBoxRight;
}

/**
 * AABB-AABB push with velocity-biased axis selection. Given an entity
 * AABB, a box AABB, and the entity's current velocity, returns
 * `{ axis, delta }` pushing the entity out through the face it most
 * recently crossed. The "entry face" is found by dividing each axis's
 * push magnitude by that axis's velocity magnitude (rewind time) — the
 * axis with the smallest rewind is the most recent entry.
 *
 * Pure min-penetration (shallowest overlap) fails for classic
 * "glancing post" cases where the ball clips a thin sliver of the box
 * on one axis while entering deeply on another.
 *
 * `useZ=false` ignores z axis — used for 2D players. Returns null if
 * the AABBs do not overlap.
 */
function minPenetrationPush(ent, box, useZ, vel) {
  if (ent.maxX <= box.minX || ent.minX >= box.maxX) return null;
  if (ent.maxY <= box.minY || ent.minY >= box.maxY) return null;
  if (useZ && (ent.maxZ <= box.minZ || ent.minZ >= box.maxZ)) return null;

  const vx = vel.vx || 0, vy = vel.vy || 0, vz = vel.vz || 0;
  const pushMinX = ent.maxX - box.minX;
  const pushMaxX = box.maxX - ent.minX;
  const pushMinY = ent.maxY - box.minY;
  const pushMaxY = box.maxY - ent.minY;

  const dx = vx > 0 ? -pushMinX : vx < 0 ? pushMaxX : (pushMinX < pushMaxX ? -pushMinX : pushMaxX);
  const dy = vy > 0 ? -pushMinY : vy < 0 ? pushMaxY : (pushMinY < pushMaxY ? -pushMinY : pushMaxY);
  const EPS = 1e-9;
  const tx = Math.abs(dx) / (Math.abs(vx) + EPS);
  const ty = Math.abs(dy) / (Math.abs(vy) + EPS);

  if (!useZ) {
    if (tx <= ty) { _scratchPush.axis = 'x'; _scratchPush.delta = dx; }
    else          { _scratchPush.axis = 'y'; _scratchPush.delta = dy; }
    return _scratchPush;
  }
  const pushMinZ = ent.maxZ - box.minZ;
  const pushMaxZ = box.maxZ - ent.minZ;
  const dz = vz > 0 ? -pushMinZ : vz < 0 ? pushMaxZ : (pushMinZ < pushMaxZ ? -pushMinZ : pushMaxZ);
  const tz = Math.abs(dz) / (Math.abs(vz) + EPS);
  if      (tx <= ty && tx <= tz) { _scratchPush.axis = 'x'; _scratchPush.delta = dx; }
  else if (ty <= tz)             { _scratchPush.axis = 'y'; _scratchPush.delta = dy; }
  else                           { _scratchPush.axis = 'z'; _scratchPush.delta = dz; }
  return _scratchPush;
}

export function clampPlayerToField(p, f) {
  if (p.x < 0) p.x = 0;
  else if (p.x > f.width - f.playerWidth) p.x = f.width - f.playerWidth;
  if (p.y < 0) p.y = 0;
  else if (p.y > FIELD_HEIGHT - PLAYER_HEIGHT) p.y = FIELD_HEIGHT - PLAYER_HEIGHT;
}

export function clampAndCollide(state, p) {
  const f = state.field;
  clampPlayerToField(p, f);
  resolvePlayerGoalBox(p, f.playerWidth, goalBox(f, 'left'));
  resolvePlayerGoalBox(p, f.playerWidth, goalBox(f, 'right'));
  // The goal-frame resolution can push a player past a field edge (notably
  // the right goal → right wall). Re-clamp so the body stays fully inside.
  clampPlayerToField(p, f);
}

function resolvePlayerGoalBox(p, pw, box) {
  const ent = _scratchEnt2D;
  ent.minX = p.x; ent.maxX = p.x + pw;
  ent.minY = p.y; ent.maxY = p.y + PLAYER_HEIGHT;
  const push = minPenetrationPush(ent, box, false, p);
  if (!push) return;
  if (push.axis === 'x') {
    p.x += push.delta;
    p.vx = 0;
    p.pushVx = 0;
  } else {
    p.y += push.delta;
    p.vy = 0;
    p.pushVy = 0;
  }
}

/**
 * Ball vs player's body-column capsule + head sphere.
 *
 * Collision math runs in WORLD coordinates. Body is inert for the
 * entire duration of an active kick (any phase) so the foot can reach
 * the ball without the torso stealing it first.
 *
 * Returns true if a clamp fired (caller breaks the substep integration
 * loop).
 */
export function resolveBallVsPlayerBody(state, p) {
  if (p.kick.active) return false;
  const ball = state.ball;
  if (ball.frozen) return false;

  const airZ = p.airZ || 0;
  const centerX = p.x + PLAYER_WIDTH / 2;
  const centerWorldZ = p.y * Z_STRETCH;

  // Ball center in world coords (ball.z stores bottom altitude).
  const ballWX = ball.x;
  const ballWY = ball.z + BALL_RADIUS;
  const ballWZ = ball.y * Z_STRETCH;
  const ballWVX = ball.vx;
  const ballWVY = ball.vz;
  const ballWVZ = ball.vy * Z_STRETCH;

  // Body-column capsule: vertical from ground (+airZ) to shoulder height.
  const closest = closestPointOnSegment(
    centerX, airZ, centerWorldZ,
    centerX, SHOULDER_Z + airZ, centerWorldZ,
    ballWX, ballWY, ballWZ,
    _scratchClosest,
  );
  const torsoHit = tryBodyContact(state, p, closest, ballWX, ballWY, ballWZ,
    ballWVX, ballWVY, ballWVZ, STICKMAN_TORSO_RADIUS);

  // Head sphere.
  _scratchClosest.x = centerX;
  _scratchClosest.y = HEAD_CENTER_Z + airZ;
  _scratchClosest.z = centerWorldZ;
  // Re-read ball world coords post-torso-clamp.
  const ballWX2 = ball.x;
  const ballWY2 = ball.z + BALL_RADIUS;
  const ballWZ2 = ball.y * Z_STRETCH;
  const ballWVX2 = ball.vx;
  const ballWVY2 = ball.vz;
  const ballWVZ2 = ball.vy * Z_STRETCH;
  const headHit = tryBodyContact(state, p, _scratchClosest, ballWX2, ballWY2, ballWZ2,
    ballWVX2, ballWVY2, ballWVZ2, STICKMAN_HEAD_RADIUS);
  return torsoHit || headHit;
}

/** Apply cushion + deflect against a single sphere/segment-closest-
 *  point in world coords. Writes new ball position + velocity back to
 *  physics coords. Returns true if a clamp fired. */
function tryBodyContact(state, p, collider, wx, wy, wz, wvx, wvy, wvz, colliderRadius) {
  const ball = state.ball;
  let nx = wx - collider.x;
  let ny = wy - collider.y;
  let nz = wz - collider.z;
  let d2 = nx * nx + ny * ny + nz * nz;
  const r = colliderRadius + BALL_RADIUS;
  if (d2 >= r * r) return false;

  let d = Math.sqrt(d2);
  if (d < 1e-9) {
    nx = 1; ny = 0; nz = 0; d = 1;
  }
  let inv = 1 / d;
  let nxU = nx * inv, nyU = ny * inv, nzU = nz * inv;

  // Tunnel correction: walking-fast-into-ball case.
  const pWVX = p.vx, pWVZ = p.vy * Z_STRETCH;
  const pSpeed = Math.hypot(pWVX, pWVZ);
  if (pSpeed > TUNNEL_CORRECTION_MIN_SPEED) {
    const fwdX = pWVX / pSpeed, fwdZ = pWVZ / pSpeed;
    const fwdDotN = fwdX * nxU + fwdZ * nzU;
    if (fwdDotN < TUNNEL_CORRECTION_BEHIND_DOT) {
      nxU = fwdX;
      nyU = 0;
      nzU = fwdZ;
    }
  }
  const overlap = r - d;

  const newWX = collider.x + nxU * r;
  const newWY = (nyU !== 0) ? wy + nyU * overlap : wy;
  const newWZ = collider.z + nzU * r;

  const vDotN = wvx * nxU + wvy * nyU + wvz * nzU;
  let newWVX = wvx, newWVY = wvy, newWVZ = wvz;
  if (vDotN < 0) {
    const vnx = vDotN * nxU, vny = vDotN * nyU, vnz = vDotN * nzU;
    newWVX = (wvx - vnx) * BODY_TANG_RETAIN;
    newWVY = (wvy - vny) * BODY_TANG_RETAIN;
    newWVZ = (wvz - vnz) * BODY_TANG_RETAIN;
    if (state.recordEvents) {
      state.events.push({
        type: 'ball_trap',
        player: p === state.p1 ? 'p1' : 'p2',
        x: newWX, y: newWZ / Z_STRETCH, z: newWY,
      });
    }
  }

  // Dribble assist.
  const pvDotN = pWVX * nxU + pWVZ * nzU;
  if (pvDotN > 0) {
    const ballVAlongN = newWVX * nxU + newWVY * nyU + newWVZ * nzU;
    const delta = pvDotN - ballVAlongN;
    if (delta > 0) {
      newWVX += delta * nxU;
      newWVY += delta * nyU;
      newWVZ += delta * nzU;
    }
  }

  // Stuck-on-top escape.
  if (vDotN < 0 && nyU > STUCK_ON_TOP_NORMAL_THRESHOLD
      && Math.abs(newWVX) < STUCK_ON_TOP_TANG_THRESHOLD
      && Math.abs(newWVZ) < STUCK_ON_TOP_TANG_THRESHOLD) {
    const fwdX = Math.cos(p.heading);
    const fwdZ = Math.sin(p.heading);
    newWVX = fwdX * STUCK_ON_TOP_SLIDE_SPEED;
    newWVZ = fwdZ * STUCK_ON_TOP_SLIDE_SPEED;
  }

  ball.x  = newWX;
  ball.z  = newWY - BALL_RADIUS;
  ball.y  = newWZ / Z_STRETCH;
  ball.vx = newWVX;
  ball.vz = newWVY;
  ball.vy = newWVZ / Z_STRETCH;
  return true;
}

/**
 * Player-vs-player body-capsule collision with swept circle-circle
 * solver in the world-horizontal plane. Each player is modelled as a
 * vertical capsule of radius 2*STICKMAN_HEAD_RADIUS — the personal-
 * space radius. Swept because a player walking at full speed can
 * easily cross the contact diameter in one tick.
 *
 * Takes pre-tick positions so we can solve for the exact time of
 * first contact along the linear motion. After resolving, separates
 * the pair to dist = r + PLAYER_PAIR_SEPARATION_GAP so a steady-state
 * inward AI press can't lock them at exactly the contact distance.
 *
 * Tracks consecutive contact ticks on `state.pairContactTicks`; once
 * the pair has been touching for PLAYER_PAIR_STUCK_TICKS in a row
 * (~3s), apply an outward velocity impulse and reset the counter.
 */
export function resolvePlayerPairCollision(state, p1, p2, pre1x, pre1y, pre2x, pre2y) {
  const r = 2 * STICKMAN_HEAD_RADIUS;
  // Pre-tick centers in world coords.
  const preC1x = pre1x + PLAYER_WIDTH / 2;
  const preC1z = pre1y * Z_STRETCH;
  const preC2x = pre2x + PLAYER_WIDTH / 2;
  const preC2z = pre2y * Z_STRETCH;
  // Post-tick centers.
  const postC1x = p1.x + PLAYER_WIDTH / 2;
  const postC1z = p1.y * Z_STRETCH;
  const postC2x = p2.x + PLAYER_WIDTH / 2;
  const postC2z = p2.y * Z_STRETCH;

  const preDx = preC1x - preC2x, preDz = preC1z - preC2z;
  const postDx = postC1x - postC2x, postDz = postC1z - postC2z;
  const mdx = postDx - preDx, mdz = postDz - preDz;
  const preDist2 = preDx * preDx + preDz * preDz;
  const postDist2 = postDx * postDx + postDz * postDz;

  // Swept-minimum reject.
  const aMot = mdx * mdx + mdz * mdz;
  let minDist2;
  if (aMot < 1e-12) {
    minDist2 = preDist2;
  } else {
    const preDotM = preDx * mdx + preDz * mdz;
    let tStar = -preDotM / aMot;
    if      (tStar <= 0) minDist2 = preDist2;
    else if (tStar >= 1) minDist2 = postDist2;
    else                 minDist2 = preDist2 + 2 * tStar * preDotM + tStar * tStar * aMot;
  }
  if (minDist2 >= r * r) {
    state.pairContactTicks = 0;
    return;
  }

  // Solve |preD + t * m|² = r² for t in [0, 1].
  let tc = 0;
  const TOL = 1e-4;
  if (aMot > 1e-9) {
    const b = 2 * (preDx * mdx + preDz * mdz);
    const c = preDist2 - r * r;
    const disc = b * b - 4 * aMot * c;
    if (disc >= 0) {
      const sq = Math.sqrt(disc);
      const t1 = (-b - sq) / (2 * aMot);
      const t2 = (-b + sq) / (2 * aMot);
      if (t1 >= -TOL && t1 <= 1 + TOL) {
        tc = Math.max(0, Math.min(1, t1));
      } else if (t2 >= -TOL && t2 <= 1 + TOL) {
        tc = Math.max(0, Math.min(1, t2));
      }
    }
  }

  // Rewind to the contact moment along the linear motion.
  p1.x = pre1x + (p1.x - pre1x) * tc;
  p1.y = pre1y + (p1.y - pre1y) * tc;
  p2.x = pre2x + (p2.x - pre2x) * tc;
  p2.y = pre2y + (p2.y - pre2y) * tc;

  const c1x = p1.x + PLAYER_WIDTH / 2;
  const c1z = p1.y * Z_STRETCH;
  const c2x = p2.x + PLAYER_WIDTH / 2;
  const c2z = p2.y * Z_STRETCH;
  const dx = c1x - c2x;
  const dz = c1z - c2z;
  const dist2 = dx * dx + dz * dz;
  const dist = Math.sqrt(dist2);
  let nxU, nzU;
  if (dist < 1e-9) {
    nxU = 1; nzU = 0;
  } else {
    const inv = 1 / dist;
    nxU = dx * inv; nzU = dz * inv;
  }
  // Always separate to r + GAP so the pair doesn't settle at exactly
  // the contact distance — a steady-state lock the AI's inward press
  // can't break out of on its own.
  const targetDist = r + PLAYER_PAIR_SEPARATION_GAP;
  if (dist < targetDist - 1e-6) {
    const half = (targetDist - dist) / 2;
    const wx = nxU * half, wz = nzU * half;
    p1.x += wx;  p1.y += wz / Z_STRETCH;
    p2.x -= wx;  p2.y -= wz / Z_STRETCH;
  }

  // Zero each player's velocity component INTO the opponent.
  const v1DotN = p1.vx * nxU + p1.vy * Z_STRETCH * nzU;
  if (v1DotN < 0) {
    p1.vx -= v1DotN * nxU;
    p1.vy -= v1DotN * nzU / Z_STRETCH;
  }
  const v2DotN = p2.vx * nxU + p2.vy * Z_STRETCH * nzU;
  if (v2DotN > 0) {
    p2.vx -= v2DotN * nxU;
    p2.vy -= v2DotN * nzU / Z_STRETCH;
  }
  // Push impulses are squashed on the contact axis.
  const pv1DotN = p1.pushVx * nxU + p1.pushVy * Z_STRETCH * nzU;
  if (pv1DotN < 0) {
    p1.pushVx -= pv1DotN * nxU;
    p1.pushVy -= pv1DotN * nzU / Z_STRETCH;
  }
  const pv2DotN = p2.pushVx * nxU + p2.pushVy * Z_STRETCH * nzU;
  if (pv2DotN > 0) {
    p2.pushVx -= pv2DotN * nxU;
    p2.pushVy -= pv2DotN * nzU / Z_STRETCH;
  }

  // Stuck-pair escalator. Increment for this contact tick; once the
  // pair has been touching for ~3s (PLAYER_PAIR_STUCK_TICKS), apply
  // an outward velocity impulse to either side so the deadlock breaks
  // even if the AI keeps pressing inward harder than the gap.
  state.pairContactTicks++;
  if (state.pairContactTicks >= PLAYER_PAIR_STUCK_TICKS) {
    p1.vx += nxU * PLAYER_PAIR_STUCK_IMPULSE;
    p1.vy += (nzU * PLAYER_PAIR_STUCK_IMPULSE) / Z_STRETCH;
    p2.vx -= nxU * PLAYER_PAIR_STUCK_IMPULSE;
    p2.vy -= (nzU * PLAYER_PAIR_STUCK_IMPULSE) / Z_STRETCH;
    state.pairContactTicks = 0;
  }
}
