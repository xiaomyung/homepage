/**
 * Football v2 — neural net forward pass.
 *
 * Architecture inherited from v1 (known-good, LeakyReLU+tanh combo fixes
 * saturation; see memory feedback_nn_saturation_fix):
 *
 *   Inputs (18) → Hidden 1 (20, LeakyReLU) → Hidden 2 (16, LeakyReLU)
 *               → Hidden 3 (18, LeakyReLU) → Output (9, tanh)
 *
 * Total 1193 weights (380 + 336 + 306 + 171).
 *
 * Forward-pass only. Training is done offline in Python (see
 * evolution/build_warm_start.py) and the resulting weights are serialized
 * as a JSON array and shipped in the repo as warm_start_weights.json.
 */

/** Layer sizes. Changing this invalidates committed warm_start_weights.json. */
export const ARCH = [18, 20, 16, 18, 9];

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
  }

  /**
   * Run a forward pass. Allocates only the minimum intermediate buffers.
   *
   * @param {number[]|Float64Array} inputs — 18-float input vector
   * @returns {number[]} 9-float output vector
   */
  forward(inputs) {
    if (inputs.length !== ARCH[0]) {
      throw new Error(`input size mismatch: expected ${ARCH[0]}, got ${inputs.length}`);
    }
    let current = inputs;
    for (let layer = 0; layer < ARCH.length - 1; layer++) {
      const fanIn = ARCH[layer];
      const fanOut = ARCH[layer + 1];
      const wOffset = LAYER_OFFSETS[layer];
      const bOffset = wOffset + fanIn * fanOut;
      const isOutputLayer = layer === ARCH.length - 2;
      const next = new Array(fanOut);
      for (let j = 0; j < fanOut; j++) {
        let sum = this.weights[bOffset + j];
        for (let i = 0; i < fanIn; i++) {
          sum += current[i] * this.weights[wOffset + i * fanOut + j];
        }
        next[j] = isOutputLayer ? Math.tanh(sum) : leakyRelu(sum);
      }
      current = next;
    }
    return current;
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

function leakyRelu(x) {
  return x >= 0 ? x : x * LEAKY_SLOPE;
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
