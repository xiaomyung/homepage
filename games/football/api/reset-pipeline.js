/**
 * Reset pipeline rendering helpers — pure, shared between the reset
 * and start buttons.
 *
 * Since training moved to a Web Worker, the broker no longer publishes
 * pipeline stages; the client drives stage labels from worker progress
 * messages directly. This module keeps the label-rendering primitives
 * that both the training phase and the reload phase use.
 */

/** Labels used while the client is waiting after a hard reset.
 *  RESPAWN_STAGE covers the slow part — broker has exited, systemd is
 *  waiting its `RestartSec` then booting a fresh broker (SQLite init,
 *  re-seed population, open listener). RELOAD_STAGE is the brief tail
 *  once /stats answers, right before the browser navigates. */
export const RESPAWN_STAGE = 'restarting broker';
export const RELOAD_STAGE = 'reloading page';

/** Default dot-cycle period (ms) shared between the label renderer and
 *  the animation driver in ui.js so a change only has to happen once. */
export const DEFAULT_DOT_INTERVAL_MS = 400;

/**
 * Number of dots to show at `elapsedMs` since a stage started, cycling
 * 1 → 2 → 3 → 1 on `intervalMs` ticks. Keeps the button looking alive
 * when the stage has no numeric sub-progress (reloading, collecting).
 */
export function cyclingDotCount(elapsedMs, intervalMs = DEFAULT_DOT_INTERVAL_MS) {
  if (!(elapsedMs >= 0)) return 1;
  return (Math.floor(elapsedMs / intervalMs) % 3) + 1;
}

/** Render the button label for `stage` with cycling dots and an
 *  optional fractional-progress tag (e.g. "training seed .. (42/200)").
 *  `progress` is `{current, total}` or null. */
export function renderStageLabel(stage, elapsedMs, intervalMs = DEFAULT_DOT_INTERVAL_MS, progress = null) {
  const dots = '.'.repeat(cyclingDotCount(elapsedMs, intervalMs));
  const tag = (progress && Number.isFinite(progress.current) && Number.isFinite(progress.total))
    ? ` (${progress.current}/${progress.total})`
    : '';
  return `${stage} ${dots}${tag}`;
}
