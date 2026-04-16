/**
 * Unit tests for the reset pipeline rendering helpers. Covers the
 * client-visible cycling-dot animation math and label composition so
 * changes don't silently break the reset button UX.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RELOAD_STAGE,
  cyclingDotCount,
  renderStageLabel,
} from '../api/reset-pipeline.js';

/* ── Reload stage label ──────────────────────────────────── */

test('RELOAD_STAGE is the canonical reloading label', () => {
  assert.equal(RELOAD_STAGE, 'reloading page');
});

/* ── Cycling dots ─────────────────────────────────────────── */

test('cyclingDotCount starts at 1 dot immediately after stage begins', () => {
  assert.equal(cyclingDotCount(0), 1);
  assert.equal(cyclingDotCount(50), 1);
});

test('cyclingDotCount cycles 1 → 2 → 3 → 1 at interval boundaries', () => {
  const interval = 400;
  assert.equal(cyclingDotCount(0, interval), 1);
  assert.equal(cyclingDotCount(399, interval), 1);
  assert.equal(cyclingDotCount(400, interval), 2);
  assert.equal(cyclingDotCount(799, interval), 2);
  assert.equal(cyclingDotCount(800, interval), 3);
  assert.equal(cyclingDotCount(1199, interval), 3);
  assert.equal(cyclingDotCount(1200, interval), 1);  // wraps
});

test('cyclingDotCount handles long-running stages without overflow', () => {
  // After ~50 seconds of training, dots should still cycle 1..3.
  const interval = 400;
  for (let t = 0; t < 50_000; t += 123) {
    const n = cyclingDotCount(t, interval);
    assert.ok(n >= 1 && n <= 3, `dots must stay in [1,3] at t=${t}, got ${n}`);
  }
});

test('cyclingDotCount clamps negative elapsed to 1 dot', () => {
  // Defensive — never show 0 dots or NaN in the label.
  assert.equal(cyclingDotCount(-100), 1);
  assert.equal(cyclingDotCount(NaN), 1);
});

/* ── Label rendering ──────────────────────────────────────── */

test('renderStageLabel combines stage name with cycling dots', () => {
  assert.equal(renderStageLabel('training seed', 0), 'training seed .');
  assert.equal(renderStageLabel('training seed', 400), 'training seed ..');
  assert.equal(renderStageLabel('training seed', 800), 'training seed ...');
});

test('renderStageLabel works for the reload stage', () => {
  assert.equal(renderStageLabel(RELOAD_STAGE, 0), 'reloading page .');
});

test('renderStageLabel respects custom interval', () => {
  assert.equal(renderStageLabel('saving', 0, 1000), 'saving .');
  assert.equal(renderStageLabel('saving', 999, 1000), 'saving .');
  assert.equal(renderStageLabel('saving', 1000, 1000), 'saving ..');
});

test('renderStageLabel appends fractional progress when provided', () => {
  assert.equal(renderStageLabel('training seed', 0, 400, { current: 42, total: 200 }), 'training seed . (42/200)');
  assert.equal(renderStageLabel('training seed', 800, 400, { current: 200, total: 200 }), 'training seed ... (200/200)');
});

test('renderStageLabel ignores malformed progress', () => {
  assert.equal(renderStageLabel('training seed', 0, 400, null), 'training seed .');
  assert.equal(renderStageLabel('training seed', 0, 400, {}), 'training seed .');
  assert.equal(renderStageLabel('training seed', 0, 400, { current: 'x', total: 10 }), 'training seed .');
});
