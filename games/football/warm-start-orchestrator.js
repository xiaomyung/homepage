/**
 * Main-thread orchestrator for federated warm-start training.
 *
 * Spawns N Web Workers (N = configured worker count), gives each a
 * disjoint shard of the fallback-match seed space, and loops:
 *
 *   for epoch = 1..epochs:
 *       broadcast current master weights to each worker
 *       await N "epoch_done" messages (one shard-epoch each)
 *       master weights := element-wise average of the N returned
 *       report progress
 *
 * The math (shard splitting, averaging) lives in warm-start-coord.js
 * and is unit-tested there. This file is the thin event-loop glue.
 *
 * Usage:
 *   const { weights, history } = await runWarmStart({
 *     workerCount: 8,
 *     workerUrl: new URL('./warm-start-worker.js', import.meta.url),
 *     epochs: 200,
 *     matches: 50,
 *     ticksPerMatch: 1000,
 *     baseSeed: 1,
 *     onProgress: ({current, total, loss}) => { ... },
 *   });
 */

import { heInit } from './evolution/warm-start-lib.js';
import { createSeededRng } from './physics.js';
import { splitShards, averageWeights } from './warm-start-coord.js';

export async function runWarmStart({
  workerCount,
  workerUrl,
  epochs,
  matches,
  ticksPerMatch,
  baseSeed,
  onProgress,
}) {
  if (workerCount <= 0) throw new Error('workerCount must be > 0');
  const shards = splitShards(matches, workerCount).filter((s) => s.count > 0);
  const actualWorkerCount = shards.length;
  const workers = [];
  try {
    // Spawn + init all workers. Each loads its shard in parallel, so
    // dataset collection costs ~1 s on the slowest worker instead of
    // N × 1 s sequentially.
    for (let i = 0; i < actualWorkerCount; i++) {
      const w = new Worker(workerUrl, { type: 'module' });
      workers.push(w);
    }
    await Promise.all(workers.map((w, i) => new Promise((resolve, reject) => {
      const onMsg = (ev) => {
        if (ev.data?.type === 'ready') {
          w.removeEventListener('message', onMsg);
          w.removeEventListener('error', onErr);
          resolve();
        } else if (ev.data?.type === 'error') {
          w.removeEventListener('message', onMsg);
          w.removeEventListener('error', onErr);
          reject(new Error(ev.data.message || 'worker init error'));
        }
      };
      const onErr = (err) => {
        w.removeEventListener('message', onMsg);
        w.removeEventListener('error', onErr);
        reject(err);
      };
      w.addEventListener('message', onMsg);
      w.addEventListener('error', onErr);
      w.postMessage({
        type: 'init',
        workerId: i,
        seedOffset: shards[i].seedOffset,
        matches: shards[i].count,
        ticksPerMatch,
        baseSeed,
      });
    })));

    // Deterministic master-weight init. Using the same seed as the
    // Node CLI (12345) so client and CLI starting points match.
    const masterWeights = heInit(createSeededRng(12345));
    const history = [];

    for (let epoch = 0; epoch < epochs; epoch++) {
      const weightsOut = new Float64Array(masterWeights);
      // Broadcast (one structured clone per worker).
      const responses = workers.map((w) => new Promise((resolve, reject) => {
        const onMsg = (ev) => {
          if (ev.data?.type === 'epoch_done') {
            w.removeEventListener('message', onMsg);
            w.removeEventListener('error', onErr);
            resolve({
              weights: new Float64Array(ev.data.weights),
              loss: ev.data.loss,
            });
          } else if (ev.data?.type === 'error') {
            w.removeEventListener('message', onMsg);
            w.removeEventListener('error', onErr);
            reject(new Error(ev.data.message || 'worker epoch error'));
          }
        };
        const onErr = (err) => {
          w.removeEventListener('message', onMsg);
          w.removeEventListener('error', onErr);
          reject(err);
        };
        w.addEventListener('message', onMsg);
        w.addEventListener('error', onErr);
        // structuredClone for broadcast — can't transfer the same
        // buffer to multiple workers. Cost is ~N × 10 KB per epoch
        // × 200 epochs = trivial.
        w.postMessage({ type: 'epoch', weights: weightsOut });
      }));
      const results = await Promise.all(responses);
      const averaged = averageWeights(results.map((r) => r.weights));
      masterWeights.set(averaged);
      const meanLoss = results.reduce((s, r) => s + r.loss, 0) / results.length;
      history.push(meanLoss);
      if (onProgress) {
        onProgress({ current: epoch + 1, total: epochs, loss: meanLoss });
      }
      // Yield between epochs so the UI message pump stays responsive.
      await new Promise((ok) => setTimeout(ok, 0));
    }

    return { weights: masterWeights, history };
  } finally {
    for (const w of workers) {
      try { w.postMessage({ type: 'shutdown' }); } catch { /* ignore */ }
      try { w.terminate(); } catch { /* ignore */ }
    }
  }
}
