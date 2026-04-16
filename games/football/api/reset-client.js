/**
 * Client-side state machine for the reset pipeline UI.
 *
 * The browser drives two phases:
 *
 *   POLLING   — broker is up and running the pipeline. Client fetches
 *               /reset/status every ~300 ms and updates the button
 *               label with the reported stage.
 *   RELOADING — broker has exited (or we hit an incompatibility, e.g.
 *               talking to a pre-PR#33 broker that has no
 *               /reset/status route). Show "reloading page" while
 *               polling /stats until the respawned broker answers,
 *               then hard-reload.
 *
 * All decision logic is in this module as pure functions so tests can
 * exercise every transition without mocking fetch.
 */

export const PHASE_POLLING = 'polling';
export const PHASE_RELOADING = 'reloading';
export const PHASE_DONE = 'done';

/**
 * Given the response to `POST /reset?hard=1`, decide which phase the
 * client enters next.
 *
 *   - 202 Accepted → PHASE_POLLING (broker kicked off async pipeline)
 *   - any other success (e.g. 200 from a pre-async broker)
 *     → PHASE_RELOADING (work already done synchronously; just wait
 *     for respawn + reload)
 *   - 4xx/5xx → PHASE_RELOADING (give up on progress; still reload
 *     once the broker is healthy again)
 *   - network error (fetch rejected) → PHASE_RELOADING (broker went
 *     down mid-request; that's the sync-and-exit behaviour of the
 *     pre-PR#33 broker, and roughly what our own pipeline does at the
 *     end anyway)
 */
export function phaseAfterPost({ ok, status, networkError }) {
  if (networkError) return PHASE_RELOADING;
  if (status === 202) return PHASE_POLLING;
  return PHASE_RELOADING;
}

/**
 * Given the response to `GET /reset/status` while in PHASE_POLLING,
 * decide whether to stay polling (and optionally update the stage
 * label) or flip to PHASE_RELOADING.
 *
 *   - 200 with `status.stage` → keep polling, caller updates label
 *   - 200 with null status    → keep polling (broker is idle —
 *     could be a stale read just before the async pipeline starts,
 *     or the pipeline finished and broker is about to exit; either
 *     way the next poll cycle will clarify)
 *   - 404 → PHASE_RELOADING (talking to a broker that doesn't
 *     implement this endpoint; fall back to stats-wait + reload)
 *   - any other HTTP error → keep polling (transient — don't give up
 *     on progress for a flaky 5xx)
 *   - network error → PHASE_RELOADING (broker exited for respawn)
 */
export function phaseAfterStatusPoll({ ok, status, body, networkError }) {
  if (networkError) return PHASE_RELOADING;
  if (status === 404) return PHASE_RELOADING;
  if (ok && body && body.status && body.status.stage) {
    return {
      phase: PHASE_POLLING,
      stage: body.status.stage,
      progress: body.status.progress ?? null,
    };
  }
  return PHASE_POLLING;  // keep polling — no stage update
}

/**
 * Given the response to `GET /stats` while in PHASE_RELOADING, decide
 * whether the respawned broker is ready (trigger reload) or we should
 * keep waiting.
 */
export function phaseAfterStatsPoll({ ok, networkError }) {
  if (networkError) return PHASE_RELOADING;  // still down, keep waiting
  if (ok) return PHASE_DONE;                 // respawned, reload now
  return PHASE_RELOADING;                    // 4xx/5xx, keep waiting
}
