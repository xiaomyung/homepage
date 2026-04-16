/**
 * Client-side state machine for the reset pipeline.
 *
 * The browser drives three phases:
 *
 *   TRAINING  — Web Worker orchestrator is running warm-start training.
 *               Label is driven by the orchestrator's onProgress callback
 *               (per-epoch counter) rather than individual worker messages.
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
 * Classify a /stats poll while in RELOADING. 200 → respawned broker is
 * ready → DONE. Anything else → stay waiting.
 */
export function phaseAfterStatsPoll({ ok, networkError }) {
  if (networkError) return PHASE_RELOADING;
  if (ok) return PHASE_DONE;
  return PHASE_RELOADING;
}
