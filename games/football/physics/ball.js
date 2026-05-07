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
  CEILING, FIELD_HEIGHT, GOAL_POST_RADIUS,
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

    checkBallScoreOrOut(state);
    if (ball.frozen) return;
    // Bars (posts + crossbar) are solid from both sides.
    resolveBallVsGoalBars(state, field.goalBoxLeft);
    resolveBallVsGoalBars(state, field.goalBoxRight);
    if (ball.inGoal) {
      // Inside the net — absorb.
      resolveBallInsideGoal(state, field.goalBoxLeft);
      resolveBallInsideGoal(state, field.goalBoxRight);
    } else {
      // Outside the goal — solid bounce planes.
      resolveBallVsGoalExterior(state, field.goalBoxLeft);
      resolveBallVsGoalExterior(state, field.goalBoxRight);
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

function checkBallScoreOrOut(state) {
  const f = state.field;
  const ball = state.ball;
  if (ball.frozen) return;

  // Out-of-bounds: ball fully past either field end.
  if (ball.x + BALL_RADIUS < 0 || ball.x - BALL_RADIUS > f.width) {
    ballOut(state);
    return;
  }

  if (state.graceFrames > 0) return;

  const crossedL = ball.x < f.goalLineL;
  const crossedR = ball.x > f.goalLineR;
  if (!crossedL && !crossedR) return;

  // Goal requires the whole ball past the line AND the ball fully
  // inside the goal mouth opening (between posts, below crossbar).
  // The "ball.x ± BALL_RADIUS inside the back wall" clause prevents
  // a false score for a ball that was never actually kicked into the
  // mouth.
  const fullyPastL = ball.x + BALL_RADIUS <= f.goalLineL
                  && ball.x - BALL_RADIUS >= f.goalLLeft;
  const fullyPastR = ball.x - BALL_RADIUS >= f.goalLineR
                  && ball.x + BALL_RADIUS <= f.goalRRight;
  // Mouth opening is inset by GOAL_POST_RADIUS so the ball must be
  // fully clear of the physical post cylinders.
  const withinMouthY =
    ball.y - BALL_RADIUS >= f.goalMouthYMin + GOAL_POST_RADIUS
    && ball.y + BALL_RADIUS <= f.goalMouthYMax - GOAL_POST_RADIUS;
  const belowCrossbar =
    ball.z + BALL_RADIUS <= f.goalMouthZMax - GOAL_POST_RADIUS;

  const goalL = crossedL && fullyPastL && withinMouthY && belowCrossbar;
  const goalR = crossedR && fullyPastR && withinMouthY && belowCrossbar;
  if (goalL) scoreGoal(state, 'left');
  else if (goalR) scoreGoal(state, 'right');
}
