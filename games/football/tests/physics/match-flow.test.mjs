import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  tick,
  FIELD_HEIGHT,
  BALL_RADIUS,
  endMatchByTime,
} from '../../physics/index.js';
import {
  freshState,
  NOOP,
} from '../helpers/state.mjs';

test('ball past the OOB margin triggers out, not goal', () => {
  const state = freshState();
  const f = state.field;
  // Place the ball far past the right-edge OOB margin with outward velocity
  state.ball.x = f.width + 100;
  state.ball.y = FIELD_HEIGHT / 2;
  state.ball.z = 0;
  state.ball.vx = 5;
  state.ball.vy = 0;
  state.ball.vz = 0;

  tick(state, NOOP, NOOP);

  // Ball is no longer frozen on OOB — it keeps moving (and falls)
  // while the reposition pause plays out.
  assert.equal(state.pauseState, 'reposition',
    'reposition pause should fire on OOB');
  assert.ok(
    state.events.some(e => e.type === 'out'),
    'out event expected'
  );
  assert.ok(
    !state.events.some(e => e.type === 'goal'),
    'no goal event should fire when ball is OOB'
  );
  assert.equal(state.scoreL, 0);
  assert.equal(state.scoreR, 0);
});

test('ball straddling the goal line (center past, edge not past) does NOT score', () => {
  const state = freshState();
  const f = state.field;
  // Center is past the line by 1, but the near edge is still on the field
  // side (ball.x - BALL_RADIUS < goalLineR). This is the "partial cross"
  // case the new stricter rule rejects.
  state.ball.x = f.goalLineR + 1;
  state.ball.y = (f.goalMouthYMin + f.goalMouthYMax) / 2;
  state.ball.z = 0;
  state.ball.vx = 0;
  state.ball.vy = 0;
  state.ball.vz = 0;

  tick(state, NOOP, NOOP);

  assert.equal(state.scoreL, 0, 'no goal on partial cross');
  assert.equal(state.scoreR, 0);
  assert.ok(
    !state.events.some(e => e.type === 'goal'),
    'no goal event on partial cross'
  );
});

test('ball crossing left field edge triggers OOB', () => {
  const state = freshState();
  state.ball.x = 5;
  state.ball.y = 27;
  state.ball.z = 0;
  state.ball.vx = -6;
  state.ball.vy = 0;
  state.ball.frozen = false;
  for (let i = 0; i < 10 && state.pauseState === null; i++) tick(state, NOOP, NOOP);
  // Out triggers reposition pause (ballOut() in physics.js)
  assert.ok(
    state.pauseState !== null,
    'ball going off left edge should trigger OOB / ball reposition',
  );
});

test('ball crossing right field edge triggers OOB', () => {
  const state = freshState();
  const f = state.field;
  state.ball.x = f.width - 5;
  state.ball.y = 27;
  state.ball.z = 0;
  state.ball.vx = 6;
  state.ball.vy = 0;
  state.ball.frozen = false;
  for (let i = 0; i < 10 && state.pauseState === null; i++) tick(state, NOOP, NOOP);
  assert.ok(
    state.pauseState !== null,
    'ball going off right edge should trigger OOB / ball reposition',
  );
});

test('goal scored from mouth center', () => {
  const state = freshState();
  const f = state.field;
  state.ball.x = 120;
  state.ball.y = (f.goalMouthYMin + f.goalMouthYMax) / 2;
  state.ball.z = 0;
  state.ball.vx = -5; state.ball.vy = 0; state.ball.vz = 0;
  state.ball.frozen = false;
  for (let i = 0; i < 40 && state.pauseState !== 'celebrate'; i++) tick(state, NOOP, NOOP);
  assert.equal(state.pauseState, 'celebrate');
  assert.equal(state.scoreR, 1, 'p2 should have scored on the left goal');
});

test('goal scored from mouth center on the right', () => {
  const state = freshState();
  const f = state.field;
  state.ball.x = f.width - 120;
  state.ball.y = (f.goalMouthYMin + f.goalMouthYMax) / 2;
  state.ball.z = 0;
  state.ball.vx = 5; state.ball.vy = 0; state.ball.vz = 0;
  state.ball.frozen = false;
  for (let i = 0; i < 40 && state.pauseState !== 'celebrate'; i++) tick(state, NOOP, NOOP);
  assert.equal(state.pauseState, 'celebrate');
  assert.equal(state.scoreL, 1);
});

test('shot well wide of the goal passes behind without scoring', () => {
  const state = freshState();
  const f = state.field;
  state.ball.x = 120;
  state.ball.y = 5;                // way below mouth y
  state.ball.z = 0;
  state.ball.vx = -5; state.ball.vy = 0; state.ball.vz = 0;
  state.ball.frozen = false;
  // Should NOT score; should travel past the goal area and eventually OOB
  // when it crosses x < -BALL_RADIUS.
  for (let i = 0; i < 60 && state.pauseState === null; i++) tick(state, NOOP, NOOP);
  assert.equal(state.scoreR, 0);
  // After enough time the ball goes OOB on the left edge.
  assert.ok(
    state.pauseState !== null || state.ball.x > 0,
    'wide ball should either OOB or still be traveling, never score',
  );
});

test('diagonal shot into the mouth center scores', () => {
  const state = freshState();
  const f = state.field;
  state.ball.x = 140;
  state.ball.y = 15;
  state.ball.z = 0;
  state.ball.vx = -5; state.ball.vy = 1.2; state.ball.vz = 0;
  state.ball.frozen = false;
  for (let i = 0; i < 40 && state.pauseState !== 'celebrate'; i++) tick(state, NOOP, NOOP);
  assert.equal(state.pauseState, 'celebrate', 'diagonal into mouth must score');
});

test('both players regain full stamina when a goal is scored', () => {
  const state = freshState();
  const f = state.field;

  // Pre-drain both players so the reset is observable.
  state.p1.stamina = 0.15;
  state.p2.stamina = 0.22;
  state.p1.exhausted = true;
  state.p2.exhausted = true;

  // Fire a ball straight into the left goal mouth.
  state.ball.x = 120;
  state.ball.y = (f.goalMouthYMin + f.goalMouthYMax) / 2;
  state.ball.z = 0;
  state.ball.vx = -5;
  state.ball.vy = 0;
  state.ball.vz = 0;
  state.ball.frozen = false;

  for (let i = 0; i < 40 && state.pauseState !== 'celebrate'; i++) {
    tick(state, NOOP, NOOP);
  }
  assert.equal(state.pauseState, 'celebrate', 'goal should have triggered celebrate pause');

  assert.equal(state.p1.stamina, 1, 'p1 stamina must reset to full on goal');
  assert.equal(state.p2.stamina, 1, 'p2 stamina must reset to full on goal');
  assert.equal(state.p1.exhausted, false);
  assert.equal(state.p2.exhausted, false);
});

test('headless scoreGoal resets pitch instantly, no pause', () => {
  const state = freshState();
  state.headless = true;
  const f = state.field;

  // Drain stamina + park players off-center so the reset is observable
  state.p1.stamina = 0.2; state.p2.stamina = 0.3;
  state.p1.x = 500; state.p1.y = 3;
  state.p2.x = 600; state.p2.y = 40;

  // Fire the ball into the left goal
  state.ball.x = 120;
  state.ball.y = (f.goalMouthYMin + f.goalMouthYMax) / 2;
  state.ball.z = 0;
  state.ball.vx = -5; state.ball.vy = 0; state.ball.vz = 0;
  state.ball.frozen = false;

  for (let i = 0; i < 40 && state.scoreR === 0; i++) tick(state, NOOP, NOOP);
  assert.equal(state.scoreR, 1, 'goal should have scored');

  // No pause at all
  assert.equal(state.pauseState, null, 'headless should bypass all pauses');
  assert.equal(state.pauseTimer, 0);
  assert.equal(state.goalScorer, null, 'headless skips the scorer celebration pointer');
  assert.equal(state.graceFrames, 0);

  // Players teleported back to kickoff with zero velocity
  const midY = FIELD_HEIGHT / 2;
  assert.ok(Math.abs(state.p1.y - midY) < 1, `p1.y ≈ midY, got ${state.p1.y}`);
  assert.ok(Math.abs(state.p2.y - midY) < 1, `p2.y ≈ midY, got ${state.p2.y}`);
  assert.equal(state.p1.vx, 0); assert.equal(state.p1.vy, 0);
  assert.equal(state.p2.vx, 0); assert.equal(state.p2.vy, 0);
  assert.equal(state.p1.pushTimer, 0);
  assert.equal(state.p1.kick.active, false);

  // Ball reset to center, on the ground, stationary, unfrozen
  assert.ok(Math.abs(state.ball.x - f.midX) < 1);
  assert.equal(state.ball.z, 0);
  assert.equal(state.ball.vx, 0);
  assert.equal(state.ball.frozen, false);

  // And critically: play can resume the very next tick
  const tickBefore = state.tick;
  tick(state, NOOP, NOOP);
  assert.equal(state.tick, tickBefore + 1);
  assert.equal(state.pauseState, null, 'still no pause after advancing');
});

test('headless ends match at WIN_SCORE (capped like visual)', () => {
  const state = freshState();
  state.headless = true;
  state.scoreL = 2; // one goal short of WIN_SCORE=3
  const f = state.field;

  state.ball.x = f.width - 120;
  state.ball.y = (f.goalMouthYMin + f.goalMouthYMax) / 2;
  state.ball.z = 0;
  state.ball.vx = 5; state.ball.vy = 0; state.ball.vz = 0;
  state.ball.frozen = false;

  for (let i = 0; i < 40 && state.scoreL < 3; i++) tick(state, NOOP, NOOP);
  assert.equal(state.scoreL, 3, 'third goal should have scored');
  assert.equal(state.matchOver, true, 'headless should set matchOver at WIN_SCORE');
  // Winner recorded but no pause-state (headless skips the celebrate).
  assert.equal(state.pauseState, null);
  assert.equal(state.winner, 'left');
});

test('headless instant-resets below WIN_SCORE (keeps playing)', () => {
  const state = freshState();
  state.headless = true;
  state.scoreL = 0; // plenty of room before WIN_SCORE
  const f = state.field;

  state.ball.x = f.width - 120;
  state.ball.y = (f.goalMouthYMin + f.goalMouthYMax) / 2;
  state.ball.z = 0;
  state.ball.vx = 5; state.ball.vy = 0; state.ball.vz = 0;
  state.ball.frozen = false;

  for (let i = 0; i < 40 && state.scoreL < 1; i++) tick(state, NOOP, NOOP);
  assert.equal(state.scoreL, 1, 'first goal should have scored');
  assert.equal(state.matchOver, false, 'non-winning goal must not end match');
  assert.equal(state.winner, null);
});

test('visual mode still runs the celebrate pause unchanged', () => {
  // Regression: the headless branch must not leak into visual mode.
  const state = freshState();
  // headless defaults to false
  const f = state.field;
  state.ball.x = 120;
  state.ball.y = (f.goalMouthYMin + f.goalMouthYMax) / 2;
  state.ball.z = 0;
  state.ball.vx = -5; state.ball.vy = 0; state.ball.vz = 0;
  state.ball.frozen = false;

  for (let i = 0; i < 40 && state.pauseState !== 'celebrate'; i++) {
    tick(state, NOOP, NOOP);
  }
  assert.equal(state.pauseState, 'celebrate', 'visual mode still celebrates');
  assert.ok(state.goalScorer !== null, 'visual mode still flags the scorer');
});

test('ball arriving from BEHIND the right goal does not tunnel through the back', () => {
  const state = freshState();
  state.headless = true;  // skip pause state machine
  const f = state.field;
  // Start outside the goal's back wall, moving left (toward midfield).
  // Without the fix, the "open mouth" exemption fires anywhere inside
  // the goal AABB and the ball passes straight through.
  state.ball.x = f.goalRRight + 3;
  state.ball.y = (f.goalMouthYMin + f.goalMouthYMax) / 2;
  state.ball.z = 5;
  state.ball.vx = -30; state.ball.vy = 0; state.ball.vz = 0;
  state.ball.frozen = false;
  const startScore = state.scoreL + state.scoreR;

  tick(state, NOOP, NOOP);

  // Ball from behind must not score for either side.
  assert.equal(state.scoreL + state.scoreR, startScore,
    'ball entering from behind must not score');
  // Ball must still be at or behind the back wall (it bounced off),
  // not on the field side of the line.
  assert.ok(
    state.ball.x >= f.goalRRight - 0.5,
    `ball crossed back wall: x=${state.ball.x}`,
  );
});

test('ball arriving from BEHIND the left goal does not tunnel through the back', () => {
  const state = freshState();
  state.headless = true;
  const f = state.field;
  state.ball.x = f.goalLLeft - 3;
  state.ball.y = (f.goalMouthYMin + f.goalMouthYMax) / 2;
  state.ball.z = 5;
  state.ball.vx = 30; state.ball.vy = 0; state.ball.vz = 0;
  state.ball.frozen = false;
  const startScore = state.scoreL + state.scoreR;

  tick(state, NOOP, NOOP);

  assert.equal(state.scoreL + state.scoreR, startScore,
    'ball entering from behind must not score');
  assert.ok(
    state.ball.x <= f.goalLLeft + 0.5,
    `ball crossed back wall: x=${state.ball.x}`,
  );
});

test('slow shot directly into the mouth still scores cleanly (regression)', () => {
  const state = freshState();
  state.headless = true;  // skip celebrate pause
  const f = state.field;
  state.ball.x = f.goalLineR - 5;
  state.ball.y = (f.goalMouthYMin + f.goalMouthYMax) / 2;
  state.ball.z = 5;
  state.ball.vx = 12; state.ball.vy = 0; state.ball.vz = 0;
  state.ball.frozen = false;

  // Ball travels into right goal → scores for LEFT team (p1).
  for (let i = 0; i < 30 && state.scoreL === 0; i++) {
    tick(state, NOOP, NOOP);
  }

  assert.equal(state.scoreL, 1, 'slow shot into right mouth should still score');
});

test('ball goes out of bounds without freezing', () => {
  const state = freshState();
  const f = state.field;
  state.ball.x = f.width + 2;  // past field edge
  state.ball.y = FIELD_HEIGHT / 2;
  state.ball.z = 0;
  state.ball.vx = 5; state.ball.vy = 0; state.ball.vz = 0;
  state.ball.frozen = false;

  tick(state, NOOP, NOOP);

  assert.equal(state.pauseState, 'reposition', 'reposition should fire on OOB');
  assert.equal(state.ball.frozen, false, 'ball should not freeze on OOB');
});

test('reset after pause clears inGoal so next play uses outer resolver', () => {
  const state = freshState();
  state.ball.inGoal = true;
  state.pauseState = 'waiting';
  state.pauseTimer = 1;
  // Run enough ticks for the waiting pause to elapse and resetBall to fire.
  for (let i = 0; i < 5; i++) tick(state, NOOP, NOOP);
  assert.equal(state.ball.inGoal, false,
    'inGoal should be cleared when the ball is reset for kickoff');
});

test('winning goal goes straight to matchend reposition (no at-spot celebrate)', () => {
  const state = freshState();
  state.headless = false;
  state.recordEvents = false;
  // Ball crossing goalLineR (into the right goal) credits scoreL.
  // See project_football_scoring_sides memory: side arg names the
  // goal that conceded. Pre-seed scoreL=2 so the next score is 3 = win.
  state.scoreL = 2;
  state.ball.x = state.field.goalLineR - 1;   // field side, just outside line
  state.ball.y = FIELD_HEIGHT / 2;
  state.ball.z = 0;
  state.ball.vx = 12;                         // fast enough to fully cross the slab in one tick
  state.ball.vy = 0;
  state.ball.vz = 0;
  state.graceFrames = 0;

  tick(state, null, null);

  assert.equal(state.scoreL, 3, 'left-side scored the winning goal');
  assert.equal(state.pauseState, 'matchend', 'winning goal skips celebrate and enters matchend immediately');
  assert.equal(state.matchEndPhase, 'reposition', 'matchend opens on the reposition (walk-back) phase');
  assert.equal(state.winner, 'left', 'winner must be flagged at the scoring tick');
  assert.equal(state.goalScorer, null, 'no celebrate-at-spot on a winning goal');
  assert.equal(state.matchOver, false, 'match is not over until the cinematic completes');
});

test('time-up matchend (no winner) walks back then finalizes — no pose/neutral', () => {
  const state = freshState();
  state.headless = false;
  state.recordEvents = false;

  // Move both players away from kickoff so reposition has work to do.
  state.p1.x = 300; state.p1.y = 30;
  state.p2.x = 350; state.p2.y = 20;

  endMatchByTime(state);
  assert.equal(state.pauseState, 'matchend');
  assert.equal(state.matchEndPhase, 'reposition');
  assert.equal(state.winner, null, 'time-up matchend has no winner');

  // Idempotent — second call while already in matchend is a no-op.
  endMatchByTime(state);
  assert.equal(state.matchEndPhase, 'reposition');

  // Run reposition to completion. With no winner, finalize fires
  // directly on arrival — no pose / neutral phase.
  for (let i = 0; i < 600 && !state.matchOver; i++) {
    tick(state, null, null);
  }
  assert.equal(state.matchOver, true, 'time-up matchend finalizes after walk-back');
  assert.equal(state.pauseState, null);
  assert.equal(state.matchEndPhase, null);
  assert.equal(state.winner, null);
});

test('matchend phase machine: reposition → pose → neutral → finalize', () => {
  const state = freshState();
  state.headless = false;
  state.recordEvents = false;
  state.scoreL = 2;
  state.ball.x = state.field.goalLineR - 1;
  state.ball.y = FIELD_HEIGHT / 2;
  state.ball.z = 0;
  state.ball.vx = 12;
  state.graceFrames = 0;
  tick(state, null, null);

  assert.equal(state.pauseState, 'matchend');
  assert.equal(state.matchEndPhase, 'reposition');

  // Reposition completes once both players reach their kickoff spots.
  // Cap at the safety horizon so a stuck reposition still fails loudly.
  for (let i = 0; i < 600 && state.matchEndPhase === 'reposition'; i++) {
    tick(state, null, null);
  }
  assert.equal(state.matchEndPhase, 'pose', 'reposition advances to pose when both at kickoff');

  for (let i = 0; i < 1000 && state.matchEndPhase === 'pose'; i++) tick(state, null, null);
  assert.equal(state.matchEndPhase, 'neutral', 'pose advances to neutral after timer expires');

  for (let i = 0; i < 1000 && state.matchEndPhase === 'neutral'; i++) tick(state, null, null);
  assert.equal(state.matchOver, true, 'neutral phase finalizes the match');
  assert.equal(state.pauseState, null);
  assert.equal(state.matchEndPhase, null);
});

test('non-winning goal celebrates then reposition (no matchend)', () => {
  const state = freshState();
  state.headless = false;
  state.recordEvents = false;
  state.scoreR = 0;   // first goal of the match, nowhere near WIN_SCORE
  state.ball.x = state.field.goalLineR - 1;
  state.ball.y = FIELD_HEIGHT / 2;
  state.ball.z = 0;
  state.ball.vx = 12;
  state.graceFrames = 0;
  tick(state, null, null);

  assert.equal(state.pauseState, 'celebrate');
  assert.equal(state.winner, null, 'non-winning goal must NOT flag winner');
  const celebrateTicks = state.pauseTimer;

  for (let i = 0; i < celebrateTicks + 5; i++) {
    tick(state, null, null);
    if (state.pauseState !== 'celebrate') break;
  }
  assert.notEqual(state.pauseState, 'matchend', 'non-winning goal must NOT go to matchend');
  assert.ok(state.pauseState === 'reposition' || state.pauseState === 'waiting' || state.pauseState === null,
    `expected reposition/waiting/null after celebrate, got ${state.pauseState}`);
});
