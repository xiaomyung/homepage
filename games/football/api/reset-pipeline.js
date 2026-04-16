/**
 * Reset pipeline state machine — pure definitions + helpers.
 *
 * The broker runs the actual work (DB wipe, warm-start training,
 * population re-seed, save, exit) and publishes the current stage via
 * `/reset/status`. The client polls that endpoint and animates the
 * reset button text. Both sides share the stage list from here.
 */

/**
 * Ordered list of stages a hard reset passes through. Client-visible
 * labels — keep short and lowercase so they fit the bracket-text
 * aesthetic ("[ wiping db . ]").
 *
 * `restarting broker` is the final broker-reported stage; the client
 * transitions to `reloading page` locally once polling detects the
 * broker has respawned and responded to /stats again.
 */
export const RESET_STAGES = [
  'wiping db',
  'training seed',
  'seeding population',
  'saving',
  'restarting broker',
];

export const RELOAD_STAGE = 'reloading page';

/** True if `stage` is a valid server-reported stage name. */
export function isValidStage(stage) {
  return RESET_STAGES.includes(stage);
}

/**
 * Number of dots to show at `elapsedMs` since the stage started,
 * cycling 1 → 2 → 3 → 1 on `intervalMs` ticks. Used by the button
 * text animation so progress looks alive even for instant stages.
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
