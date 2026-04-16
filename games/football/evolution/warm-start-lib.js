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

/**
 * Trainable state bundled into one object so it can be handed to
 * `epochStep` repeatedly. Adam state (m, v, t) is kept across epochs;
 * weights can be externally overwritten between epochs (e.g. by a
 * federated-averaging orchestrator) without touching the Adam state,
 * which matches common federated-learning practice.
 */
export function createTrainingState(seed) {
  const rng = createSeededRng(seed);
  return {
    rng,
    weights: heInit(rng),
    m: new Float64Array(WEIGHT_COUNT),
    v: new Float64Array(WEIGHT_COUNT),
    t: 0,
    history: [],
  };
}

const BETA1 = 0.9;
const BETA2 = 0.999;
const EPS = 1e-8;

/** Hyperparameters shared by the Node CLI (`build-warm-start.mjs`) and
 *  the browser Web Worker (`warm-start-worker.js`) so both paths
 *  produce comparable models. */
export const WARM_START_HYPERPARAMS = Object.freeze({
  epochs: 200,
  batchSize: 256,
  lr: 0.005,
  matches: 50,
  ticksPerMatch: 1000,
  baseSeed: 1,
});

/** Run one epoch of Adam SGD over `inputs`/`actions`, mutating
 *  `state.weights`, `state.m`, `state.v`, `state.t` in place. Returns
 *  the mean per-batch loss for the epoch. */
export function epochStep(state, inputs, actions, { batchSize, lr }) {
  const { rng, weights, m, v } = state;
  const grad = new Float64Array(WEIGHT_COUNT);
  const activations = makeActivationBuffers();
  const preacts = makePreactivationBuffers();
  const dA = makeActivationBuffers();
  const dZ = makePreactivationBuffers();

  const N = inputs.length;
  const indices = new Int32Array(N);
  for (let i = 0; i < N; i++) indices[i] = i;
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
    state.t++;
    const biasCorr1 = 1 - Math.pow(BETA1, state.t);
    const biasCorr2 = 1 - Math.pow(BETA2, state.t);
    for (let k = 0; k < WEIGHT_COUNT; k++) {
      const g = grad[k];
      m[k] = BETA1 * m[k] + (1 - BETA1) * g;
      v[k] = BETA2 * v[k] + (1 - BETA2) * g * g;
      const mHat = m[k] / biasCorr1;
      const vHat = v[k] / biasCorr2;
      weights[k] -= lr * mHat / (Math.sqrt(vHat) + EPS);
    }
    epochLoss += batchLoss * invBs;
    nBatches++;
  }
  return epochLoss / nBatches;
}

export async function trainWarmStartWeights(inputs, actions, { epochs, batchSize, lr, seed }) {
  const state = createTrainingState(seed);
  for (let epoch = 0; epoch < epochs; epoch++) {
    const loss = epochStep(state, inputs, actions, { batchSize, lr });
    state.history.push(loss);
    // Yield between epochs so the worker can drain its message queue
    // (abort signals, progress polls, etc). setTimeout(0) works both
    // in browser Workers and in Node; setImmediate is Node-only.
    await new Promise((ok) => setTimeout(ok, 0));
  }
  return { weights: state.weights, history: state.history };
}

export { LAYER_COUNT, OUTPUT_SIZE };
