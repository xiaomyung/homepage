/**
 * Unit tests for the client-side reset-pipeline state machine.
 *
 * The pipeline runs training in the browser: a Web Worker orchestrator
 * trains warm-start weights, reports per-epoch progress via a callback,
 * and returns the trained weights. The client then POSTs the weights
 * to the broker and polls /stats while the broker respawns. These tests
 * pin the pure decision logic (/stats response → next phase) without
 * spinning up a worker or a broker.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PHASE_TRAINING,
  PHASE_RELOADING,
  PHASE_DONE,
  phaseAfterStatsPoll,
} from '../api/reset-client.js';

/* ── /stats poll while reloading ──────────────────────────── */

test('phaseAfterStatsPoll: 200 → DONE (respawned broker ready)', () => {
  assert.equal(phaseAfterStatsPoll({ ok: true, networkError: false }), PHASE_DONE);
});

test('phaseAfterStatsPoll: network error → stay RELOADING (still respawning)', () => {
  assert.equal(phaseAfterStatsPoll({ ok: false, networkError: true }), PHASE_RELOADING);
});

test('phaseAfterStatsPoll: HTTP error → stay RELOADING (broker not ready yet)', () => {
  assert.equal(phaseAfterStatsPoll({ ok: false, networkError: false }), PHASE_RELOADING);
});

/* ── Phase constants are distinct ─────────────────────────── */

test('phase constants are mutually distinct', () => {
  const set = new Set([PHASE_TRAINING, PHASE_RELOADING, PHASE_DONE]);
  assert.equal(set.size, 3);
});
