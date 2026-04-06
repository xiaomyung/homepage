"""Genetic algorithm for football neural network evolution."""

import struct
import random
import math

# Must match nn.js: Input(18) -> Hidden(20) -> Hidden(16) -> Hidden(12) -> Output(9)
LAYERS = [18, 20, 16, 12, 9]
TOTAL_WEIGHTS = sum(
    LAYERS[i - 1] * LAYERS[i] + LAYERS[i] for i in range(1, len(LAYERS))
)  # 1037

POPULATION_SIZE = 50
TOURNAMENT_SIZE = 5
ELITISM_COUNT = 2
MUTATION_RATE = 0.05
MUTATION_STD = 0.3
MIN_MATCHES_PER_BRAIN = 5


def random_weights() -> bytes:
    """Generate Xavier-initialized random weights as bytes."""
    weights = []
    for i in range(1, len(LAYERS)):
        fan_in = LAYERS[i - 1]
        fan_out = LAYERS[i]
        scale = math.sqrt(2 / (fan_in + fan_out))
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
    """Uniform crossover of two weight arrays."""
    a = weights_to_list(parent_a)
    b = weights_to_list(parent_b)
    child = [a[i] if random.random() < 0.5 else b[i] for i in range(len(a))]
    return list_to_weights(child)


def mutate(weights_blob: bytes) -> bytes:
    """Apply Gaussian mutation to weights."""
    values = weights_to_list(weights_blob)
    for i in range(len(values)):
        if random.random() < MUTATION_RATE:
            values[i] += random.gauss(0, MUTATION_STD)
    return list_to_weights(values)


def breed_next_generation(brains: list[dict]) -> list[bytes]:
    """
    Produce a new generation of weight blobs from the current population.

    brains: list of dicts with 'weights' (bytes) and 'fitness' (float).
    Returns: list of weight blobs for the new generation.
    """
    # Sort by fitness descending
    ranked = sorted(brains, key=lambda b: b["fitness"], reverse=True)

    new_weights = []

    # Elitism: top brains pass through unchanged
    for i in range(min(ELITISM_COUNT, len(ranked))):
        new_weights.append(ranked[i]["weights"])

    # Fill the rest with crossover + mutation
    while len(new_weights) < POPULATION_SIZE:
        parent_a = tournament_select(brains)
        parent_b = tournament_select(brains)
        child = crossover(parent_a["weights"], parent_b["weights"])
        child = mutate(child)
        new_weights.append(child)

    return new_weights


def should_breed(brains: list[dict]) -> bool:
    """Check if all brains have played enough matches."""
    return all(b["matches_played"] >= MIN_MATCHES_PER_BRAIN for b in brains)
