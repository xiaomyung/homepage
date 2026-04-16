/**
 * Web Worker — one shard of federated warm-start training.
 *
 * Protocol:
 *
 *   main → worker: {type: 'init', workerId, seedOffset, matches, ticksPerMatch, baseSeed}
 *     → collects fallback-vs-fallback dataset for its shard and
 *       initializes Adam state. Replies {type: 'ready', workerId,
 *       samples}.
 *
 *   main → worker: {type: 'epoch', weights}
 *     → overwrites the worker's local weights with the broadcast
 *       values, runs one SGD epoch on its shard, replies
 *       {type: 'epoch_done', workerId, weights, loss}.
 *       Weights travel back via a transferable ArrayBuffer so there's
 *       no copy cost on the message boundary.
 *
 *   main → worker: {type: 'shutdown'}  (optional; main can just terminate())
 *
 * Adam state (m, v, t) is kept local and survives across epochs — it
 * only gets stale-ish when averaged weights diverge meaningfully from
 * local weights, which at this model size doesn't hurt convergence
 * in practice.
 */

import {
  collectImitationDataset,
  createTrainingState,
  epochStep,
  WARM_START_HYPERPARAMS,
} from './evolution/warm-start-lib.js';

const { batchSize: BATCH_SIZE, lr: LR } = WARM_START_HYPERPARAMS;

let state = null;
let shardInputs = null;
let shardActions = null;
let workerId = -1;

self.addEventListener('message', (ev) => {
  const msg = ev.data;
  if (!msg || typeof msg !== 'object') return;

  try {
    if (msg.type === 'init') {
      workerId = msg.workerId;
      state = createTrainingState(msg.baseSeed + msg.workerId);
      const { inputs, actions } = collectImitationDataset(
        msg.matches,
        msg.ticksPerMatch,
        msg.baseSeed + msg.seedOffset,
      );
      shardInputs = inputs;
      shardActions = actions;
      self.postMessage({ type: 'ready', workerId, samples: inputs.length });
    } else if (msg.type === 'epoch' && state && shardInputs) {
      // Overwrite local weights with broadcast average.
      const incoming = new Float64Array(msg.weights);
      state.weights.set(incoming);
      const loss = epochStep(state, shardInputs, shardActions, {
        batchSize: BATCH_SIZE,
        lr: LR,
      });
      const out = new Float64Array(state.weights).buffer;
      self.postMessage(
        { type: 'epoch_done', workerId, weights: out, loss },
        [out],
      );
    } else if (msg.type === 'shutdown') {
      self.close();
    }
  } catch (err) {
    self.postMessage({
      type: 'error',
      workerId,
      message: err?.message ?? String(err),
    });
  }
});
