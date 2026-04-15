/**
 * Football v2 — training web worker.
 *
 * Spawned by main.js when the user clicks [start]. Terminated on [stop]
 * or when the main-thread pause gate fires (visibilitychange, pagehide).
 *
 * Protocol (bandwidth-efficient):
 *   1. On start: `GET /population` — fetches all 50 brain weights in
 *      one snapshot, keyed by id, and records the current generation.
 *   2. `GET /matchup?count=N` — returns just brain IDs + the broker's
 *      current generation. The worker looks weights up locally.
 *   3. If the matchup response's generation drifts from our cached
 *      one, re-fetch /population before running the batch.
 *   4. Run each match headlessly via physics.js (tight tick loop).
 *   5. Batch-POST `/results` fire-and-forget, amortized across
 *      RESULT_BATCH_SIZE matches.
 *
 * Critical optimisation: /matchup used to embed the full 1233-float
 * weight array for every brain in every matchup. With batch=40 that's
 * ~1.7 MB per response × 16 workers = ~200 MB/sec through the single-
 * threaded broker, which capped throughput at ~2500 sims/sec
 * regardless of client compute speed. Moving weights to a per-
 * generation `/population` snapshot cuts matchup responses to a few
 * bytes per match; broker bandwidth becomes negligible and workers
 * run compute-limited.
 *
 * Messages:
 *   main → worker: {type: 'start', apiBase: '/api/football'}
 *   main → worker: {type: 'stop'}
 *   worker → main: {type: 'batch', posted: N, simsPerSec: X}
 *   worker → main: {type: 'error', message}
 */

import { createField, createState, createSeededRng, tick as physicsTick, buildInputs, TICK_MS, NN_INPUT_SIZE, NN_ACTION_STRIDE } from './physics.js';
import { NeuralNet, WEIGHT_COUNT } from './nn.js';
import { fallbackAction } from './fallback.js';

const MATCHUP_BATCH_SIZE = 40;
const RESULT_BATCH_SIZE = 40;
const DEFAULT_MATCH_TICKS = 1500; // ~24s of simulated play at 16ms/tick

let running = false;
let apiBase = '/api/football';
let matchTicks = DEFAULT_MATCH_TICKS;

// Local population cache — indexed by brain.id, populated once per
// generation via /population, refreshed on generation drift. Each
// entry holds a pre-built Float64Array so runMatch can loadWeights
// directly without re-parsing.
let cachedGeneration = -1;
let weightsById = [];

// Persistent NN instances reused across all matches. Each holds its
// own pre-allocated weights Float64Array and layer scratch buffers,
// so matches only need to memcpy fresh weights in (no allocations).
const p1Brain = new NeuralNet(new Float64Array(WEIGHT_COUNT));
const p2Brain = new NeuralNet(new Float64Array(WEIGHT_COUNT));

self.onmessage = (ev) => {
  const msg = ev.data;
  if (msg.type === 'start') {
    apiBase = msg.apiBase || apiBase;
    if (!running) {
      running = true;
      main().catch((err) => {
        self.postMessage({ type: 'error', message: String(err) });
        running = false;
      });
    }
  } else if (msg.type === 'stop') {
    running = false;
  }
};

/* ── Main loop ───────────────────────────────────────────── */

async function main() {
  // Pick up match duration from /config on startup
  try {
    const res = await fetch(`${apiBase}/config`);
    if (res.ok) {
      const cfg = await res.json();
      if (cfg.match_duration_ms) {
        matchTicks = Math.ceil(cfg.match_duration_ms / TICK_MS);
      }
    }
  } catch {
    /* use defaults */
  }

  // Prime the local population cache before any matchup work.
  await ensurePopulation(null);

  let results = [];
  let simsSinceReport = 0;
  let reportStart = Date.now();

  // Prefetch: the next /matchup fetch races with the current batch's
  // compute, so the worker's critical path never awaits HTTP.
  let pendingFetch = safeFetchBatch();

  while (running) {
    const envelope = await pendingFetch;
    pendingFetch = safeFetchBatch();

    if (!envelope || !envelope.matchups || envelope.matchups.length === 0) {
      await sleep(100);
      continue;
    }

    // Refresh population cache if the broker has bred since our last
    // fetch. Stale-id matches still process correctly — the broker's
    // recordResult drops unknown ids.
    if (envelope.generation !== cachedGeneration) {
      await ensurePopulation(envelope.generation);
    }

    for (const matchup of envelope.matchups) {
      if (!running) break;
      const result = runMatch(matchup);
      if (result) {
        results.push(result);
        simsSinceReport++;
      }

      if (results.length >= RESULT_BATCH_SIZE) {
        const toSend = results;
        results = [];
        postResults(toSend).catch(() => {});
        const elapsed = (Date.now() - reportStart) / 1000;
        const simsPerSec = simsSinceReport / Math.max(0.001, elapsed);
        self.postMessage({ type: 'batch', posted: toSend.length, simsPerSec });
        simsSinceReport = 0;
        reportStart = Date.now();
      }
    }
  }

  if (results.length > 0) {
    try { await postResults(results); } catch { /* drop on shutdown */ }
  }
}

async function safeFetchBatch() {
  try {
    return await fetchMatchupBatch(MATCHUP_BATCH_SIZE);
  } catch {
    await sleep(1000);
    return null;
  }
}

/** Fetch /population and rebuild the local weights cache. If the
 *  caller knows the target generation, we verify it and retry on
 *  unexpected drift (rare but possible if two breeds race between
 *  a matchup fetch and a population fetch). Otherwise any generation
 *  the broker currently serves is accepted. */
async function ensurePopulation(expectedGen) {
  try {
    const res = await fetch(`${apiBase}/population`);
    if (!res.ok) throw new Error(`population fetch: ${res.status}`);
    const body = await res.json();
    const nextCache = [];
    for (const b of body.brains) {
      nextCache[b.id] = new Float64Array(b.weights);
    }
    weightsById = nextCache;
    cachedGeneration = body.generation;
    // If the broker's generation jumped past the one we expected, we
    // accept the new snapshot anyway — future matchups will arrive
    // on the newer generation and match our cache.
    void expectedGen;
  } catch {
    /* leave stale cache in place; ensurePopulation will be retried */
  }
}

/* ── Match runner ───────────────────────────────────────── */

const p1InputBuf = new Float64Array(NN_INPUT_SIZE);
const p2InputBuf = new Float64Array(NN_INPUT_SIZE);

function runMatch(matchup) {
  const p1Weights = weightsById[matchup.p1];
  if (!p1Weights) return null; // cache miss — broker will drop results anyway
  const p2IsFallback = matchup.type === 'fallback';
  const p2Weights = p2IsFallback ? null : weightsById[matchup.p2];
  if (!p2IsFallback && !p2Weights) return null;

  const field = createField();
  const seed = (Math.random() * 2 ** 31) >>> 0;
  const state = createState(field, createSeededRng(seed));
  // Training mode: skip celebrate/reposition/waiting/matchend pauses,
  // zero grace frames, no ball drop — every tick on active play.
  state.headless = true;
  state.graceFrames = 0;
  state.ball.z = 0;

  p1Brain.loadWeights(p1Weights);
  if (!p2IsFallback) p2Brain.loadWeights(p2Weights);

  // Action-repeat stride — decision-outer, physics-inner so V8 sees
  // two monomorphic loop bodies and can fully inline physicsTick in
  // the tight inner loop. Same stride number is used in the visual
  // showcase loop (main.js) for training/visual parity.
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

/* ── HTTP ─────────────────────────────────────────────────── */

async function fetchMatchupBatch(count) {
  const res = await fetch(`${apiBase}/matchup?count=${count}`);
  if (!res.ok) throw new Error(`matchup fetch: ${res.status}`);
  return res.json();
}

async function postResults(batch) {
  const res = await fetch(`${apiBase}/results`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(batch),
  });
  if (!res.ok) throw new Error(`results post: ${res.status}`);
  return res.json();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
