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
  trainWarmStartWeights,
  heInit,
  forwardCached,
  LAYER_COUNT,
  OUTPUT_SIZE,
  WARM_START_HYPERPARAMS,
} from './warm-start-lib.js';

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
  console.log('Collecting imitation dataset...');
  const { inputs, actions } = collectImitationDataset(matches, ticksPerMatch, baseSeed);
  console.log(`  dataset size: ${inputs.length} samples`);

  console.log('Training imitation NN...');
  const { weights, history } = await trainWarmStartWeights(inputs, actions, {
    epochs,
    batchSize,
    lr,
    seed: baseSeed,
  });
  console.log(`  loss: ${history[0].toFixed(4)} → ${history[history.length - 1].toFixed(4)}`);
  console.log(`  weight count: ${weights.length}`);

  console.log(`Writing ${OUT_PATH}`);
  writeFileSync(OUT_PATH, JSON.stringify(Array.from(weights)));
  console.log('Done.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
