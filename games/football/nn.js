/**
 * Simple feedforward neural network for football AI.
 *
 * Architecture: Input(18) → Hidden(20) → Hidden(16) → Hidden(18) → Output(9)
 * Hidden layers use LeakyReLU; the output layer keeps tanh so outputs stay in [-1, 1]
 * (the engine relies on that range — see _applyOutputs* in engine.js).
 *
 * Why this mix: tanh on every layer caused weights to drift into the saturating zone
 * over many generations of unconstrained mutation, pinning outputs at ±1 regardless of
 * inputs. LeakyReLU on hidden layers does not saturate, so selection pressure can
 * actually steer weight changes. The 18-unit "bottleneck" widened from 12 because
 * under ReLU roughly half the units are inactive on any input — a 12-unit layer feeding
 * 9 outputs left only ~6 effective dimensions.
 *
 * Weights stored as a flat Float32Array for easy serialization.
 *
 * Inputs (18, normalized to ~[-1, 1]):
 *   0  player.x         5  opponent.x       10  ball.y       15  target_goal.x
 *   1  player.y         6  opponent.y       11  ball.z       16  own_goal.x
 *   2  player.vx        7  opponent.vx      12  ball.vx      17  field_width
 *   3  player.vy        8  opponent.vy      13  ball.vy
 *   4  player.stamina   9  ball.x           14  ball.vz
 *
 * Outputs (9):
 *   0 move_x    3 kick_dx    6 kick_power
 *   1 move_y    4 kick_dy    7 push
 *   2 kick      5 kick_dz    8 push_power
 */

const LAYERS = [18, 20, 16, 18, 9];
const LEAKY_RELU_SLOPE = 0.1;

/** Padé approximant tanh: max error ~0.003 for |x|<3, ~5x faster than Math.tanh. */
function fastTanh(x) {
  if (x > 4.9) return 1;
  if (x < -4.9) return -1;
  const x2 = x * x;
  return x * (27 + x2) / (27 + 9 * x2);
}

function leakyRelu(x) {
  return x > 0 ? x : LEAKY_RELU_SLOPE * x;
}

/** Total number of weights (including biases) in the network. */
function totalWeights() {
  let n = 0;
  for (let i = 1; i < LAYERS.length; i++) {
    n += LAYERS[i - 1] * LAYERS[i] + LAYERS[i]; // weights + biases
  }
  return n;
}

const TOTAL_WEIGHTS = totalWeights();
const OUTPUT_LAYER_INDEX = LAYERS.length - 1;

export class NeuralNet {
  /**
   * @param {Float32Array} [weights] — flat weight array. Random init if omitted.
   */
  constructor(weights) {
    if (weights) {
      this.weights = weights instanceof Float32Array ? weights : new Float32Array(weights);
    } else {
      this.weights = NeuralNet.randomWeights();
    }
    // Pre-compute weight offsets and allocate reusable layer buffers
    this._offsets = [];
    this._buffers = [];
    let off = 0;
    for (let i = 1; i < LAYERS.length; i++) {
      this._offsets.push(off);
      this._buffers.push(new Float32Array(LAYERS[i]));
      off += LAYERS[i - 1] * LAYERS[i] + LAYERS[i];
    }
  }

  /**
   * Random init: He scaling for LeakyReLU hidden layers, Xavier for the tanh output.
   * Matching scale must be applied in evolution/ga.py random_weights().
   */
  static randomWeights() {
    const w = new Float32Array(TOTAL_WEIGHTS);
    let offset = 0;
    for (let i = 1; i < LAYERS.length; i++) {
      const fanIn = LAYERS[i - 1];
      const fanOut = LAYERS[i];
      const isOutput = i === OUTPUT_LAYER_INDEX;
      const scale = isOutput
        ? Math.sqrt(2 / (fanIn + fanOut))   // Xavier — tanh output
        : Math.sqrt(2 / fanIn);             // He — LeakyReLU hidden
      const count = fanIn * fanOut + fanOut; // weights + biases
      for (let j = 0; j < count; j++) {
        // Box-Muller transform for Gaussian
        const u1 = Math.random() || 1e-10;
        const u2 = Math.random();
        w[offset + j] = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2) * scale;
      }
      offset += count;
    }
    return w;
  }

  /**
   * Run a forward pass. Returns a reference to an internal buffer —
   * valid until the next forward() call on this instance.
   * @param {number[]|Float64Array} inputs — 18 normalized floats
   * @returns {Float64Array} — 9 output floats
   */
  forward(inputs) {
    let current = inputs;
    const w = this.weights;

    const lastLayer = this._offsets.length - 1;
    for (let layer = 0; layer < this._offsets.length; layer++) {
      const inSize = LAYERS[layer];
      const outSize = LAYERS[layer + 1];
      const next = this._buffers[layer];
      const offset = this._offsets[layer];
      const biasOffset = offset + outSize * inSize;
      const isOutput = layer === lastLayer;

      for (let j = 0; j < outSize; j++) {
        let sum = w[biasOffset + j];
        const wOffset = offset + j * inSize;
        for (let i = 0; i < inSize; i++) {
          sum += current[i] * w[wOffset + i];
        }
        next[j] = isOutput ? fastTanh(sum) : leakyRelu(sum);
      }

      current = next;
    }

    return current;
  }

}
