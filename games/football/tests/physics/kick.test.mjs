import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  tick,
  FIELD_HEIGHT,
  PLAYER_HEIGHT,
  PLAYER_WIDTH,
  BALL_RADIUS,
  Z_STRETCH,
  TICK_MS,
  GRAVITY,
  KICK_WINDUP_MS,
  KICK_DURATION_MS,
  STICKMAN_UPPER_LEG,
  STICKMAN_LOWER_LEG,
  solve2BoneIK,
  KICK_STRIKE_WINDOW_MS,
  kickLegExtension,
  kickLegPose,
  canKickReach,
  AIRKICK_MS,
  AIRKICK_PEAK_FRAC,
} from '../../physics/index.js';
import {
  freshState,
  NOOP,
  kickAction,
  trapState,
  footError,
  reconstructFoot,
  kickBenchState,
} from '../helpers/state.mjs';

test('kick activates when ball is within hip reach', () => {
  const state = freshState();
  // Ball parked directly in front of p1 on his depth-line. The hip
  // anchor sits at HIP_BASE_Z (20) above the pitch; the ball at
  // ground level is ~16 world-y below, leaving ~12 world-xz of
  // horizontal reach — 5 units forward is well inside that.
  state.p1.x = 300;
  state.p1.y = 20;
  state.ball.x = state.p1.x + state.field.playerWidth / 2 + 5;
  state.ball.y = state.p1.y;
  state.ball.z = 0;
  state.ball.vx = 0; state.ball.vy = 0; state.ball.vz = 0;
  state.ball.frozen = false;

  tick(state, kickAction(1, 0, 0, 1), NOOP);

  assert.ok(state.p1.kick.active, 'kick should activate when ball is in reach');
});

test('kick does not activate when ball is laterally far in depth', () => {
  const state = freshState();
  // Same forward distance, but offset the ball by a full player depth
  // plus ball radius on the y axis — legs cannot reach laterally at
  // all, so even a small offset past body+ball should be rejected.
  state.p1.x = 300;
  state.p1.y = 20;
  state.ball.x = state.p1.x + state.field.playerWidth / 2 + 5;
  state.ball.y = state.p1.y + PLAYER_HEIGHT / 2 + PLAYER_HEIGHT + BALL_RADIUS + 4;
  state.ball.z = 0;
  state.ball.vx = 0; state.ball.vy = 0; state.ball.vz = 0;
  state.ball.frozen = false;

  tick(state, kickAction(1, 0, 0, 1), NOOP);

  assert.equal(
    state.p1.kick.active, false,
    'kick must not activate when ball is beyond stretched-leg reach on depth axis',
  );
});

test('kick blocked when player faces away from the ball', () => {
  const state = freshState();
  state.p1.x = 300;
  state.p1.y = 20;
  state.p1.heading = Math.PI;  // facing -x
  state.ball.x = state.p1.x + state.field.playerWidth / 2 + 5; // ball in +x
  state.ball.y = state.p1.y + PLAYER_HEIGHT / 2;
  state.ball.z = 0;
  state.ball.vx = 0; state.ball.vy = 0; state.ball.vz = 0;
  state.ball.frozen = false;

  tick(state, kickAction(1, 0, 0, 1), NOOP);

  assert.equal(
    state.p1.kick.active, false,
    'kick must not activate when heading is opposite the ball direction',
  );
});

test('kick state machine fires impact at windup end and clears at duration end', () => {
  const state = freshState();
  state.p1.x = 300;
  state.p1.y = 20;
  state.ball.x = state.p1.x + state.field.playerWidth / 2 + 5;
  state.ball.y = state.p1.y;
  state.ball.z = 0;
  state.ball.vx = 0; state.ball.vy = 0; state.ball.vz = 0;
  state.ball.frozen = false;

  // Start the kick on tick 1.
  tick(state, kickAction(1, 0, 0, 1), NOOP);
  assert.ok(state.p1.kick.active, 'kick should be active after start');
  assert.equal(state.p1.kick.fired, false, 'kick should not have fired on tick 1');

  // Drive the state machine up to just after the windup — impact
  // should fire (ball.vx becomes non-zero).
  const windupTicks = Math.ceil(KICK_WINDUP_MS / TICK_MS);
  for (let i = 0; i < windupTicks + 1; i++) tick(state, NOOP, NOOP);
  assert.ok(
    state.p1.kick.fired,
    `kick should have fired by tick ${windupTicks + 2}, timer=${state.p1.kick.timer}`,
  );
  assert.ok(
    state.ball.vx > 0,
    `ball should have gained forward velocity after fire, got vx=${state.ball.vx}`,
  );

  // Drive to the end of KICK_DURATION_MS — active must go false.
  const totalTicks = Math.ceil(KICK_DURATION_MS / TICK_MS);
  for (let i = 0; i < totalTicks; i++) tick(state, NOOP, NOOP);
  assert.equal(state.p1.kick.active, false, 'kick should deactivate after KICK_DURATION_MS');
});

test('stall reset fires after 10 wall-clock seconds of no kicks (headless + visual)', () => {
  // The stall timeout was unified at 10 s for both modes so showcase
  // replays (which run with state.headless=true for scoreGoal
  // determinism) reset on the same schedule as the worker that
  // produced the recording. Before the visual never saw a reset
  // before tick 625, the worker at tick 187 — the mismatch showed up
  // as jarring mid-replay teleports every 3 s.
  const stallTicks = Math.ceil(10000 / TICK_MS);

  for (const headless of [true, false]) {
    const state = freshState();
    state.headless = headless;
    const f = state.field;
    state.ball.x = f.midX + 200;
    state.ball.y = 10;
    state.p2.x = 700;

    // Just before the timeout: no reset yet.
    for (let i = 0; i <= stallTicks - 2; i++) tick(state, NOOP, NOOP);
    assert.ok(
      Math.abs(state.ball.x - (f.midX + 200)) < 5,
      `${headless ? 'headless' : 'visual'}: stall fired too early; ball.x=${state.ball.x}`,
    );

    // Crossing the threshold: reset fires.
    for (let i = 0; i < 3; i++) tick(state, NOOP, NOOP);
    assert.ok(
      Math.abs(state.ball.x - f.midX) < 1,
      `${headless ? 'headless' : 'visual'}: ball should reset to midX, got ${state.ball.x}`,
    );
    assert.equal(state.ball.vx, 0);

    // Headless also teleports players back; visual leaves them put.
    if (headless) {
      assert.ok(Math.abs(state.p1.y - FIELD_HEIGHT / 2) < 1);
      assert.ok(Math.abs(state.p2.y - FIELD_HEIGHT / 2) < 1);
    }
  }
});

test('active kick skips body trap — foot contact handles impulse', () => {
  const state = trapState();
  const p = state.p1;
  // Ball aimed directly at torso, same as the first trap test.
  state.ball.x = p.x + PLAYER_WIDTH / 2 - 30;
  state.ball.y = p.y;
  state.ball.z = 12;
  state.ball.vx = 15; state.ball.vy = 0; state.ball.vz = 0;
  state.ball.frozen = false;
  // Force an active kick on the player — body collider should be inert.
  p.kick.active = true;
  p.kick.kind = 'ground';
  p.kick.stage = 'windup';
  p.kick.timer = 0;

  // Run just long enough for the ball to reach the torso region.
  for (let i = 0; i < 10; i++) tick(state, NOOP, NOOP);

  // Ball should have carried through the torso zone without being trapped —
  // horizontal speed stays mostly intact (subject to air friction), and it's
  // past the player's x position.
  assert.ok(state.ball.x > p.x + PLAYER_WIDTH,
    `ball should have passed through torso zone, x=${state.ball.x}`);
  assert.ok(state.ball.vx > 10,
    `active kick should leave ball vx mostly intact, got ${state.ball.vx}`);
});

test('solve2BoneIK reachable target → foot lands on target', () => {
  const U = 10, L = 10;
  // Typical kick pose: ball 10 forward, 16 below hip.
  const res = solve2BoneIK(10, -16, U, L, { upperAngle: 0, lowerAngle: 0, footFwd: 0, footUp: 0 });
  assert.ok(footError(res, 10, -16) < 1e-9, `foot missed: ${footError(res, 10, -16)}`);
  const recon = reconstructFoot(res, U, L);
  assert.ok(Math.hypot(recon.fwd - 10, recon.up - (-16)) < 1e-9, 'angles inconsistent with foot position');
});

test('solve2BoneIK knee bends forward of hip→foot line', () => {
  const U = 10, L = 10;
  // Target forward and below — knee should be MORE forward than
  // the midpoint of the hip→foot line (knee-forward branch).
  const res = solve2BoneIK(8, -14, U, L, {});
  const kneeFwd = U * Math.sin(res.upperAngle);
  const midFwd = res.footFwd / 2;  // hip at 0, foot at footFwd
  assert.ok(kneeFwd > midFwd, `knee should be forward of midpoint: knee=${kneeFwd} mid=${midFwd}`);
});

test('solve2BoneIK target at max reach → straight leg pointed at target', () => {
  const U = 10, L = 10;
  // D = U+L = 20 exactly.
  const res = solve2BoneIK(20, 0, U, L, {});
  assert.ok(Math.abs(res.upperAngle - res.lowerAngle) < 1e-9, 'straight leg: upper == lower angle');
  assert.ok(footError(res, 20, 0) < 1e-9, 'foot on target at max reach');
});

test('solve2BoneIK target beyond max reach → clamped to straight leg toward target', () => {
  const U = 10, L = 10;
  // D = 30 > 20. Clamp to direction at reach 20.
  const res = solve2BoneIK(30, 0, U, L, {});
  assert.ok(Math.abs(res.upperAngle - res.lowerAngle) < 1e-9, 'clamped: straight leg');
  // Foot should lie on the hip→target ray, at distance U+L from hip.
  const footD = Math.hypot(res.footFwd, res.footUp);
  assert.ok(Math.abs(footD - (U + L)) < 1e-9, `foot at max reach (got ${footD})`);
  // Direction preserved.
  assert.ok(res.footFwd > 0 && Math.abs(res.footUp) < 1e-9, 'along +fwd axis');
});

test('solve2BoneIK numerical stability at edge cases', () => {
  const U = 10, L = 10;
  // Fully extended (D exactly at U+L) should not NaN.
  const r1 = solve2BoneIK(U + L, 0, U, L, {});
  assert.ok(!Number.isNaN(r1.upperAngle), 'NaN at full extension');
  // Target at hip (D=0) when U=L=0 is degenerate — our guard picks a default.
  const r2 = solve2BoneIK(0, 0, U, L, {});
  assert.ok(!Number.isNaN(r2.upperAngle), 'NaN at zero-distance target');
  // Target directly below hip, distance = |U-L| = 0 (U=L case) → straight down, no bend.
  const r3 = solve2BoneIK(0, -0.5, U, L, {});
  assert.ok(!Number.isNaN(r3.upperAngle) && !Number.isNaN(r3.lowerAngle), 'NaN on near-zero vertical target');
});

test('solve2BoneIK unequal bone lengths reach correct foot position', () => {
  const U = 12, L = 8;
  const res = solve2BoneIK(9, -11, U, L, {});
  assert.ok(footError(res, 9, -11) < 1e-9, 'foot on target with U != L');
  const recon = reconstructFoot(res, U, L);
  assert.ok(Math.hypot(recon.fwd - 9, recon.up - (-11)) < 1e-9, 'reconstruction matches');
});

test('solve2BoneIK scratch-out parameter is mutated and returned', () => {
  const U = 10, L = 10;
  const out = { upperAngle: -99, lowerAngle: -99, footFwd: -99, footUp: -99 };
  const returned = solve2BoneIK(6, -12, U, L, out);
  assert.equal(returned, out, 'returns same object');
  assert.ok(out.upperAngle !== -99, 'out was mutated');
});

test('kick prediction matches physics integration over 6 + 9 ticks', () => {
  // Mirrors `predictBallAtStrike`'s use in the reachability gate.
  // If the prediction formula drifts from the integrator, the gate
  // accepts or rejects kicks the visible simulation can't finish.
  for (const leadTicks of [6, 9]) {
    // Freeze p1 in place so the body collider doesn't deflect the
    // ball mid-prediction (clean ballistic parity check).
    const state = freshState();
    state.p1.x = -1000;  // park player far away so no interaction
    state.p2.x = -1001;
    state.ball.x = 0;
    state.ball.y = FIELD_HEIGHT / 2;
    state.ball.z = 50;
    state.ball.vx = 3;
    state.ball.vy = 0;
    state.ball.vz = 2;
    state.ball.frozen = false;

    // Advance N ticks with no input — pure ballistic + friction.
    for (let i = 0; i < leadTicks; i++) tick(state, NOOP, NOOP);

    // Actual vs predicted vertical position (before friction affects it).
    // Friction only damps x/y, so the prediction error on z is from the
    // integrator discretization alone.
    const actualZ = state.ball.z;
    const predictedZ = Math.max(
      0,
      50 + 2 * leadTicks - 0.5 * GRAVITY * leadTicks * (leadTicks + 1),
    );
    assert.ok(
      Math.abs(actualZ - predictedZ) < 0.01,
      `lead ${leadTicks}: predicted z ${predictedZ}, actual ${actualZ}`,
    );
  }
});

test('canKickReach matches tryStartKick commit exactly (no ghost outputs)', () => {
  // Scan a grid of ball positions around a stationary player. For
  // each position, canKickReach(margin=0) must match whether
  // applyAction/tryStartKick actually commits a kick. If the two
  // ever disagree the teacher emits kick actions the physics
  // silently rejects (or vice versa) — kills imitation signal.
  const disagreements = [];
  for (let dx = -25; dx <= 25; dx += 5) {
    for (let dy = -6; dy <= 6; dy += 2) {
      for (let bz = 0; bz <= 12; bz += 4) {
        const state = freshState();
        state.p1.x = 400;
        state.p1.y = 25;
        state.p1.heading = 0;
        state.ball.x = state.p1.x + PLAYER_WIDTH / 2 + dx;
        state.ball.y = state.p1.y + dy;
        state.ball.z = bz;
        state.ball.vx = 0; state.ball.vy = 0; state.ball.vz = 0;
        state.ball.frozen = false;
        const predicted = canKickReach(state, state.p1);
        tick(state, kickAction(1, 0, 0, 1), NOOP);
        const actual = state.p1.kick.active;
        if (predicted !== actual) {
          disagreements.push({ dx, dy, bz, predicted, actual });
        }
      }
    }
  }
  assert.equal(disagreements.length, 0,
    `canKickReach must match tryStartKick, disagreements: ${JSON.stringify(disagreements)}`);
});

test('canKickReach safetyMargin shrinks the reach sphere', () => {
  // Hip world vertical is HIP_BASE_Z=20; ball at ground has
  // up = −15.776 world units. Max forward reach at ground level is
  // sqrt(20² − 15.776²) ≈ 12.3 for margin=0. With margin=2 (reach
  // capped at 18) the forward budget shrinks to sqrt(18² − 15.776²)
  // ≈ 8.7. A ball 10 forward sits between the two thresholds.
  const state = freshState();
  state.p1.x = 400;
  state.p1.y = 25;
  state.p1.heading = 0;
  state.ball.y = state.p1.y;
  state.ball.z = 0;
  state.ball.frozen = false;
  state.ball.vx = 0; state.ball.vy = 0; state.ball.vz = 0;

  // fwd = 10 — inside margin=0, outside margin=2
  state.ball.x = state.p1.x + PLAYER_WIDTH / 2 + 10;
  assert.equal(canKickReach(state, state.p1, 0), true, 'margin=0 accepts at fwd=10');
  assert.equal(canKickReach(state, state.p1, 2), false, 'margin=2 rejects at fwd=10');

  // fwd = 6 — well inside both margins.
  state.ball.x = state.p1.x + PLAYER_WIDTH / 2 + 6;
  assert.equal(canKickReach(state, state.p1, 0), true, 'margin=0 accepts at fwd=6');
  assert.equal(canKickReach(state, state.p1, 2), true, 'margin=2 accepts at fwd=6');

  // fwd = 14 — beyond both margins.
  state.ball.x = state.p1.x + PLAYER_WIDTH / 2 + 14;
  assert.equal(canKickReach(state, state.p1, 0), false, 'margin=0 rejects at fwd=14');
});

test('kick rejects when ball is beyond hip reach', () => {
  const state = kickBenchState();
  // Shove the ball 30 units forward — well beyond STICKMAN_UPPER_LEG +
  // STICKMAN_LOWER_LEG = 20, even accounting for the drop to ball height.
  state.ball.x = state.p1.x + PLAYER_WIDTH / 2 + 30;
  tick(state, kickAction(1, 0, 0, 1), NOOP);
  assert.equal(state.p1.kick.active, false, 'kick must not activate beyond reach');
  assert.ok(
    state.events.some((e) => e.type === 'kick_missed' && e.reason === 'out_of_reach'),
    'should emit kick_missed with reason=out_of_reach',
  );
});

test('kick footTarget tracks ball during windup and freezes at strike', () => {
  const state = kickBenchState();
  // Give the ball a small forward drift so its prediction moves each
  // windup tick. Slow enough to stay in reach for the whole windup.
  state.ball.vx = 0.4;

  tick(state, kickAction(1, 0, 0, 1), NOOP);
  assert.ok(state.p1.kick.active, 'kick committed');
  assert.equal(state.p1.kick.stage, 'windup');
  const targetAtStart = state.p1.kick.footTargetX;

  // Mid-windup: prediction has shrunk (fewer remaining ticks), so
  // with a ball still moving +x, the target SHOULD have moved.
  const windupTicks = Math.ceil(KICK_WINDUP_MS / TICK_MS);
  for (let i = 0; i < Math.floor(windupTicks / 2); i++) tick(state, NOOP, NOOP);
  const targetMidWindup = state.p1.kick.footTargetX;
  assert.notEqual(targetMidWindup, targetAtStart, 'target should update during windup');

  // Drive to strike-start and capture the first frozen target.
  while (state.p1.kick.stage === 'windup') tick(state, NOOP, NOOP);
  assert.equal(state.p1.kick.stage, 'strike');
  const targetAtStrike = state.p1.kick.footTargetX;

  // One more strike tick: target must not change.
  tick(state, NOOP, NOOP);
  assert.equal(state.p1.kick.footTargetX, targetAtStrike, 'target frozen during strike');
});

test('kick fires on foot-ball contact during strike window', () => {
  const state = kickBenchState();
  tick(state, kickAction(1, 0, 0, 1), NOOP);
  assert.ok(state.p1.kick.active);
  // Drive through windup + first strike tick — contact should fire.
  const strikeOnsetTicks = Math.ceil(KICK_WINDUP_MS / TICK_MS) + 1;
  for (let i = 0; i < strikeOnsetTicks; i++) tick(state, NOOP, NOOP);
  assert.ok(state.p1.kick.fired, `kick should have fired by tick ${strikeOnsetTicks}`);
  assert.ok(state.ball.vx > 0, `ball should have gained +x velocity, got ${state.ball.vx}`);
});

test('kick misses when ball moves out of foot reach during windup', () => {
  const state = kickBenchState();
  // Launch the kick while the ball is stationary.
  tick(state, kickAction(1, 0, 0, 1), NOOP);
  assert.ok(state.p1.kick.active);
  // Now YANK the ball way out of reach during windup so by the time
  // strike opens, the frozen target is far from the actual ball.
  state.ball.x = state.p1.x + PLAYER_WIDTH / 2 + 200;
  // Drive past the full strike window, collecting events across
  // ticks — state.events is cleared at the start of each tick so
  // we can't inspect it once at the end.
  let sawMiss = false;
  const totalTicks = Math.ceil((KICK_WINDUP_MS + KICK_STRIKE_WINDOW_MS) / TICK_MS) + 2;
  for (let i = 0; i < totalTicks; i++) {
    tick(state, NOOP, NOOP);
    if (state.events.some((e) => e.type === 'kick_missed' && e.reason === 'no_contact')) {
      sawMiss = true;
    }
  }
  assert.ok(sawMiss, 'should emit kick_missed with reason=no_contact across ticks');
  assert.equal(state.p1.kick.fired, false, 'kick should not have fired');
});

test('kick foot-contact is symmetric on both hip sides', () => {
  // The foot collider uses the BODY-AXIS center hip (matches the
  // reach gate), so a ball offset by HIP_OFX to either the left or
  // the right of the body axis gets kicked the same way — no
  // asymmetric kill zone that silently wastes kicks on the
  // non-dominant side.
  for (const sign of [-1, +1]) {
    const state = kickBenchState();
    state.ball.y = state.p1.y + sign * (2.64 / Z_STRETCH);
    tick(state, kickAction(1, 0, 0, 1), NOOP);
    assert.ok(state.p1.kick.active, `ball on sign=${sign} side still reachable`);
    const strikeOnsetTicks = Math.ceil(KICK_WINDUP_MS / TICK_MS) + 1;
    for (let i = 0; i < strikeOnsetTicks; i++) tick(state, NOOP, NOOP);
    assert.ok(state.p1.kick.fired, `foot-sphere should fire for ball on sign=${sign} side`);
  }
});

test('kick facing cone rejects a ball behind the player', () => {
  const state = kickBenchState();
  state.p1.heading = Math.PI;  // facing -x, ball is in +x
  tick(state, kickAction(1, 0, 0, 1), NOOP);
  assert.equal(state.p1.kick.active, false, 'kick must not activate when facing away');
  assert.ok(
    state.events.some((e) => e.type === 'kick_missed' && e.reason === 'facing_away'),
    'should emit kick_missed with reason=facing_away',
  );
});

test('kickLegExtension returns 0 for inactive kick', () => {
  assert.equal(kickLegExtension(null), 0);
  assert.equal(kickLegExtension({ active: false }), 0);
});

test('kickLegExtension walks 0 → 0.7 → 1 → 0 smoothly across stages (ground)', () => {
  // Windup is split: load (0 → 0.7 of windup) ramps 0 → 0.7,
  // then rise (0.7 → 1 of windup) ramps 0.7 → 1. Strike holds at 1,
  // recovery decays to 0. No discontinuity at the windup/strike boundary.
  const k = { active: true, kind: 'ground', timer: 0 };
  const loadEnd = KICK_WINDUP_MS * 0.7;
  assert.equal(kickLegExtension(k), 0, 'timer 0 → extension 0');
  k.timer = loadEnd / 2;
  assert.ok(Math.abs(kickLegExtension(k) - 0.35) < 1e-9, 'mid-load → 0.35');
  k.timer = loadEnd;
  assert.ok(Math.abs(kickLegExtension(k) - 0.7) < 1e-9, 'load end → 0.7');
  k.timer = (loadEnd + KICK_WINDUP_MS) / 2;
  assert.ok(Math.abs(kickLegExtension(k) - 0.85) < 1e-9, 'mid-rise → 0.85');
  k.timer = KICK_WINDUP_MS - 0.001;
  assert.ok(kickLegExtension(k) > 0.999, 'windup end → ~1');
  k.timer = KICK_WINDUP_MS;
  assert.equal(kickLegExtension(k), 1, 'strike start → 1 (continuous with windup end)');
  k.timer = KICK_WINDUP_MS + KICK_STRIKE_WINDOW_MS - 1;
  assert.equal(kickLegExtension(k), 1, 'mid-strike → 1');
  k.timer = KICK_WINDUP_MS + KICK_STRIKE_WINDOW_MS;
  assert.equal(kickLegExtension(k), 1, 'recovery boundary → still 1 (just starting to decay)');
  k.timer = KICK_WINDUP_MS + KICK_STRIKE_WINDOW_MS + 1;
  assert.ok(kickLegExtension(k) < 1 && kickLegExtension(k) > 0.99, 'just inside recovery → <1');
  k.timer = KICK_DURATION_MS;
  assert.ok(Math.abs(kickLegExtension(k)) < 1e-9, 'recovery end → 0');
});

test('kickLegExtension uses AIRKICK_PEAK_FRAC * AIRKICK_MS as windup for air', () => {
  const k = { active: true, kind: 'air', timer: 0 };
  const windupMs = AIRKICK_PEAK_FRAC * AIRKICK_MS;
  const loadEnd  = windupMs * 0.7;
  k.timer = loadEnd / 2;
  assert.ok(Math.abs(kickLegExtension(k) - 0.35) < 1e-9, 'air mid-load → 0.35');
  k.timer = windupMs + KICK_STRIKE_WINDOW_MS / 2;
  assert.equal(kickLegExtension(k), 1, 'air strike → 1');
});

test('kickLegPose neutral for inactive kick', () => {
  const out = { upperAngle: 99, lowerAngle: 99 };
  kickLegPose({ active: false }, 0, 20, 0, 1, 0, out);
  assert.equal(out.upperAngle, 0);
  assert.equal(out.lowerAngle, 0);
});

test('kickLegPose at strike reaches the foot target', () => {
  // Hip at world (0, 20, 0), facing +x, target 8 forward at ground.
  const k = {
    active: true, kind: 'ground', stage: 'strike',
    timer: KICK_WINDUP_MS + KICK_STRIKE_WINDOW_MS / 2,
    footTargetX: 8, footTargetY: 4.224, footTargetZ: 0,
  };
  const out = { upperAngle: 0, lowerAngle: 0 };
  kickLegPose(k, 0, 20, 0, 1, 0, out);
  // Reconstruct foot position from angles.
  const U = STICKMAN_UPPER_LEG, L = STICKMAN_LOWER_LEG;
  const kneeFwd  = U * Math.sin(out.upperAngle);
  const kneeDown = U * Math.cos(out.upperAngle);
  const footFwd  = kneeFwd + L * Math.sin(out.lowerAngle);
  const footDown = kneeDown + L * Math.cos(out.lowerAngle);
  // Target local: fwd = 8, up = 4.224 - 20 = -15.776, down = 15.776.
  assert.ok(Math.abs(footFwd - 8) < 1e-6, `foot fwd should be 8, got ${footFwd}`);
  assert.ok(Math.abs(footDown - 15.776) < 1e-6, `foot down should be 15.776, got ${footDown}`);
});

test('kickLegPose at windup load-end (tEff=0.7) reaches the cock-back keyframe', () => {
  // The foot path during windup is a three-keyframe trajectory:
  //   load (tEff: 0 → 0.7)  rest → cock
  //   rise (tEff: 0.7 → 1)  cock → target
  // At the end of the load phase the foot should be at the cock-
  // back position (20% of leg-length behind hip, 50% below) — NOT
  // on the line from rest to ball. This is what gives the kick a
  // visible windup pose instead of a snap-to-target.
  const k = {
    active: true, kind: 'ground', stage: 'windup',
    timer: KICK_WINDUP_MS * 0.7,  // exact end of the load phase
    footTargetX: 10, footTargetY: 4.224, footTargetZ: 0,
  };
  const out = { upperAngle: 0, lowerAngle: 0 };
  kickLegPose(k, 0, 20, 0, 1, 0, out);
  const U = STICKMAN_UPPER_LEG, L = STICKMAN_LOWER_LEG;
  const legLen = U + L;
  const kneeFwd  = U * Math.sin(out.upperAngle);
  const kneeDown = U * Math.cos(out.upperAngle);
  const footFwd  = kneeFwd + L * Math.sin(out.lowerAngle);
  const footDown = kneeDown + L * Math.cos(out.lowerAngle);
  const expectedFwd  = -0.20 * legLen;  // 20% behind hip
  const expectedDown =  0.50 * legLen;  // 50% below hip
  assert.ok(Math.abs(footFwd - expectedFwd) < 1e-3, `foot fwd expected ${expectedFwd}, got ${footFwd}`);
  assert.ok(Math.abs(footDown - expectedDown) < 1e-3, `foot down expected ${expectedDown}, got ${footDown}`);
});

test('kickLegPose produces finite, non-hyperextended angles across the full stage', () => {
  // Sweep `kick.timer` from 0 → KICK_DURATION_MS across a range of
  // foot targets (reachable and just-out-of-reach). The IK solver
  // always picks the knee-forward branch; lowerAngle must never be
  // less than the hip-foot angle (that would put the knee BEHIND
  // the hip-foot line, i.e. hyperextended / reversed).
  const hipWX = 0, hipWY = 20, hipWZ = 0;
  const fwdX = 1, fwdZ = 0;
  for (const targetFwd of [4, 8, 12, 18, 22]) {
    for (const targetUp of [-18, -12, -4, 0, 6]) {
      const k = {
        active: true, kind: 'ground',
        footTargetX: hipWX + targetFwd,
        footTargetY: hipWY + targetUp,
        footTargetZ: hipWZ,
        timer: 0,
      };
      for (let t = 0; t <= KICK_DURATION_MS; t += 16) {
        k.timer = t;
        const out = { upperAngle: 0, lowerAngle: 0 };
        kickLegPose(k, hipWX, hipWY, hipWZ, fwdX, fwdZ, out);
        assert.ok(
          Number.isFinite(out.upperAngle) && Number.isFinite(out.lowerAngle),
          `NaN at t=${t}, target=(${targetFwd},${targetUp})`,
        );
        // Knee-forward branch: upperAngle ≥ lowerAngle for a forward
        // target (upper sweeps ahead of shin). Not a strict rule —
        // allow tiny epsilon for the fully-straight-leg edge.
        if (targetFwd > 0) {
          assert.ok(
            out.upperAngle - out.lowerAngle > -1e-6,
            `knee inverted at t=${t}, target=(${targetFwd},${targetUp}): upper=${out.upperAngle}, lower=${out.lowerAngle}`,
          );
        }
      }
    }
  }
});

test('kickLegPose projects along heading (rotation-invariant)', () => {
  // Same relative target, different headings — the local angles
  // must be identical because IK operates in hip-local (fwd, up).
  const tgt = { fwd: 8, up: -15.776 };  // ball 8 forward, 15.776 below hip
  const poses = [];
  for (const h of [0, Math.PI / 3, Math.PI / 2, -Math.PI / 4, Math.PI]) {
    const fwdX = Math.cos(h);
    const fwdZ = Math.sin(h);
    const targetX = tgt.fwd * fwdX;
    const targetZ = tgt.fwd * fwdZ;
    const k = {
      active: true, kind: 'ground', stage: 'strike',
      timer: KICK_WINDUP_MS,
      footTargetX: targetX, footTargetY: 20 + tgt.up, footTargetZ: targetZ,
    };
    const out = { upperAngle: 0, lowerAngle: 0 };
    kickLegPose(k, 0, 20, 0, fwdX, fwdZ, out);
    poses.push({ h, ...out });
  }
  const ref = poses[0];
  for (const p of poses) {
    assert.ok(Math.abs(p.upperAngle - ref.upperAngle) < 1e-9,
      `upperAngle drifts with heading ${p.h}: ${p.upperAngle} vs ${ref.upperAngle}`);
    assert.ok(Math.abs(p.lowerAngle - ref.lowerAngle) < 1e-9,
      `lowerAngle drifts with heading ${p.h}: ${p.lowerAngle} vs ${ref.lowerAngle}`);
  }
});
