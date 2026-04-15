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
import { NeuralNet, WEIGHT_COUNT } from './nn.js';
import { fallbackAction } from './fallback.js';

// Fetch this many matchups per /matchup GET. Amortizes HTTP latency +
// JSON decode across many matches — at ~60 matches/sec per worker, a
// batch of 20 means one /matchup fetch every ~330ms instead of one per
// match. Bigger batches lose less work to breeding staleness but waste
// more on cache-miss rebuilds.
const MATCHUP_BATCH_SIZE = 20;
// Post this many results per /results POST.
const RESULT_BATCH_SIZE = 20;
const DEFAULT_MATCH_TICKS = 1500; // ~24s of simulated play at 16ms/tick

let running = false;
let apiBase = '/api/football';
let matchTicks = DEFAULT_MATCH_TICKS;

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
    // Use defaults if /config is unreachable
  }

  const results = [];
  let simsSinceReport = 0;
  let reportStart = Date.now();

  while (running) {
    let matchups;
    try {
      matchups = await fetchMatchupBatch(MATCHUP_BATCH_SIZE);
    } catch {
      // Broker unreachable — back off briefly and retry.
      await sleep(1000);
      continue;
    }
    if (!matchups || matchups.length === 0) {
      await sleep(100);
      continue;
    }

    for (const matchup of matchups) {
      if (!running) break;
      results.push(runMatch(matchup));
      simsSinceReport++;

      if (results.length >= RESULT_BATCH_SIZE) {
        try {
          await postResults(results);
        } catch {
          /* drop on failure — broker is eventually consistent */
        }
        const elapsed = (Date.now() - reportStart) / 1000;
        const simsPerSec = simsSinceReport / Math.max(0.001, elapsed);
        self.postMessage({ type: 'batch', posted: results.length, simsPerSec });
        results.length = 0;
        simsSinceReport = 0;
        reportStart = Date.now();
      }
    }
  }

  // Flush any remaining results on shutdown
  if (results.length > 0) {
    try {
      await postResults(results);
    } catch {
      /* drop on shutdown */
    }
  }
}

/* ── Match runner ───────────────────────────────────────── */

// Reused NN input buffers — typed so the NN forward loop can read
// them via Float64Array fast paths without deopting on mixed-type
// element access.
const p1InputBuf = new Float64Array(NN_INPUT_SIZE);
const p2InputBuf = new Float64Array(NN_INPUT_SIZE);

function runMatch(matchup) {
  const field = createField();
  const seed = (Math.random() * 2 ** 31) >>> 0;
  const state = createState(field, createSeededRng(seed));
  state.graceFrames = 0;

  p1Brain.loadWeights(matchup.p1.weights);
  const p2IsFallback = matchup.type === 'fallback';
  if (!p2IsFallback) p2Brain.loadWeights(matchup.p2.weights);

  for (let i = 0; i < matchTicks; i++) {
    if (state.matchOver) break;
    if (state.pauseState !== null) {
      physicsTick(state, null, null);
      continue;
    }

    const p1Action = p1Brain.forward(buildInputs(state, 'p1', p1InputBuf));
    const p2Action = p2IsFallback
      ? fallbackAction(state, 'p2')
      : p2Brain.forward(buildInputs(state, 'p2', p2InputBuf));

    physicsTick(state, p1Action, p2Action);
  }

  return {
    p1_id: matchup.p1.id,
    p2_id: p2IsFallback ? null : matchup.p2.id,
    goals_p1: state.scoreL,
    goals_p2: state.scoreR,
  };
}

/* ── HTTP ─────────────────────────────────────────────────── */

async function fetchMatchupBatch(count) {
  const res = await fetch(`${apiBase}/matchup?count=${count}`);
  if (!res.ok) throw new Error(`matchup fetch: ${res.status}`);
  const body = await res.json();
  // Broker responds with an array when `count` is present, a single
  // object otherwise — accept both for backward compatibility.
  return Array.isArray(body) ? body : [body];
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
