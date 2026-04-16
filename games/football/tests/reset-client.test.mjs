/**
 * Unit tests for the client-side reset-pipeline state machine.
 *
 * The pipeline runs training in the browser: a Web Worker trains
 * warm-start weights, posts messages with progress, and returns the
 * trained weights. The client then POSTs the weights to the broker
 * and polls /stats while the broker respawns. These tests pin the
 * pure decision logic (worker message classification + HTTP response
 * → next phase) without spinning up a worker or a broker.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PHASE_TRAINING,
  PHASE_RELOADING,
  PHASE_DONE,
  classifyWorkerMessage,
  phaseAfterPost,
  phaseAfterStatsPoll,
} from '../api/reset-client.js';

/* ── Worker message classification ────────────────────────── */

test('classifyWorkerMessage: train progress → "training seed" stage', () => {
  const r = classifyWorkerMessage({ type: 'progress', phase: 'train', current: 42, total: 200 });
  assert.deepEqual(r, { kind: 'progress', stage: 'training seed', current: 42, total: 200 });
});

test('classifyWorkerMessage: collect progress → "collecting data" stage', () => {
  const r = classifyWorkerMessage({ type: 'progress', phase: 'collect', current: 1, total: 1 });
  assert.deepEqual(r, { kind: 'progress', stage: 'collecting data', current: 1, total: 1 });
});

test('classifyWorkerMessage: done message carries weights through', () => {
  const weights = new ArrayBuffer(100);
  const r = classifyWorkerMessage({ type: 'done', weights, finalLoss: 0.05 });
  assert.equal(r.kind, 'done');
  assert.equal(r.weights, weights);
});

test('classifyWorkerMessage: error message carries description', () => {
  const r = classifyWorkerMessage({ type: 'error', message: 'oh no' });
  assert.deepEqual(r, { kind: 'error', message: 'oh no' });
});

test('classifyWorkerMessage: error without message gets a default', () => {
  const r = classifyWorkerMessage({ type: 'error' });
  assert.equal(r.kind, 'error');
  assert.ok(r.message && r.message.length > 0);
});

test('classifyWorkerMessage: unknown type → ignore', () => {
  assert.equal(classifyWorkerMessage({ type: 'bogus' }).kind, 'ignore');
  assert.equal(classifyWorkerMessage({}).kind, 'ignore');
  assert.equal(classifyWorkerMessage(null).kind, 'ignore');
  assert.equal(classifyWorkerMessage('string').kind, 'ignore');
});

test('classifyWorkerMessage: progress with non-numeric counts → defaults', () => {
  const r = classifyWorkerMessage({ type: 'progress', phase: 'train', current: 'x', total: 'y' });
  assert.equal(r.current, 0);
  assert.equal(r.total, 1);
});

/* ── POST /reset response classification ───────────────────── */

test('phaseAfterPost: any outcome → RELOADING (always reload to clear client state)', () => {
  // 200 success: broker will have exited for systemd respawn
  assert.equal(phaseAfterPost({ ok: true, status: 200, networkError: false }), PHASE_RELOADING);
  // 4xx/5xx: still reload to recover a clean client state
  assert.equal(phaseAfterPost({ ok: false, status: 500, networkError: false }), PHASE_RELOADING);
  assert.equal(phaseAfterPost({ ok: false, status: 400, networkError: false }), PHASE_RELOADING);
  // Network error (broker exited mid-response — expected for hard=1)
  assert.equal(phaseAfterPost({ ok: false, status: 0, networkError: true }), PHASE_RELOADING);
});

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
