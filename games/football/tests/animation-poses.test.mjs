// Unit tests for animation/poses.js — verifies that every layered
// mechanic (walk / kick / airkick / push / celebrate) contributes
// the expected channel changes to the composed pose.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createAnimState, advanceAnimState } from '../animation/state.js';
import { composeStickmanPose, createPoseScratch } from '../animation/poses.js';
import { PLAYER_WIDTH, Z_STRETCH, STICKMAN_LIMB_FULL_H } from '../physics.js';

function makePlayer(overrides = {}) {
  return {
    x: 0, y: 0, heading: 0, vx: 0, vy: 0, airZ: 0, stamina: 1,
    kick: { active: false, kind: 'ground', timer: 0, stage: 'windup' },
    pushTimer: 0, pushArm: 'right', pushType: 'jab',
    pushTargetX: 0, pushTargetY: 0, pushTargetZ: 0,
    ...overrides,
  };
}

function scratches() {
  return {
    kick: { upperAngle: 0, lowerAngle: 0 },
    push: { upperAngle: 0, lowerAngle: 0, upperYaw: 0, lowerYaw: 0 },
  };
}

function runFrame(player, { isCelebrating = false, ticks = 1 } = {}) {
  const anim = createAnimState(0, player);
  const pose = createPoseScratch();
  const s = scratches();
  let snap;
  for (let t = 1; t <= ticks; t++) {
    snap = advanceAnimState(anim, player, t, isCelebrating, {});
    composeStickmanPose(snap, player, pose, s.kick, s.push);
  }
  return { pose, snap, anim };
}

describe('animation/poses', () => {
  describe('createPoseScratch', () => {
    it('allocates a reusable flat pose object', () => {
      const p = createPoseScratch();
      assert.equal(p.baseX, 0);
      assert.equal(p.lArmUpper, 0);
      assert.equal(p.rArmLower, 0);
      assert.equal(p.lLegUpper, 0);
    });
  });

  describe('idle pose', () => {
    it('places hips / neck / head / shoulders relative to player position', () => {
      const p = makePlayer({ x: 100, y: 25, heading: 0 });
      const { pose } = runFrame(p);
      // baseX = player.x + PLAYER_WIDTH/2
      assert.equal(pose.baseX, 100 + PLAYER_WIDTH / 2);
      // baseZ = player.y * Z_STRETCH
      assert.equal(pose.baseZ, 25 * Z_STRETCH);
      // hipBaseY = STICKMAN_LIMB_FULL_H (no bob, no jump, no airLift)
      assert.ok(Math.abs(pose.hipBaseY - STICKMAN_LIMB_FULL_H) < 1e-6);
      // Neck is higher than hip
      assert.ok(pose.neckY > pose.hipBaseY);
      // Head is higher than neck
      assert.ok(pose.headY > pose.neckY);
      // Shoulders are lateral to the neck — for a player facing +x,
      // they separate along +z/-z (lateralZ = forwardX = 1), not x.
      // Regardless of axis, they're symmetric about the neck.
      assert.ok(Math.abs(pose.lShX + pose.rShX - 2 * pose.neckX) < 1e-9);
      assert.ok(Math.abs(pose.lShZ + pose.rShZ - 2 * pose.neckZ) < 1e-9);
      // Distance between shoulders equals 2 * STICKMAN_SHOULDER_OFX.
      const dx = pose.rShX - pose.lShX;
      const dz = pose.rShZ - pose.lShZ;
      assert.ok(Math.hypot(dx, dz) > 5, 'shoulders should be separated along some lateral axis');
    });

    it('all limb angles are ~0 for a stationary idle player', () => {
      const p = makePlayer({ x: 0, y: 25 });
      const { pose } = runFrame(p);
      assert.ok(Math.abs(pose.lArmUpper) < 1e-6);
      assert.ok(Math.abs(pose.rArmUpper) < 1e-6);
      assert.ok(Math.abs(pose.lLegUpper) < 1e-6);
      assert.ok(Math.abs(pose.rLegUpper) < 1e-6);
    });
  });

  describe('walk pose', () => {
    it('arms swing contralaterally with non-zero amplitude while walking', () => {
      const p = makePlayer({ x: 0, y: 25 });
      const anim = createAnimState(0, p);
      const pose = createPoseScratch();
      const s = scratches();
      // Walk for many frames to let LPF + phase reach non-trivial values.
      let snap;
      for (let t = 1; t <= 40; t++) {
        p.x = t * 5;  // speed ≈ 5 u/tick
        snap = advanceAnimState(anim, p, t, false, {});
        composeStickmanPose(snap, p, pose, s.kick, s.push);
      }
      assert.ok(snap.amplitude > 0.5);
      // Arms swing contralaterally: left + right sum to 0 (opposite signs).
      assert.ok(Math.abs(pose.lArmUpper + pose.rArmUpper) < 1e-6);
      // At least one arm has non-zero angle (phase produced motion).
      assert.ok(Math.abs(pose.lArmUpper) > 0.05, `lArmUpper=${pose.lArmUpper} should swing`);
    });

    it('legs swing opposite to arms (contralateral) while walking', () => {
      const p = makePlayer({ x: 0, y: 25 });
      const anim = createAnimState(0, p);
      const pose = createPoseScratch();
      const s = scratches();
      let snap;
      for (let t = 1; t <= 40; t++) {
        p.x = t * 5;
        snap = advanceAnimState(anim, p, t, false, {});
        composeStickmanPose(snap, p, pose, s.kick, s.push);
      }
      // Legs are contralateral too: l + r = 0.
      assert.ok(Math.abs(pose.lLegUpper + pose.rLegUpper) < 1e-6);
      // Left leg upper and left arm upper have OPPOSITE signs
      // (contralateral swing: as right arm forward, left leg forward).
      const sameSideSign = Math.sign(pose.lArmUpper) * Math.sign(pose.lLegUpper);
      assert.ok(sameSideSign <= 0, 'left arm and left leg should swing contralaterally');
    });
  });

  describe('kick pose', () => {
    it('ground kick activates: hipBaseY includes kick body dip', () => {
      const idle = makePlayer();
      const { pose: idlePose } = runFrame(idle);

      // Kick mid-strike
      const kicker = makePlayer();
      kicker.kick.active = true;
      kicker.kick.kind = 'ground';
      kicker.kick.timer = 100;  // well into strike window
      kicker.kick.footTargetX = 30;
      kicker.kick.footTargetY = 4;
      kicker.kick.footTargetZ = 0;
      const { pose: kickPose } = runFrame(kicker);

      // upperHipY for a kicking player is LOWER (kickBodyDip < 0) than idle.
      assert.ok(kickPose.upperHipY < idlePose.upperHipY,
        `kick upperHipY=${kickPose.upperHipY} should dip below idle=${idlePose.upperHipY}`);
    });

    it('airkick lifts the whole figure by player.airZ', () => {
      const idle = makePlayer();
      const { pose: idlePose } = runFrame(idle);

      const leaping = makePlayer();
      leaping.kick.active = true;
      leaping.kick.kind = 'air';
      leaping.kick.timer = 50;
      leaping.kick.footTargetX = 30;
      leaping.kick.footTargetY = 20;
      leaping.kick.footTargetZ = 0;
      leaping.airZ = 15;
      const { pose: airPose } = runFrame(leaping);

      // hipBaseY grows by ~15 (airLift) relative to idle (minus any dip).
      assert.ok(airPose.hipBaseY > idlePose.hipBaseY + 10,
        `airkick hipBaseY=${airPose.hipBaseY} should be ~15 higher than idle=${idlePose.hipBaseY}`);
    });

    it('kick right-leg IK overrides walk swing on the kicking leg', () => {
      const p = makePlayer();
      p.kick.active = true;
      p.kick.kind = 'ground';
      p.kick.timer = 50;
      p.kick.footTargetX = p.x + PLAYER_WIDTH / 2 + 12;
      p.kick.footTargetY = 4;
      p.kick.footTargetZ = p.y * Z_STRETCH;
      const { pose } = runFrame(p);
      // rLegUpper comes from kickLegPose IK — should be non-zero (leg reaches forward).
      assert.ok(Math.abs(pose.rLegUpper) > 0.1, `kick rLegUpper=${pose.rLegUpper} should be solved via IK`);
    });
  });

  describe('push pose', () => {
    it('push hop shifts baseX forward along heading', () => {
      const idle = makePlayer();
      const { pose: idlePose } = runFrame(idle);

      const pusher = makePlayer({ heading: 0, pushTimer: 200 });
      pusher.pushArm = 'right';
      pusher.pushType = 'jab';
      pusher.pushTargetX = 30;
      pusher.pushTargetY = 30;
      pusher.pushTargetZ = 0;
      // Advance far enough that pushProgress hits the STRIKE hop window.
      // With PUSH_TOTAL_TICKS = 63 (1000 ms / 16 ms), STRIKE_T is at
      // 63 * 0.50 = 31 ticks, so run past that.
      const anim = createAnimState(0, pusher);
      const pose = createPoseScratch();
      const s = scratches();
      let snap;
      for (let t = 1; t <= 35; t++) {
        snap = advanceAnimState(anim, pusher, t, false, {});
        composeStickmanPose(snap, pusher, pose, s.kick, s.push);
      }
      // Once the hop fires (pushProgress ~ STRIKE_T), baseX > idlePose.baseX.
      assert.ok(pose.baseX > idlePose.baseX,
        `push baseX=${pose.baseX} should hop forward of idle baseX=${idlePose.baseX}`);
    });

    it('push overrides the striking arm IK (right arm)', () => {
      const p = makePlayer({ pushTimer: 200, pushArm: 'right', pushType: 'jab' });
      p.pushTargetX = 30; p.pushTargetY = 30; p.pushTargetZ = 0;
      const { pose } = runFrame(p, { ticks: 5 });
      // Right arm should have a non-zero yaw from pushArmPose IK.
      const absYaw = Math.abs(pose.rArmUpperYaw) + Math.abs(pose.rArmLowerYaw);
      assert.ok(absYaw > 0 || Math.abs(pose.rArmUpper) > 0.2,
        `push right arm should be driven by IK (yaw=${absYaw}, upper=${pose.rArmUpper})`);
    });

    it('push stance splits the legs — front leg forward, rear leg back', () => {
      // Right-arm push → front leg = left, rear leg = right. Front
      // thigh tilts forward (positive), rear thigh tilts backward
      // (negative).
      const p = makePlayer({ pushTimer: 800, pushArm: 'right', pushType: 'jab' });
      p.pushTargetX = 30; p.pushTargetY = 30; p.pushTargetZ = 0;
      // Run into the middle of windup where stance is fully on and
      // squat is building up (~tick 18 of 63).
      const { pose } = runFrame(p, { ticks: 18 });
      assert.ok(pose.lLegUpper > 0,
        `front (left) thigh should tilt forward, got ${pose.lLegUpper}`);
      assert.ok(pose.rLegUpper < pose.lLegUpper,
        `rear (right) thigh should be behind front: r=${pose.rLegUpper}, l=${pose.lLegUpper}`);
    });

    it('left-arm push mirrors the stance — left = rear, right = front', () => {
      const p = makePlayer({ pushTimer: 800, pushArm: 'left', pushType: 'jab' });
      p.pushTargetX = 30; p.pushTargetY = 30; p.pushTargetZ = 0;
      const { pose } = runFrame(p, { ticks: 18 });
      assert.ok(pose.rLegUpper > 0,
        `front (right) thigh should tilt forward, got ${pose.rLegUpper}`);
      assert.ok(pose.lLegUpper < pose.rLegUpper,
        `rear (left) thigh should be behind front: l=${pose.lLegUpper}, r=${pose.rLegUpper}`);
    });

    it('squat flex peaks at windup end — both shins tip back from base', () => {
      // At t = PUSH_WINDUP_T (0.35 → tick 22 of 63) the squat is
      // fully loaded on top of the stance. The squat adds a flex
      // pattern (upper +flex, lower -flex), so the front-leg shin
      // should be BEHIND its thigh by the full flex amount.
      const p = makePlayer({ pushTimer: 800, pushArm: 'right', pushType: 'jab' });
      p.pushTargetX = 30; p.pushTargetY = 30; p.pushTargetZ = 0;
      const { pose } = runFrame(p, { ticks: 22 });
      // Front leg: thigh = stance + flex, shin = stance - flex → diff = 2*flex.
      const frontDiff = pose.lLegUpper - pose.lLegLower;
      assert.ok(frontDiff > 0.4,
        `front-leg thigh-shin diff should be ~2*flex, got ${frontDiff}`);
    });

    it('legs hold the split stance through strike end, unload by settle', () => {
      // At t = PUSH_STRIKE_T (0.50 → tick 31-32) the squat is 0 but
      // the stance is still full → straight split-stance legs.
      // Front thigh should equal front shin (straight front leg).
      const p = makePlayer({ pushTimer: 800, pushArm: 'right', pushType: 'jab' });
      p.pushTargetX = 30; p.pushTargetY = 30; p.pushTargetZ = 0;
      const { pose } = runFrame(p, { ticks: 32 });
      assert.ok(pose.lLegUpper > 0.1,
        `stance still on: front thigh should be forward, got ${pose.lLegUpper}`);
      assert.ok(Math.abs(pose.lLegUpper - pose.lLegLower) < 0.05,
        `straight front leg at strike end: upper=${pose.lLegUpper} lower=${pose.lLegLower}`);
    });

    it('legs are fully neutral after the settle phase', () => {
      // t > PUSH_SETTLE_T (0.70 → tick 45+) both stance and squat are
      // 0 → legs back to walking-base neutral (~0 for a stationary
      // pusher).
      const p = makePlayer({ pushTimer: 800, pushArm: 'right', pushType: 'jab' });
      p.pushTargetX = 30; p.pushTargetY = 30; p.pushTargetZ = 0;
      const { pose } = runFrame(p, { ticks: 46 });
      assert.ok(Math.abs(pose.lLegUpper) < 0.05,
        `front thigh should be neutral after settle, got ${pose.lLegUpper}`);
      assert.ok(Math.abs(pose.rLegUpper) < 0.05,
        `rear thigh should be neutral after settle, got ${pose.rLegUpper}`);
    });
  });

  describe('celebrate pose', () => {
    it('celebrate sweeps arms toward ±π (jumping-jack extreme)', () => {
      const p = makePlayer();
      const anim = createAnimState(0, p);
      const pose = createPoseScratch();
      const s = scratches();
      let snap;
      // 30 frames at STICKMAN_SMOOTH=0.15 converges celebrate → ~1.
      for (let t = 1; t <= 30; t++) {
        snap = advanceAnimState(anim, p, t, true, {});
        composeStickmanPose(snap, p, pose, s.kick, s.push);
      }
      assert.ok(snap.celebrate > 0.95);
      // Arms reach near ±π (straight up overhead).
      assert.ok(Math.abs(pose.lArmUpper) > 2.5, `lArmUpper=${pose.lArmUpper} should be near π`);
      assert.ok(Math.abs(pose.rArmUpper) > 2.5, `rArmUpper=${pose.rArmUpper} should be near π`);
      // Arms are opposite signs (one +π, one −π).
      assert.ok(pose.lArmUpper * pose.rArmUpper < 0);
    });

    it('celebrate jumpY raises hipBaseY above idle', () => {
      const p = makePlayer();
      const { pose: idlePose } = runFrame(p);

      const anim = createAnimState(0, p);
      const pose = createPoseScratch();
      const s = scratches();
      for (let t = 1; t <= 30; t++) {
        const snap = advanceAnimState(anim, p, t, true, {});
        composeStickmanPose(snap, p, pose, s.kick, s.push);
      }
      // Celebrate jumpY sinusoid peaks when celebratePhase sits around π/2.
      // Over 30 frames (celebratePhase = 7.5 rad ≈ 1.22π), sin(phase) swings
      // so hipBaseY may be above or at idle level — the max over several
      // consecutive frames must exceed idle.
      let maxHip = pose.hipBaseY;
      for (let t = 30; t <= 50; t++) {
        const snap = advanceAnimState(anim, p, t, true, {});
        composeStickmanPose(snap, p, pose, s.kick, s.push);
        if (pose.hipBaseY > maxHip) maxHip = pose.hipBaseY;
      }
      assert.ok(maxHip > idlePose.hipBaseY + 1,
        `celebrate max hipBaseY=${maxHip} should rise above idle=${idlePose.hipBaseY}`);
    });
  });

  describe('no per-frame allocation', () => {
    it('reuses the same pose scratch across frames', () => {
      const p = makePlayer();
      const anim = createAnimState(0, p);
      const pose = createPoseScratch();
      const s = scratches();
      for (let t = 1; t <= 5; t++) {
        const snap = advanceAnimState(anim, p, t, false, {});
        const result = composeStickmanPose(snap, p, pose, s.kick, s.push);
        assert.equal(result, pose, 'composeStickmanPose should return the pose argument');
      }
    });
  });
});
