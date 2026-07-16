/**
 * Fixed-timestep accumulator math for the showcase game loop.
 */

/**
 * Given the elapsed real time since the last frame and the leftover
 * accumulator, return the number of fixed ticks to run this frame and
 * the new accumulator carrying over to the next frame.
 *
 *   - 60 Hz display (elapsed ~16.67 ms) → 1 tick per frame on average
 *   - 120 Hz display (elapsed ~8.33 ms) → 0 ticks half the frames,
 *     1 tick the other half, averaging out to 60 Hz wall time
 *   - Long pause (elapsed >> maxTicks × tickMs) → capped at `maxTicks`
 *     AND accumulator is reset. If we carried the overage forward we'd
 *     keep spilling `maxTicks` into every subsequent frame until the
 *     backlog drained — which is exactly the tab-switch speedup bug:
 *     background the tab for 30 s, come back, and the game runs at
 *     ~3× speed for ~6 s while the accumulator pays itself off.
 *
 * Leftover sub-tick time is carried in the accumulator so fractional
 * frames don't drift — over a full second the tick count exactly
 * matches `round(1000 / tickMs)`.
 *
 * Returns a module-level scratch object, not a fresh allocation —
 * this runs once per rAF frame and the old per-call `{ ticks,
 * accumulator }` literal was steady allocation pressure for values
 * the caller only ever reads once and discards. The returned object
 * is valid only until the next `computeTicks` call: read `.ticks`
 * and `.accumulator` into locals immediately, don't hold the
 * reference across a subsequent call.
 */
const _scratch = { ticks: 0, accumulator: 0 };

export function computeTicks(elapsedMs, accumulator, tickMs, maxTicks) {
  const total = accumulator + elapsedMs;
  const rawTicks = Math.max(0, Math.floor(total / tickMs));
  const ticks = Math.min(rawTicks, maxTicks);
  // Drop the excess when the cap fires so the next frame runs at
  // normal cadence. When no cap fires, preserve fractional leftover.
  const accumulatorNext = ticks === rawTicks ? total - ticks * tickMs : 0;
  _scratch.ticks = ticks;
  _scratch.accumulator = accumulatorNext;
  return _scratch;
}
