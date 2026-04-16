/**
 * Fixed-timestep accumulator math for the showcase game loop.
 *
 * Extracted so it can be unit-tested without mocking the browser's
 * requestAnimationFrame, renderer, or DOM. See main.js frame() for
 * the runtime consumer.
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
 */
export function computeTicks(elapsedMs, accumulator, tickMs, maxTicks) {
  const total = accumulator + elapsedMs;
  const rawTicks = Math.max(0, Math.floor(total / tickMs));
  const ticks = Math.min(rawTicks, maxTicks);
  // Drop the excess when the cap fires so the next frame runs at
  // normal cadence. When no cap fires, preserve fractional leftover.
  const accumulatorNext = ticks === rawTicks ? total - ticks * tickMs : 0;
  return { ticks, accumulator: accumulatorNext };
}
