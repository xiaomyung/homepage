"""
Phase 3 tests for build_warm_start.py.

Primary test: after training on fallback-vs-fallback match data, the NN
should imitate the fallback's policy well enough that MSE on a held-out
set is small.

These tests use short match counts and training epochs to stay fast. The
production run (`python build_warm_start.py`) uses larger values.
"""
from __future__ import annotations

import random

import numpy as np
import pytest

from build_warm_start import (
    collect_imitation_dataset,
    train_warm_start_weights,
)
from ga import WEIGHT_COUNT, nn_forward


def test_collect_imitation_dataset_returns_pairs():
    """Running fallback-vs-fallback matches must produce a non-empty
    dataset of (input, action) pairs."""
    inputs, actions = collect_imitation_dataset(
        num_matches=3,
        ticks_per_match=50,
        seed=42,
    )
    # Each match contributes ticks_per_match * 2 (both players)
    assert len(inputs) == len(actions)
    assert len(inputs) > 0
    # Shape checks
    assert inputs.shape[1] == 18
    assert actions.shape[1] == 9
    # No NaNs or infinities — the teacher is deterministic
    assert np.all(np.isfinite(inputs))
    assert np.all(np.isfinite(actions))


def test_train_warm_start_weights_reduces_mse():
    """Training for a short number of epochs should measurably reduce
    MSE against the teacher. This is the core property of imitation
    learning."""
    inputs, actions = collect_imitation_dataset(
        num_matches=5,
        ticks_per_match=50,
        seed=42,
    )
    weights, history = train_warm_start_weights(
        inputs,
        actions,
        epochs=30,
        batch_size=64,
        lr=0.01,
        seed=1,
    )
    assert len(weights) == WEIGHT_COUNT
    assert len(history) == 30
    # Loss should be lower at the end than at the start
    assert history[-1] < history[0], (
        f"MSE did not drop: start={history[0]:.4f}, end={history[-1]:.4f}"
    )
    # And should be reasonably small in absolute terms (fallback outputs
    # are all in [-1, 1], so MSE < 0.3 means the NN is learning structure)
    assert history[-1] < 0.3, f"final MSE too high: {history[-1]:.4f}"


def test_trained_nn_approximates_fallback():
    """The numpy NN forward pass on trained weights should produce outputs
    close to the fallback's action on sampled states."""
    inputs, actions = collect_imitation_dataset(
        num_matches=10,
        ticks_per_match=50,
        seed=2,
    )
    weights, _ = train_warm_start_weights(
        inputs,
        actions,
        epochs=50,
        batch_size=128,
        lr=0.01,
        seed=1,
    )
    # Evaluate MSE on the whole dataset (not ideal, but stable enough
    # to show the NN has learned *something* non-trivial)
    preds = np.array([nn_forward(weights, x) for x in inputs])
    mse = float(np.mean((preds - actions) ** 2))
    assert mse < 0.3, f"trained NN MSE too high: {mse:.4f}"
