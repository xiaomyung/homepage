/**
 * Football v2 — ball-vs-static-world geometry.
 *
 * Ball-vs-cylinder (goal posts, crossbar), ball-vs-goal-exterior
 * (back wall, side nets, roof), ball-vs-goal-interior (the absorbing
 * net), and the small geometry helpers shared with kick.js
 * (hipAnchor, projectHipLocal, closestPointOnSegment). Plus
 * recordBounce — the ball-event emitter that the geometry resolvers
 * and the ball physics integrator both call into.
 *
 * Pure module aside from the state mutations it performs — no DOM,
 * no three.js. Caller passes the live state in and out.
 */

import {
  BALL_RADIUS, BOUNCE_RETAIN, BOUNCE_EVENT_MIN,
  GOAL_POST_RADIUS,
  HIP_BASE_Z, PLAYER_WIDTH, Z_STRETCH,
} from './tuning.js';

/** Emit a ball-bounce particle event. Gates out settle-noise below
 *  BOUNCE_EVENT_MIN so microscopic ground bounces don't spawn dust. */
export function recordBounce(state, axis, force) {
  if (!state.recordEvents) return;
  if (force < BOUNCE_EVENT_MIN) return;
  const ball = state.ball;
  state.events.push({
    type: 'ball_bounce',
    axis,
    force,
    x: ball.x,
    y: ball.y,
    z: ball.z,
  });
}

/** Closest point on segment AB to point P, written into `out` (same
 *  {x,y,z} object style as _scratchPush). Pure math, no allocation. */
const _scratchClosest = { x: 0, y: 0, z: 0 };
export function closestPointOnSegment(ax, ay, az, bx, by, bz, px, py, pz, out = _scratchClosest) {
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  const len2 = dx * dx + dy * dy + dz * dz;
  let t = 0;
  if (len2 > 1e-12) {
    t = ((px - ax) * dx + (py - ay) * dy + (pz - az) * dz) / len2;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
  }
  out.x = ax + t * dx;
  out.y = ay + t * dy;
  out.z = az + t * dz;
  return out;
}

/**
 * Hip anchor in WORLD coords — the pivot a leg swings from. Uses the
 * body-axis center so the reach gate and the foot-contact test stay
 * symmetric on both kick sides. Matches the renderer's draw origin:
 * (p.x + PLAYER_WIDTH/2, p.y * Z_STRETCH) on the floor, HIP_BASE_Z
 * above the ground, plus p.airZ during an airkick.
 */
const _scratchHip = { x: 0, y: 0, z: 0 };
export function hipAnchor(p, out = _scratchHip) {
  out.x = p.x + PLAYER_WIDTH / 2;
  out.y = HIP_BASE_Z + (p.airZ || 0);
  out.z = p.y * Z_STRETCH;
  return out;
}

/**
 * Project a floor-plane delta into a heading-local (fwd, perp) frame,
 * given the heading's forward unit vector (fwdX, fwdZ). `fwd` is the
 * component along the heading, `perp` the in-plane component to its
 * left. Shared by projectHipLocal (heading = p.heading), kickLegPose
 * (heading = smoothed animHeading, passed in), and tryPush.
 *
 * FP operation order is load-bearing — the game is bit-exact-diffed
 * against a fixed-seed reference, so do NOT commute the operands.
 */
const _scratchDelta = { fwd: 0, perp: 0 };
export function projectDeltaLocal(dx, dz, fwdX, fwdZ, out = _scratchDelta) {
  out.fwd  = dx * fwdX + dz * fwdZ;
  out.perp = -dx * fwdZ + dz * fwdX;
  return out;
}

/**
 * Project a world-space point into the player's hip-local frame:
 * `fwd` along the heading, `up` vertical, `perp` perpendicular to
 * heading in the floor plane. The IK solver only uses (fwd, up);
 * `perp` feeds the sphere-sphere contact test so a ball off to the
 * side still misses even if (fwd, up) lines up.
 */
const _scratchLocal = { fwd: 0, up: 0, perp: 0 };
export function projectHipLocal(hip, heading, wx, wy, wz, out = _scratchLocal) {
  const dx = wx - hip.x;
  const dy = wy - hip.y;
  const dz = wz - hip.z;
  const fwdX = Math.cos(heading);
  const fwdZ = Math.sin(heading);
  projectDeltaLocal(dx, dz, fwdX, fwdZ, out);
  out.up = dy;
  return out;
}

/**
 * Ball vs goal interior — the absorbing inner net. Runs ONLY when
 * ball.inGoal=true (goal already counted, ball settling into the net).
 * Slanted back wall, two side nets, and the underside of the roof.
 * On contact: snap to surface and zero horizontal velocity (vx, vy
 * for back/sides; vz for roof) so the ball drops to the floor instead
 * of bouncing back through the mouth on its way to the back net.
 */
export function resolveBallInsideGoal(state, box) {
  const ball = state.ball;
  if (ball.frozen) return;

  const isLeftGoal = box === state.field.goalBoxLeft;
  let hitBackOrSide = false;

  // Slanted back wall — modeled per-tick as a vertical wall at the
  // slope's x-coordinate for the BALL's current height, so the
  // substep loop's purely-horizontal bounce stays correct.
  const floorBackX = isLeftGoal ? box.minX : box.maxX;
  const roofBackX  = box.roofBackX;
  const ballCY     = Math.max(0, Math.min(box.maxZ, ball.z + BALL_RADIUS));
  const slopeXatY  = floorBackX + (ballCY / box.maxZ) * (roofBackX - floorBackX);
  const penetration = isLeftGoal
    ? slopeXatY - (ball.x - BALL_RADIUS)
    : (ball.x + BALL_RADIUS) - slopeXatY;
  if (penetration > 0) {
    ball.x = isLeftGoal ? slopeXatY + BALL_RADIUS : slopeXatY - BALL_RADIUS;
    hitBackOrSide = true;
    if (state.recordEvents && Math.abs(ball.vx) > BOUNCE_EVENT_MIN) {
      state.events.push({ type: 'ball_bounce', axis: 'x', force: Math.abs(ball.vx), x: ball.x, y: ball.y, z: ball.z });
    }
  }

  if (ball.y - BALL_RADIUS < box.minY) {
    ball.y = box.minY + BALL_RADIUS;
    hitBackOrSide = true;
  } else if (ball.y + BALL_RADIUS > box.maxY) {
    ball.y = box.maxY - BALL_RADIUS;
    hitBackOrSide = true;
  }

  if (hitBackOrSide) {
    // Net absorbs — ball loses horizontal momentum and drops.
    ball.vx = 0;
    ball.vy = 0;
  }

  // Inner roof (crossbar underside) — flat plane at z=maxZ, but only
  // over the front-rectangular portion of the trapezoidal net.
  const xMouth = isLeftGoal ? box.maxX : box.minX;
  const xLo = Math.min(xMouth, roofBackX);
  const xHi = Math.max(xMouth, roofBackX);
  if (ball.z + BALL_RADIUS > box.maxZ
      && ball.x + BALL_RADIUS > xLo
      && ball.x - BALL_RADIUS < xHi) {
    ball.z = box.maxZ - BALL_RADIUS;
    if (ball.vz > 0) ball.vz = 0;
  }
}

/**
 * Ball vs cylinder — sphere-cylinder collision used for goal posts
 * and the crossbar. Returns true on contact and emits a bounce event
 * along the true contact normal.
 */
function resolveBallVsCylinder(state, ax, ay, az, bx, by, bz, radius) {
  const ball = state.ball;
  if (ball.frozen) return false;

  const dx = bx - ax, dy = by - ay, dz = bz - az;
  const len2 = dx * dx + dy * dy + dz * dz;
  const rx = ball.x - ax, ry = ball.y - ay, rz = ball.z - az;
  let t = len2 > 0 ? (rx * dx + ry * dy + rz * dz) / len2 : 0;
  if (t < 0) t = 0; else if (t > 1) t = 1;
  const nx = ax + t * dx, ny = ay + t * dy, nz = az + t * dz;

  const vx = ball.x - nx, vy = ball.y - ny, vz = ball.z - nz;
  const dist2 = vx * vx + vy * vy + vz * vz;
  const contact = BALL_RADIUS + radius;
  if (dist2 >= contact * contact) return false;

  const dist = Math.sqrt(dist2);
  const penetration = contact - dist;

  let normX, normY, normZ;
  if (dist > 1e-6) {
    const inv = 1 / dist;
    normX = vx * inv; normY = vy * inv; normZ = vz * inv;
  } else {
    const vmag = Math.hypot(ball.vx, ball.vy, ball.vz);
    if (vmag > 1e-6) {
      normX = -ball.vx / vmag;
      normY = -ball.vy / vmag;
      normZ = -ball.vz / vmag;
    } else {
      normX = 1; normY = 0; normZ = 0;
    }
  }

  ball.x += normX * penetration;
  ball.y += normY * penetration;
  ball.z += normZ * penetration;
  if (ball.z < 0) ball.z = 0;

  const vDotN = ball.vx * normX + ball.vy * normY + ball.vz * normZ;
  if (vDotN < 0) {
    const k = (1 + BOUNCE_RETAIN) * vDotN;
    ball.vx -= k * normX;
    ball.vy -= k * normY;
    ball.vz -= k * normZ;
    const absNx = Math.abs(normX), absNy = Math.abs(normY), absNz = Math.abs(normZ);
    const axis = absNx >= absNy && absNx >= absNz
      ? 'x' : absNy >= absNz ? 'y' : 'z';
    recordBounce(state, axis, Math.abs(vDotN));
  }
  return true;
}

/**
 * Ball vs the three bars at one goal's mouth: left post, right post,
 * crossbar. Bars are solid from BOTH sides — runs every path,
 * inGoal or not.
 */
export function resolveBallVsGoalBars(state, box) {
  const isLeft = box === state.field.goalBoxLeft;
  const mouthX = isLeft ? box.maxX : box.minX;
  const mouthZ = box.maxZ;
  resolveBallVsCylinder(state, mouthX, box.minY, 0,        mouthX, box.minY, mouthZ, GOAL_POST_RADIUS);
  resolveBallVsCylinder(state, mouthX, box.maxY, 0,        mouthX, box.maxY, mouthZ, GOAL_POST_RADIUS);
  resolveBallVsCylinder(state, mouthX, box.minY, mouthZ,   mouthX, box.maxY, mouthZ, GOAL_POST_RADIUS);
}

/**
 * Ball vs one goal's EXTERIOR non-bar faces: back wall, two side
 * walls, roof. Each face is solid in BOTH directions when inGoal=false:
 * a ball straddling the plane gets pushed back to whichever side it
 * came from in the pre-substep position. Runs only when inGoal=false;
 * resolveBallInsideGoal owns the absorbing-net path after a goal counts.
 *
 * Pre-substep position (preX, preY, preZ) is the ball position before
 * this substep's move + post-bar bounce. It's the only reliable
 * side-of signal — current position can be on the "wrong" side after
 * a glancing post bounce, and current velocity reflects whatever the
 * post bounce just imparted, not the ball's prior trajectory.
 */
export function resolveBallVsGoalExterior(state, box, preX, preY, preZ) {
  const ball = state.ball;
  if (ball.frozen) return;
  const isLeft = box === state.field.goalBoxLeft;

  // Back wall — slanted, modeled per-height as a vertical wall at the
  // slope's x for the ball's current ceiling.
  const floorBackX = isLeft ? box.minX : box.maxX;
  const roofBackX  = box.roofBackX;
  const ballCYBack = Math.max(0, Math.min(box.maxZ, ball.z + BALL_RADIUS));
  const slopeXatY  = floorBackX + (ballCYBack / box.maxZ) * (roofBackX - floorBackX);
  if (ball.x - BALL_RADIUS < slopeXatY && ball.x + BALL_RADIUS > slopeXatY
      && ball.y + BALL_RADIUS > box.minY
      && ball.y - BALL_RADIUS < box.maxY
      && ball.z - BALL_RADIUS < box.maxZ) {
    // Inside the box is the mouth side (x > slopeXatY for left,
    // x < slopeXatY for right). Pre-substep position names the side
    // the ball came from.
    const fromInside = isLeft ? preX >= slopeXatY : preX <= slopeXatY;
    if (fromInside) {
      ball.x = slopeXatY + (isLeft ? +1 : -1) * BALL_RADIUS;
      const intoWall = isLeft ? ball.vx < 0 : ball.vx > 0;
      if (intoWall) {
        const pre = Math.abs(ball.vx);
        ball.vx = -ball.vx * BOUNCE_RETAIN;
        recordBounce(state, 'x', pre);
      }
    } else {
      ball.x = slopeXatY + (isLeft ? -1 : +1) * BALL_RADIUS;
      const intoWall = isLeft ? ball.vx > 0 : ball.vx < 0;
      if (intoWall) {
        const pre = Math.abs(ball.vx);
        ball.vx = -ball.vx * BOUNCE_RETAIN;
        recordBounce(state, 'x', pre);
      }
    }
  }
  if (ball.frozen) return;

  // Lower side wall — plane at y=mouthYMin. Pre-substep ball.y >=
  // wallY ⇒ ball was inside the box and is exiting; pre-substep
  // ball.y < wallY ⇒ ball was outside and the wall is glancing it.
  if (ball.y - BALL_RADIUS < box.minY && ball.y + BALL_RADIUS > box.minY
      && ball.x + BALL_RADIUS > box.minX
      && ball.x - BALL_RADIUS < box.maxX
      && ball.z - BALL_RADIUS < box.maxZ) {
    const fromInside = preY >= box.minY;
    if (fromInside) {
      ball.y = box.minY + BALL_RADIUS;
      if (ball.vy < 0) {
        const pre = Math.abs(ball.vy);
        ball.vy = -ball.vy * BOUNCE_RETAIN;
        recordBounce(state, 'y', pre);
      }
    } else {
      ball.y = box.minY - BALL_RADIUS;
      if (ball.vy > 0) {
        const pre = Math.abs(ball.vy);
        ball.vy = -ball.vy * BOUNCE_RETAIN;
        recordBounce(state, 'y', pre);
      }
    }
  }
  if (ball.frozen) return;

  // Upper side wall — plane at y=mouthYMax. Pre-substep ball.y <=
  // wallY ⇒ inside and exiting upward.
  if (ball.y - BALL_RADIUS < box.maxY && ball.y + BALL_RADIUS > box.maxY
      && ball.x + BALL_RADIUS > box.minX
      && ball.x - BALL_RADIUS < box.maxX
      && ball.z - BALL_RADIUS < box.maxZ) {
    const fromInside = preY <= box.maxY;
    if (fromInside) {
      ball.y = box.maxY - BALL_RADIUS;
      if (ball.vy > 0) {
        const pre = Math.abs(ball.vy);
        ball.vy = -ball.vy * BOUNCE_RETAIN;
        recordBounce(state, 'y', pre);
      }
    } else {
      ball.y = box.maxY + BALL_RADIUS;
      if (ball.vy < 0) {
        const pre = Math.abs(ball.vy);
        ball.vy = -ball.vy * BOUNCE_RETAIN;
        recordBounce(state, 'y', pre);
      }
    }
  }
  if (ball.frozen) return;

  // Roof — flat plane at z=mouthZMax, truncated to the front-
  // rectangular portion of the trapezoidal net. Pre-substep ball.z <=
  // wallZ ⇒ inside and hitting the underside.
  const xMouth = isLeft ? box.maxX : box.minX;
  const roofXLo = Math.min(xMouth, roofBackX);
  const roofXHi = Math.max(xMouth, roofBackX);
  if (ball.z - BALL_RADIUS < box.maxZ && ball.z + BALL_RADIUS > box.maxZ
      && ball.x + BALL_RADIUS > roofXLo
      && ball.x - BALL_RADIUS < roofXHi
      && ball.y + BALL_RADIUS > box.minY
      && ball.y - BALL_RADIUS < box.maxY) {
    const fromInside = preZ <= box.maxZ;
    if (fromInside) {
      ball.z = box.maxZ - BALL_RADIUS;
      if (ball.vz > 0) {
        const pre = Math.abs(ball.vz);
        ball.vz = -ball.vz * BOUNCE_RETAIN;
        recordBounce(state, 'z', pre);
      }
    } else {
      ball.z = box.maxZ + BALL_RADIUS;
      if (ball.vz < 0) {
        const pre = Math.abs(ball.vz);
        ball.vz = -ball.vz * BOUNCE_RETAIN;
        recordBounce(state, 'z', pre);
      }
    }
  }
}
