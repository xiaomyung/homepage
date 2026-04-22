// Validates that every keyframe array in animation/keyframes.js is
// well-formed and that adjacent-state boundaries are continuous
// (so blending from KICK_WIND into KICK_STRIKE doesn't snap).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { KEYFRAMES } from '../animation/keyframes.js';
import { sample, validateKeyframes } from '../animation/sampler.js';

describe('animation/keyframes', () => {
  it('every state has well-formed keyframe arrays', () => {
    for (const [stateName, entries] of Object.entries(KEYFRAMES)) {
      for (const [ch, kf] of Object.entries(entries)) {
        if (ch === 'ikGroups') continue;
        validateKeyframes(kf, `${stateName}.${ch}`);
      }
    }
  });

  it('ikGroups (where present) are arrays of {solver, target, channels}', () => {
    for (const [stateName, entries] of Object.entries(KEYFRAMES)) {
      if (!entries.ikGroups) continue;
      assert.ok(Array.isArray(entries.ikGroups), `${stateName}.ikGroups is not an array`);
      for (const g of entries.ikGroups) {
        assert.equal(typeof g.solver, 'string', `${stateName}: solver missing`);
        assert.equal(typeof g.target, 'string', `${stateName}: target missing`);
        assert.ok(Array.isArray(g.channels) && g.channels.length > 0,
                  `${stateName}: channels must be a non-empty array`);
      }
    }
  });

  // Stage continuity: at the boundary between WIND → STRIKE → RECOVER
  // within one composite action (KICK, AIRKICK, PUSH), the shared
  // channel's trailing value must equal the next stage's leading
  // value. Keeps the visual pose continuous across the FSM seam.
  const TRANSITIONS = [
    { from: 'KICK_WIND',     to: 'KICK_STRIKE',    channels: ['torsoTilt', 'bodyY', 'hipTwist', 'armR_upper'] },
    { from: 'KICK_STRIKE',   to: 'KICK_RECOVER',   channels: ['torsoTilt', 'bodyY', 'hipTwist', 'armR_upper'] },
    { from: 'AIRKICK_LEAP',  to: 'AIRKICK_STRIKE', channels: ['torsoTilt', 'hipTwist', 'armR_upper'] },
    { from: 'AIRKICK_STRIKE',to: 'AIRKICK_LAND',   channels: ['torsoTilt', 'hipTwist', 'armR_upper'] },
    { from: 'PUSH_WIND',     to: 'PUSH_STRIKE',    channels: ['torsoTilt', 'bodyY'] },
    { from: 'PUSH_STRIKE',   to: 'PUSH_RECOVER',   channels: ['torsoTilt'] },
  ];

  for (const { from, to, channels } of TRANSITIONS) {
    it(`${from} → ${to}: shared channels are continuous at t=1 → t=0`, () => {
      for (const ch of channels) {
        const a = KEYFRAMES[from][ch];
        const b = KEYFRAMES[to][ch];
        if (!a || !b) continue;
        const tail = sample(a, 1);
        const head = sample(b, 0);
        assert.ok(
          Math.abs(tail - head) < 1e-9,
          `${from}.${ch} (=${tail}) != ${to}.${ch} (=${head}) — snap at FSM boundary`,
        );
      }
    });
  }
});
