/**
 * Football v2 — training web worker (postMessage-only).
 *
 * Workers are pure compute: they never talk to the broker, never run
 * matchmaking, never track training state. The main thread owns the
 * population cache, picks matchups via matchmaker.js, and feeds
 * workers batches via postMessage. Workers receive a `population`
 * message with brain weights, then any number of `batch` messages
 * with matchups to execute, and reply with the raw results for the
 * main thread to aggregate and sync to the broker.
 *
 * This kills the broker's hot path entirely (no /matchup, no /results
 * per-match) and unblocks worker compute from the HTTP event loop.
 *
 * Messages:
 *   main → worker:
 *     {type: 'population', brains: [{id, weights: number[]}], matchTicks?}
 *     {type: 'batch', batchId: number, matchups: [{type, p1, p2}]}
 *     {type: 'stop'}
 *   worker → main:
 *     {type: 'results', batchId: number, results: [{p1_id, p2_id, goals_p1, goals_p2}]}
 *     {type: 'ready'}   once the population has been loaded
 *     {type: 'error', message}
 */

import {
  createField,
  createState,
  createSeededRng,
  tick as physicsTick,
  buildInputs,
  NN_INPUT_SIZE,
  NN_ACTION_STRIDE,
} from './physics.js';
import { NeuralNet, WEIGHT_COUNT } from './nn.js';
import { fallbackAction } from './fallback.js';

const DEFAULT_MATCH_TICKS = 1500;
let matchTicks = DEFAULT_MATCH_TICKS;

// Persistent NN instances reused across all matches. The weight
// Float64Array and layer scratch buffers are allocated exactly once
// per worker lifetime; each match calls `loadWeights()` which memcpys
// fresh parameters in without touching the scratch.
const p1Brain = new NeuralNet(new Float64Array(WEIGHT_COUNT));
const p2Brain = new NeuralNet(new Float64Array(WEIGHT_COUNT));
const p1InputBuf = new Float64Array(NN_INPUT_SIZE);
const p2InputBuf = new Float64Array(NN_INPUT_SIZE);

// Local weights cache populated from the main thread's `population`
// message. Keyed by brain id; values are per-brain Float64Arrays.
// Any cache miss during a match (e.g. a stale matchup landed during
// a population swap) is silently skipped — main thread handles it.
const weightsById = new Map();

self.onmessage = (ev) => {
  const msg = ev.data;
  try {
    if (msg.type === 'population') {
      handlePopulation(msg);
    } else if (msg.type === 'batch') {
      handleBatch(msg);
    }
    // 'stop': no-op. The main thread terminates the worker directly.
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err) });
  }
};

function handlePopulation(msg) {
  weightsById.clear();
  for (const brain of msg.brains) {
    // Brain weights may arrive as a plain number[] (JSON) or a typed
    // array (transferable). Either converts to Float64Array cheaply.
    weightsById.set(brain.id, brain.weights instanceof Float64Array
      ? brain.weights
      : new Float64Array(brain.weights));
  }
  if (msg.matchTicks && Number.isFinite(msg.matchTicks)) {
    matchTicks = msg.matchTicks;
  }
  self.postMessage({ type: 'ready' });
}

function handleBatch(msg) {
  const results = [];
  for (const matchup of msg.matchups) {
    const r = runMatch(matchup);
    if (r) results.push(r);
  }
  self.postMessage({ type: 'results', batchId: msg.batchId, results });
}

function runMatch(matchup) {
  const p1Weights = weightsById.get(matchup.p1);
  if (!p1Weights) return null;
  const p2IsFallback = matchup.type === 'fallback';
  const p2Weights = p2IsFallback ? null : weightsById.get(matchup.p2);
  if (!p2IsFallback && !p2Weights) return null;

  const field = createField();
  const seed = (Math.random() * 2 ** 31) >>> 0;
  const state = createState(field, createSeededRng(seed));
  state.headless = true;
  state.graceFrames = 0;
  state.ball.z = 0;

  p1Brain.loadWeights(p1Weights);
  if (!p2IsFallback) p2Brain.loadWeights(p2Weights);

  // Decision-outer / physics-inner stride loop. See physics.js
  // NN_ACTION_STRIDE comment for the training/visual parity rules.
  let ticksDone = 0;
  while (ticksDone < matchTicks) {
    const p1Action = p1Brain.forward(buildInputs(state, 'p1', p1InputBuf));
    const p2Action = p2IsFallback
      ? fallbackAction(state, 'p2')
      : p2Brain.forward(buildInputs(state, 'p2', p2InputBuf));
    const chunkEnd = Math.min(ticksDone + NN_ACTION_STRIDE, matchTicks);
    while (ticksDone < chunkEnd) {
      physicsTick(state, p1Action, p2Action);
      ticksDone++;
    }
  }

  return {
    p1_id: matchup.p1,
    p2_id: p2IsFallback ? null : matchup.p2,
    goals_p1: state.scoreL,
    goals_p2: state.scoreR,
  };
}
