/**
 * Web Worker — runs the warm-start imitation training in the browser.
 *
 * Spawned by ui.js on reset / seed click. Receives a `{type: 'train',
 * seed}` message, runs the full pipeline (dataset collection → SGD →
 * weights), posts progress messages every epoch, and finally posts
 * `{type: 'done', weights}` with a transferable Float64Array buffer.
 *
 * Moving training off the broker makes reset fast from the server's
 * point of view (broker just accepts the finished weights and seeds
 * the population). The client uses its own CPU — typically faster
 * than the homelab host.
 */

import {
  collectImitationDataset,
  trainWarmStartWeights,
} from './evolution/warm-start-lib.js';

self.addEventListener('message', async (ev) => {
  const msg = ev.data;
  if (msg?.type !== 'train') return;
  const seed = typeof msg.seed === 'number' ? msg.seed : 1;
  try {
    // Dataset collection is fast (~1 s); no progress reporting
    // beyond a single "collecting" beat at the start.
    self.postMessage({ type: 'progress', phase: 'collect', current: 0, total: 1 });
    const { inputs, actions } = collectImitationDataset(50, 1000, seed);
    self.postMessage({ type: 'progress', phase: 'collect', current: 1, total: 1 });

    const epochs = 200;
    const { weights, history } = await trainWarmStartWeights(inputs, actions, {
      epochs,
      batchSize: 256,
      lr: 0.005,
      seed,
      onEpoch: (current, total, loss) => {
        self.postMessage({ type: 'progress', phase: 'train', current, total, loss });
      },
    });

    // Transfer the Float64Array buffer so we don't copy 10 KB back
    // through the structured clone path.
    const buf = new Float64Array(weights).buffer;
    self.postMessage(
      { type: 'done', weights: buf, finalLoss: history[history.length - 1] },
      [buf],
    );
  } catch (err) {
    self.postMessage({
      type: 'error',
      message: err?.message ?? String(err),
    });
  }
});
