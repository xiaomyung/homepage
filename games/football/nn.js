/**
 * Football v2 — neural net forward pass.
 *
 * Architecture (LeakyReLU+tanh combo fixes saturation; see memory
 * feedback_nn_saturation_fix):
 *
 *   Inputs (25) → Hidden (16, LeakyReLU) → Output (9, tanh)
 *
 * Total 569 weights (400 + 16 + 144 + 9). Inputs 20–24 are derived
 * (possession / ball threat / goal distances) — see
 * physics.js:buildInputs(). Shrinking from the previous 3-layer
 * 1233-weight net is a NEAT-style "start small" choice: the new
 * derived inputs carry most of the decision signal, so the NN
 * just needs enough capacity to route them into the 9-dim action
 * rather than rediscovering them from raw state.
 *
 * Forward-pass only. Initial weights come from offline imitation
 * training (see evolution/build-warm-start.mjs), serialized as a
 * flat JSON array shipped in the repo as warm_start_weights.json.
 * Runtime weights evolve via the GA in evolution/ga.mjs.
 */

/** Layer sizes. Changing this invalidates committed warm_start_weights.json. */
export const ARCH = [25, 16, 9];

/** LeakyReLU slope on the negative side. */
const LEAKY_SLOPE = 0.01;

/** Precompute weight/bias offsets so forward() is allocation-free in hot loops. */
const LAYER_OFFSETS = computeLayerOffsets(ARCH);

/** Total number of scalar parameters in the network. */
export const WEIGHT_COUNT = LAYER_OFFSETS[LAYER_OFFSETS.length - 1];

/**
 * Feedforward NN, flat weight layout.
 *
 * Weights are stored as a single flat Float64Array for cache-friendly access
 * and trivial serialization. Layout per layer: [weights (fan_in * fan_out),
 * biases (fan_out)], concatenated in layer order.
 */
export class NeuralNet {
  /**
   * @param {number[]|Float64Array} [weights] — optional pre-trained weights.
   *        If omitted, initializes with He-scaled random values.
   */
  constructor(weights) {
    if (weights === undefined) {
      this.weights = heInit(ARCH);
    } else {
      if (weights.length !== WEIGHT_COUNT) {
        throw new Error(
          `weight count mismatch: expected ${WEIGHT_COUNT}, got ${weights.length}`
        );
      }
      this.weights = weights instanceof Float64Array
        ? weights
        : Float64Array.from(weights);
    }
    // Pre-allocated per-layer scratch buffers so `forward()` is fully
    // allocation-free on the training hot path (~1500 calls per match
    // per brain × dozens of matches per second per worker). One typed
    // array per layer output; the final one is returned directly.
    this._layerBufs = new Array(ARCH.length - 1);
    for (let i = 1; i < ARCH.length; i++) {
      this._layerBufs[i - 1] = new Float64Array(ARCH[i]);
    }
  }

  /**
   * Run a forward pass. Zero allocations on the hot path — all layer
   * outputs write into pre-allocated scratch buffers owned by this NN
   * instance. The returned Float64Array is the last layer buffer, so
   * the caller must consume it before the next `forward()` call on
   * the same instance overwrites it.
   *
   * @param {number[]|Float64Array} inputs — ARCH[0]-float input vector
   * @returns {Float64Array} ARCH[last]-float output vector (owned buffer)
   */
  forward(inputs) {
    if (inputs.length !== ARCH[0]) {
      throw new Error(`input size mismatch: expected ${ARCH[0]}, got ${inputs.length}`);
    }
    const weights = this.weights;
    const lastLayer = ARCH.length - 2;
    let current = inputs;
    for (let layer = 0; layer < ARCH.length - 1; layer++) {
      const fanIn = ARCH[layer];
      const fanOut = ARCH[layer + 1];
      const wOffset = LAYER_OFFSETS[layer];
      const bOffset = wOffset + fanIn * fanOut;
      const next = this._layerBufs[layer];

      // Loop order: i outer, j inner. Inner `j` is a stride-1 walk
      // through weights (row-major layout) so V8's JIT and the
      // hardware prefetcher both hit. Tried manual unrolls and
      // j-outer — all measurably slower than this simple form on
      // the small (≤20) layer widths.
      for (let j = 0; j < fanOut; j++) next[j] = weights[bOffset + j];
      for (let i = 0; i < fanIn; i++) {
        const inI = current[i];
        const rowOff = wOffset + i * fanOut;
        for (let j = 0; j < fanOut; j++) {
          next[j] += inI * weights[rowOff + j];
        }
      }

      if (layer === lastLayer) {
        for (let j = 0; j < fanOut; j++) next[j] = Math.tanh(next[j]);
      } else {
        for (let j = 0; j < fanOut; j++) {
          const v = next[j];
          if (v < 0) next[j] = v * LEAKY_SLOPE;
        }
      }
      current = next;
    }
    return current;
  }

  /**
   * Copy fresh weights into this NN's existing buffer without
   * reallocating. Lets callers (notably worker.js) reuse a single NN
   * instance across thousands of matches — the scratch buffers and
   * the weight Float64Array stay pinned, only the floats flip.
   *
   * @param {number[]|Float64Array} source
   */
  loadWeights(source) {
    if (source.length !== WEIGHT_COUNT) {
      throw new Error(
        `weight count mismatch: expected ${WEIGHT_COUNT}, got ${source.length}`
      );
    }
    this.weights.set(source);
  }

  /**
   * Serialize weights as a JSON string (flat array).
   */
  toJson() {
    return JSON.stringify(Array.from(this.weights));
  }

  /**
   * Create a NN from a JSON string produced by toJson() or by the Python
   * warm-start script. Throws on malformed input or wrong length.
   *
   * @param {string} json
   * @returns {NeuralNet}
   */
  static fromJson(json) {
    const arr = JSON.parse(json);
    if (!Array.isArray(arr)) {
      throw new Error('fromJson expected a JSON array');
    }
    return new NeuralNet(arr);
  }
}

/* ── Helpers ───────────────────────────────────────────────── */

function computeLayerOffsets(arch) {
  // Returns [start_of_layer_0, start_of_layer_1, ..., total_count].
  const offsets = [0];
  let acc = 0;
  for (let i = 0; i < arch.length - 1; i++) {
    const fanIn = arch[i];
    const fanOut = arch[i + 1];
    acc += fanIn * fanOut + fanOut;
    offsets.push(acc);
  }
  return offsets;
}

function heInit(arch) {
  const weights = new Float64Array(WEIGHT_COUNT);
  let idx = 0;
  for (let i = 0; i < arch.length - 1; i++) {
    const fanIn = arch[i];
    const fanOut = arch[i + 1];
    const stddev = Math.sqrt(2 / fanIn);
    // Weight matrix
    for (let k = 0; k < fanIn * fanOut; k++) {
      weights[idx++] = gaussianNoise() * stddev;
    }
    // Biases init to zero
    idx += fanOut;
  }
  return weights;
}

/** Box-Muller gaussian sampler — uses Math.random, not seeded. */
function gaussianNoise() {
  const u1 = Math.random() || 1e-10;
  const u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}
