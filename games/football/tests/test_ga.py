"""
Phase 3 unit tests for ga.py — the genetic algorithm and NN forward pass.

Covers: fitness computation, tournament selection, two-point crossover,
Gaussian mutation, breeding, and the numpy NN forward pass.

Must pass before local_test.py can be trusted — local_test.py is the
end-to-end training smoke test that depends on all of the above.
"""
from __future__ import annotations

import random

import numpy as np
import pytest

from ga import (
    ARCH,
    WEIGHT_COUNT,
    FitnessWeights,
    breed_next_generation,
    compute_fitness,
    gaussian_mutate,
    he_init_weights,
    nn_forward,
    tournament_select,
    two_point_crossover,
)


# ── Fitness ────────────────────────────────────────────────────

DEFAULT_WEIGHTS = FitnessWeights(w_pop=0.4, w_fallback=0.6, max_goal_diff=3.0)


def test_compute_fitness_zero_everything_has_no_data():
    """A brain with zero matches has no fitness signal — returns 0, not 0.5."""
    brain = {"pop_matches": 0, "fallback_matches": 0}
    assert compute_fitness(brain, DEFAULT_WEIGHTS) == 0.0


def test_compute_fitness_always_in_0_1_range():
    """Whatever the stats, fitness stays in [0, 1]. Randomized realistic data
    (wins + draws + losses = matches)."""
    rng = random.Random(1)
    for _ in range(200):
        fb_matches = rng.randint(1, 10)
        fb_wins = rng.randint(0, fb_matches)
        fb_draws = rng.randint(0, fb_matches - fb_wins)
        pop_matches = rng.randint(1, 20)
        brain = {
            "pop_matches": pop_matches,
            "pop_goal_diff": rng.randint(-pop_matches * 5, pop_matches * 5),
            "fallback_matches": fb_matches,
            "fallback_wins": fb_wins,
            "fallback_draws": fb_draws,
        }
        f = compute_fitness(brain, DEFAULT_WEIGHTS)
        assert 0.0 <= f <= 1.0, f"fitness escaped [0,1]: {f}, brain={brain}"


def test_compute_fitness_monotonic_in_goal_diff():
    low = {"pop_matches": 10, "pop_goal_diff": 1.0, "fallback_matches": 0}
    high = {"pop_matches": 10, "pop_goal_diff": 5.0, "fallback_matches": 0}
    assert compute_fitness(high, DEFAULT_WEIGHTS) > compute_fitness(low, DEFAULT_WEIGHTS)


def test_compute_fitness_fallback_wins_dominate_draws():
    winner = {"pop_matches": 0, "fallback_matches": 1, "fallback_wins": 1, "fallback_draws": 0}
    drawer = {"pop_matches": 0, "fallback_matches": 1, "fallback_wins": 0, "fallback_draws": 1}
    assert compute_fitness(winner, DEFAULT_WEIGHTS) > compute_fitness(drawer, DEFAULT_WEIGHTS)


def test_compute_fitness_fallback_draw_is_signal_above_losses():
    """Draws against fallback beat losses (draws are holding the line)."""
    drawer = {"pop_matches": 0, "fallback_matches": 4, "fallback_wins": 0, "fallback_draws": 4}
    loser = {"pop_matches": 0, "fallback_matches": 4, "fallback_wins": 0, "fallback_draws": 0}
    assert compute_fitness(drawer, DEFAULT_WEIGHTS) > compute_fitness(loser, DEFAULT_WEIGHTS)


def test_compute_fitness_perfect_is_one():
    """All wins against fallback and max goal diff in pop matches → 1.0."""
    brain = {
        "pop_matches": 10,
        "pop_goal_diff": 10 * 3,  # avg 3 per match == max_goal_diff
        "fallback_matches": 5,
        "fallback_wins": 5,
        "fallback_draws": 0,
    }
    f = compute_fitness(brain, DEFAULT_WEIGHTS)
    assert abs(f - 1.0) < 1e-9, f"perfect brain should score 1.0, got {f}"


def test_compute_fitness_worst_is_zero():
    """All losses on both axes → 0.0."""
    brain = {
        "pop_matches": 10,
        "pop_goal_diff": -10 * 3,
        "fallback_matches": 5,
        "fallback_wins": 0,
        "fallback_draws": 0,
    }
    f = compute_fitness(brain, DEFAULT_WEIGHTS)
    assert abs(f - 0.0) < 1e-9, f"worst brain should score 0.0, got {f}"


# ── Tournament selection ──────────────────────────────────────

def test_tournament_select_picks_highest_fitness_in_sample():
    """With k equal to population size, the entire population is sampled
    and the winner is the global max."""
    population = [
        {"weights": np.zeros(WEIGHT_COUNT), "fitness": f}
        for f in [0.1, 0.9, 0.4, 0.7, 0.2]
    ]
    rng = random.Random(42)
    winner = tournament_select(population, k=5, rng=rng)
    assert winner["fitness"] == 0.9


def test_tournament_select_small_k_is_stochastic_but_bounded():
    """With k=2, the winner could be any of the top (n-k+2) brains,
    depending on which 2 get sampled. Run many trials; the expected winner
    set should be reasonable."""
    population = [
        {"weights": np.zeros(WEIGHT_COUNT), "fitness": f}
        for f in [0.1, 0.2, 0.3, 0.9, 1.0]
    ]
    rng = random.Random(42)
    winners = set()
    for _ in range(200):
        w = tournament_select(population, k=2, rng=rng)
        winners.add(w["fitness"])
    # With enough trials, both top-2 brains should be seen
    assert 1.0 in winners, "top brain should win at least sometimes"


# ── Crossover ─────────────────────────────────────────────────

def test_crossover_child_length_matches_parents():
    rng = random.Random(1)
    a = np.ones(WEIGHT_COUNT) * 0.5
    b = np.ones(WEIGHT_COUNT) * -0.5
    child = two_point_crossover(a, b, rng=rng)
    assert len(child) == WEIGHT_COUNT


def test_crossover_uses_both_parents():
    """With parents of +1 and -1, a two-point crossover child must contain
    both positive and negative values (unless the crossover points are at
    0 and WEIGHT_COUNT, which happens with very low probability)."""
    rng = random.Random(42)
    a = np.ones(WEIGHT_COUNT)
    b = -np.ones(WEIGHT_COUNT)
    child = two_point_crossover(a, b, rng=rng)
    has_pos = np.any(child > 0)
    has_neg = np.any(child < 0)
    assert has_pos, "child should contain some +1 from parent a"
    assert has_neg, "child should contain some -1 from parent b"


def test_crossover_deterministic_with_seeded_rng():
    a = np.arange(WEIGHT_COUNT, dtype=np.float64)
    b = np.arange(WEIGHT_COUNT, dtype=np.float64) * -1
    child1 = two_point_crossover(a, b, rng=random.Random(7))
    child2 = two_point_crossover(a, b, rng=random.Random(7))
    np.testing.assert_array_equal(child1, child2)


# ── Mutation ──────────────────────────────────────────────────

def test_mutation_modifies_expected_fraction_on_average():
    """With rate=0.2, about 20% of weights should be modified per call."""
    rng = random.Random(0)
    zeros = np.zeros(WEIGHT_COUNT)
    mutated = gaussian_mutate(zeros, rate=0.2, std=0.5, rng=rng)
    changed = np.count_nonzero(mutated)
    # Loose bounds: 10%-30% of 1193 = 119-358
    assert 100 < changed < 400, f"expected ~20% changes, got {changed}"


def test_mutation_zero_rate_does_nothing():
    rng = random.Random(0)
    weights = np.arange(WEIGHT_COUNT, dtype=np.float64)
    out = gaussian_mutate(weights, rate=0.0, std=1.0, rng=rng)
    np.testing.assert_array_equal(out, weights)


def test_mutation_preserves_weight_count():
    rng = random.Random(0)
    weights = np.zeros(WEIGHT_COUNT)
    out = gaussian_mutate(weights, rate=0.5, std=0.1, rng=rng)
    assert len(out) == WEIGHT_COUNT


# ── Breeding ──────────────────────────────────────────────────

def test_breed_next_generation_preserves_population_size():
    rng = random.Random(1)
    population = [
        {"weights": np.random.default_rng(i).standard_normal(WEIGHT_COUNT), "fitness": i / 10}
        for i in range(10)
    ]
    new_pop = breed_next_generation(
        population,
        size=10,
        elitism=2,
        tournament_k=3,
        mutation_rate=0.1,
        mutation_std=0.1,
        random_injection_rate=0.1,
        rng=rng,
    )
    assert len(new_pop) == 10


def test_breed_preserves_elite_brains():
    """The top `elitism` brains should be carried forward unchanged."""
    rng = random.Random(2)
    population = [
        {"weights": np.full(WEIGHT_COUNT, i * 1.0), "fitness": float(i)}
        for i in range(5)
    ]
    # Top 2 by fitness are indices 4 (fitness=4.0) and 3 (fitness=3.0)
    new_pop = breed_next_generation(
        population,
        size=5,
        elitism=2,
        tournament_k=3,
        mutation_rate=0.0,
        mutation_std=0.0,
        random_injection_rate=0.0,
        rng=rng,
    )
    # The first 2 of new_pop are the elites — their weights must match exactly
    elite_weights = {float(population[i]["weights"][0]) for i in (3, 4)}
    new_elite_weights = {float(new_pop[i]["weights"][0]) for i in (0, 1)}
    assert new_elite_weights == elite_weights


def test_breed_child_weight_count_matches():
    rng = random.Random(3)
    population = [
        {"weights": np.zeros(WEIGHT_COUNT), "fitness": 0.0} for _ in range(6)
    ]
    new_pop = breed_next_generation(
        population,
        size=6,
        elitism=1,
        tournament_k=2,
        mutation_rate=0.1,
        mutation_std=0.1,
        random_injection_rate=0.0,
        rng=rng,
    )
    for brain in new_pop:
        assert len(brain["weights"]) == WEIGHT_COUNT


# ── NN forward pass (numpy) ───────────────────────────────────

def test_nn_forward_output_shape():
    weights = he_init_weights(random.Random(0))
    out = nn_forward(weights, np.zeros(18))
    assert out.shape == (9,)


def test_nn_forward_output_range_is_tanh():
    weights = np.ones(WEIGHT_COUNT) * 0.1
    inputs = np.full(18, 100.0)
    out = nn_forward(weights, inputs)
    assert np.all(out >= -1)
    assert np.all(out <= 1)


def test_nn_forward_deterministic_on_same_weights():
    weights = np.arange(WEIGHT_COUNT, dtype=np.float64) * 0.001
    inputs = np.sin(np.arange(18, dtype=np.float64))
    out1 = nn_forward(weights, inputs)
    out2 = nn_forward(weights, inputs)
    np.testing.assert_array_equal(out1, out2)


def test_nn_forward_rejects_wrong_input_size():
    weights = np.zeros(WEIGHT_COUNT)
    with pytest.raises((ValueError, AssertionError)):
        nn_forward(weights, np.zeros(5))


def test_nn_forward_rejects_wrong_weight_count():
    weights = np.zeros(100)
    with pytest.raises((ValueError, AssertionError)):
        nn_forward(weights, np.zeros(18))


# ── He init ────────────────────────────────────────────────────

def test_he_init_produces_correct_shape():
    rng = random.Random(0)
    weights = he_init_weights(rng)
    assert weights.shape == (WEIGHT_COUNT,)


def test_he_init_is_nontrivial():
    rng = random.Random(0)
    weights = he_init_weights(rng)
    # He init should produce non-zero weights with std ~sqrt(2/fan_in)
    assert np.any(weights != 0)
    # Rough sanity: values should be in a small range
    assert np.abs(weights).max() < 5
