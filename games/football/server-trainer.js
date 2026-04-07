#!/usr/bin/env node
/**
 * Server-side headless football trainer.
 *
 * Runs the same training loop as the browser Web Worker (trainer.js)
 * but using Node.js worker_threads for multi-core parallelism.
 * CPU load is controlled via systemd CPUQuota — no in-process throttling.
 *
 * Usage: node server-trainer.js [workers] [api-url]
 *   workers  — number of worker threads (default: 4)
 *   api-url  — Flask API base URL (default: http://127.0.0.1:5050)
 */

import { isMainThread, Worker, workerData, parentPort } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

if (isMainThread) {
  // ── Main thread: spawn workers and aggregate stats ──────────
  const workerCount = Math.max(1, parseInt(process.argv[2]) || 4);
  const apiBase = process.argv[3] || 'http://127.0.0.1:5050';

  const workerSims = new Array(workerCount).fill(0);
  const thisFile = fileURLToPath(import.meta.url);
  const RESPAWN_DELAY_MS = 2000;

  function spawnWorker(i, respawn = false) {
    const w = new Worker(thisFile, { workerData: { apiBase } });
    w.on('message', msg => {
      if (msg.type === 'stats') workerSims[i] = msg.simsPerSecond;
    });
    w.on('error', err => console.error(`[worker ${i}] error:`, err.message));
    if (!respawn) {
      // Only first-level spawn gets an exit handler (systemd handles deeper crashes)
      w.on('exit', code => {
        console.error(`[worker ${i}] exited (code ${code}), restarting...`);
        setTimeout(() => spawnWorker(i, true), RESPAWN_DELAY_MS);
      });
    }
  }

  for (let i = 0; i < workerCount; i++) spawnWorker(i);

  // Print aggregated stats every 5 seconds
  setInterval(() => {
    const total = workerSims.reduce((a, b) => a + b, 0);
    console.log(`[trainer] ${total} sims/s (${workerCount} workers)`);
  }, 5000);

  console.log(`[trainer] started ${workerCount} workers → ${apiBase}`);

} else {
  // ── Worker thread: training loop ────────────────────────────
  const { FootballEngine, FieldConfig, TICK } = await import('./engine.js');
  const { NeuralNet } = await import('./nn.js');

  const API_BASE = `${workerData.apiBase}/api/football`;
  const BATCH_SIZE = 125;
  const SOURCE_ID = 'server-' + Math.random().toString(36).slice(2, 8);
  const MIN_FIELD_WIDTH = 600;
  const FIELD_WIDTH_RANGE = 300;

  let maxHeadlessTicks = Math.ceil(45000 / TICK);
  let goalSize = 2.0;

  function b64ToFloat32(b64) {
    const buf = Buffer.from(b64, 'base64');
    return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  }

  function randomFieldWidth() {
    return MIN_FIELD_WIDTH + Math.random() * FIELD_WIDTH_RANGE;
  }

  const inputBufA = new Array(18);
  const inputBufB = new Array(18);

  function runMatch(nnA, nnB) {
    const field = new FieldConfig(randomFieldWidth(), goalSize);
    const engine = new FootballEngine(field, true);
    const state = engine.createState();
    let ticks = 0;
    let outA = null, outB = null;
    while (!state.matchOver && ticks < maxHeadlessTicks) {
      if (ticks % 3 === 0) {
        engine.buildInputsInto(state, 'p1', inputBufA);
        outA = nnA.forward(inputBufA);
        if (nnB) {
          engine.buildInputsInto(state, 'p2', inputBufB);
          outB = nnB.forward(inputBufB);
        }
      }
      engine.tick(state, outA, outB);
      ticks++;
    }
    return {
      scoreA: state.scoreL, scoreB: state.scoreR,
      fitnessA: state.fitness.p1, fitnessB: state.fitness.p2,
    };
  }

  // Stats
  let matchesThisSecond = 0;
  let simsPerSecond = 0;
  let lastStatTime = Date.now();

  function updateStats() {
    const now = Date.now();
    const elapsed = now - lastStatTime;
    if (elapsed >= 1000) {
      simsPerSecond = Math.round(matchesThisSecond * 1000 / elapsed);
      matchesThisSecond = 0;
      lastStatTime = now;
      parentPort.postMessage({ type: 'stats', simsPerSecond });
    }
  }

  // Brain cache
  let cachedGen = null;
  let cachedBrains = new Map();

  async function trainingLoop() {
    while (true) {
      try {
        const knownIds = cachedGen !== null ? [...cachedBrains.keys()].join(',') : '';
        const url = `${API_BASE}/matchup?count=${BATCH_SIZE}` + (knownIds ? `&known=${knownIds}` : '');
        const res = await fetch(url);
        if (!res.ok) throw new Error(`matchup ${res.status}`);
        const data = await res.json();

        const { pairs, generation_id: genId } = data;
        if (data.match_duration) maxHeadlessTicks = Math.ceil(data.match_duration * 1000 / TICK);
        if (data.goal_size !== undefined) goalSize = data.goal_size;

        if (genId !== cachedGen) { cachedBrains.clear(); cachedGen = genId; }

        const batchResults = [];
        for (const pair of pairs) {
          if (!cachedBrains.has(pair.brain_a.id) && pair.brain_a.weights) {
            cachedBrains.set(pair.brain_a.id, new NeuralNet(b64ToFloat32(pair.brain_a.weights)));
          }
          const nnA = cachedBrains.get(pair.brain_a.id);

          let nnB = null;
          const bType = pair.brain_b.type;
          if (bType === 'random' || bType === 'hof') {
            nnB = new NeuralNet(b64ToFloat32(pair.brain_b.weights));
          } else if (bType !== 'idle') {
            if (!cachedBrains.has(pair.brain_b.id) && pair.brain_b.weights) {
              cachedBrains.set(pair.brain_b.id, new NeuralNet(b64ToFloat32(pair.brain_b.weights)));
            }
            nnB = cachedBrains.get(pair.brain_b.id);
          }

          const result = runMatch(nnA, nnB);
          batchResults.push({
            brain_a_id: pair.brain_a.id,
            brain_b_id: pair.brain_b.id,
            score_a: result.scoreA,
            score_b: result.scoreB,
            fitness_a: result.fitnessA,
            fitness_b: bType === 'normal' ? result.fitnessB : null,
            generation_id: genId,
            opponent_type: bType || 'normal',
          });
          matchesThisSecond++;
          updateStats();
        }

        await fetch(`${API_BASE}/results`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ results: batchResults, source: SOURCE_ID, sims_per_sec: simsPerSecond }),
        });
      } catch {
        await new Promise(r => setTimeout(r, 2000));
      }
    }
  }

  trainingLoop();
}
