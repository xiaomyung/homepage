/**
 * Browser-safe warm-start training primitives.
 *
 * Runs in any context that has `physics.js`, `fallback.js`, and `nn.js`
 * importable as ES modules — the Node CLI (`build-warm-start.mjs`) and
 * the browser Web Worker (`warm-start-worker.js`) both import from here.
 *
 * No Node-specific imports (no `node:fs`, no `node:path`). File I/O and
 * CLI glue live in `build-warm-start.mjs`.
 */

import {
  createField,
  createState,
  createSeededRng,
  tick,
  buildInputs,
  NN_INPUT_SIZE,
} from '../physics.js';
import { fallbackAction } from '../fallback.js';
import { ARCH, WEIGHT_COUNT } from '../nn.js';

const LAYER_COUNT = ARCH.length - 1;
const LEAKY_SLOPE = 0.01;
const OUTPUT_SIZE = ARCH[ARCH.length - 1];

const LAYER_OFFSETS = (() => {
  const offsets = [0];
  let acc = 0;
  for (let i = 0; i < LAYER_COUNT; i++) {
    acc += ARCH[i] * ARCH[i + 1] + ARCH[i + 1];
    offsets.push(acc);
  }
  return offsets;
})();

/* ── Dataset collection ───────────────────────────────────────── */

export function collectImitationDataset(numMatches, ticksPerMatch, seed) {
  const inputs = [];
  const actions = [];
  const p1In = new Array(NN_INPUT_SIZE);
  const p2In = new Array(NN_INPUT_SIZE);
  for (let m = 0; m < numMatches; m++) {
    const field = createField();
    const state = createState(field, createSeededRng(seed + m));
    state.graceFrames = 0;
    for (let t = 0; t < ticksPerMatch; t++) {
      const p1Act = fallbackAction(state, 'p1');
      const p2Act = fallbackAction(state, 'p2');
      buildInputs(state, 'p1', p1In);
      inputs.push(p1In.slice());
      actions.push(p1Act.slice());
      buildInputs(state, 'p2', p2In);
      inputs.push(p2In.slice());
      actions.push(p2Act.slice());
      tick(state, p1Act, p2Act);
      if (state.matchOver) break;
    }
  }
  return { inputs, actions };
}

/* ── Forward + backward with cached activations ───────────────── */

function makeActivationBuffers() {
  const buffers = [new Array(ARCH[0])];
  for (let i = 1; i < ARCH.length; i++) {
    buffers.push(new Array(ARCH[i]));
  }
  return buffers;
}

function makePreactivationBuffers() {
  const buffers = [null];
  for (let i = 1; i < ARCH.length; i++) {
    buffers.push(new Array(ARCH[i]));
  }
  return buffers;
}

export function forwardCached(weights, input, activations, preacts) {
  const a0 = activations[0];
  for (let i = 0; i < ARCH[0]; i++) a0[i] = input[i];
  for (let layer = 0; layer < LAYER_COUNT; layer++) {
    const fanIn = ARCH[layer];
    const fanOut = ARCH[layer + 1];
    const wOff = LAYER_OFFSETS[layer];
    const bOff = wOff + fanIn * fanOut;
    const prev = activations[layer];
    const z = preacts[layer + 1];
    const a = activations[layer + 1];
    const isOutput = layer === LAYER_COUNT - 1;
    for (let j = 0; j < fanOut; j++) {
      let sum = weights[bOff + j];
      for (let i = 0; i < fanIn; i++) {
        sum += prev[i] * weights[wOff + i * fanOut + j];
      }
      z[j] = sum;
      a[j] = isOutput ? Math.tanh(sum) : (sum >= 0 ? sum : sum * LEAKY_SLOPE);
    }
  }
}

function backwardAccumulate(weights, activations, preacts, target, gradOut, dA, dZ) {
  const aOut = activations[LAYER_COUNT];
  const dAOut = dA[LAYER_COUNT];
  let loss = 0;
  const invN = 1 / OUTPUT_SIZE;
  for (let j = 0; j < OUTPUT_SIZE; j++) {
    const diff = aOut[j] - target[j];
    loss += diff * diff;
    dAOut[j] = 2 * diff * invN;
  }
  loss *= invN;

  for (let layer = LAYER_COUNT - 1; layer >= 0; layer--) {
    const fanIn = ARCH[layer];
    const fanOut = ARCH[layer + 1];
    const wOff = LAYER_OFFSETS[layer];
    const bOff = wOff + fanIn * fanOut;
    const isOutput = layer === LAYER_COUNT - 1;
    const z = preacts[layer + 1];
    const dAL = dA[layer + 1];
    const dZL = dZ[layer + 1];
    if (isOutput) {
      const a = activations[layer + 1];
      for (let j = 0; j < fanOut; j++) {
        dZL[j] = dAL[j] * (1 - a[j] * a[j]);
      }
    } else {
      for (let j = 0; j < fanOut; j++) {
        dZL[j] = dAL[j] * (z[j] >= 0 ? 1 : LEAKY_SLOPE);
      }
    }
    const prev = activations[layer];
    for (let j = 0; j < fanOut; j++) {
      gradOut[bOff + j] += dZL[j];
    }
    for (let i = 0; i < fanIn; i++) {
      const ai = prev[i];
      const base = wOff + i * fanOut;
      for (let j = 0; j < fanOut; j++) {
        gradOut[base + j] += ai * dZL[j];
      }
    }
    if (layer > 0) {
      const dAPrev = dA[layer];
      for (let i = 0; i < fanIn; i++) {
        let s = 0;
        const base = wOff + i * fanOut;
        for (let j = 0; j < fanOut; j++) {
          s += weights[base + j] * dZL[j];
        }
        dAPrev[i] = s;
      }
    }
  }
  return loss;
}

/* ── Weight init + training loop ──────────────────────────────── */

export function heInit(rng) {
  const weights = new Float64Array(WEIGHT_COUNT);
  for (let layer = 0; layer < LAYER_COUNT; layer++) {
    const fanIn = ARCH[layer];
    const fanOut = ARCH[layer + 1];
    const stddev = Math.sqrt(2 / fanIn);
    const wOff = LAYER_OFFSETS[layer];
    const matSize = fanIn * fanOut;
    for (let k = 0; k < matSize; k++) {
      const u1 = rng() || 1e-10;
      const u2 = rng();
      weights[wOff + k] = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2) * stddev;
    }
  }
  return weights;
}

export async function trainWarmStartWeights(inputs, actions, { epochs, batchSize, lr, seed, onEpoch }) {
  const rng = createSeededRng(seed);
  const weights = heInit(rng);
  const m = new Float64Array(WEIGHT_COUNT);
  const v = new Float64Array(WEIGHT_COUNT);
  const grad = new Float64Array(WEIGHT_COUNT);

  const activations = makeActivationBuffers();
  const preacts = makePreactivationBuffers();
  const dA = makeActivationBuffers();
  const dZ = makePreactivationBuffers();

  const beta1 = 0.9;
  const beta2 = 0.999;
  const eps = 1e-8;

  const N = inputs.length;
  const indices = new Int32Array(N);
  for (let i = 0; i < N; i++) indices[i] = i;

  let t = 0;
  const history = [];

  for (let epoch = 0; epoch < epochs; epoch++) {
    for (let i = N - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const tmp = indices[i];
      indices[i] = indices[j];
      indices[j] = tmp;
    }

    let epochLoss = 0;
    let nBatches = 0;
    for (let s = 0; s < N; s += batchSize) {
      const end = Math.min(s + batchSize, N);
      grad.fill(0);
      let batchLoss = 0;
      for (let i = s; i < end; i++) {
        const idx = indices[i];
        forwardCached(weights, inputs[idx], activations, preacts);
        batchLoss += backwardAccumulate(
          weights, activations, preacts, actions[idx], grad, dA, dZ,
        );
      }
      const bs = end - s;
      const invBs = 1 / bs;
      for (let k = 0; k < WEIGHT_COUNT; k++) grad[k] *= invBs;
      t++;
      const biasCorr1 = 1 - Math.pow(beta1, t);
      const biasCorr2 = 1 - Math.pow(beta2, t);
      for (let k = 0; k < WEIGHT_COUNT; k++) {
        const g = grad[k];
        m[k] = beta1 * m[k] + (1 - beta1) * g;
        v[k] = beta2 * v[k] + (1 - beta2) * g * g;
        const mHat = m[k] / biasCorr1;
        const vHat = v[k] / biasCorr2;
        weights[k] -= lr * mHat / (Math.sqrt(vHat) + eps);
      }
      epochLoss += batchLoss * invBs;
      nBatches++;
    }
    const loss = epochLoss / nBatches;
    history.push(loss);
    if (onEpoch) onEpoch(epoch + 1, epochs, loss);
    // Yield between epochs so the worker can drain its message queue
    // (abort signals, progress polls, etc). setTimeout(0) works both
    // in browser Workers and in Node; setImmediate is Node-only.
    await new Promise((ok) => setTimeout(ok, 0));
  }
  return { weights, history };
}

export { LAYER_COUNT, OUTPUT_SIZE, LAYER_OFFSETS };
