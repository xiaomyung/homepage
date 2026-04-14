"""
Football v2 — offline tool that generates the warm-start NN seed.

Purpose: the v1 GA never learned because it started from random weights
and never climbed out of the flat-landscape region near random. Phase 3's
fix is to pre-train a NN via imitation learning to approximate the
deterministic fallback policy. Generation 0 then starts at approximately
fallback level and the GA's job is to find improvements — a task it can
actually make progress on.

Pipeline:
  1. collect_imitation_dataset(): run fallback-vs-fallback matches through
     physics_py.py, recording (build_inputs(state), fallback_action(state))
     for both players every tick.
  2. train_warm_start_weights(): fit a torch NN (same architecture as nn.js)
     to the dataset via MSE + Adam.
  3. Export the trained weights as a flat JSON array (matching nn.js's
     layer layout) to games/football/warm_start_weights.json.

The JS side loads this file at init; brain #0 is the frozen seed, brains
#1..N-1 are mutated copies.

Run manually from the repo root:
    ./venv/bin/python games/football/evolution/build_warm_start.py
"""
from __future__ import annotations

import json
import os
import random
from typing import Optional

import numpy as np
import torch
import torch.nn as nn

from fallback_py import fallback_action
from ga import ARCH, LAYER_OFFSETS, WEIGHT_COUNT
from physics_py import (
    build_inputs,
    create_field,
    create_seeded_rng,
    create_state,
    tick,
)

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_PATH = os.path.join(HERE, "..", "warm_start_weights.json")


# ── Data collection ────────────────────────────────────────────

def collect_imitation_dataset(
    num_matches: int,
    ticks_per_match: int,
    seed: int,
) -> tuple[np.ndarray, np.ndarray]:
    """Run fallback-vs-fallback matches, record (input, action) pairs.

    For each tick of each match, capture both players' perspectives:
    one pair from p1's view and one from p2's view. This doubles the
    dataset size and teaches the NN to play both sides.

    Returns:
        inputs:  (N, 18) float64 array
        actions: (N, 9) float64 array
    """
    inputs_list: list[list[float]] = []
    actions_list: list[list[float]] = []

    for match in range(num_matches):
        field = create_field()
        state = create_state(field, create_seeded_rng(seed + match))
        state["graceFrames"] = 0  # allow scoring from tick 1

        for _ in range(ticks_per_match):
            # Record BEFORE the tick — so (state, action) reflects what the
            # teacher decided for that state. Then apply both actions and
            # advance the physics.
            p1_action = fallback_action(state, "p1")
            p2_action = fallback_action(state, "p2")
            inputs_list.append(build_inputs(state, "p1"))
            actions_list.append(p1_action)
            inputs_list.append(build_inputs(state, "p2"))
            actions_list.append(p2_action)

            tick(state, p1_action, p2_action)
            if state["matchOver"]:
                break

    inputs = np.array(inputs_list, dtype=np.float64)
    actions = np.array(actions_list, dtype=np.float64)
    return inputs, actions


# ── Torch NN that mirrors nn.js architecture ──────────────────

class ImitationNN(nn.Module):
    """Matches ARCH [18, 20, 16, 18, 9] with LeakyReLU hidden + tanh output.

    Used only for offline training; the runtime forward pass uses the
    numpy version in ga.py (and the JS version in nn.js). After training,
    weights are extracted as a flat array matching the nn.js layout.
    """

    def __init__(self):
        super().__init__()
        self.fc1 = nn.Linear(18, 20)
        self.fc2 = nn.Linear(20, 16)
        self.fc3 = nn.Linear(16, 18)
        self.fc4 = nn.Linear(18, 9)
        self.leaky = nn.LeakyReLU(negative_slope=0.01)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        x = self.leaky(self.fc1(x))
        x = self.leaky(self.fc2(x))
        x = self.leaky(self.fc3(x))
        x = torch.tanh(self.fc4(x))
        return x


def _extract_flat_weights(model: ImitationNN) -> np.ndarray:
    """Convert torch model parameters into the flat layout nn.js expects:
    [W0 (fan_in * fan_out row-major), b0 (fan_out), W1, b1, ...].

    torch Linear stores weight as (out_features, in_features). We transpose
    so the memory layout matches the JS convention (in-major)."""
    weights = np.zeros(WEIGHT_COUNT, dtype=np.float64)
    layers = [model.fc1, model.fc2, model.fc3, model.fc4]
    for layer_idx, layer in enumerate(layers):
        fan_in = ARCH[layer_idx]
        fan_out = ARCH[layer_idx + 1]
        w_off = LAYER_OFFSETS[layer_idx]
        b_off = w_off + fan_in * fan_out
        # torch: weight is (out, in); nn.js expects (in, out) row-major.
        weight_np = layer.weight.detach().cpu().numpy().T.reshape(-1)
        bias_np = layer.bias.detach().cpu().numpy()
        weights[w_off : w_off + fan_in * fan_out] = weight_np
        weights[b_off : b_off + fan_out] = bias_np
    return weights


# ── Training loop ──────────────────────────────────────────────

def train_warm_start_weights(
    inputs: np.ndarray,
    actions: np.ndarray,
    *,
    epochs: int,
    batch_size: int,
    lr: float,
    seed: int,
) -> tuple[np.ndarray, list[float]]:
    """Train a torch model to imitate the teacher dataset.

    Returns:
        weights: flat np.float64 array of shape (WEIGHT_COUNT,), in the
                 layer layout nn.js expects
        history: list of epoch-level MSE values for debugging
    """
    torch.manual_seed(seed)
    np.random.seed(seed)
    random.seed(seed)

    model = ImitationNN()
    optimizer = torch.optim.Adam(model.parameters(), lr=lr)
    loss_fn = nn.MSELoss()

    X = torch.from_numpy(inputs.astype(np.float32))
    Y = torch.from_numpy(actions.astype(np.float32))
    num_samples = X.shape[0]

    history: list[float] = []
    for epoch in range(epochs):
        perm = torch.randperm(num_samples)
        X_shuf = X[perm]
        Y_shuf = Y[perm]
        epoch_loss = 0.0
        num_batches = 0
        for start in range(0, num_samples, batch_size):
            end = start + batch_size
            xb = X_shuf[start:end]
            yb = Y_shuf[start:end]
            optimizer.zero_grad()
            pred = model(xb)
            loss = loss_fn(pred, yb)
            loss.backward()
            optimizer.step()
            epoch_loss += loss.item()
            num_batches += 1
        history.append(epoch_loss / max(1, num_batches))

    weights = _extract_flat_weights(model)
    return weights, history


# ── Script entry point ────────────────────────────────────────

def main() -> None:
    print("Collecting imitation dataset...")
    inputs, actions = collect_imitation_dataset(
        num_matches=50,
        ticks_per_match=1000,
        seed=1,
    )
    print(f"  dataset size: {len(inputs)} samples")

    print("Training imitation NN...")
    weights, history = train_warm_start_weights(
        inputs,
        actions,
        epochs=200,
        batch_size=256,
        lr=0.005,
        seed=1,
    )
    print(f"  loss: {history[0]:.4f} → {history[-1]:.4f}")
    print(f"  weight count: {len(weights)}")

    print(f"Writing {OUT_PATH}")
    with open(OUT_PATH, "w") as f:
        json.dump(weights.tolist(), f)
    print("Done.")


if __name__ == "__main__":
    main()
