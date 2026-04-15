"""
Football v2 — genetic algorithm and numpy NN forward pass.

Responsibilities:
  - Represent brains as {weights: np.ndarray[1233], fitness: float, ...}
  - Hybrid fitness computation (goal diff + fallback anchor tournament)
  - Tournament selection (k=5 default)
  - Two-point crossover over flat weight arrays
  - Gaussian mutation with per-generation decay
  - Breeding: elitism + selection + crossover + mutation + random injection
  - Numpy-based NN forward pass for running brains in local_test.py

Fitness weights are hyperparameters — iterated against local_test.py until
top_fitness climbs measurably over 10 generations (phase 3 hard gate).

The numpy NN matches the JS nn.js architecture bit-for-bit: 20→20→16→18→9,
LeakyReLU hidden, tanh output, 1233 total parameters, flat weight layout
[weights0, biases0, weights1, biases1, ...]. Inputs 18 and 19 are
cos/sin of the player's heading.
"""
from __future__ import annotations

import math
import random
from dataclasses import dataclass
from typing import Optional

import numpy as np


# ── NN architecture (must match games/football/nn.js) ─────────

ARCH = [20, 20, 16, 18, 9]
LEAKY_SLOPE = 0.01


def _layer_offsets(arch: list[int]) -> list[int]:
    """Start offset of each layer in the flat weights array, plus the total."""
    offsets = [0]
    acc = 0
    for i in range(len(arch) - 1):
        fan_in = arch[i]
        fan_out = arch[i + 1]
        acc += fan_in * fan_out + fan_out
        offsets.append(acc)
    return offsets


LAYER_OFFSETS = _layer_offsets(ARCH)
WEIGHT_COUNT = LAYER_OFFSETS[-1]


# ── Fitness ────────────────────────────────────────────────────

@dataclass(frozen=True)
class FitnessWeights:
    """Tunable coefficients for the normalized [0, 1] fitness.

    `w_pop` and `w_fallback` must sum to 1 — the final fitness is guaranteed
    to stay in [0, 1] regardless of how the weights are split. `max_goal_diff`
    is the goal differential that saturates `pop_score` to 1.0 (e.g., 3 goals
    per match average means perfect pop dominance).
    """
    w_pop: float
    w_fallback: float
    max_goal_diff: float


def compute_fitness(brain: dict, w: FitnessWeights) -> float:
    """Normalized hybrid fitness, guaranteed in [0, 1].

    Formula:
        pop_score = clip(avg_goal_diff / max_goal_diff, -1, +1) mapped to [0, 1]
        fb_score  = (wins + 0.5 * draws) / fallback_matches     in [0, 1]
        fitness   = w_pop * pop_score + w_fallback * fb_score   in [0, 1]

    Semantics:
        0.0 = loses everything (or no data at all)
        0.5 = neutral (all draws, or pop_score average with no fallback data)
        1.0 = perfect dominance on both axes

    If a brain has no data on one axis, that axis contributes a neutral 0.5
    to the weighted sum so partial data still yields a meaningful score.
    A brain with no data at all returns 0.0.
    """
    pop_matches = brain.get("pop_matches", 0)
    fb_matches = brain.get("fallback_matches", 0)

    if pop_matches == 0 and fb_matches == 0:
        return 0.0

    if pop_matches > 0:
        avg_diff = brain.get("pop_goal_diff", 0.0) / pop_matches
        normalized = max(-1.0, min(1.0, avg_diff / w.max_goal_diff))
        pop_score = (normalized + 1) / 2
    else:
        pop_score = 0.5

    if fb_matches > 0:
        raw = (
            brain.get("fallback_wins", 0)
            + 0.5 * brain.get("fallback_draws", 0)
        ) / fb_matches
        # Defensive clamp in case wins + draws > matches due to bad data
        fb_score = max(0.0, min(1.0, raw))
    else:
        fb_score = 0.5

    return w.w_pop * pop_score + w.w_fallback * fb_score


# ── Tournament selection ───────────────────────────────────────

def tournament_select(population: list[dict], k: int, rng: random.Random) -> dict:
    """Pick k brains at random, return the one with the highest fitness.

    k=1 is random selection (no pressure), k=population_size is elitist
    (always returns the best). Default k=5 balances diversity and pressure.
    """
    sample = rng.sample(population, min(k, len(population)))
    return max(sample, key=lambda b: b["fitness"])


# ── Crossover ─────────────────────────────────────────────────

def two_point_crossover(
    parent_a: np.ndarray, parent_b: np.ndarray, rng: random.Random
) -> np.ndarray:
    """Two cut points partition the weight array into three segments. Child
    takes [outer, middle, outer] from [a, b, a] respectively.
    """
    n = len(parent_a)
    assert len(parent_b) == n, "parent weight counts must match"
    p1 = rng.randint(0, n - 1)
    p2 = rng.randint(0, n - 1)
    if p1 > p2:
        p1, p2 = p2, p1
    child = parent_a.copy()
    if p2 > p1:
        child[p1:p2] = parent_b[p1:p2]
    return child


# ── Mutation ──────────────────────────────────────────────────

def gaussian_mutate(
    weights: np.ndarray, rate: float, std: float, rng: random.Random
) -> np.ndarray:
    """Apply Gaussian noise to each weight with independent probability `rate`.
    Uses the provided random.Random for reproducibility (not numpy's global).
    """
    if rate <= 0.0:
        return weights.copy()
    out = weights.copy()
    # Use the random.Random so test seeding is deterministic. For speed,
    # generate masks/noises in numpy with a derived seed from rng.
    seed = rng.randrange(2**31)
    np_rng = np.random.default_rng(seed)
    mask = np_rng.random(len(weights)) < rate
    noise = np_rng.standard_normal(len(weights)) * std
    out[mask] += noise[mask]
    return out


# ── Weight init ────────────────────────────────────────────────

def he_init_weights(rng: random.Random) -> np.ndarray:
    """He initialization: N(0, sqrt(2/fan_in)) per weight matrix, biases 0.
    Uses the provided rng for determinism."""
    seed = rng.randrange(2**31)
    np_rng = np.random.default_rng(seed)
    weights = np.zeros(WEIGHT_COUNT, dtype=np.float64)
    idx = 0
    for i in range(len(ARCH) - 1):
        fan_in = ARCH[i]
        fan_out = ARCH[i + 1]
        stddev = math.sqrt(2 / fan_in)
        weights[idx : idx + fan_in * fan_out] = np_rng.standard_normal(fan_in * fan_out) * stddev
        idx += fan_in * fan_out
        idx += fan_out  # biases stay 0
    return weights


# ── Breeding ──────────────────────────────────────────────────

def breed_next_generation(
    population: list[dict],
    *,
    size: int,
    elitism: int,
    tournament_k: int,
    mutation_rate: float,
    mutation_std: float,
    random_injection_rate: float,
    rng: random.Random,
) -> list[dict]:
    """Produce the next generation from the current population.

    Steps:
      1. Sort by fitness descending; copy top `elitism` brains unchanged.
      2. Inject some fraction of fresh random brains (exploration).
      3. Fill the remainder by: select 2 parents via tournament_k, crossover,
         mutate, push into new population.

    New brains have reset fitness/match counters — only weights are copied.
    """
    sorted_pop = sorted(population, key=lambda b: b["fitness"], reverse=True)
    new_pop: list[dict] = []

    # 1. Elite pass-through
    for b in sorted_pop[:elitism]:
        new_pop.append(_fresh_brain(b["weights"].copy()))

    # 2. Random injection
    num_random = int(round(size * random_injection_rate))
    for _ in range(num_random):
        if len(new_pop) >= size:
            break
        new_pop.append(_fresh_brain(he_init_weights(rng)))

    # 3. Crossover + mutation fills the rest
    while len(new_pop) < size:
        parent_a = tournament_select(population, tournament_k, rng)
        parent_b = tournament_select(population, tournament_k, rng)
        child_weights = two_point_crossover(parent_a["weights"], parent_b["weights"], rng)
        child_weights = gaussian_mutate(child_weights, mutation_rate, mutation_std, rng)
        new_pop.append(_fresh_brain(child_weights))

    return new_pop[:size]


def _fresh_brain(weights: np.ndarray) -> dict:
    """Create a brain record with cleared fitness/match stats."""
    return {
        "weights": weights,
        "fitness": 0.0,
        "pop_matches": 0,
        "pop_goal_diff": 0.0,
        "blowout_bonus": 0.0,
        "fallback_matches": 0,
        "fallback_wins": 0,
        "fallback_draws": 0,
        "fallback_losses": 0,
    }


# ── Numpy NN forward pass ─────────────────────────────────────

def nn_forward(weights: np.ndarray, inputs: np.ndarray) -> np.ndarray:
    """Run the 20→20→16→18→9 network on one input vector.

    Layout matches nn.js: for each layer, [weights (fan_in * fan_out),
    biases (fan_out)] concatenated. LeakyReLU on hidden layers, tanh on output.
    """
    if len(weights) != WEIGHT_COUNT:
        raise ValueError(f"weight count mismatch: expected {WEIGHT_COUNT}, got {len(weights)}")
    if len(inputs) != ARCH[0]:
        raise ValueError(f"input size mismatch: expected {ARCH[0]}, got {len(inputs)}")

    current = np.asarray(inputs, dtype=np.float64)
    for layer in range(len(ARCH) - 1):
        fan_in = ARCH[layer]
        fan_out = ARCH[layer + 1]
        w_off = LAYER_OFFSETS[layer]
        b_off = w_off + fan_in * fan_out
        W = weights[w_off : b_off].reshape(fan_in, fan_out)
        b = weights[b_off : b_off + fan_out]
        z = current @ W + b
        is_output_layer = (layer == len(ARCH) - 2)
        if is_output_layer:
            current = np.tanh(z)
        else:
            current = np.where(z >= 0, z, z * LEAKY_SLOPE)
    return current
