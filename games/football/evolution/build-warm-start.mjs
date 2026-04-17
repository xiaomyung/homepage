/**
 * Offline warm-start trainer (Node CLI).
 *
 * Runs the imitation pipeline once from the command line and writes the
 * result to `warm_start_weights.json` next to the rest of the game
 * assets. This file exists for historical / bootstrapping use — in
 * production the broker stores weights in SQLite and the client
 * regenerates them via a Web Worker on reset. Kept here so a fresh
 * clone can seed a weights file without needing a browser open.
 *
 * Run:
 *   node games/football/evolution/build-warm-start.mjs
 */

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { NeuralNet, ARCH } from '../nn.js';
import { createSeededRng } from '../physics.js';
import {
  collectImitationDataset,
  collectDAggerDataset,
  oversampleKickPositives,
  trainWarmStartWeights,
  heInit,
  forwardCached,
  LAYER_COUNT,
  OUTPUT_SIZE,
  WARM_START_HYPERPARAMS,
} from './warm-start-lib.js';

const DAGGER_ROUNDS = 2;
// Target fraction of positive-kick samples in the training set. The
// teacher fires kick=+1 on ~1.5% of ticks; without oversampling MSE
// drives the NN to predict a constant "don't kick" minimum.
const KICK_OVERSAMPLE_FRAC = 0.25;

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = join(HERE, '..', 'warm_start_weights.json');

/* ── Self-check: our forward must match nn.js's forward ──────── */

function selfCheck() {
  const rng = createSeededRng(12345);
  const weights = heInit(rng);
  const input = new Array(ARCH[0]);
  for (let i = 0; i < ARCH[0]; i++) input[i] = rng() * 2 - 1;

  const activations = [new Array(ARCH[0])];
  const preacts = [null];
  for (let i = 1; i < ARCH.length; i++) {
    activations.push(new Array(ARCH[i]));
    preacts.push(new Array(ARCH[i]));
  }
  forwardCached(weights, input, activations, preacts);
  const ours = activations[LAYER_COUNT];

  const theirs = new NeuralNet(Array.from(weights)).forward(input);

  for (let j = 0; j < OUTPUT_SIZE; j++) {
    const diff = Math.abs(ours[j] - theirs[j]);
    if (diff > 1e-12) {
      throw new Error(
        `self-check failed: output ${j} mismatch ours=${ours[j]} theirs=${theirs[j]} diff=${diff}`,
      );
    }
  }
}

/* ── Entry point ──────────────────────────────────────────────── */

async function main() {
  selfCheck();

  const { matches, ticksPerMatch, baseSeed, epochs, batchSize, lr } = WARM_START_HYPERPARAMS;

  // Round 0 — pure behavioural cloning on fallback-vs-fallback.
  console.log('Round 0: BC on fallback-vs-fallback trajectories...');
  const bc = collectImitationDataset(matches, ticksPerMatch, baseSeed);
  let inputs  = bc.inputs;
  let actions = bc.actions;
  console.log(`  raw dataset: ${inputs.length} samples`);
  ({ inputs, actions } = oversampleKickPositives(inputs, actions, { targetFrac: KICK_OVERSAMPLE_FRAC }));
  console.log(`  after kick oversample: ${inputs.length} samples`);

  let trained = await trainWarmStartWeights(inputs, actions, {
    epochs, batchSize, lr, seed: baseSeed,
  });
  let weights = trained.weights;
  console.log(`  round 0 loss: ${trained.history[0].toFixed(4)} → ${trained.history[trained.history.length - 1].toFixed(4)}`);

  // Rounds 1..N — DAgger-lite: aggregate student-visited states with
  // the teacher's correction actions, then retrain. Covers the
  // distribution shift that pure BC can't address.
  for (let r = 1; r <= DAGGER_ROUNDS; r++) {
    console.log(`Round ${r}: DAgger — student-visited states + teacher corrections...`);
    const dagSeed = baseSeed + 10000 * r;
    const extra = collectDAggerDataset(weights, matches, ticksPerMatch, dagSeed);
    const combined = {
      inputs:  inputs.concat(extra.inputs),
      actions: actions.concat(extra.actions),
    };
    console.log(`  raw aggregated: ${combined.inputs.length} samples (+${extra.inputs.length})`);
    ({ inputs, actions } = oversampleKickPositives(combined.inputs, combined.actions, { targetFrac: KICK_OVERSAMPLE_FRAC }));
    console.log(`  after kick oversample: ${inputs.length} samples`);

    trained = await trainWarmStartWeights(inputs, actions, {
      epochs, batchSize, lr, seed: baseSeed + r,
    });
    weights = trained.weights;
    console.log(`  round ${r} loss: ${trained.history[0].toFixed(4)} → ${trained.history[trained.history.length - 1].toFixed(4)}`);
  }

  console.log(`Weight count: ${weights.length}`);
  console.log(`Writing ${OUT_PATH}`);
  writeFileSync(OUT_PATH, JSON.stringify(Array.from(weights)));
  console.log('Done.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
