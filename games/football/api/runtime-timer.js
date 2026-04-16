/**
 * Pure math for the broker's cumulative-runtime tracker.
 *
 * Extracted from broker.mjs so it can be unit-tested without spinning
 * up a real HTTP server or mocking Date.now everywhere. The broker
 * owns the state; this module just describes how state transforms
 * under the two events that drive it (/results POST arrival, /stats
 * read) and one invariant (fold + persist on shutdown).
 *
 * Shape of the state object:
 *   {
 *     runtimeMsTotal:       number,     // cumulative ms across folded windows
 *     runtimeActiveStart:   number|null // start of current window (ms since epoch)
 *     runtimeLastPostAt:    number|null // timestamp of most recent /results POST
 *   }
 */

/**
 * Displayed runtime at time `now`. Equals the persisted total plus
 * the duration of the current active window measured from its start
 * to the LAST recorded POST — never to `now`. Using `now` here was
 * the original bug: inside the hysteresis window the timer would
 * advance past actual activity and then snap back once the window
 * closed.
 */
export function runtimeNowMs(state) {
  let inProgress = 0;
  if (state.runtimeActiveStart !== null && state.runtimeLastPostAt !== null) {
    inProgress = Math.max(0, state.runtimeLastPostAt - state.runtimeActiveStart);
  }
  return state.runtimeMsTotal + inProgress;
}

/**
 * Apply a /results POST arrival at `now`. If the gap since the last
 * POST exceeds `hysteresisMs` (or no window is open), fold the old
 * window into runtimeMsTotal and open a new one at `now`. Otherwise
 * the existing window extends to cover this POST.
 *
 * Returns a new state object — caller mutates nothing in place, which
 * makes this pure and trivially testable.
 */
export function recordRuntimeActivity(state, now, hysteresisMs) {
  const prevLast = state.runtimeLastPostAt;
  const hasWindow = state.runtimeActiveStart !== null;
  const gapTooLong = prevLast !== null && (now - prevLast) > hysteresisMs;

  let runtimeMsTotal = state.runtimeMsTotal;
  let runtimeActiveStart = state.runtimeActiveStart;

  if (!hasWindow || gapTooLong) {
    if (hasWindow && prevLast !== null) {
      runtimeMsTotal += Math.max(0, prevLast - state.runtimeActiveStart);
    }
    runtimeActiveStart = now;
  }
  return {
    runtimeMsTotal,
    runtimeActiveStart,
    runtimeLastPostAt: now,
  };
}

/**
 * Snapshot the current active window into runtimeMsTotal and return a
 * state object suitable for persistence. Leaves the window "open" at
 * `now` so training keeps accruing without a double-count on the next
 * tick — but fresh state (activeStart/lastPostAt both null) is also
 * valid for shutdown paths that are about to exit the process.
 */
export function flushRuntime(state, now) {
  const snapshot = runtimeNowMs(state);
  if (state.runtimeActiveStart === null) {
    return { ...state, runtimeMsTotal: snapshot };
  }
  return {
    runtimeMsTotal: snapshot,
    runtimeActiveStart: now,
    runtimeLastPostAt: now,
  };
}
