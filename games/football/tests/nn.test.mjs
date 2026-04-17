/**
 * Unit tests for nn.js.
 *
 * Architecture: 25 → 16 → 9, LeakyReLU on hidden, tanh on output.
 * 425 total weights (25*16 + 16 + 16*9 + 9 = 400 + 16 + 144 + 9).
 * Inputs 18 and 19 are cos/sin of the player's heading; 20–24 are
 * derived signals (see physics.js:buildInputs).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NeuralNet, WEIGHT_COUNT, ARCH } from '../nn.js';

/* ── Shape + constants ─────────────────────────────────────── */

test('ARCH is [25, 16, 9]', () => {
  assert.deepEqual(ARCH, [25, 16, 9]);
});

test('WEIGHT_COUNT matches layer sum', () => {
  // 25*16+16 + 16*9+9 = 416 + 153 = 569
  assert.equal(WEIGHT_COUNT, 569);
});

/* ── Construction ──────────────────────────────────────────── */

test('new NeuralNet() with no args initializes with random weights of correct length', () => {
  const nn = new NeuralNet();
  assert.equal(nn.weights.length, WEIGHT_COUNT);
  // Random init should produce non-zero values
  const anyNonZero = nn.weights.some(w => w !== 0);
  assert.ok(anyNonZero, 'random init should produce non-zero weights');
});

test('new NeuralNet(weights) stores the provided weight array', () => {
  const weights = new Array(WEIGHT_COUNT).fill(0.1);
  const nn = new NeuralNet(weights);
  assert.equal(nn.weights.length, WEIGHT_COUNT);
  assert.equal(nn.weights[0], 0.1);
  assert.equal(nn.weights[WEIGHT_COUNT - 1], 0.1);
});

test('new NeuralNet rejects weights of wrong length', () => {
  assert.throws(() => new NeuralNet(new Array(100).fill(0)), /weight/i);
});

/* ── Forward pass ──────────────────────────────────────────── */

test('forward returns a 9-float array', () => {
  const nn = new NeuralNet();
  const inputs = new Array(25).fill(0);
  const out = nn.forward(inputs);
  assert.equal(out.length, 9);
});

test('forward rejects inputs of wrong length', () => {
  const nn = new NeuralNet();
  assert.throws(() => nn.forward(new Array(5).fill(0)), /input/i);
});

test('forward output is in tanh range [-1, 1]', () => {
  const nn = new NeuralNet();
  // Feed large positive and negative to push tanh toward saturation
  const large = new Array(25).fill(100);
  const small = new Array(25).fill(-100);
  for (const v of nn.forward(large)) {
    assert.ok(v >= -1 && v <= 1, `output out of tanh range: ${v}`);
  }
  for (const v of nn.forward(small)) {
    assert.ok(v >= -1 && v <= 1, `output out of tanh range: ${v}`);
  }
});

test('forward is deterministic: same weights + same inputs → same output', () => {
  const weights = new Array(WEIGHT_COUNT).fill(0).map((_, i) => Math.sin(i) * 0.1);
  const nn = new NeuralNet(weights);
  const inputs = new Array(25).fill(0).map((_, i) => Math.cos(i) * 0.5);
  const out1 = nn.forward(inputs);
  const out2 = nn.forward(inputs);
  assert.deepEqual(out1, out2);
});

test('different weights produce different outputs on same input', () => {
  const inputs = new Array(25).fill(0.5);
  const weightsA = new Array(WEIGHT_COUNT).fill(0.1);
  const weightsB = new Array(WEIGHT_COUNT).fill(-0.1);
  const outA = new NeuralNet(weightsA).forward(inputs);
  const outB = new NeuralNet(weightsB).forward(inputs);
  assert.notDeepEqual(outA, outB);
});

/* ── LeakyReLU behavior on hidden layers ──────────────────── */

test('LeakyReLU lets negative inputs leak through hidden layers', () => {
  // Set all weights to -1 so the first hidden layer gets large negative
  // pre-activations. A ReLU would zero these; LeakyReLU lets a small
  // negative slope through, which changes the final output.
  const leakyWeights = new Array(WEIGHT_COUNT).fill(-1);
  const zeroWeights = new Array(WEIGHT_COUNT).fill(0);
  const inputs = new Array(25).fill(1);
  const leakyOut = new NeuralNet(leakyWeights).forward(inputs);
  const zeroOut = new NeuralNet(zeroWeights).forward(inputs);
  // With all zero weights, output should be tanh(0) = 0 across the board
  for (const v of zeroOut) assert.equal(v, 0);
  // With all -1 weights, leaky slope produces non-zero outputs
  const anyNonZero = leakyOut.some(v => v !== 0);
  assert.ok(anyNonZero, 'LeakyReLU should leak negative signal through to output');
});

/* ── Weight load from JSON ─────────────────────────────────── */

test('NeuralNet.fromJson parses a flat array', () => {
  const json = JSON.stringify(new Array(WEIGHT_COUNT).fill(0.25));
  const nn = NeuralNet.fromJson(json);
  assert.equal(nn.weights.length, WEIGHT_COUNT);
  assert.equal(nn.weights[0], 0.25);
});

test('NeuralNet.fromJson rejects malformed JSON', () => {
  assert.throws(() => NeuralNet.fromJson('not json'));
});

test('NeuralNet.fromJson rejects wrong-length arrays', () => {
  const tooShort = JSON.stringify([0.1, 0.2]);
  assert.throws(() => NeuralNet.fromJson(tooShort), /weight/i);
});

/* ── Serialize roundtrip ───────────────────────────────────── */

test('toJson roundtrips through fromJson', () => {
  const originalWeights = new Array(WEIGHT_COUNT).fill(0).map((_, i) => Math.sin(i));
  const nn1 = new NeuralNet(originalWeights);
  const json = nn1.toJson();
  const nn2 = NeuralNet.fromJson(json);
  assert.deepEqual(nn2.weights, nn1.weights);
});
