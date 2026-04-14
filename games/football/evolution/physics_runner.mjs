#!/usr/bin/env node
/**
 * Parity-test driver for physics.js.
 *
 * Reads a scenario JSON from stdin, runs N ticks through the JS physics,
 * writes a trajectory JSON to stdout. Python's physics_py.py runs the
 * same scenario and test_parity.py compares tick-by-tick.
 *
 * Scenario shape:
 *   {
 *     "seed":       <int>,                     // PRNG seed
 *     "fieldWidth": <number>,                   // default 900
 *     "numTicks":   <int>,                     // how many ticks to run
 *     "actions":    [[p1Act, p2Act], ...]      // per-tick action pairs; null = no action
 *     "initialOverrides": { p1: {x, y, ...}, p2: {...}, ball: {...} }  // optional
 *   }
 *
 * Trajectory output shape:
 *   [{ tick, p1, p2, ball, scoreL, scoreR, events }, ...]
 */

import { createField, createState, createSeededRng, tick as physicsTick } from '../physics.js';

let input = '';
process.stdin.on('data', (chunk) => (input += chunk));
process.stdin.on('end', () => {
  const scenario = JSON.parse(input);
  const field = createField(scenario.fieldWidth ?? 900);
  const state = createState(field, createSeededRng(scenario.seed));

  // Optional initial state overrides
  if (scenario.initialOverrides) {
    applyOverrides(state, scenario.initialOverrides);
  }
  // Always zero graceFrames so goal checks are active from tick 1
  state.graceFrames = 0;

  const trajectory = [];
  const numTicks = scenario.numTicks ?? scenario.actions?.length ?? 100;
  for (let i = 0; i < numTicks; i++) {
    const [p1Act, p2Act] = scenario.actions?.[i] ?? [null, null];
    physicsTick(state, p1Act, p2Act);
    trajectory.push(snapshot(state));
  }

  process.stdout.write(JSON.stringify({ trajectory }));
});

function applyOverrides(state, overrides) {
  if (overrides.p1) Object.assign(state.p1, overrides.p1);
  if (overrides.p2) Object.assign(state.p2, overrides.p2);
  if (overrides.ball) Object.assign(state.ball, overrides.ball);
}

function snapshot(state) {
  return {
    tick: state.tick,
    p1: {
      x: state.p1.x, y: state.p1.y,
      vx: state.p1.vx, vy: state.p1.vy,
      stamina: state.p1.stamina,
    },
    p2: {
      x: state.p2.x, y: state.p2.y,
      vx: state.p2.vx, vy: state.p2.vy,
      stamina: state.p2.stamina,
    },
    ball: {
      x: state.ball.x, y: state.ball.y, z: state.ball.z,
      vx: state.ball.vx, vy: state.ball.vy, vz: state.ball.vz,
      frozen: state.ball.frozen,
    },
    scoreL: state.scoreL,
    scoreR: state.scoreR,
    events: state.events,
  };
}
