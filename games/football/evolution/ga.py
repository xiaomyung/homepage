"""Genetic algorithm for football neural network evolution."""

import struct
import random
import math

# Must match nn.js: Input(18) -> Hidden(20) -> Hidden(16) -> Hidden(12) -> Output(9)
LAYERS = [18, 20, 16, 12, 9]
TOTAL_WEIGHTS = sum(
    LAYERS[i - 1] * LAYERS[i] + LAYERS[i] for i in range(1, len(LAYERS))
)  # 1037

# Defaults — can be overridden by config from DB
POPULATION_SIZE = 50
TOURNAMENT_SIZE = 3
ELITISM_COUNT = 2
MUTATION_RATE = 0.05
MUTATION_STD = 0.3
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
    except Exception:
        pass
    return cfg


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


def mutate(weights_blob: bytes, rate=MUTATION_RATE, std=MUTATION_STD) -> bytes:
    """Apply Gaussian mutation to weights."""
    values = weights_to_list(weights_blob)
    for i in range(len(values)):
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
    pop_size = int(cfg.get("population_size", POPULATION_SIZE)) if cfg else POPULATION_SIZE
    mut_rate = cfg.get("mutation_rate", MUTATION_RATE) if cfg else MUTATION_RATE
    mut_std = cfg.get("mutation_std", MUTATION_STD) if cfg else MUTATION_STD

    ranked = sorted(brains, key=lambda b: b["fitness"], reverse=True)

    new_weights = []

    # Elitism: top brains pass through unchanged
    for i in range(min(ELITISM_COUNT, len(ranked))):
        new_weights.append(ranked[i]["weights"])

    # Fill with crossover + mutation, reserving ~2% for random injection
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
