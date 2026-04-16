/**
 * Unit tests for the client-side reset-pipeline state machine.
 *
 * Ground covered: every transition between POLLING / RELOADING / DONE
 * under every combination of (HTTP status × network error × response
 * body shape) that the UI actually hits in the wild.
 *
 * This is the regression shield for the bug where the pre-PR#33
 * broker's 404 on /reset/status caused the client to reload instantly
 * without showing any progress.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PHASE_POLLING,
  PHASE_RELOADING,
  PHASE_DONE,
  phaseAfterPost,
  phaseAfterStatusPoll,
  phaseAfterStatsPoll,
} from '../api/reset-client.js';

/* ── POST /reset?hard=1 response classification ───────────── */

test('phaseAfterPost: 202 → POLLING (new broker kicked off async)', () => {
  assert.equal(phaseAfterPost({ ok: true, status: 202, networkError: false }), PHASE_POLLING);
});

test('phaseAfterPost: 200 → RELOADING (old broker did sync work and will exit)', () => {
  // Regression: pre-PR#33 broker responded 200 after the sync reset
  // and then called process.exit. Falling through to RELOADING and
  // polling /stats is the correct fallback.
  assert.equal(phaseAfterPost({ ok: true, status: 200, networkError: false }), PHASE_RELOADING);
});

test('phaseAfterPost: 4xx/5xx → RELOADING (give up on progress, still wait for broker)', () => {
  assert.equal(phaseAfterPost({ ok: false, status: 409, networkError: false }), PHASE_RELOADING);
  assert.equal(phaseAfterPost({ ok: false, status: 500, networkError: false }), PHASE_RELOADING);
});

test('phaseAfterPost: network error → RELOADING (broker exited mid-response)', () => {
  assert.equal(phaseAfterPost({ ok: false, status: 0, networkError: true }), PHASE_RELOADING);
});

/* ── /reset/status response classification ────────────────── */

test('phaseAfterStatusPoll: 200 with stage → POLLING + stage update', () => {
  const result = phaseAfterStatusPoll({
    ok: true, status: 200, networkError: false,
    body: { status: { stage: 'training seed', startedAt: 1000 } },
  });
  assert.deepEqual(result, { phase: PHASE_POLLING, stage: 'training seed' });
});

test('phaseAfterStatusPoll: 200 with null status → POLLING (stay, no update)', () => {
  // Happens momentarily before the async pipeline sets the first stage,
  // or between pipeline completion and broker exit.
  const result = phaseAfterStatusPoll({
    ok: true, status: 200, networkError: false, body: { status: null },
  });
  assert.equal(result, PHASE_POLLING);
});

test('phaseAfterStatusPoll: 404 → RELOADING (BUG REGRESSION — old broker fallback)', () => {
  // Pre-PR#33 brokers don't have /reset/status. Previously the client
  // flipped brokerDown on 404, then polled /stats which was still up,
  // then reloaded instantly with no progress shown. Now 404 drops
  // directly to RELOADING which is honest about what's happening.
  const result = phaseAfterStatusPoll({
    ok: false, status: 404, networkError: false, body: null,
  });
  assert.equal(result, PHASE_RELOADING);
});

test('phaseAfterStatusPoll: network error → RELOADING (broker exited for respawn)', () => {
  const result = phaseAfterStatusPoll({
    ok: false, status: 0, networkError: true, body: null,
  });
  assert.equal(result, PHASE_RELOADING);
});

test('phaseAfterStatusPoll: transient 5xx → POLLING (don\'t give up on one flaky response)', () => {
  const result = phaseAfterStatusPoll({
    ok: false, status: 503, networkError: false, body: null,
  });
  assert.equal(result, PHASE_POLLING);
});

test('phaseAfterStatusPoll: malformed body → POLLING (stay, wait for next poll)', () => {
  // Hand-crafted weird responses should not crash the animation.
  for (const body of [null, {}, { status: {} }, { status: 'not-an-object' }]) {
    const result = phaseAfterStatusPoll({
      ok: true, status: 200, networkError: false, body,
    });
    assert.equal(result, PHASE_POLLING, `body=${JSON.stringify(body)}`);
  }
});

/* ── /stats response classification (while RELOADING) ─────── */

test('phaseAfterStatsPoll: 200 → DONE (respawned broker is ready)', () => {
  assert.equal(phaseAfterStatsPoll({ ok: true, networkError: false }), PHASE_DONE);
});

test('phaseAfterStatsPoll: network error → stay RELOADING (still mid-respawn)', () => {
  assert.equal(phaseAfterStatsPoll({ ok: false, networkError: true }), PHASE_RELOADING);
});

test('phaseAfterStatsPoll: HTTP error → stay RELOADING (not ready yet)', () => {
  // E.g. during a brief window where Caddy can connect but the broker
  // hasn't finished binding the socket.
  assert.equal(phaseAfterStatsPoll({ ok: false, networkError: false }), PHASE_RELOADING);
});
