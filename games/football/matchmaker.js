/**
 * Football v2 — client-side matchmaker.
 *
 * Pure functions that pick training matchups from a local snapshot of
 * the population. Previously this logic lived on the broker, which
 * meant every match cost a full HTTP round-trip to pick a pair; after
 * the refactor it runs in the browser's main thread and workers
 * receive matchups via postMessage. The broker's /matchup endpoint is
 * deleted entirely.
 *
 * The matchmaker is deliberately independent of any network or DOM
 * dependencies so it can be unit-tested against fixed populations +
 * fixed counts and every assertion fails loudly if the selection
 * algorithm regresses.
 */

/**
 * 1 fallback matchup for every 4 pop matchups. The broker used to
 * own this constant; it moved here alongside the picker. Same
 * cadence, same fitness weighting — so the GA sees the same mix of
 * data points before and after the refactor.
 */
export const FALLBACK_MATCHUP_EVERY_N = 4;

/**
 * Pick a single matchup descriptor from the given population and
 * per-brain match counts.
 *
 * Priority rules (preserved from the v1 broker logic):
 *   1. Every Nth call is a fallback slot — pick any brain whose
 *      `fallbackMatches` is below `config.min_fallback_matches`.
 *   2. If no such brain exists, fall through to the pop path.
 *   3. Pop picker prefers brains whose `popMatches` is below
 *      `config.min_pop_matches` — pairs two of them whenever
 *      possible. If fewer than two are under-served, draws from
 *      the full population so the matchmaker never stalls.
 *
 * @param {Array<{id:number}>} population
 * @param {Map<number, {popMatches:number, fallbackMatches:number}>} counts
 * @param {{min_pop_matches:number, min_fallback_matches:number}} config
 * @param {number} counter - monotonic call counter (supply sequential values across calls)
 * @param {() => number} rng - random number source in [0, 1); defaults to Math.random
 * @returns {{type:'pop'|'fallback', p1:number, p2:number|null}}
 */
export function pickMatchup(population, counts, config, counter, rng = Math.random) {
  if (!population.length) {
    throw new Error('pickMatchup: population is empty');
  }
  const pickIdx = (len) => Math.floor(rng() * len);

  if ((counter % FALLBACK_MATCHUP_EVERY_N) === 0) {
    const candidates = [];
    for (const b of population) {
      const c = counts.get(b.id);
      if (!c || c.fallbackMatches < config.min_fallback_matches) {
        candidates.push(b);
      }
    }
    if (candidates.length > 0) {
      const pick = candidates[pickIdx(candidates.length)];
      return { type: 'fallback', p1: pick.id, p2: null };
    }
    // Fall through to a pop matchup if everyone has enough fallback data.
  }

  const needFew = [];
  for (const b of population) {
    const c = counts.get(b.id);
    if (!c || c.popMatches < config.min_pop_matches) {
      needFew.push(b);
    }
  }
  const pool = needFew.length >= 2 ? needFew : population;
  if (pool.length < 2) {
    throw new Error('pickMatchup: population needs at least 2 brains for a pop matchup');
  }

  const a = pool[pickIdx(pool.length)];
  let b = pool[pickIdx(pool.length)];
  for (let attempts = 0; b.id === a.id && attempts < 5; attempts++) {
    b = pool[pickIdx(pool.length)];
  }
  return { type: 'pop', p1: a.id, p2: b.id };
}

/**
 * Build N matchups in one call — used by the orchestrator to hand a
 * worker a fresh batch in one postMessage. Increments the counter
 * internally and returns both the matchups and the new counter
 * value so the caller can persist it across batches.
 */
export function pickMatchups(population, counts, config, counterStart, n, rng = Math.random) {
  const out = new Array(n);
  let counter = counterStart;
  for (let i = 0; i < n; i++) {
    counter++;
    out[i] = pickMatchup(population, counts, config, counter, rng);
  }
  return { matchups: out, counter };
}

/**
 * Factory for a fresh per-brain counts entry. Used when bootstrapping
 * a local counts map from a broker population snapshot — counts are
 * seeded from whatever the broker has recorded so far.
 */
export function emptyCounts() {
  return {
    popMatches: 0,
    popGoalDiff: 0,
    fallbackMatches: 0,
    fallbackWins: 0,
    fallbackDraws: 0,
  };
}

/**
 * Apply a single completed match result to a local counts map. This
 * is the CLIENT-side mirror of the broker's `recordResult`. It runs
 * after every finished match on the orchestrator thread so the next
 * matchmaker call sees up-to-date local stats — prevents the
 * orchestrator from oversampling a brain it just paired.
 *
 * @param {Map<number, ReturnType<typeof emptyCounts>>} counts
 * @param {{p1_id:number, p2_id:number|null, goals_p1:number, goals_p2:number}} result
 * @returns {boolean} true if applied, false if the id was unknown
 */
export function applyResultToCounts(counts, result) {
  const p1 = counts.get(result.p1_id);
  if (!p1) return false;

  const goalsP1 = result.goals_p1 | 0;
  const goalsP2 = result.goals_p2 | 0;

  if (result.p2_id == null) {
    p1.fallbackMatches += 1;
    if (goalsP1 > goalsP2) p1.fallbackWins += 1;
    else if (goalsP1 === goalsP2) p1.fallbackDraws += 1;
    return true;
  }

  const p2 = counts.get(result.p2_id);
  if (!p2) return false;
  const diff = goalsP1 - goalsP2;
  p1.popMatches += 1;
  p1.popGoalDiff += diff;
  p2.popMatches += 1;
  p2.popGoalDiff -= diff;
  return true;
}

/**
 * Replace all entries in `target` with the broker-authoritative
 * snapshot in `server`. Used after every /results sync to reconcile
 * the client's local deltas with whatever the broker accepted from
 * all clients combined — prevents local views from drifting out of
 * line with reality over long sessions.
 *
 * @param {Map<number, ReturnType<typeof emptyCounts>>} target
 * @param {Array<{id, popMatches, popGoalDiff, fallbackMatches, fallbackWins, fallbackDraws}>} server
 */
export function reconcileCounts(target, server) {
  for (const s of server) {
    const entry = target.get(s.id);
    if (!entry) {
      target.set(s.id, {
        popMatches: s.popMatches | 0,
        popGoalDiff: +s.popGoalDiff || 0,
        fallbackMatches: s.fallbackMatches | 0,
        fallbackWins: s.fallbackWins | 0,
        fallbackDraws: s.fallbackDraws | 0,
      });
    } else {
      entry.popMatches = s.popMatches | 0;
      entry.popGoalDiff = +s.popGoalDiff || 0;
      entry.fallbackMatches = s.fallbackMatches | 0;
      entry.fallbackWins = s.fallbackWins | 0;
      entry.fallbackDraws = s.fallbackDraws | 0;
    }
  }
}
