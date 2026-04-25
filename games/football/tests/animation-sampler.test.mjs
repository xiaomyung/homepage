import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sample, validateKeyframes } from '../animation/sampler.js';

describe('animation/sampler', () => {
  describe('sample()', () => {
    it('empty array returns 0', () => {
      assert.equal(sample([], 0.5), 0);
    });

    it('single-entry array returns that value at any t', () => {
      const kf = [{ t: 0, v: 7 }];
      assert.equal(sample(kf, 0), 7);
      assert.equal(sample(kf, 0.5), 7);
      assert.equal(sample(kf, 1), 7);
      assert.equal(sample(kf, -1), 7);
      assert.equal(sample(kf, 2), 7);
    });

    it('holds first value for t before first knot', () => {
      const kf = [{ t: 0.2, v: 5 }, { t: 1, v: 10 }];
      assert.equal(sample(kf, 0), 5);
      assert.equal(sample(kf, 0.1), 5);
      assert.equal(sample(kf, 0.2), 5);
    });

    it('holds last value for t after last knot', () => {
      const kf = [{ t: 0, v: 5 }, { t: 0.8, v: 10 }];
      assert.equal(sample(kf, 1), 10);
      assert.equal(sample(kf, 0.8), 10);
      assert.equal(sample(kf, 99), 10);
    });

    it('linear ease interpolates straight between knots', () => {
      const kf = [
        { t: 0, v: 0, ease: 'linear' },
        { t: 1, v: 10 },
      ];
      assert.equal(sample(kf, 0), 0);
      assert.equal(sample(kf, 0.5), 5);
      assert.equal(sample(kf, 1), 10);
    });

    it('default inOut ease is symmetric and monotonic', () => {
      const kf = [{ t: 0, v: 0 }, { t: 1, v: 10 }];
      const v25 = sample(kf, 0.25);
      const v50 = sample(kf, 0.5);
      const v75 = sample(kf, 0.75);
      assert.equal(v50, 5);              // midpoint of inOut is exactly midpoint
      assert.ok(v25 < v50 && v50 < v75); // monotonic
      // inOut: slow at the start, so mid-quarter is below linear
      assert.ok(v25 < 2.5);
    });

    it('step ease holds the starting value until the next knot', () => {
      const kf = [
        { t: 0, v: 5, ease: 'step' },
        { t: 1, v: 10 },
      ];
      assert.equal(sample(kf, 0), 5);
      assert.equal(sample(kf, 0.5), 5);
      assert.equal(sample(kf, 0.9), 5);
      // At the boundary the next knot takes over.
      assert.equal(sample(kf, 1), 10);
    });

    it('three-knot curve interpolates through the middle knot', () => {
      const kf = [
        { t: 0,   v: 0, ease: 'linear' },
        { t: 0.5, v: 8, ease: 'linear' },
        { t: 1,   v: 4 },
      ];
      assert.equal(sample(kf, 0.25), 4);   // halfway from 0→8
      assert.equal(sample(kf, 0.5), 8);    // middle knot exact
      assert.equal(sample(kf, 0.75), 6);   // halfway from 8→4
    });

    it('duplicate-t knots produce a step discontinuity (later wins at the boundary)', () => {
      const kf = [
        { t: 0, v: 1 },
        { t: 0.5, v: 2 },
        { t: 0.5, v: 3, ease: 'linear' },  // step to a new value at t=0.5
        { t: 1,   v: 9 },
      ];
      // At exactly the duplicate boundary the later knot wins — useful
      // for modeling instant pose snaps mid-animation.
      assert.equal(sample(kf, 0.5), 3);
      // Past the duplicate, normal interpolation resumes from 3 → 9.
      assert.equal(sample(kf, 0.75), 6);
      // Before the duplicate, interpolation runs to 2 as expected.
      assert.equal(sample(kf, 0.25), 1.5);  // linear 1 → 2 at midpoint (default inOut would give 1.5 too for midpoint)
    });
  });

  describe('validateKeyframes()', () => {
    it('accepts a single-entry sorted array', () => {
      validateKeyframes([{ t: 0, v: 0 }], 'ok');
    });

    it('accepts a multi-entry sorted array', () => {
      validateKeyframes([{ t: 0, v: 0 }, { t: 0.5, v: 1 }, { t: 1, v: 0 }], 'ok');
    });

    it('rejects empty array', () => {
      assert.throws(() => validateKeyframes([], 'ch'));
    });

    it('rejects non-array', () => {
      assert.throws(() => validateKeyframes(null, 'ch'));
      assert.throws(() => validateKeyframes({}, 'ch'));
    });

    it('rejects unsorted knots', () => {
      assert.throws(() => validateKeyframes(
        [{ t: 0, v: 0 }, { t: 0.8, v: 1 }, { t: 0.5, v: 0 }],
        'bad',
      ));
    });

    it('rejects non-finite t or v', () => {
      assert.throws(() => validateKeyframes([{ t: NaN, v: 0 }], 'ch'));
      assert.throws(() => validateKeyframes([{ t: 0, v: Infinity }], 'ch'));
      assert.throws(() => validateKeyframes([{ t: 0 }], 'ch'));
    });
  });
});
