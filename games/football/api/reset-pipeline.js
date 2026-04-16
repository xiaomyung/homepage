/**
 * Reset pipeline rendering helpers — pure, shared between the reset
 * and start buttons.
 *
 * Since training moved to a Web Worker, the broker no longer publishes
 * pipeline stages; the client drives stage labels from worker progress
 * messages directly. This module keeps the label-rendering primitives
 * that both the training phase and the reload phase use.
 */

/** Label used while the client is waiting for the broker to respawn
 *  after a hard reset. */
export const RELOAD_STAGE = 'reloading page';

/**
 * Number of dots to show at `elapsedMs` since a stage started, cycling
 * 1 → 2 → 3 → 1 on `intervalMs` ticks. Keeps the button looking alive
 * when the stage has no numeric sub-progress (reloading, collecting).
 */
export function cyclingDotCount(elapsedMs, intervalMs = 400) {
  if (!(elapsedMs >= 0)) return 1;
  return (Math.floor(elapsedMs / intervalMs) % 3) + 1;
}

/** Render the button label for `stage` with cycling dots and an
 *  optional fractional-progress tag (e.g. "training seed .. (42/200)").
 *  `progress` is `{current, total}` or null. */
export function renderStageLabel(stage, elapsedMs, intervalMs = 400, progress = null) {
  const dots = '.'.repeat(cyclingDotCount(elapsedMs, intervalMs));
  const tag = (progress && Number.isFinite(progress.current) && Number.isFinite(progress.total))
    ? ` (${progress.current}/${progress.total})`
    : '';
  return `${stage} ${dots}${tag}`;
}
