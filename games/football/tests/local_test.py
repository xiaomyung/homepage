"""
Football v2 — CLI training smoke test. The phase 3 hard gate.

Purpose: prove that the training pipeline actually learns before phase 4
writes a single browser worker. 32k generations of v1 produced zero
improvement; if this script can't show fitness climbing over 10 generations
offline, the problem is in the pipeline (fitness function, GA, or warm
start), not in the browser integration.

Pipeline per generation:
  1. Run N pop-internal matches (brain vs brain, random pairings).
     Record goal_diff for each brain from each match.
  2. Run M fallback-anchor matches per brain (brain as p1, fallback as p2).
     Record wins / draws / losses and goal_diff.
  3. Compute fitness per brain using compute_fitness().
  4. Print avg / top / fallback_win_rate for the generation.
  5. Breed next generation. Brain #0 stays frozen as the warm-start seed.

Exits 0 on success (top_fitness at last gen > top_fitness at first gen +
SUCCESS_DELTA). Exits 1 if fitness did not climb — phase 3 is not done in
that case and fitness weights / selection pressure / warm start must be
tuned until it does.

Run from the repo root:
    ./venv/bin/python games/football/tests/local_test.py
"""
from __future__ import annotations

import json
import os
import random
import sys
import time
from typing import Optional

HERE = os.path.dirname(os.path.abspath(__file__))
# Run as a standalone script, so wire up sys.path directly rather than
# depending on conftest.py (which only runs under pytest).
sys.path.insert(0, os.path.abspath(os.path.join(HERE, "..", "evolution")))

import numpy as np  # noqa: E402

from fallback_py import fallback_action  # noqa: E402
from ga import (  # noqa: E402
    FitnessWeights,
    WEIGHT_COUNT,
    breed_next_generation,
    compute_fitness,
    gaussian_mutate,
    he_init_weights,
    nn_forward,
)
from physics_py import (  # noqa: E402
    build_inputs,
    create_field,
    create_seeded_rng,
    create_state,
    tick,
)

WARM_START_PATH = os.path.abspath(os.path.join(HERE, "..", "warm_start_weights.json"))

# Smoke-test scale — small enough to run in a few minutes, large enough
# to show meaningful fitness signal.
POPULATION_SIZE = 30
NUM_GENERATIONS = 10
MATCH_TICKS = 300  # ~5 seconds of simulated play
POP_MATCHES_PER_BRAIN = 4
FALLBACK_MATCHES_PER_BRAIN = 3
TOURNAMENT_K = 5
ELITISM = 3
MUTATION_RATE = 0.1
MUTATION_STD = 0.1
RANDOM_INJECTION_RATE = 0.05

# Fitness formula coefficients (phase 3 starting values — tune until
# top_fitness climbs meaningfully over NUM_GENERATIONS). All fitness
# values are normalized to [0, 1].
FITNESS_WEIGHTS = FitnessWeights(
    w_pop=0.4,
    w_fallback=0.6,
    max_goal_diff=3.0,
)

# Success criteria — both must hold for PASS. Smoothing uses a 3-gen
# window at the start and end to absorb single-generation noise. Thresholds
# are in the [0, 1] fitness scale, so "0.02" means a 2-percentage-point
# improvement in average brain fitness — small but unambiguous.
SMOOTH_WINDOW = 3
MIN_AVG_FITNESS_DELTA = 0.02
MIN_FB_WIN_RATE_DELTA = 0.03


# ── Match runner ───────────────────────────────────────────────

def run_match(
    weights_a: np.ndarray,
    weights_b_or_none: Optional[np.ndarray],
    seed: int,
    duration_ticks: int,
) -> tuple[int, int]:
    """Run one match. If weights_b_or_none is None, p2 is the fallback.

    Returns (goals_a, goals_b) — goals scored by each side.
    """
    field = create_field()
    state = create_state(field, create_seeded_rng(seed))
    state["graceFrames"] = 0  # allow scoring from tick 1

    for _ in range(duration_ticks):
        if state["matchOver"]:
            break

        if state["pauseState"] is not None:
            tick(state, None, None)
            continue

        # p1 always uses weights_a
        p1_input = np.asarray(build_inputs(state, "p1"), dtype=np.float64)
        a_action = nn_forward(weights_a, p1_input).tolist()

        # p2 is either fallback or another brain
        if weights_b_or_none is None:
            b_action = fallback_action(state, "p2")
        else:
            p2_input = np.asarray(build_inputs(state, "p2"), dtype=np.float64)
            b_action = nn_forward(weights_b_or_none, p2_input).tolist()

        tick(state, a_action, b_action)

    return state["scoreL"], state["scoreR"]


# ── Generation loop ───────────────────────────────────────────

def reset_brain_stats(population: list[dict]) -> None:
    for b in population:
        b["pop_matches"] = 0
        b["pop_goal_diff"] = 0.0
        b["blowout_bonus"] = 0.0
        b["fallback_matches"] = 0
        b["fallback_wins"] = 0
        b["fallback_draws"] = 0
        b["fallback_losses"] = 0
        b["fitness"] = 0.0


def run_pop_matches(population: list[dict], rng: random.Random) -> None:
    """Each brain plays POP_MATCHES_PER_BRAIN matches against random
    others. Pairings are symmetric — both brains in a match record stats."""
    n = len(population)
    total_matches = (POP_MATCHES_PER_BRAIN * n) // 2
    for _ in range(total_matches):
        i = rng.randint(0, n - 1)
        j = rng.randint(0, n - 1)
        while j == i:
            j = rng.randint(0, n - 1)
        a = population[i]
        b = population[j]
        match_seed = rng.randint(0, 2**31 - 1)
        goals_a, goals_b = run_match(a["weights"], b["weights"], match_seed, MATCH_TICKS)
        _record_pop_match(a, goals_a, goals_b)
        _record_pop_match(b, goals_b, goals_a)


def _record_pop_match(brain: dict, my_goals: int, opp_goals: int) -> None:
    diff = my_goals - opp_goals
    brain["pop_matches"] += 1
    brain["pop_goal_diff"] += diff
    if diff >= 3:
        brain["blowout_bonus"] += diff - 2


def run_fallback_matches(population: list[dict], rng: random.Random) -> None:
    """Each brain plays FALLBACK_MATCHES_PER_BRAIN matches against the fallback."""
    for brain in population:
        for _ in range(FALLBACK_MATCHES_PER_BRAIN):
            match_seed = rng.randint(0, 2**31 - 1)
            goals_a, goals_b = run_match(brain["weights"], None, match_seed, MATCH_TICKS)
            brain["fallback_matches"] += 1
            if goals_a > goals_b:
                brain["fallback_wins"] += 1
            elif goals_a == goals_b:
                brain["fallback_draws"] += 1
            else:
                brain["fallback_losses"] += 1


def compute_all_fitness(population: list[dict]) -> None:
    for b in population:
        b["fitness"] = compute_fitness(b, FITNESS_WEIGHTS)


# ── Population init ───────────────────────────────────────────

def init_population_from_seed(
    seed_weights: np.ndarray, rng: random.Random
) -> list[dict]:
    """Brain #0 is the frozen warm-start seed. The rest are mutated copies."""
    population: list[dict] = []
    # Brain #0: frozen, never mutated in breeding
    population.append({
        "weights": seed_weights.copy(),
        "fitness": 0.0,
        "pop_matches": 0,
        "pop_goal_diff": 0.0,
        "blowout_bonus": 0.0,
        "fallback_matches": 0,
        "fallback_wins": 0,
        "fallback_draws": 0,
        "fallback_losses": 0,
        "is_frozen_seed": True,
    })
    # Brains #1..N-1: seed + small Gaussian noise
    for _ in range(POPULATION_SIZE - 1):
        child = gaussian_mutate(
            seed_weights, rate=0.3, std=0.1, rng=rng
        )
        population.append({
            "weights": child,
            "fitness": 0.0,
            "pop_matches": 0,
            "pop_goal_diff": 0.0,
            "blowout_bonus": 0.0,
            "fallback_matches": 0,
            "fallback_wins": 0,
            "fallback_draws": 0,
            "fallback_losses": 0,
            "is_frozen_seed": False,
        })
    return population


def make_seed_brain(seed_weights: np.ndarray) -> dict:
    """Fresh brain record wrapping the frozen warm-start weights."""
    return {
        "weights": seed_weights.copy(),
        "fitness": 0.0,
        "pop_matches": 0,
        "pop_goal_diff": 0.0,
        "blowout_bonus": 0.0,
        "fallback_matches": 0,
        "fallback_wins": 0,
        "fallback_draws": 0,
        "fallback_losses": 0,
        "is_frozen_seed": True,
    }


# ── Main ──────────────────────────────────────────────────────

def main() -> int:
    print("=" * 60)
    print("Football v2 — local training smoke test")
    print("=" * 60)
    print(f"population:         {POPULATION_SIZE}")
    print(f"generations:        {NUM_GENERATIONS}")
    print(f"match ticks:        {MATCH_TICKS}")
    print(f"pop matches/brain:  {POP_MATCHES_PER_BRAIN}")
    print(f"fallback matches:   {FALLBACK_MATCHES_PER_BRAIN}")
    print(f"fitness weights:    w_pop={FITNESS_WEIGHTS.w_pop} "
          f"w_fallback={FITNESS_WEIGHTS.w_fallback} "
          f"max_goal_diff={FITNESS_WEIGHTS.max_goal_diff}")
    print()

    with open(WARM_START_PATH) as f:
        seed_weights = np.array(json.load(f), dtype=np.float64)
    print(f"loaded warm-start seed: {len(seed_weights)} weights")

    rng = random.Random(1)
    population = init_population_from_seed(seed_weights, rng)
    print(f"initialized population: {len(population)} brains (brain #0 is frozen seed)")
    print()

    history: list[dict] = []

    for gen in range(NUM_GENERATIONS):
        gen_start = time.time()

        reset_brain_stats(population)
        run_pop_matches(population, rng)
        run_fallback_matches(population, rng)
        compute_all_fitness(population)

        top = max(b["fitness"] for b in population)
        avg = sum(b["fitness"] for b in population) / len(population)
        fb_wins = sum(b["fallback_wins"] for b in population)
        fb_matches = sum(b["fallback_matches"] for b in population)
        fb_win_rate = fb_wins / max(1, fb_matches)
        goal_diff_avg = sum(b["pop_goal_diff"] for b in population) / len(population)
        seed_brain = next(b for b in population if b.get("is_frozen_seed"))
        seed_fitness = seed_brain["fitness"]

        top_goal_diff = max(b["pop_goal_diff"] for b in population)
        elapsed = time.time() - gen_start
        print(
            f"gen {gen:2d}: "
            f"top={top:+6.2f}  avg={avg:+6.2f}  "
            f"seed={seed_fitness:+6.2f}  "
            f"fb_wr={fb_win_rate:.2f}  "
            f"top_gd={top_goal_diff:+4.0f}  "
            f"[{elapsed:.1f}s]"
        )

        history.append({
            "gen": gen,
            "top": top,
            "avg": avg,
            "seed": seed_fitness,
            "fb_win_rate": fb_win_rate,
        })

        if gen < NUM_GENERATIONS - 1:
            new_pop = breed_next_generation(
                population,
                size=POPULATION_SIZE,
                elitism=ELITISM,
                tournament_k=TOURNAMENT_K,
                mutation_rate=MUTATION_RATE,
                mutation_std=MUTATION_STD,
                random_injection_rate=RANDOM_INJECTION_RATE,
                rng=rng,
            )
            # Always re-pin the warm-start seed at index 0 — it's a fixed
            # anchor inside the population, never bred out.
            new_pop[0] = make_seed_brain(seed_weights)
            population = new_pop

    print()

    # Smoothed first-window vs last-window comparison. Single-generation
    # metrics are noisy; a 3-gen window absorbs the variance.
    first = history[:SMOOTH_WINDOW]
    last = history[-SMOOTH_WINDOW:]

    def window_mean(window: list[dict], key: str) -> float:
        return sum(h[key] for h in window) / len(window)

    start_avg = window_mean(first, "avg")
    end_avg = window_mean(last, "avg")
    start_wr = window_mean(first, "fb_win_rate")
    end_wr = window_mean(last, "fb_win_rate")

    avg_delta = end_avg - start_avg
    wr_delta = end_wr - start_wr

    avg_pass = avg_delta >= MIN_AVG_FITNESS_DELTA
    wr_pass = wr_delta >= MIN_FB_WIN_RATE_DELTA

    print(f"smoothed over {SMOOTH_WINDOW}-gen windows:")
    print(f"  avg_fitness:   {start_avg:+.3f}  →  {end_avg:+.3f}   "
          f"delta={avg_delta:+.3f}  (need >= {MIN_AVG_FITNESS_DELTA})  "
          f"{'PASS' if avg_pass else 'FAIL'}")
    print(f"  fb_win_rate:   {start_wr:.3f}  →  {end_wr:.3f}   "
          f"delta={wr_delta:+.3f}  (need >= {MIN_FB_WIN_RATE_DELTA})  "
          f"{'PASS' if wr_pass else 'FAIL'}")
    print()

    climbed = avg_pass and wr_pass
    print("RESULT:", "PASS — training is learning" if climbed
          else "FAIL — training is not climbing, tune fitness weights")
    return 0 if climbed else 1


if __name__ == "__main__":
    sys.exit(main())
