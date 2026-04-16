/**
 * Pure helpers for the multi-worker warm-start orchestrator.
 *
 * Kept separate from the orchestrator itself so the math (weight
 * averaging, shard splitting) can be unit-tested without spawning
 * any Web Workers.
 *
 * "Local SGD with epoch-level averaging" semantics:
 *   - N workers each own a disjoint slice of the fallback-match seeds
 *   - Every epoch, each worker runs one full SGD pass over its shard
 *     starting from the same broadcast weights
 *   - Main thread averages the N resulting weight vectors
 *   - Averaged weights are broadcast for the next epoch
 *
 * This is the "FedAvg" pattern from federated learning. It converges
 * nearly identically to centralized SGD for problems of this size,
 * with a sync cost of ~200 weight-broadcasts total (one per epoch)
 * rather than ~78 000 gradient-broadcasts (one per batch) that pure
 * per-batch data-parallel SGD would need. For a model this small with
 * sub-millisecond per-batch work, per-batch sync would dominate and
 * actually slow things down.
 */

/**
 * Split `numMatches` match seeds across `numWorkers` shards. Returns
 * `[{seedOffset, count}, ...]` in worker order. Remainders distributed
 * to the first few workers so shards differ by at most 1 match.
 *
 * Each worker collects fallback-vs-fallback matches using
 * `collectImitationDataset(count, ticksPerMatch, baseSeed + seedOffset)`
 * so workers get disjoint, deterministic data.
 */
export function splitShards(numMatches, numWorkers) {
  if (numWorkers <= 0) throw new Error('numWorkers must be > 0');
  if (numMatches < numWorkers) {
    // Can't meaningfully split; give one match to each of the first
    // `numMatches` workers and zero to the rest.
    return Array.from({ length: numWorkers }, (_, i) => ({
      seedOffset: i,
      count: i < numMatches ? 1 : 0,
    }));
  }
  const base = Math.floor(numMatches / numWorkers);
  const remainder = numMatches - base * numWorkers;
  const shards = [];
  let offset = 0;
  for (let i = 0; i < numWorkers; i++) {
    const count = base + (i < remainder ? 1 : 0);
    shards.push({ seedOffset: offset, count });
    offset += count;
  }
  return shards;
}

/**
 * Average N Float64Array weight vectors element-wise. Returns a new
 * Float64Array; does not mutate inputs.
 */
export function averageWeights(weightArrays) {
  if (!weightArrays || weightArrays.length === 0) {
    throw new Error('averageWeights: empty input');
  }
  const n = weightArrays.length;
  const len = weightArrays[0].length;
  for (const w of weightArrays) {
    if (w.length !== len) {
      throw new Error(`averageWeights: length mismatch (${w.length} vs ${len})`);
    }
  }
  const out = new Float64Array(len);
  for (const w of weightArrays) {
    for (let i = 0; i < len; i++) out[i] += w[i];
  }
  const invN = 1 / n;
  for (let i = 0; i < len; i++) out[i] *= invN;
  return out;
}
