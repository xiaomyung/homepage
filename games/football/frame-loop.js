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
 *   - Long pause (elapsed >> MAX_TICKS × TICK_MS) → capped at `maxTicks`
 *     so a backgrounded tab doesn't catch up in slow motion
 *
 * Leftover sub-tick time is carried in the accumulator so fractional
 * frames don't drift — over a full second the tick count exactly
 * matches `round(1000 / tickMs)`.
 */
export function computeTicks(elapsedMs, accumulator, tickMs, maxTicks) {
  const total = accumulator + elapsedMs;
  const ticks = Math.min(Math.max(0, Math.floor(total / tickMs)), maxTicks);
  return { ticks, accumulator: total - ticks * tickMs };
}
