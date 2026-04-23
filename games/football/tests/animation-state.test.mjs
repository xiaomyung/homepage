// Unit tests for animation/state.js — covers every mechanic:
//   * createAnimState default values
//   * LPF smoothing convergence for tilt/amplitude/celebrate
//   * walk-phase accumulation driven by position delta
//   * pushProgress edge detection + accumulation
//   * derived state label (IDLE/WALK/KICK_*/PUSH/CELEBRATE)

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createAnimState, advanceAnimState,
  STICKMAN_SMOOTH, STICKMAN_RUN_THRESHOLD,
} from '../animation/state.js';

function makePlayer(overrides = {}) {
  return {
    x: 0, y: 0, heading: 0, vx: 0, vy: 0, airZ: 0, stamina: 1,
    kick: { active: false, kind: 'ground', timer: 0, stage: 'windup' },
    pushTimer: 0, pushArm: 'right', pushType: 'jab',
    ...overrides,
  };
}

describe('animation/state', () => {
  describe('createAnimState', () => {
    it('returns a fresh anim struct keyed to the player position', () => {
      const p = makePlayer({ x: 100, y: 25 });
      const a = createAnimState(10, p);
      assert.equal(a.tilt, 0);
      assert.equal(a.amplitude, 0);
      assert.equal(a.phase, 0);
      assert.equal(a.celebrate, 0);
      assert.equal(a.celebratePhase, 0);
      assert.equal(a.pushing, 0);
      assert.equal(a.pushProgress, 0);
      assert.equal(a.prevPushTimer, 0);
      assert.equal(a.lastTick, 10);
      assert.equal(a.lastX, 100);
      assert.equal(a.lastY, 25);
    });
  });

  describe('advanceAnimState — idle state', () => {
    it('reports IDLE when player is stationary and nothing active', () => {
      const p = makePlayer();
      const a = createAnimState(0, p);
      const snap = advanceAnimState(a, p, 1, false, {});
      assert.equal(snap.state, 'IDLE');
      assert.equal(snap.speed, 0);
      assert.equal(snap.isKicking, false);
      assert.equal(snap.pushing, 0);
    });

    it('amplitude stays at 0 for idle player', () => {
      const p = makePlayer();
      const a = createAnimState(0, p);
      let snap;
      for (let t = 1; t < 20; t++) snap = advanceAnimState(a, p, t, false, {});
      assert.ok(Math.abs(snap.amplitude) < 1e-6);
    });
  });

  describe('advanceAnimState — walking', () => {
    it('derives speed from position delta (not player.vx)', () => {
      const p = makePlayer({ x: 0 });
      const a = createAnimState(0, p);
      p.x = 3;  // moved 3 units in 1 tick
      const snap = advanceAnimState(a, p, 1, false, {});
      assert.equal(snap.speed, 3);
      assert.equal(snap.state, 'WALK');
    });

    it('amplitude LPF converges toward speed*0.2', () => {
      const p = makePlayer({ x: 0 });
      const a = createAnimState(0, p);
      let snap;
      // Step forward 5 units per tick for 40 frames.
      for (let t = 1; t <= 40; t++) {
        p.x = t * 5;
        snap = advanceAnimState(a, p, t, false, {});
      }
      // target = min(speed*0.2, 1) = min(1.0, 1) = 1.0 (saturated)
      assert.ok(snap.amplitude > 0.95, `amplitude=${snap.amplitude} should be near 1.0`);
    });

    it('phase accumulates based on speed-derived swingRate', () => {
      const p = makePlayer({ x: 0 });
      const a = createAnimState(0, p);
      for (let t = 1; t <= 10; t++) { p.x = t * 5; advanceAnimState(a, p, t, false, {}); }
      assert.ok(a.phase > 0);
      // After 10 frames at speed=5, swingRate = 0.2 + 5*0.04 = 0.4
      // phase ≈ 4.0, then mod 2π ≈ 4.0 - 2π*0 = 4.0 (no wrap yet)
      assert.ok(a.phase > 1);
    });

    it('walk tilt only fires above STICKMAN_RUN_THRESHOLD', () => {
      // Slow move → no tilt target
      const pSlow = makePlayer({ x: 0 });
      const aSlow = createAnimState(0, pSlow);
      let snapSlow;
      for (let t = 1; t <= 20; t++) { pSlow.x = t * 1.0; snapSlow = advanceAnimState(aSlow, pSlow, t, false, {}); }
      assert.ok(Math.abs(snapSlow.walkTilt) < 0.02, `slow tilt=${snapSlow.walkTilt} should be ~0`);

      // Fast forward move → tilt forward
      const pFast = makePlayer({ x: 0 });
      const aFast = createAnimState(0, pFast);
      let snapFast;
      for (let t = 1; t <= 40; t++) { pFast.x = t * 8; snapFast = advanceAnimState(aFast, pFast, t, false, {}); }
      assert.ok(snapFast.walkTilt > 0.1, `fast tilt=${snapFast.walkTilt} should lean forward`);
    });
  });

  describe('advanceAnimState — celebrate', () => {
    it('reports CELEBRATE and smooths celebrate factor toward 1', () => {
      const p = makePlayer();
      const a = createAnimState(0, p);
      let snap;
      for (let t = 1; t <= 30; t++) snap = advanceAnimState(a, p, t, /*isCelebrating*/ true, {});
      assert.equal(snap.state, 'CELEBRATE');
      assert.ok(snap.celebrate > 0.95, `celebrate=${snap.celebrate} should be near 1`);
    });

    it('celebratePhase advances monotonically', () => {
      const p = makePlayer();
      const a = createAnimState(0, p);
      const phases = [];
      for (let t = 1; t <= 10; t++) {
        advanceAnimState(a, p, t, true, {});
        phases.push(a.celebratePhase);
      }
      // Phase grows; stop at 2π wrap.
      for (let i = 1; i < 8; i++) {
        assert.ok(phases[i] > phases[i - 1] || Math.abs(phases[i] - phases[i - 1]) < 0.01);
      }
    });
  });

  describe('advanceAnimState — kick state', () => {
    it('reports KICK_GROUND when kick.active && kind=ground', () => {
      const p = makePlayer();
      p.kick.active = true;
      p.kick.kind = 'ground';
      const a = createAnimState(0, p);
      const snap = advanceAnimState(a, p, 1, false, {});
      assert.equal(snap.state, 'KICK_GROUND');
      assert.equal(snap.isKicking, true);
      assert.equal(snap.isAirkick, false);
    });

    it('reports KICK_AIR when kind=air', () => {
      const p = makePlayer();
      p.kick.active = true;
      p.kick.kind = 'air';
      p.airZ = 10;
      const a = createAnimState(0, p);
      const snap = advanceAnimState(a, p, 1, false, {});
      assert.equal(snap.state, 'KICK_AIR');
      assert.equal(snap.isAirkick, true);
      assert.equal(snap.airLift, 10);
    });
  });

  describe('advanceAnimState — push state', () => {
    it('reports PUSH when pushTimer > 0', () => {
      const p = makePlayer({ pushTimer: 200 });
      const a = createAnimState(0, p);
      const snap = advanceAnimState(a, p, 1, false, {});
      assert.equal(snap.state, 'PUSH');
      assert.equal(snap.pushing, 1);
    });

    it('resets pushProgress on the rising edge of pushTimer', () => {
      const p = makePlayer();
      const a = createAnimState(0, p);
      // pushing for 5 ticks
      p.pushTimer = 200;
      for (let t = 1; t <= 5; t++) advanceAnimState(a, p, t, false, {});
      const afterFirst = a.pushProgress;
      assert.ok(afterFirst > 4, `pushProgress=${afterFirst} should accumulate dt`);
      // drop and restart
      p.pushTimer = 0;
      advanceAnimState(a, p, 6, false, {});
      assert.equal(a.pushProgress, 0);
      p.pushTimer = 200;
      advanceAnimState(a, p, 7, false, {});
      assert.equal(a.pushProgress, 1, 'should reset on rising edge then add dt=1');
    });

    it('state precedence: CELEBRATE beats KICK beats PUSH beats WALK', () => {
      const a = createAnimState(0, makePlayer());
      // Only celebrate
      let snap = advanceAnimState(a, makePlayer(), 1, true, {});
      assert.equal(snap.state, 'CELEBRATE');
      // Kick + celebrate — celebrate wins
      const a2 = createAnimState(0, makePlayer());
      const pKickCeleb = makePlayer();
      pKickCeleb.kick.active = true;
      snap = advanceAnimState(a2, pKickCeleb, 1, true, {});
      assert.equal(snap.state, 'CELEBRATE');
      // Kick + push (no celebrate) — kick wins
      const a3 = createAnimState(0, makePlayer());
      const pKickPush = makePlayer({ pushTimer: 200 });
      pKickPush.kick.active = true;
      snap = advanceAnimState(a3, pKickPush, 1, false, {});
      assert.equal(snap.state, 'KICK_GROUND');
    });
  });

  describe('advanceAnimState — forward unit vector', () => {
    it('emits cos/sin(heading) as forwardX/Z', () => {
      const p = makePlayer({ heading: Math.PI / 2 });  // +90°
      const a = createAnimState(0, p);
      const snap = advanceAnimState(a, p, 1, false, {});
      assert.ok(Math.abs(snap.forwardX - 0) < 1e-9);
      assert.ok(Math.abs(snap.forwardZ - 1) < 1e-9);
    });
  });
});
