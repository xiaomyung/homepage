/**
 * Unit tests for the fixed-timestep accumulator used by the showcase
 * visual loop. Pins the behaviour that broke on high-refresh displays:
 * without the accumulator the game ran at display Hz instead of 60 Hz.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeTicks } from '../frame-loop.js';

const TICK_MS = 16;
const MAX = 5;

test('60 Hz display produces 1 tick per frame on average', () => {
  // rAF fires every ~16.67 ms on a 60 Hz display.
  const frameMs = 1000 / 60;
  let acc = 0;
  let total = 0;
  for (let i = 0; i < 60; i++) {
    const r = computeTicks(frameMs, acc, TICK_MS, MAX);
    total += r.ticks;
    acc = r.accumulator;
  }
  // Over 1 second of wall time, the accumulator yields exactly
  // floor(1000/16) = 62 ticks. Not 60 — that's the cost of rounding
  // TICK_MS from 16.67 to 16. The invariant we care about: the tick
  // count is bounded to the true physical rate, not the display rate.
  assert.equal(total, 62);
});

test('120 Hz display still yields ~60 Hz of ticks, not 120', () => {
  // rAF fires every ~8.33 ms on a 120 Hz display. Previously the
  // game ran at 120 ticks/sec (2× speed) because it ticked once per
  // rAF. With the accumulator we should still get ~60 Hz of ticks.
  const frameMs = 1000 / 120;
  let acc = 0;
  let total = 0;
  for (let i = 0; i < 120; i++) {
    const r = computeTicks(frameMs, acc, TICK_MS, MAX);
    total += r.ticks;
    acc = r.accumulator;
  }
  // Expect same 62 ticks over 1 s — refresh rate has no effect.
  assert.equal(total, 62);
});

test('144 Hz display also yields ~60 Hz of ticks', () => {
  const frameMs = 1000 / 144;
  let acc = 0;
  let total = 0;
  for (let i = 0; i < 144; i++) {
    const r = computeTicks(frameMs, acc, TICK_MS, MAX);
    total += r.ticks;
    acc = r.accumulator;
  }
  assert.equal(total, 62);
});

test('30 Hz display (half-rate) still yields 60 Hz of ticks', () => {
  // If the browser can only hit 30 fps (slow machine, tab throttled),
  // each frame runs ~2 physics ticks to maintain wall-clock speed.
  const frameMs = 1000 / 30;
  let acc = 0;
  let total = 0;
  for (let i = 0; i < 30; i++) {
    const r = computeTicks(frameMs, acc, TICK_MS, MAX);
    total += r.ticks;
    acc = r.accumulator;
  }
  assert.equal(total, 62);
});

test('long pause is capped at maxTicks (no spiral of death)', () => {
  // Tab backgrounded for 10 seconds — would require 625 ticks to
  // catch up. The cap prevents the browser from locking up.
  const r = computeTicks(10_000, 0, TICK_MS, MAX);
  assert.equal(r.ticks, MAX);
  // Leftover accumulator is NOT 10000 - 80 — we've intentionally
  // dropped the overage rather than carry it forward.
  // (Actually the math carries it forward; that's a judgement call.
  // Verify the current behaviour so a future change is intentional.)
  assert.equal(r.accumulator, 10_000 - MAX * TICK_MS);
});

test('accumulator carries fractional time across frames', () => {
  // Single sub-tick frame → 0 ticks, full elapsed stays in accumulator.
  const r1 = computeTicks(10, 0, TICK_MS, MAX);
  assert.equal(r1.ticks, 0);
  assert.equal(r1.accumulator, 10);
  // Next frame brings total to 20 → 1 tick, 4 ms carried.
  const r2 = computeTicks(10, r1.accumulator, TICK_MS, MAX);
  assert.equal(r2.ticks, 1);
  assert.equal(r2.accumulator, 4);
});

test('negative elapsed (clock skew) does not produce negative ticks', () => {
  // Should be impossible in practice (rAF timestamps are monotonic)
  // but guard against it — a negative tick count would run physics
  // backwards.
  const r = computeTicks(-50, 0, TICK_MS, MAX);
  assert.equal(r.ticks, 0);
});

test('zero elapsed produces zero ticks', () => {
  const r = computeTicks(0, 0, TICK_MS, MAX);
  assert.equal(r.ticks, 0);
  assert.equal(r.accumulator, 0);
});
