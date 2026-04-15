/**
 * Headless profiling harness for the training hot path.
 *
 * Runs the exact same tight loop that worker.js runs (headless
 * physics, NN forward ×2, action-repeat stride) inside a single
 * Node process so we get stable timings without the browser's
 * GC, scheduler, or HTTP overhead in the picture. Prints a
 * per-subsystem breakdown by deliberately commenting out each
 * subsystem in turn so you can see the delta.
 *
 * Run: node games/football/debug/profile.mjs
 */

import {
  createField, createState, createSeededRng,
  tick as physicsTick, buildInputs,
  NN_INPUT_SIZE, NN_ACTION_STRIDE,
} from '../physics.js';
import { NeuralNet, WEIGHT_COUNT } from '../nn.js';
import { fallbackAction } from '../fallback.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const WARM_PATH = join(HERE, '..', 'warm_start_weights.json');

const weights = new Float64Array(JSON.parse(readFileSync(WARM_PATH, 'utf8')));
if (weights.length !== WEIGHT_COUNT) throw new Error('weights length mismatch');

const MATCH_TICKS = 1500;
const MATCHES = 400;
const p1Brain = new NeuralNet(weights.slice());
const p2Brain = new NeuralNet(weights.slice());
const p1In = new Float64Array(NN_INPUT_SIZE);
const p2In = new Float64Array(NN_INPUT_SIZE);

function runOneMatch() {
  const field = createField();
  const state = createState(field, createSeededRng((Math.random() * 2 ** 31) >>> 0));
  state.headless = true;
  state.graceFrames = 0;
  state.ball.z = 0;
  let ticksDone = 0;
  while (ticksDone < MATCH_TICKS) {
    const p1Action = p1Brain.forward(buildInputs(state, 'p1', p1In));
    const p2Action = p2Brain.forward(buildInputs(state, 'p2', p2In));
    const end = Math.min(ticksDone + NN_ACTION_STRIDE, MATCH_TICKS);
    while (ticksDone < end) {
      physicsTick(state, p1Action, p2Action);
      ticksDone++;
    }
  }
  return state;
}

/* ── Warmup so V8 tiers up ──────────────────────────────── */
for (let i = 0; i < 50; i++) runOneMatch();
if (typeof gc === 'function') gc();

/* ── Full loop × 5 back-to-back to observe variance ───── */
const fullRuns = [];
for (let r = 0; r < 5; r++) {
  if (typeof gc === 'function') gc();
  const t0 = performance.now();
  for (let i = 0; i < MATCHES; i++) runOneMatch();
  fullRuns.push(performance.now() - t0);
}
const fullMs = fullRuns.reduce((a, b) => a + b, 0) / fullRuns.length;
const fullMin = Math.min(...fullRuns);
const fullMax = Math.max(...fullRuns);

/* ── Physics-only (same state progression, no NN) ─────────── */
// Uses the pre-computed last-action vectors so physics still gets
// meaningful inputs. Measures raw physicsTick cost without NN work.
function runOneMatchPhysicsOnly() {
  const field = createField();
  const state = createState(field, createSeededRng((Math.random() * 2 ** 31) >>> 0));
  state.headless = true;
  state.graceFrames = 0;
  state.ball.z = 0;
  const p1Action = fallbackAction(state, 'p1');
  const p2Action = fallbackAction(state, 'p2');
  for (let i = 0; i < MATCH_TICKS; i++) {
    physicsTick(state, p1Action, p2Action);
  }
  return state;
}
for (let i = 0; i < 50; i++) runOneMatchPhysicsOnly();
if (typeof gc === 'function') gc();
const physT0 = performance.now();
for (let i = 0; i < MATCHES; i++) runOneMatchPhysicsOnly();
const physMs = performance.now() - physT0;

/* ── NN-only (no physicsTick) ─────────────────────────────── */
function runOneMatchNNOnly() {
  const field = createField();
  const state = createState(field, createSeededRng((Math.random() * 2 ** 31) >>> 0));
  state.headless = true;
  state.graceFrames = 0;
  state.ball.z = 0;
  let ticksDone = 0;
  while (ticksDone < MATCH_TICKS) {
    p1Brain.forward(buildInputs(state, 'p1', p1In));
    p2Brain.forward(buildInputs(state, 'p2', p2In));
    ticksDone += NN_ACTION_STRIDE;
  }
  return state;
}
for (let i = 0; i < 50; i++) runOneMatchNNOnly();
if (typeof gc === 'function') gc();
const nnT0 = performance.now();
for (let i = 0; i < MATCHES; i++) runOneMatchNNOnly();
const nnMs = performance.now() - nnT0;

/* ── buildInputs-only ─────────────────────────────────────── */
function runOneMatchBuildOnly() {
  const field = createField();
  const state = createState(field, createSeededRng((Math.random() * 2 ** 31) >>> 0));
  state.headless = true;
  state.graceFrames = 0;
  state.ball.z = 0;
  let ticksDone = 0;
  while (ticksDone < MATCH_TICKS) {
    buildInputs(state, 'p1', p1In);
    buildInputs(state, 'p2', p2In);
    ticksDone += NN_ACTION_STRIDE;
  }
  return state;
}
for (let i = 0; i < 50; i++) runOneMatchBuildOnly();
if (typeof gc === 'function') gc();
const buildT0 = performance.now();
for (let i = 0; i < MATCHES; i++) runOneMatchBuildOnly();
const buildMs = performance.now() - buildT0;

/* ── Report ───────────────────────────────────────────────── */

const fmt = (ms, label) => {
  const simsPerSec = (MATCHES / (ms / 1000)).toFixed(0);
  const usPerTick = ((ms * 1000) / (MATCHES * MATCH_TICKS)).toFixed(2);
  console.log(`${label.padEnd(32)} ${ms.toFixed(0).padStart(5)} ms   ${simsPerSec.padStart(5)} sims/s   ${usPerTick.padStart(5)} µs/tick`);
};

console.log(`--- profile (${MATCHES} matches × ${MATCH_TICKS} ticks, stride ${NN_ACTION_STRIDE}) ---`);
console.log('full loop × 5 runs (back-to-back, same V8 process):');
for (let r = 0; r < fullRuns.length; r++) {
  fmt(fullRuns[r], `  run ${r + 1}`);
}
console.log(`  min/avg/max                  ${fullMin.toFixed(0).padStart(5)} / ${fullMs.toFixed(0).padStart(5)} / ${fullMax.toFixed(0).padStart(5)} ms  (spread ${(100 * (fullMax - fullMin) / fullMs).toFixed(0)}%)`);
console.log('');
fmt(fullMs,  'full loop (avg of 5)');
fmt(physMs,  'physicsTick only');
fmt(nnMs,    'NN forward + buildInputs');
fmt(buildMs, 'buildInputs only');
console.log('');
console.log(`NN forward × 2 (inferred) : ${((nnMs - buildMs)).toFixed(0)} ms   ${(((MATCHES * MATCH_TICKS) / NN_ACTION_STRIDE) * 2 / ((nnMs - buildMs) / 1000) / 1000).toFixed(0)} kforwards/s`);
console.log('');
const fullUsPerTick = (fullMs * 1000) / (MATCHES * MATCH_TICKS);
const physUsPerTick = (physMs * 1000) / (MATCHES * MATCH_TICKS);
const nnUsPerTick = ((nnMs - buildMs) * 1000) / (MATCHES * MATCH_TICKS);
const buildUsPerTick = (buildMs * 1000) / (MATCHES * MATCH_TICKS);
console.log(`per-tick breakdown (approx, full loop = ${fullUsPerTick.toFixed(2)} µs):`);
console.log(`  physicsTick      : ${physUsPerTick.toFixed(2)} µs   (${(100 * physUsPerTick / fullUsPerTick).toFixed(0)}%)`);
console.log(`  NN forward × 2   : ${nnUsPerTick.toFixed(2)} µs   (${(100 * nnUsPerTick / fullUsPerTick).toFixed(0)}%)`);
console.log(`  buildInputs × 2  : ${buildUsPerTick.toFixed(2)} µs   (${(100 * buildUsPerTick / fullUsPerTick).toFixed(0)}%)`);
console.log(`  overhead         : ${(fullUsPerTick - physUsPerTick - nnUsPerTick - buildUsPerTick).toFixed(2)} µs   (${(100 * (fullUsPerTick - physUsPerTick - nnUsPerTick - buildUsPerTick) / fullUsPerTick).toFixed(0)}%)`);
