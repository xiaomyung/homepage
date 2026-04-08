"""Genetic algorithm for football neural network evolution."""

import math
import random
import sqlite3
import struct

# Must match nn.js LAYERS: Input(18) -> Hidden(20) -> Hidden(16) -> Hidden(18) -> Output(9)
# Hidden layers use LeakyReLU (in nn.js); the output layer uses tanh.
LAYERS = [18, 20, 16, 18, 9]
OUTPUT_LAYER_INDEX = len(LAYERS) - 1
TOTAL_WEIGHTS = sum(
    LAYERS[i - 1] * LAYERS[i] + LAYERS[i] for i in range(1, len(LAYERS))
)

# Defaults — can be overridden by config from DB
POPULATION_SIZE = 50
TOURNAMENT_SIZE = 5
ELITISM_COUNT = 5
# Mutation: smaller perturbations applied to twice as many weights per child.
# Previous 0.05 × 0.30 was a random walk relative to Xavier scale; new 0.10 × 0.10 is
# a directional search at appropriate scale.
MUTATION_RATE = 0.10
MUTATION_STD = 0.10
# Per-mutation weight decay — pulls weights toward zero each breeding step.
# AR(1) equilibrium weight std is `MUTATION_STD * sqrt(MUTATION_RATE / (1 - WEIGHT_DECAY**2))`;
# 0.995 places it near He init scale for the current rate/std (≈0.32 vs target 0.33).
# 0.999 was too gentle: equilibrium drifted to ~0.71, pushing the output tanh into saturation.
WEIGHT_DECAY = 0.995
MIN_MATCHES_PER_BRAIN = 5


def get_config(db):
    """Read GA config from DB, falling back to module defaults."""
    cfg = {
        "mutation_rate": MUTATION_RATE,
        "mutation_std": MUTATION_STD,
        "population_size": POPULATION_SIZE,
    }
    try:
        rows = db.execute("SELECT key, value FROM config").fetchall()
        for r in rows:
            cfg[r[0]] = r[1]
    except sqlite3.DatabaseError:
        pass
    return cfg


def random_weights() -> bytes:
    """Generate random weights as bytes. He init for LeakyReLU hidden layers,
    Xavier for the tanh output layer. Must match nn.js NeuralNet.randomWeights()."""
    weights = []
    for i in range(1, len(LAYERS)):
        fan_in = LAYERS[i - 1]
        fan_out = LAYERS[i]
        is_output = i == OUTPUT_LAYER_INDEX
        scale = (
            math.sqrt(2 / (fan_in + fan_out)) if is_output  # Xavier — tanh output
            else math.sqrt(2 / fan_in)                       # He — LeakyReLU hidden
        )
        count = fan_in * fan_out + fan_out
        for _ in range(count):
            weights.append(random.gauss(0, scale))
    return struct.pack(f"{len(weights)}f", *weights)


def weights_to_list(blob: bytes) -> list[float]:
    """Unpack weight bytes to list of floats."""
    return list(struct.unpack(f"{TOTAL_WEIGHTS}f", blob))


def list_to_weights(values: list[float]) -> bytes:
    """Pack list of floats to weight bytes."""
    return struct.pack(f"{len(values)}f", *values)


def tournament_select(brains: list[dict], k: int = TOURNAMENT_SIZE) -> dict:
    """Select the best brain from k random candidates."""
    candidates = random.sample(brains, min(k, len(brains)))
    return max(candidates, key=lambda b: b["fitness"])


def crossover(parent_a: bytes, parent_b: bytes) -> bytes:
    """Two-point crossover — preserves contiguous weight blocks."""
    a = weights_to_list(parent_a)
    b = weights_to_list(parent_b)
    n = len(a)
    p1, p2 = sorted(random.sample(range(n), 2))
    child = a[:p1] + b[p1:p2] + a[p2:]
    return list_to_weights(child)


def mutate(weights_blob: bytes, rate=MUTATION_RATE, std=MUTATION_STD) -> bytes:
    """Apply weight decay then Gaussian mutation to a child's weights.
    Decay runs unconditionally; Gaussian noise is sparse (per `rate`)."""
    values = weights_to_list(weights_blob)
    for i in range(len(values)):
        values[i] *= WEIGHT_DECAY
        if random.random() < rate:
            values[i] += random.gauss(0, std)
    return list_to_weights(values)


def breed_next_generation(brains: list[dict], cfg: dict | None = None) -> list[bytes]:
    """
    Produce a new generation of weight blobs from the current population.

    brains: list of dicts with 'weights' (bytes) and 'fitness' (float).
    cfg: optional config dict with mutation_rate, mutation_std, population_size.
    Returns: list of weight blobs for the new generation.
    """
    cfg = cfg or {}
    pop_size = int(cfg.get("population_size", POPULATION_SIZE))
    mut_rate = cfg.get("mutation_rate", MUTATION_RATE)
    mut_std = cfg.get("mutation_std", MUTATION_STD)

    ranked = sorted(brains, key=lambda b: b["fitness"], reverse=True)

    new_weights = []

    # Elitism: top brains pass through unchanged
    for i in range(min(ELITISM_COUNT, len(ranked))):
        new_weights.append(ranked[i]["weights"])

    # Fill with crossover + mutation, reserving ~6% for random injection
    inject_count = max(1, pop_size // 16)  # ~6% random injection
    breed_target = pop_size - inject_count
    while len(new_weights) < breed_target:
        parent_a = tournament_select(brains)
        parent_b = tournament_select(brains)
        child = crossover(parent_a["weights"], parent_b["weights"])
        child = mutate(child, rate=mut_rate, std=mut_std)
        new_weights.append(child)

    # Random injection: fresh brains to maintain diversity
    for _ in range(inject_count):
        new_weights.append(random_weights())

    return new_weights


def should_breed(brains: list[dict]) -> bool:
    """Check if all brains have played enough matches."""
    return all(b["matches_played"] >= MIN_MATCHES_PER_BRAIN for b in brains)
