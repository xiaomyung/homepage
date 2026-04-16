/**
 * Unit tests for the broker's cumulative-runtime math.
 *
 * Pins the behaviour that broke before: the displayed runtime used
 * wall-clock `now` inside the hysteresis window, so the timer kept
 * advancing for up to 15 s after training stopped, then snapped back
 * when the window closed. Tests below assert the timer only counts up
 * to actual activity, regardless of how much real time has elapsed
 * since the last POST.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  runtimeNowMs,
  recordRuntimeActivity,
  flushRuntime,
} from '../api/runtime-timer.js';

const HYSTERESIS = 15_000;

function freshState() {
  return {
    runtimeMsTotal: 0,
    runtimeActiveStart: null,
    runtimeLastPostAt: null,
  };
}

test('fresh state reports 0 ms', () => {
  assert.equal(runtimeNowMs(freshState()), 0);
});

test('first POST opens a window but reports 0 until a second POST arrives', () => {
  const s = recordRuntimeActivity(freshState(), 1000, HYSTERESIS);
  assert.equal(s.runtimeActiveStart, 1000);
  assert.equal(s.runtimeLastPostAt, 1000);
  // Single-POST window has zero duration by definition.
  assert.equal(runtimeNowMs(s), 0);
});

test('second POST extends the window to its timestamp', () => {
  let s = recordRuntimeActivity(freshState(), 1000, HYSTERESIS);
  s = recordRuntimeActivity(s, 2500, HYSTERESIS);
  assert.equal(runtimeNowMs(s), 1500);
});

test('BUG REGRESSION: timer does not advance past last POST while idle', () => {
  // The original bug: inside the hysteresis window, runtimeNowMs
  // measured up to Date.now() instead of lastPostAt, so the timer
  // kept ticking for up to 15 s after training stopped.
  let s = recordRuntimeActivity(freshState(), 1000, HYSTERESIS);
  s = recordRuntimeActivity(s, 5000, HYSTERESIS);
  // Now 10 s pass with no more POSTs (well within the 15 s hysteresis
  // window). The displayed runtime must not advance past 5 s — i.e.
  // it must stay equal to lastPostAt - activeStart.
  assert.equal(runtimeNowMs(s), 4000);
  // Another 4 s pass (still within hysteresis). Still 4 s.
  assert.equal(runtimeNowMs(s), 4000);
  // Hysteresis expires. Still 4 s — no sudden "reset back" jump.
  assert.equal(runtimeNowMs(s), 4000);
});

test('gap longer than hysteresis folds old window into total and opens a new one', () => {
  let s = recordRuntimeActivity(freshState(), 1000, HYSTERESIS);
  s = recordRuntimeActivity(s, 5000, HYSTERESIS);  // +4000 ms window
  // 30 s idle, then new POST — exceeds 15 s hysteresis.
  s = recordRuntimeActivity(s, 35_000, HYSTERESIS);
  // Old window (4 s) folded into total; new window opened at 35 s.
  assert.equal(s.runtimeMsTotal, 4000);
  assert.equal(s.runtimeActiveStart, 35_000);
  assert.equal(s.runtimeLastPostAt, 35_000);
  assert.equal(runtimeNowMs(s), 4000);
});

test('new POST within hysteresis extends the same window — no double-count', () => {
  let s = recordRuntimeActivity(freshState(), 1000, HYSTERESIS);
  s = recordRuntimeActivity(s, 5000, HYSTERESIS);   // 4 s
  s = recordRuntimeActivity(s, 10_000, HYSTERESIS); // 5 s later, still in window
  s = recordRuntimeActivity(s, 15_000, HYSTERESIS);
  // Single continuous window from 1000 → 15000 = 14 s
  assert.equal(s.runtimeMsTotal, 0);
  assert.equal(s.runtimeActiveStart, 1000);
  assert.equal(runtimeNowMs(s), 14_000);
});

test('flushRuntime folds window into total and resets window at now', () => {
  let s = recordRuntimeActivity(freshState(), 1000, HYSTERESIS);
  s = recordRuntimeActivity(s, 5000, HYSTERESIS);
  s = flushRuntime(s, 5000);
  // The 4 s window is now in the persisted total; a fresh window
  // continues at t=5000 so the next POST doesn't re-add those 4 s.
  assert.equal(s.runtimeMsTotal, 4000);
  assert.equal(s.runtimeActiveStart, 5000);
  assert.equal(runtimeNowMs(s), 4000);
});

test('flushRuntime on fresh state is a no-op (nothing to fold)', () => {
  const s = flushRuntime(freshState(), 1000);
  assert.equal(s.runtimeMsTotal, 0);
  assert.equal(s.runtimeActiveStart, null);
  assert.equal(s.runtimeLastPostAt, null);
});

test('persisted total carries across multiple fold cycles', () => {
  // Simulate 3 training sessions separated by idle gaps > hysteresis.
  let s = recordRuntimeActivity(freshState(), 1000, HYSTERESIS);
  s = recordRuntimeActivity(s, 3000, HYSTERESIS);              // session 1: 2 s
  s = recordRuntimeActivity(s, 100_000, HYSTERESIS);           // folds session 1
  s = recordRuntimeActivity(s, 107_000, HYSTERESIS);           // session 2: 7 s
  s = recordRuntimeActivity(s, 200_000, HYSTERESIS);           // folds session 2
  s = recordRuntimeActivity(s, 201_500, HYSTERESIS);           // session 3: 1.5 s
  assert.equal(runtimeNowMs(s), 2000 + 7000 + 1500);
});

test('negative timestamps never produce negative runtime', () => {
  // Defensive — shouldn't happen in practice but don't corrupt state.
  const s = {
    runtimeMsTotal: 1000,
    runtimeActiveStart: 5000,
    runtimeLastPostAt: 3000,  // before start, broken
  };
  assert.equal(runtimeNowMs(s), 1000);  // clamped via Math.max(0, ...)
});

test('recordRuntimeActivity is pure (does not mutate input)', () => {
  const before = freshState();
  const after = recordRuntimeActivity(before, 1000, HYSTERESIS);
  assert.equal(before.runtimeActiveStart, null);
  assert.equal(after.runtimeActiveStart, 1000);
});
