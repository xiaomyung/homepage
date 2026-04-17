/**
 * Football v2 — genetic algorithm.
 *
 * Pure module: no deps, no DOM, no filesystem. Consumed by broker.mjs and
 * warm-start tooling. Brain records use camelCase; the broker converts to
 * snake_case SQLite columns at the boundary.
 *
 * Determinism: all randomness flows through a seeded LCG (createGaRng)
 * matching the physics.js PRNG formula, so given the same seed the breeding
 * loop is bit-reproducible. The GA keeps its own rng stream independent of
 * physics so match rollouts don't perturb selection order.
 */

/* ── NN architecture (must match games/football/nn.js) ─────────── */

export const ARCH = [25, 16, 9];

const LAYER_COUNT = ARCH.length - 1;

function computeLayerOffsets(arch) {
  const offsets = [0];
  let acc = 0;
  for (let i = 0; i < arch.length - 1; i++) {
    acc += arch[i] * arch[i + 1] + arch[i + 1];
    offsets.push(acc);
  }
  return offsets;
}

export const LAYER_OFFSETS = computeLayerOffsets(ARCH);
export const WEIGHT_COUNT = LAYER_OFFSETS[LAYER_OFFSETS.length - 1];

/* ── Fitness ───────────────────────────────────────────────────── */

/**
 * Build a FitnessWeights record. `wPop` and `wFallback` should sum to 1 so
 * fitness stays in [0, 1]; `goalDiffScale` is the k in `tanh(avgDiff/k)`.
 * k≈2 goals makes a two-goal lead land at tanh(1)≈0.76 and a blowout
 * saturate smoothly rather than clip hard.
 */
export function makeFitnessWeights({ wPop, wFallback, goalDiffScale, maxGoalDiff }) {
  // Backwards-compat: if a caller still passes `maxGoalDiff`, use it as
  // the tanh scale. New callers should pass `goalDiffScale`.
  const k = goalDiffScale ?? maxGoalDiff ?? 2;
  return { wPop, wFallback, goalDiffScale: k };
}

/**
 * Normalized hybrid fitness in [0, 1]. A brain with zero data on both
 * axes scores 0.0; one axis of data yields neutral 0.5 on the missing
 * axis so partial data is still meaningful.
 *
 * Pop axis uses `tanh(avgGoalDiff / k)` rather than a hard clamp. That
 * choice (see 2026-04-17 brainstorm) is defined everywhere (no 0-0
 * divide-by-zero), smoothly saturates at blowouts, and gives a strong
 * signal on narrow wins without discarding information on big ones.
 */
export function computeFitness(brain, w) {
  const popMatches = brain.popMatches || 0;
  const fbMatches = brain.fallbackMatches || 0;

  if (popMatches === 0 && fbMatches === 0) return 0.0;

  let popScore;
  if (popMatches > 0) {
    const avgDiff = (brain.popGoalDiff || 0) / popMatches;
    const scale = w.goalDiffScale ?? w.maxGoalDiff ?? 2;
    // tanh(x) ∈ (-1, 1); shift to [0, 1].
    popScore = (Math.tanh(avgDiff / scale) + 1) / 2;
  } else {
    popScore = 0.5;
  }

  let fbScore;
  if (fbMatches > 0) {
    const raw =
      ((brain.fallbackWins || 0) + 0.5 * (brain.fallbackDraws || 0)) / fbMatches;
    fbScore = Math.max(0.0, Math.min(1.0, raw));
  } else {
    fbScore = 0.5;
  }

  return w.wPop * popScore + w.wFallback * fbScore;
}

/* ── Tournament selection ──────────────────────────────────────── */

/**
 * Fisher-Yates partial shuffle to draw `size` distinct indices from [0, n).
 * Deterministic given the rng.
 */
function sampleIndices(n, size, rng) {
  const pool = new Array(n);
  for (let i = 0; i < n; i++) pool[i] = i;
  const take = Math.min(size, n);
  for (let i = 0; i < take; i++) {
    // rng() is [0,1); floor(rng() * (n-i)) ∈ [0, n-i).
    const j = i + Math.floor(rng() * (n - i));
    const tmp = pool[i];
    pool[i] = pool[j];
    pool[j] = tmp;
  }
  return pool.slice(0, take);
}

export function tournamentSelect(population, k, rng) {
  const idx = sampleIndices(population.length, k, rng);
  let best = population[idx[0]];
  for (let i = 1; i < idx.length; i++) {
    const cand = population[idx[i]];
    if (cand.fitness > best.fitness) best = cand;
  }
  return best;
}

/* ── Crossover ─────────────────────────────────────────────────── */

/**
 * Two-point crossover over flat weight arrays. When the two cut points
 * collapse (p1 === p2) the child is a pure copy of parentA.
 */
export function twoPointCrossover(parentAWeights, parentBWeights, rng) {
  const n = parentAWeights.length;
  if (parentBWeights.length !== n) {
    throw new Error('parent weight counts must match');
  }
  let p1 = Math.floor(rng() * n);
  let p2 = Math.floor(rng() * n);
  if (p1 > p2) { const tmp = p1; p1 = p2; p2 = tmp; }
  const child = new Float64Array(n);
  child.set(parentAWeights);
  if (p2 > p1) {
    for (let i = p1; i < p2; i++) child[i] = parentBWeights[i];
  }
  return child;
}

/* ── Mutation ──────────────────────────────────────────────────── */

export function gaussianMutate(weights, rate, std, rng) {
  const out = new Float64Array(weights.length);
  out.set(weights);
  if (rate <= 0.0) return out;
  const sampler = gaussianFromRng(rng);
  for (let i = 0; i < out.length; i++) {
    if (rng() < rate) out[i] += sampler() * std;
  }
  return out;
}

/* ── Weight init ───────────────────────────────────────────────── */

/**
 * He initialization: N(0, sqrt(2/fan_in)) per weight matrix, biases left at
 * zero. Determinism flows entirely through the passed rng.
 */
export function heInitWeights(rng) {
  const weights = new Float64Array(WEIGHT_COUNT);
  const sampler = gaussianFromRng(rng);
  let idx = 0;
  for (let layer = 0; layer < LAYER_COUNT; layer++) {
    const fanIn = ARCH[layer];
    const fanOut = ARCH[layer + 1];
    const stddev = Math.sqrt(2 / fanIn);
    const matSize = fanIn * fanOut;
    for (let k = 0; k < matSize; k++) {
      weights[idx++] = sampler() * stddev;
    }
    idx += fanOut; // biases stay zero
  }
  return weights;
}

/* ── Breeding ──────────────────────────────────────────────────── */

/**
 * Produce the next generation.
 *   1. Sort current pop by fitness desc, copy top `elitism` unchanged.
 *   2. Inject round(size * randomInjectionRate) fresh random brains.
 *   3. Fill the remainder by tournament-select → crossover → mutate.
 *
 * New brains have cleared stats — only weights carry over from parents.
 */
export function breedNextGeneration(population, opts) {
  const {
    size,
    elitism,
    tournamentK,
    mutationRate,
    mutationStd,
    randomInjectionRate,
    rng,
  } = opts;

  const sorted = population.slice().sort((a, b) => b.fitness - a.fitness);
  const newPop = [];

  for (let i = 0; i < elitism && i < sorted.length; i++) {
    newPop.push(freshBrain(new Float64Array(sorted[i].weights)));
  }

  const numRandom = Math.round(size * randomInjectionRate);
  for (let i = 0; i < numRandom; i++) {
    if (newPop.length >= size) break;
    newPop.push(freshBrain(heInitWeights(rng)));
  }

  while (newPop.length < size) {
    const parentA = tournamentSelect(population, tournamentK, rng);
    const parentB = tournamentSelect(population, tournamentK, rng);
    let child = twoPointCrossover(parentA.weights, parentB.weights, rng);
    child = gaussianMutate(child, mutationRate, mutationStd, rng);
    newPop.push(freshBrain(child));
  }

  return newPop.slice(0, size);
}

/** Brain record with cleared fitness/match stats. */
export function freshBrain(weights) {
  return {
    weights,
    fitness: 0,
    popMatches: 0,
    popGoalDiff: 0,
    fallbackMatches: 0,
    fallbackWins: 0,
    fallbackDraws: 0,
  };
}

/* ── PRNG ──────────────────────────────────────────────────────── */

/**
 * Seeded LCG matching physics.js:createSeededRng() bit-for-bit. The GA keeps
 * its own stream so match rollouts don't perturb breeding order.
 */
export function createGaRng(seed) {
  let state = (seed >>> 0) || 1;
  return function rng() {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/**
 * Box-Muller gaussian sampler built on a seeded rng. Returns a closure; each
 * call yields one standard normal sample (we discard the paired draw for
 * simplicity — the rng is cheap).
 */
export function gaussianFromRng(rng) {
  return function gauss() {
    const u1 = rng() || 1e-10;
    const u2 = rng();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  };
}
