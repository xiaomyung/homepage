/**
 * Client-side state machine for the reset pipeline.
 *
 * The browser drives three phases:
 *
 *   TRAINING  — Web Worker is running warm-start training. Label is
 *               driven by worker progress messages (epoch counter,
 *               collect-vs-train phase) not HTTP polls.
 *   RELOADING — Weights have been POSTed to /reset. Broker has exited
 *               for systemd respawn (or the POST itself failed and we're
 *               falling back). Poll /stats until respawned broker
 *               answers, then reload.
 *   DONE      — Cache-bust reload.
 *
 * All decision logic lives in pure functions so tests can exercise
 * every transition without spinning up a worker or a broker.
 */

export const PHASE_TRAINING = 'training';
export const PHASE_RELOADING = 'reloading';
export const PHASE_DONE = 'done';

/**
 * Classify a message received from the warm-start worker into a
 * canonical shape the UI can render without knowing the worker
 * protocol internals.
 *
 *   { kind: 'progress', stage, current, total } — update label
 *   { kind: 'done', weights }                     — transition to RELOADING
 *   { kind: 'error', message }                    — transition to RELOADING (fallback)
 *   { kind: 'ignore' }                             — unknown / malformed
 */
export function classifyWorkerMessage(msg) {
  if (!msg || typeof msg !== 'object') return { kind: 'ignore' };
  if (msg.type === 'progress') {
    const stage = msg.phase === 'collect' ? 'collecting data' : 'training seed';
    return {
      kind: 'progress',
      stage,
      current: Number.isFinite(msg.current) ? msg.current : 0,
      total: Number.isFinite(msg.total) ? msg.total : 1,
    };
  }
  if (msg.type === 'done' && msg.weights) {
    return { kind: 'done', weights: msg.weights };
  }
  if (msg.type === 'error') {
    return { kind: 'error', message: msg.message || 'worker error' };
  }
  return { kind: 'ignore' };
}

/**
 * Classify the POST /reset response. On any outcome (success, non-2xx,
 * network failure), transition to RELOADING: either the broker has
 * already exited (hard=1), or we still want to reload to clear any
 * client-cached state that may reference the old population.
 */
export function phaseAfterPost({ ok, status, networkError }) {
  void ok; void status; void networkError;
  return PHASE_RELOADING;
}

/**
 * Classify a /stats poll while in RELOADING. 200 → respawned broker is
 * ready → DONE. Anything else → stay waiting.
 */
export function phaseAfterStatsPoll({ ok, networkError }) {
  if (networkError) return PHASE_RELOADING;
  if (ok) return PHASE_DONE;
  return PHASE_RELOADING;
}
