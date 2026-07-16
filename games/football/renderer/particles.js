/**
 * Football v2 — particle bursts.
 *
 * Four spawn paths share a single 120-slot pool: ball-bounce,
 * footstep, push-contact, goal-burst (event-driven), plus the per-
 * frame `stepParticles` ageing and `drawParticles` write into the
 * instanced mesh. ctx-style: every function takes the Renderer
 * instance as the first argument so the pool, scratch buffers, and
 * field reference stay on the class.
 */

import {
  PARTICLE_BASE_COUNT, PARTICLE_FORCE_COUNT, PARTICLE_MAX_COUNT,
  PARTICLE_BASE_SPEED, PARTICLE_SPREAD,
  PARTICLE_LIFE_BASE, PARTICLE_LIFE_VARIANCE,
  PARTICLE_GRAVITY, PARTICLE_GROUND_DRAG,
  PARTICLE_VISUAL_RADIUS,
  FOOTSTEP_MIN_SPEED, FOOTSTEP_BASE_COUNT, FOOTSTEP_FORCE_COUNT,
  FOOTSTEP_MAX_COUNT, FOOTSTEP_SPEED, FOOTSTEP_BACK_OFFSET,
  PUSH_CONTACT_BASE_COUNT, PUSH_CONTACT_FORCE_COUNT,
  PUSH_CONTACT_MAX_COUNT, PUSH_CONTACT_SPEED, PUSH_CONTACT_LIFT_BIAS,
  GOAL_BURST_COUNT, GOAL_BURST_SPEED, GOAL_BURST_LIFT,
  GOAL_BURST_LIFE_BASE, GOAL_BURST_LIFE_VAR,
} from './tuning.js';
import {
  FIELD_HEIGHT, MAX_PLAYER_SPEED, PLAYER_WIDTH, Z_STRETCH,
} from '../physics/index.js';

/** Advance the rolling pool cursor and return the next recyclable
 *  particle slot. Shared by all four spawn paths. */
function nextParticle(ctx) {
  const p = ctx._particles[ctx._particleNext];
  ctx._particleNext = (ctx._particleNext + 1) % ctx._particles.length;
  return p;
}

/** Spawn a burst of splash particles at the bounce location. Count and
 *  outward speed both scale with `ev.force`; `ev.axis` selects the
 *  surface-normal axis (z = ground/ceiling, y = field walls, x = goal posts). */
export function spawnBounceParticles(ctx, ev) {
  const count = Math.min(
    PARTICLE_MAX_COUNT,
    Math.floor(PARTICLE_BASE_COUNT + ev.force * PARTICLE_FORCE_COUNT),
  );
  const speed = ev.force * PARTICLE_BASE_SPEED;
  const spread = speed * PARTICLE_SPREAD;
  for (let i = 0; i < count; i++) {
    const p = nextParticle(ctx);

    p.x = ev.x;
    p.y = ev.y;
    p.z = ev.z;

    const r1 = (Math.random() - 0.5) * 2;
    const r2 = (Math.random() - 0.5) * 2;
    const r3 = Math.random();
    if (ev.axis === 'z') {
      p.vx = r1 * spread;
      p.vy = r2 * spread;
      p.vz = (ev.z > 0 ? -1 : 1) * speed * (0.5 + r3);
    } else if (ev.axis === 'y') {
      const sign = ev.y < FIELD_HEIGHT / 2 ? 1 : -1;
      p.vx = r1 * spread;
      p.vy = sign * speed * (0.5 + r3);
      p.vz = speed * (0.3 + r3 * 0.7);
    } else {
      const sign = ev.x < ctx.fieldWidth * 0.5 ? 1 : -1;
      p.vx = sign * speed * (0.5 + r3);
      p.vy = r2 * spread;
      p.vz = speed * (0.3 + r3 * 0.7);
    }

    p.maxLife = PARTICLE_LIFE_BASE + Math.floor(Math.random() * PARTICLE_LIFE_VARIANCE);
    p.life = p.maxLife;
  }
}

/** Detect a foot-plant on the walk cycle (sin(phase) zero-crossing)
 *  and spawn a dust burst when the player is moving. Idle/kicking/
 *  pushing/celebrating stickmen are gated out. */
export function maybeFootstepBurst(ctx, player, snap) {
  const speed = Math.hypot(player.vx || 0, (player.vy || 0) * Z_STRETCH);
  const swing = snap.swing;
  const prev = ctx._lastFootSwing.get(player);
  ctx._lastFootSwing.set(player, swing);
  if (prev === undefined) return;
  if (speed < FOOTSTEP_MIN_SPEED) return;
  if (player.kick && player.kick.active) return;
  if (player.pushTimer > 0) return;
  // Zero-crossing of sin(phase) → one foot just touched ground.
  if ((prev <= 0) === (swing <= 0)) return;
  spawnFootstepParticles(ctx, player, speed);
}

/** Spawn the footstep dust burst. Count + outward speed scale with
 *  the player's normalized speed (vs MAX_PLAYER_SPEED). */
export function spawnFootstepParticles(ctx, player, speed) {
  const speed01 = Math.min(1, speed / MAX_PLAYER_SPEED);
  const count = Math.min(
    FOOTSTEP_MAX_COUNT,
    Math.floor(FOOTSTEP_BASE_COUNT + speed01 * FOOTSTEP_FORCE_COUNT),
  );
  if (count <= 0) return;
  const burstSpeed = speed01 * FOOTSTEP_SPEED;

  // Motion direction in world xz; spawn slightly behind the player.
  const wvx = player.vx || 0;
  const wvz = (player.vy || 0) * Z_STRETCH;
  const wmag = Math.sqrt(wvx * wvx + wvz * wvz) || 1;
  const dirX = wvx / wmag;
  const dirZ = wvz / wmag;
  const spawnX = player.x + PLAYER_WIDTH / 2 - dirX * FOOTSTEP_BACK_OFFSET;
  const spawnY = player.y - (dirZ / Z_STRETCH) * FOOTSTEP_BACK_OFFSET;

  for (let i = 0; i < count; i++) {
    const p = nextParticle(ctx);

    p.x = spawnX;
    p.y = spawnY;
    p.z = 0;

    const r1 = (Math.random() - 0.5) * 2;
    const r2 = (Math.random() - 0.5) * 2;
    const r3 = Math.random();
    p.vx = (-dirX * (0.4 + r3 * 0.4) + r1 * 0.4) * burstSpeed;
    p.vy = (-(dirZ / Z_STRETCH) * (0.4 + r3 * 0.4) + r2 * 0.4) * burstSpeed;
    p.vz = (0.6 + r3 * 0.5) * burstSpeed;

    p.maxLife = PARTICLE_LIFE_BASE + Math.floor(Math.random() * PARTICLE_LIFE_VARIANCE);
    p.life = p.maxLife;
  }
}

/** Spawn a burst of dust at the punch impact point. Particles fly
 *  outward in all directions (Marsaglia uniform-sphere) with a mild
 *  upward bias so they arc visibly before gravity pulls them down. */
export function spawnPushContactParticles(ctx, ev) {
  const force = Math.max(0.2, ev.force);
  const count = Math.min(
    PUSH_CONTACT_MAX_COUNT,
    Math.floor(PUSH_CONTACT_BASE_COUNT + force * PUSH_CONTACT_FORCE_COUNT),
  );
  const speed = force * PUSH_CONTACT_SPEED;
  for (let i = 0; i < count; i++) {
    const p = nextParticle(ctx);

    p.x = ev.x;
    p.y = ev.y;
    p.z = ev.z;

    let u1, u2, s;
    do {
      u1 = Math.random() * 2 - 1;
      u2 = Math.random() * 2 - 1;
      s = u1 * u1 + u2 * u2;
    } while (s >= 1 || s === 0);
    const factor = Math.sqrt(1 - s);
    const dirX  = 2 * u1 * factor;
    const dirYp = 2 * u2 * factor;
    const dirZu = 1 - 2 * s;

    const mag = speed * (0.4 + 0.6 * Math.random());
    p.vx = dirX  * mag;
    p.vy = dirYp * mag;
    p.vz = (dirZu + PUSH_CONTACT_LIFT_BIAS) * mag;

    p.maxLife = PARTICLE_LIFE_BASE + Math.floor(Math.random() * PARTICLE_LIFE_VARIANCE);
    p.life = p.maxLife;
  }
}

/** Spawn a big burst of particles when a goal is scored. Spawns inside
 *  the scored goal's mouth across the full mouth width and shoots
 *  outward toward the field with a strong upward lift. */
export function spawnGoalBurst(ctx, scorer) {
  const f = ctx._field;
  // p1 scored = ball into RIGHT goal; p2 scored = ball into LEFT goal.
  const isRight = scorer === 'p1';
  const mouthX = isRight ? f.goalLineR : f.goalLineL;
  const outSign = isRight ? -1 : 1;
  const mouthYMin = f.goalMouthYMin;
  const mouthYMax = f.goalMouthYMax;
  const mouthYSpan = mouthYMax - mouthYMin;
  const mouthZMax = f.goalMouthZMax;

  for (let i = 0; i < GOAL_BURST_COUNT; i++) {
    const p = nextParticle(ctx);

    p.x = mouthX;
    p.y = mouthYMin + Math.random() * mouthYSpan;
    p.z = Math.random() * mouthZMax * 0.8;

    const r1 = Math.random();
    const r2 = (Math.random() - 0.5) * 2;
    const r3 = Math.random();
    p.vx = outSign * GOAL_BURST_SPEED * (0.6 + r1 * 0.8);
    p.vy = r2 * GOAL_BURST_SPEED * 0.5;
    p.vz = GOAL_BURST_LIFT * (0.7 + r3 * 0.6);

    p.maxLife = GOAL_BURST_LIFE_BASE + Math.floor(Math.random() * GOAL_BURST_LIFE_VAR);
    p.life = p.maxLife;
  }
}

/** Advance all live particles by one frame. Particles fall under light
 *  gravity and lose horizontal speed on ground contact. */
export function stepParticles(ctx) {
  for (let i = 0; i < ctx._particles.length; i++) {
    const p = ctx._particles[i];
    if (p.life <= 0) continue;
    p.x += p.vx;
    p.y += p.vy;
    p.z += p.vz;
    p.vz -= PARTICLE_GRAVITY;
    if (p.z < 0) {
      p.z = 0;
      p.vz = 0;
      p.vx *= PARTICLE_GROUND_DRAG;
      p.vy *= PARTICLE_GROUND_DRAG;
    }
    p.life--;
  }
}

/** Write live particles into the InstancedMesh. Position maps physics
 *  (x, y, z) → world (x, z, y*Z_STRETCH); per-instance color fades the
 *  rgb channels from full to black as the particle ages. Live particles
 *  are packed to the front so `.count` can skip the dead tail. */
export function drawParticles(ctx) {
  const q = ctx._scratchZeroQ;
  const pos = ctx._scratchPos;
  const scl = ctx._scratchScaleVec;
  const mat = ctx._scratchMat;
  const colors = ctx._particleColorArr;
  let n = 0;
  for (let i = 0; i < ctx._particles.length; i++) {
    const p = ctx._particles[i];
    if (p.life <= 0) continue;
    const ageFrac = p.life / p.maxLife;
    const size = PARTICLE_VISUAL_RADIUS * (0.4 + 0.6 * ageFrac);
    pos.set(p.x, Math.max(0, p.z) + size, p.y * Z_STRETCH);
    scl.set(size, size, size);
    mat.compose(pos, q, scl);
    ctx._particleMesh.setMatrixAt(n, mat);
    const c = ageFrac;
    const idx = n * 3;
    colors[idx + 0] = c;
    colors[idx + 1] = c;
    colors[idx + 2] = c;
    n++;
  }
  ctx._particleMesh.count = n;
  if (n > 0) {
    ctx._particleMesh.instanceMatrix.needsUpdate = true;
    ctx._particleColorAttr.needsUpdate = true;
  }
}
