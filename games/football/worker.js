/**
 * Football v2 — training web worker.
 *
 * Spawned by main.js when the user clicks [start]. Terminated on [stop]
 * or when the main-thread pause gate fires (visibilitychange, pagehide).
 *
 * Loop:
 *   1. Fetch a matchup from /api/football/matchup
 *   2. Run the match headlessly using physics.js (tick loop, no wall-clock)
 *   3. Record the result in a local batch
 *   4. Every BATCH_SIZE results, POST to /api/football/results
 *   5. Repeat
 *
 * The matchup response carries the full weight arrays for each brain so
 * the worker never needs to ask "give me the weights for brain id X"
 * separately. This keeps the broker stateless w.r.t. ongoing worker
 * sessions — restart-safe.
 *
 * Messages:
 *   main → worker: {type: 'start', apiBase: '/api/football'}
 *   main → worker: {type: 'stop'}
 *   worker → main: {type: 'batch', posted: N, simsPerSec: X}
 *   worker → main: {type: 'error', message}
 */

import { createField, createState, createSeededRng, tick as physicsTick, buildInputs, TICK_MS, NN_INPUT_SIZE } from './physics.js';
import { NeuralNet } from './nn.js';
import { fallbackAction } from './fallback.js';

const BATCH_SIZE = 10;
const DEFAULT_MATCH_TICKS = 1500; // ~24s of simulated play at 16ms/tick

let running = false;
let apiBase = '/api/football';
let matchTicks = DEFAULT_MATCH_TICKS;

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
    // Use defaults if /config is unreachable
  }

  const batch = [];
  let simsSinceReport = 0;
  let reportStart = Date.now();

  while (running) {
    let matchup;
    try {
      matchup = await fetchMatchup();
    } catch {
      // Broker unreachable — back off briefly and retry.
      await sleep(1000);
      continue;
    }
    if (!matchup) continue;

    const result = runMatch(matchup);
    batch.push(result);
    simsSinceReport++;

    if (batch.length >= BATCH_SIZE) {
      try {
        await postResults(batch);
      } catch {
        // Drop the batch on failure; the broker's population is eventually
        // consistent and one lost batch doesn't break training.
      }
      const elapsed = (Date.now() - reportStart) / 1000;
      const simsPerSec = simsSinceReport / Math.max(0.001, elapsed);
      self.postMessage({ type: 'batch', posted: batch.length, simsPerSec });
      batch.length = 0;
      simsSinceReport = 0;
      reportStart = Date.now();
    }
  }

  // Flush any remaining results on shutdown
  if (batch.length > 0) {
    try {
      await postResults(batch);
    } catch {
      /* drop on shutdown */
    }
  }
}

/* ── Match runner ───────────────────────────────────────── */

// Reused NN input buffers — avoid per-tick allocation in buildInputs().
const p1InputBuf = new Array(NN_INPUT_SIZE);
const p2InputBuf = new Array(NN_INPUT_SIZE);

function runMatch(matchup) {
  const field = createField();
  const seed = (Math.random() * 2 ** 31) >>> 0;
  const state = createState(field, createSeededRng(seed));
  state.graceFrames = 0;

  const p1Brain = new NeuralNet(matchup.p1.weights);
  const p2Brain = matchup.type === 'fallback' ? null : new NeuralNet(matchup.p2.weights);

  for (let i = 0; i < matchTicks; i++) {
    if (state.matchOver) break;
    if (state.pauseState !== null) {
      physicsTick(state, null, null);
      continue;
    }

    const p1Action = p1Brain.forward(buildInputs(state, 'p1', p1InputBuf));
    const p2Action = p2Brain === null
      ? fallbackAction(state, 'p2')
      : p2Brain.forward(buildInputs(state, 'p2', p2InputBuf));

    physicsTick(state, p1Action, p2Action);
  }

  return {
    p1_id: matchup.p1.id,
    p2_id: matchup.type === 'fallback' ? null : matchup.p2.id,
    goals_p1: state.scoreL,
    goals_p2: state.scoreR,
  };
}

/* ── HTTP ─────────────────────────────────────────────────── */

async function fetchMatchup() {
  const res = await fetch(`${apiBase}/matchup`);
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
