/**
 * Football v2 — ball physics + scoring gates.
 *
 * Per-tick ball integrator: gravity (one z step), horizontal substep
 * loop (so a hard shot can't tunnel past a thin post / back wall),
 * field-wall bounce, ceiling bounce, friction, low-velocity cutoff.
 * Inside the substep loop: scoring + OOB check, goal-bar collisions,
 * goal interior absorber / exterior bounce, ball-vs-player body
 * capsule trap.
 */

import {
  GRAVITY, AIR_FRICTION, GROUND_FRICTION,
  AIR_BOUNCE, WALL_BOUNCE_DAMP, BOUNCE_VZ_MIN,
  BALL_VEL_CUTOFF_SQ, BALL_RADIUS,
  CEILING, FIELD_HEIGHT,
} from './tuning.js';
import {
  recordBounce,
  resolveBallVsGoalBars, resolveBallVsGoalExterior, resolveBallInsideGoal,
} from './geometry.js';
import { resolveBallVsPlayerBody } from './collisions.js';
import { scoreGoal, ballOut } from './match-flow.js';

export function updateBall(state) {
  const ball = state.ball;
  if (ball.frozen) return;

  // Z physics in one step per tick (gravity + ground/ceiling bounces).
  // Horizontal motion is what tunnels through thin goal surfaces, so
  // only those get substepped below.
  if (ball.z > 0 || ball.vz > 0) {
    ball.vz -= GRAVITY;
    ball.z += ball.vz;
    if (ball.z <= 0) {
      const preVz = Math.abs(ball.vz);
      ball.z = 0;
      if (preVz > BOUNCE_VZ_MIN) {
        ball.vz = preVz * AIR_BOUNCE;
        recordBounce(state, 'z', preVz);
      } else {
        ball.vz = 0;
      }
    }
  }
  if (ball.z > CEILING) {
    const preVz = Math.abs(ball.vz);
    ball.z = CEILING;
    ball.vz = -preVz * AIR_BOUNCE;
    recordBounce(state, 'z', preVz);
  }

  // Horizontal motion in substeps so a hard shot can't tunnel past
  // a thin post / back wall.
  const motionXY = Math.sqrt(ball.vx * ball.vx + ball.vy * ball.vy);
  const substeps = motionXY > BALL_RADIUS ? Math.ceil(motionXY / BALL_RADIUS) : 1;
  const invN = 1 / substeps;
  const field = state.field;

  for (let s = 0; s < substeps; s++) {
    // Pre-substep position — passed to the goal-exterior resolver so
    // it can tell which side the ball was on before this substep
    // moved (and a possible post-bar bounce shoved) it. Position is
    // the only reliable side-of signal: post bounces can flip
    // velocity in arbitrary directions.
    const preX = ball.x;
    const preY = ball.y;
    const preZ = ball.z;
    ball.x += ball.vx * invN;
    ball.y += ball.vy * invN;

    if (ball.y < BALL_RADIUS) {
      const preVy = Math.abs(ball.vy);
      ball.y = BALL_RADIUS;
      ball.vy = preVy * WALL_BOUNCE_DAMP;
      recordBounce(state, 'y', preVy);
    } else if (ball.y > FIELD_HEIGHT - BALL_RADIUS) {
      const preVy = Math.abs(ball.vy);
      ball.y = FIELD_HEIGHT - BALL_RADIUS;
      ball.vy = -preVy * WALL_BOUNCE_DAMP;
      recordBounce(state, 'y', preVy);
    }

    checkBallScoreOrOut(state, preX);
    if (ball.frozen) return;
    // Bars (posts + crossbar) are solid from both sides.
    resolveBallVsGoalBars(state, field.goalBoxLeft);
    resolveBallVsGoalBars(state, field.goalBoxRight);
    if (ball.inGoal) {
      // Inside the net — absorb.
      resolveBallInsideGoal(state, field.goalBoxLeft);
      resolveBallInsideGoal(state, field.goalBoxRight);
    } else {
      // Outside the goal — solid bounce planes (bidirectional).
      resolveBallVsGoalExterior(state, field.goalBoxLeft, preX, preY, preZ);
      resolveBallVsGoalExterior(state, field.goalBoxRight, preX, preY, preZ);
    }
    if (ball.frozen) return;
    // Ball vs player bodies — cushion + deflect trap. On a clamp,
    // break the substep loop.
    const hit1 = resolveBallVsPlayerBody(state, state.p1);
    const hit2 = resolveBallVsPlayerBody(state, state.p2);
    if (hit1 || hit2) break;
  }

  const friction = ball.z > 0 ? AIR_FRICTION : GROUND_FRICTION;
  ball.vx *= friction;
  ball.vy *= friction;

  if (ball.vx * ball.vx < BALL_VEL_CUTOFF_SQ) ball.vx = 0;
  if (ball.vy * ball.vy < BALL_VEL_CUTOFF_SQ) ball.vy = 0;
}

function checkBallScoreOrOut(state, preX) {
  const f = state.field;
  const ball = state.ball;
  if (ball.frozen) return;

  // Out-of-bounds: ball fully past either field end.
  if (ball.x + BALL_RADIUS < 0 || ball.x - BALL_RADIUS > f.width) {
    ballOut(state);
    return;
  }

  // Track inward goal-line crossings — set when the ball center
  // transitions from the field side to the goal side this substep,
  // cleared on resetBall. Goals only fire when the corresponding
  // flag is set, so a ball that fell into a goal box from behind
  // (past the back wall, never crossed the line) cannot score.
  if (preX > f.goalLineL && ball.x <= f.goalLineL) ball.crossedLineL = true;
  if (preX < f.goalLineR && ball.x >= f.goalLineR) ball.crossedLineR = true;

  if (state.graceFrames > 0) return;

  if (ball.crossedLineL && ballFullyCrossedSensor(ball, f.goalSensorLeft, 'left')) {
    scoreGoal(state, 'left');
    return;
  }
  if (ball.crossedLineR && ballFullyCrossedSensor(ball, f.goalSensorRight, 'right')) {
    scoreGoal(state, 'right');
  }
}

// Ball is fully past the slab's back face AND its y/z extents fit
// through the mouth aperture. Posts and the crossbar are physical
// (sphere-cylinder collision in geometry.js::resolveBallVsGoalBars),
// so any trajectory that would clip them is bounced before this
// check sees it — the aperture spans post-to-post and floor-to-
// crossbar with no inset.
function ballFullyCrossedSensor(ball, s, side) {
  const fullyPast = side === 'left'
    ? ball.x + BALL_RADIUS <= s.minX
    : ball.x - BALL_RADIUS >= s.maxX;
  if (!fullyPast) return false;
  return ball.y >= s.minY
      && ball.y <= s.maxY
      && ball.z >= s.minZ
      && ball.z + BALL_RADIUS <= s.maxZ;
}
