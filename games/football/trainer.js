/**
 * Web Worker for headless football training.
 *
 * Fetches matchups from the API, runs them at max speed using the engine,
 * and reports results back. Runs continuously while the page is open.
 *
 * Communicates with main thread via postMessage for stats updates.
 */

import { FootballEngine, FieldConfig, WIN_SCORE } from './engine.js';
import { NeuralNet } from './nn.js';

const API_BASE = '/api/football';
const BATCH_SIZE = 125;
let maxHeadlessTicks = Math.ceil(45000 / 16); // default 45s, updated from API
const MIN_FIELD_WIDTH = 600;
const FIELD_WIDTH_RANGE = 300;

function randomFieldWidth() {
  return MIN_FIELD_WIDTH + Math.random() * FIELD_WIDTH_RANGE;
}

function b64ToFloat32(b64) {
  const binary = atob(b64);
  const buffer = new ArrayBuffer(binary.length);
  const view = new Uint8Array(buffer);
  for (let i = 0; i < binary.length; i++) view[i] = binary.charCodeAt(i);
  return new Float32Array(buffer);
}

async function fetchMatchups() {
  // Tell the server which brains we already have cached
  const knownIds = cachedGen !== null ? [...cachedBrains.keys()].join(',') : '';
  const url = `${API_BASE}/matchup?count=${BATCH_SIZE}` + (knownIds ? `&known=${knownIds}` : '');
  const res = await fetch(url);
  if (!res.ok) throw new Error(`matchup fetch failed: ${res.status}`);
  return res.json();
}

async function reportResults(results) {
  await fetch(`${API_BASE}/results`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ results }),
  });
}

// Pre-allocate reusable input arrays to avoid GC pressure
const inputBufA = new Array(18);
const inputBufB = new Array(18);

// Reuse engine per field width to avoid constructor overhead
const engineCache = new Map();
function getEngine(fieldWidth) {
  // Round to nearest 10px to limit cache size
  const key = Math.round(fieldWidth / 10) * 10;
  if (!engineCache.has(key)) {
    engineCache.set(key, new FootballEngine(new FieldConfig(key), true));
  }
  return engineCache.get(key);
}

function runMatch(nnA, nnB) {
  const fieldWidth = randomFieldWidth();
  const engine = getEngine(fieldWidth);
  const state = engine.createState();

  let ticks = 0;
  let outA = null, outB = null;
  while (!state.matchOver && ticks < maxHeadlessTicks) {
    // NN evaluates every 3rd tick — ~20 decisions/sec
    if (ticks % 3 === 0) {
      engine.buildInputsInto(state, 'p1', inputBufA);
      outA = nnA.forward(inputBufA);
      if (nnB) {
        engine.buildInputsInto(state, 'p2', inputBufB);
        outB = nnB.forward(inputBufB);
      }
      // nnB null → outB stays null → idle opponent
    }
    engine.tick(state, outA, outB);
    ticks++;
  }

  return {
    scoreA: state.scoreL,
    scoreB: state.scoreR,
    fitnessA: state.fitness.p1,
    fitnessB: state.fitness.p2,
  };
}

// Stats tracking
let matchesThisSecond = 0;
let simsPerSecond = 0;
let lastStatTime = Date.now();

function updateStats() {
  const now = Date.now();
  const elapsed = now - lastStatTime;
  if (elapsed >= 1000) {
    simsPerSecond = Math.round(matchesThisSecond * 1000 / elapsed);
    matchesThisSecond = 0;
    lastStatTime = now;
    self.postMessage({ type: 'stats', simsPerSecond });
  }
}

// Cache brain weights per generation to avoid re-downloading
let cachedGen = null;
let cachedBrains = new Map(); // id → NeuralNet

async function trainingLoop() {
  while (true) {
    try {
      const data = await fetchMatchups();

      const pairs = data.pairs;
      const genId = data.generation_id;
      if (data.match_duration) {
        maxHeadlessTicks = Math.ceil(data.match_duration * 1000 / 16);
      }

      // Clear cache on generation change
      if (genId !== cachedGen) {
        cachedBrains.clear();
        cachedGen = genId;
      }

      // Run all matches in batch, then report all at once
      const batchResults = [];
      for (const pair of pairs) {
        // Brain A — always a real brain from the population
        if (!cachedBrains.has(pair.brain_a.id) && pair.brain_a.weights) {
          cachedBrains.set(pair.brain_a.id, new NeuralNet(b64ToFloat32(pair.brain_a.weights)));
        }
        const nnA = cachedBrains.get(pair.brain_a.id);

        // Brain B — could be normal, random, or idle
        let nnB = null;
        const bType = pair.brain_b.type;
        if (bType === 'idle') {
          nnB = null; // engine receives null → opponent doesn't act
        } else if (bType === 'random') {
          nnB = new NeuralNet(b64ToFloat32(pair.brain_b.weights));
        } else {
          // Normal brain from population
          if (!cachedBrains.has(pair.brain_b.id) && pair.brain_b.weights) {
            cachedBrains.set(pair.brain_b.id, new NeuralNet(b64ToFloat32(pair.brain_b.weights)));
          }
          nnB = cachedBrains.get(pair.brain_b.id);
        }

        const result = runMatch(nnA, nnB);

        // Only report for real brains (brain_a always real; brain_b only if it has an id)
        batchResults.push({
          brain_a_id: pair.brain_a.id,
          brain_b_id: pair.brain_b.id,
          score_a: result.scoreA,
          score_b: result.scoreB,
          fitness_a: result.fitnessA,
          fitness_b: bType ? null : result.fitnessB, // no fitness for idle/random opponents
          generation_id: genId,
          opponent_type: bType || 'normal',
        });
        matchesThisSecond++;
        updateStats();
      }
      // Single request for all results
      reportResults(batchResults).catch(() => {});
    } catch {
      // Back off on error
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

// Start
trainingLoop();
