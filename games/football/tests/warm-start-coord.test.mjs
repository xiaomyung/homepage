/**
 * Unit tests for the warm-start coordinator's pure helpers.
 * Covers: shard splitting (match seeds → N workers) and weight
 * averaging (N Float64Arrays → one element-wise mean).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitShards, averageWeights } from '../warm-start-coord.js';

/* ── splitShards ──────────────────────────────────────────── */

test('splitShards: exact divisions give equal shards', () => {
  const shards = splitShards(50, 5);
  assert.equal(shards.length, 5);
  for (const s of shards) assert.equal(s.count, 10);
  // Offsets are contiguous and cover [0, 50)
  assert.deepEqual(shards.map((s) => s.seedOffset), [0, 10, 20, 30, 40]);
});

test('splitShards: remainder distributed to the first workers', () => {
  // 50 / 8 = 6 base, remainder 2 → first 2 get 7, rest get 6
  const shards = splitShards(50, 8);
  assert.equal(shards.length, 8);
  assert.deepEqual(shards.map((s) => s.count), [7, 7, 6, 6, 6, 6, 6, 6]);
  assert.deepEqual(shards.map((s) => s.seedOffset), [0, 7, 14, 20, 26, 32, 38, 44]);
  // Total count covers exactly `numMatches`
  const total = shards.reduce((sum, s) => sum + s.count, 0);
  assert.equal(total, 50);
});

test('splitShards: shard sizes differ by at most 1', () => {
  for (const n of [1, 2, 3, 4, 7, 13, 50]) {
    for (const w of [1, 2, 3, 4, 8, 16]) {
      if (w > n) continue;
      const shards = splitShards(n, w);
      const sizes = shards.map((s) => s.count);
      assert.ok(
        Math.max(...sizes) - Math.min(...sizes) <= 1,
        `n=${n} w=${w} got spread ${sizes}`,
      );
    }
  }
});

test('splitShards: when workers > matches, extra workers get count=0', () => {
  const shards = splitShards(3, 8);
  assert.equal(shards.length, 8);
  assert.deepEqual(shards.map((s) => s.count), [1, 1, 1, 0, 0, 0, 0, 0]);
});

test('splitShards: single worker gets everything', () => {
  const shards = splitShards(50, 1);
  assert.deepEqual(shards, [{ seedOffset: 0, count: 50 }]);
});

test('splitShards: throws on invalid worker count', () => {
  assert.throws(() => splitShards(50, 0), /numWorkers/);
  assert.throws(() => splitShards(50, -1), /numWorkers/);
});

/* ── averageWeights ───────────────────────────────────────── */

test('averageWeights: single input returns a copy', () => {
  const w = new Float64Array([1, 2, 3]);
  const avg = averageWeights([w]);
  assert.deepEqual(Array.from(avg), [1, 2, 3]);
  // Must be a new array, not the input
  avg[0] = 99;
  assert.equal(w[0], 1, 'input must not be mutated');
});

test('averageWeights: two inputs give the midpoint', () => {
  const a = new Float64Array([0, 10, -4]);
  const b = new Float64Array([4, 2,  4]);
  const avg = averageWeights([a, b]);
  assert.deepEqual(Array.from(avg), [2, 6, 0]);
});

test('averageWeights: N-way average is the element-wise mean', () => {
  const n = 8;
  const len = 100;
  const arrays = Array.from({ length: n }, (_, i) =>
    new Float64Array(len).fill(i));
  const avg = averageWeights(arrays);
  // Mean of 0..7 is 3.5
  for (let i = 0; i < len; i++) assert.equal(avg[i], 3.5);
});

test('averageWeights: rejects mismatched lengths', () => {
  const a = new Float64Array([1, 2, 3]);
  const b = new Float64Array([1, 2]);
  assert.throws(() => averageWeights([a, b]), /length mismatch/);
});

test('averageWeights: rejects empty input', () => {
  assert.throws(() => averageWeights([]), /empty/);
  assert.throws(() => averageWeights(null), /empty/);
});

test('averageWeights: is numerically stable across many inputs', () => {
  // Simulate 16 workers each with slightly different weights.
  const n = 16;
  const len = 1233;
  const arrays = Array.from({ length: n }, (_, i) => {
    const w = new Float64Array(len);
    for (let k = 0; k < len; k++) w[k] = Math.sin(k * 0.01) + i * 1e-6;
    return w;
  });
  const avg = averageWeights(arrays);
  // Expected mean: sin(k*0.01) + (0+1+...+15)/16 * 1e-6
  const offset = 7.5e-6;
  for (let k = 0; k < len; k++) {
    const want = Math.sin(k * 0.01) + offset;
    assert.ok(Math.abs(avg[k] - want) < 1e-12,
      `k=${k}: got ${avg[k]}, want ${want}`);
  }
});
