/**
 * Main-thread training orchestrator.
 *
 * Replaces the old "worker fetches from broker" flow. One instance
 * per open page:
 *
 *   1. `start(workerCount)` spins up N workers, fetches the broker
 *      population once via /population, and pushes the full snapshot
 *      to every worker via postMessage.
 *   2. Each worker receives batches of matchups picked locally by
 *      matchmaker.js, runs them headlessly, and replies with raw
 *      results.
 *   3. The orchestrator aggregates results into its local counts
 *      (so the matchmaker's next pick reflects work completed since
 *      the last broker sync), then refills the worker with another
 *      batch immediately.
 *   4. Every SYNC_INTERVAL_MS it POSTs pending results to the
 *      broker. The broker's response carries the authoritative
 *      counts + current generation; the orchestrator reconciles
 *      local state with the broker-authoritative view. If the
 *      generation advanced the orchestrator fetches a fresh
 *      population snapshot and pushes it to every worker.
 *
 * Zero HTTP traffic during the compute hot path — workers never fetch,
 * the main thread syncs at most once per ~5 seconds.
 */

import {
  pickMatchups,
  emptyCounts,
  applyResultToCounts,
  reconcileCounts,
} from './matchmaker.js';

const DEFAULT_SYNC_INTERVAL_MS = 5000;
const DEFAULT_BATCH_SIZE = 40;
// Hard ceiling on unposted results — if the broker is unreachable we
// drop older results rather than growing the buffer unboundedly.
const MAX_PENDING_RESULTS = 4000;
const DEFAULT_MATCH_TICKS_MS = 30000;

export function createTrainingOrchestrator({
  apiBase,
  workerUrl,
  syncIntervalMs = DEFAULT_SYNC_INTERVAL_MS,
  batchSize = DEFAULT_BATCH_SIZE,
  onStats = null,
} = {}) {
  const workers = [];             // { worker, busy, batchId }
  let running = false;
  let cachedGeneration = -1;
  let cachedPopulation = [];      // [{id, name}] (weights live in workers)
  let cachedMatchTicks = Math.ceil(DEFAULT_MATCH_TICKS_MS / 16);
  const localCounts = new Map();  // id → {popMatches, popGoalDiff, fallbackMatches, fallbackWins, fallbackDraws}
  let config = { min_pop_matches: 10, min_fallback_matches: 5 };
  let matchupCounter = 0;
  let nextBatchId = 1;

  // Pending result buffers. `pending` is filled by worker replies;
  // `inFlight` holds the batch currently being POSTed so its ids can
  // be cleaned up on success/failure.
  let pending = [];
  let inFlight = null;
  let syncTimer = null;

  // Stats reporting — updated after each worker batch so the UI can
  // display a live sims/s counter.
  let simsSinceReport = 0;
  let reportStart = 0;

  async function start(workerCount) {
    if (running) await stop();
    running = true;
    cachedGeneration = -1;

    await syncConfigAndPopulation({ force: true });

    for (let i = 0; i < workerCount; i++) {
      const w = new Worker(workerUrl, { type: 'module' });
      const entry = { worker: w, busy: false, batchId: 0 };
      w.onmessage = (ev) => onWorkerMessage(entry, ev);
      w.onerror = (err) => {
        // eslint-disable-next-line no-console
        console.error('[training-orchestrator] worker error:', err.message || err);
      };
      workers.push(entry);
      // Push the current population snapshot; worker replies 'ready'
      // and we start feeding batches in onWorkerMessage.
      pushPopulationToWorker(entry);
    }

    reportStart = Date.now();
    simsSinceReport = 0;

    syncTimer = setInterval(() => { void syncPending(); }, syncIntervalMs);
  }

  async function stop() {
    running = false;
    if (syncTimer !== null) {
      clearInterval(syncTimer);
      syncTimer = null;
    }
    // Tear down workers first so no stray replies race the final sync.
    for (const entry of workers) {
      try { entry.worker.terminate(); } catch { /* ignore */ }
    }
    workers.length = 0;
    // Final flush so nothing from the run is lost.
    try { await syncPending({ final: true }); } catch { /* ignore */ }
    pending.length = 0;
    inFlight = null;
  }

  function onWorkerMessage(entry, ev) {
    const msg = ev.data;
    if (msg.type === 'ready') {
      // Fresh population loaded — begin feeding.
      entry.busy = false;
      feedWorker(entry);
    } else if (msg.type === 'results') {
      entry.busy = false;
      for (const r of msg.results) {
        if (applyResultToCounts(localCounts, r)) {
          pending.push(r);
          simsSinceReport++;
        }
      }
      // Bound the pending buffer so a broker outage doesn't blow up RAM.
      if (pending.length > MAX_PENDING_RESULTS) {
        pending.splice(0, pending.length - MAX_PENDING_RESULTS);
      }
      if (onStats) {
        const elapsed = (Date.now() - reportStart) / 1000;
        if (elapsed >= 1) {
          const simsPerSec = simsSinceReport / elapsed;
          onStats({ simsPerSec, perWorker: simsPerSec / Math.max(1, workers.length) });
          simsSinceReport = 0;
          reportStart = Date.now();
        }
      }
      // Eager sync: the moment local counts show every brain is
      // over the breed thresholds, POST the accumulated results
      // immediately rather than waiting for the next 5 s timer.
      // Without this, ~95% of each sync batch lands AFTER the local
      // counts already met the breed gate, so the broker sees one
      // giant POST per 5 s and breeds at most once per 5 s. With
      // eager sync the breed cadence becomes compute-limited
      // instead of network-interval-limited.
      if (running && pending.length > 0 && readyToBreedLocally()) {
        void syncPending();
      }
      if (running) feedWorker(entry);
    } else if (msg.type === 'error') {
      // eslint-disable-next-line no-console
      console.error('[training-orchestrator] worker reported error:', msg.message);
      entry.busy = false;
      if (running) feedWorker(entry);
    }
  }

  /** Cheap O(pop) check that every brain in `localCounts` has
   *  already met BOTH training thresholds — no brain left to
   *  improve before the next breed. Used to trigger an immediate
   *  /results sync so the broker breeds as fast as compute allows
   *  instead of at the sync timer's cadence. */
  function readyToBreedLocally() {
    if (cachedPopulation.length === 0) return false;
    const minPop = config.min_pop_matches;
    const minFb = config.min_fallback_matches;
    for (const b of cachedPopulation) {
      const c = localCounts.get(b.id);
      if (!c) return false;
      if (c.popMatches < minPop) return false;
      if (c.fallbackMatches < minFb) return false;
    }
    return true;
  }

  function feedWorker(entry) {
    if (entry.busy || !running) return;
    if (cachedPopulation.length < 2) return;
    const { matchups, counter } = pickMatchups(
      cachedPopulation,
      localCounts,
      config,
      matchupCounter,
      batchSize,
    );
    matchupCounter = counter;
    entry.busy = true;
    entry.batchId = nextBatchId++;
    entry.worker.postMessage({ type: 'batch', batchId: entry.batchId, matchups });
  }

  function pushPopulationToWorker(entry) {
    const brains = cachedPopulation.map((b) => ({
      id: b.id,
      weights: b.weights,
    }));
    entry.busy = true; // until we get 'ready'
    entry.worker.postMessage({
      type: 'population',
      brains,
      matchTicks: cachedMatchTicks,
    });
  }

  async function syncConfigAndPopulation({ force = false } = {}) {
    try {
      const cfgRes = await fetch(`${apiBase}/config`);
      if (cfgRes.ok) {
        const cfg = await cfgRes.json();
        if (cfg.min_pop_matches) config.min_pop_matches = cfg.min_pop_matches;
        if (cfg.min_fallback_matches) config.min_fallback_matches = cfg.min_fallback_matches;
        if (cfg.match_duration_ms) cachedMatchTicks = Math.ceil(cfg.match_duration_ms / 16);
      }
    } catch { /* use defaults */ }

    try {
      const popRes = await fetch(`${apiBase}/population`);
      if (!popRes.ok) throw new Error(`population fetch: ${popRes.status}`);
      const body = await popRes.json();
      cachedPopulation = body.brains.map((b) => ({
        id: b.id,
        name: b.name,
        weights: b.weights, // plain array — workers will typed-copy
      }));
      cachedGeneration = body.generation;
      // Seed local counts from the broker snapshot: every brain
      // starts with zeroed local deltas, and the authoritative stats
      // come back in the next /results sync response.
      localCounts.clear();
      for (const b of cachedPopulation) {
        localCounts.set(b.id, emptyCounts());
      }
      // Push to any already-spawned workers.
      if (!force) {
        for (const entry of workers) pushPopulationToWorker(entry);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[training-orchestrator] population fetch failed:', err.message || err);
    }
  }

  async function syncPending({ final = false } = {}) {
    if (inFlight !== null) return; // one POST in flight at a time
    if (pending.length === 0) return;
    inFlight = pending;
    pending = [];
    try {
      const res = await fetch(`${apiBase}/results`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          generation: cachedGeneration,
          results: inFlight,
        }),
      });
      if (!res.ok) throw new Error(`results post: ${res.status}`);
      const body = await res.json();
      // Broker echoes its authoritative generation + per-brain
      // counts. If generation advanced, a breed happened — fetch a
      // fresh snapshot and push to every worker.
      if (body.generation !== cachedGeneration) {
        await syncConfigAndPopulation();
        for (const entry of workers) pushPopulationToWorker(entry);
      } else if (body.counts) {
        reconcileCounts(localCounts, body.counts);
      }
    } catch (err) {
      // Drop the in-flight batch on failure (broker will miss these
      // results — acceptable since it's eventually consistent) and
      // fall back to local stats until the next successful sync.
      if (!final) {
        // eslint-disable-next-line no-console
        console.error('[training-orchestrator] results sync failed:', err.message || err);
      }
    } finally {
      inFlight = null;
    }
  }

  return {
    start,
    stop,
    /** Trigger a manual sync — mostly for tests. */
    flush: () => syncPending(),
    /** Current in-memory counts snapshot — tests + UI can inspect. */
    getLocalCounts: () => new Map(localCounts),
    getGeneration: () => cachedGeneration,
    /** True iff start() is currently in effect (not stopped/paused). */
    isRunning: () => running,
  };
}
