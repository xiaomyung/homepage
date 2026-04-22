// Pure keyframe sampler. No DOM, no three.js — exercisable in node
// tests.
//
// A keyframe array drives one channel for one animation state:
//   [{ t: 0,    v: 0    },
//    { t: 0.3,  v: -0.4, ease: 'out' },
//    { t: 1,    v: 0    }]
//
// Contract:
//   - `kf` is an array of { t, v, ease? } entries sorted by t ascending
//     (dev-time assert; not enforced at runtime — bad data returns
//     garbage rather than throwing).
//   - `t` is normalized phase in [0, 1]. Out-of-range: hold the
//     nearest knot's value (no extrapolation). Looping states compute
//     `t = phase mod 1` upstream.
//   - `ease` is the OUTGOING easing to the next knot:
//       'linear' — straight line
//       'inOut'  — smooth start + smooth end (default)
//       'out'    — snappy start, settled end
//       'step'   — hold current value, snap to next at boundary
//
// Returns a number. No per-sample object allocation — the renderer
// calls this in the hot draw path.

import { easeInOut, easeOut } from '../renderer-math.js';

const EASE_STEP   = (u) => (u < 0.9999 ? 0 : 1);
const EASE_LINEAR = (u) => u;

const EASE_FNS = {
  linear: EASE_LINEAR,
  inOut:  easeInOut,
  out:    easeOut,
  step:   EASE_STEP,
};

export function sample(kf, t) {
  const n = kf.length;
  if (n === 0) return 0;
  if (n === 1 || t <= kf[0].t) return kf[0].v;
  const last = kf[n - 1];
  if (t >= last.t) return last.v;
  // Linear scan — n is tiny (< 10 knots per channel in practice).
  let i = 0;
  while (i < n - 1 && kf[i + 1].t <= t) i++;
  const a = kf[i], b = kf[i + 1];
  const span = b.t - a.t;
  if (span <= 0) return b.v;
  const u = (t - a.t) / span;
  const easeFn = EASE_FNS[a.ease || 'inOut'] || EASE_FNS.inOut;
  const w = easeFn(u);
  return a.v + (b.v - a.v) * w;
}

/** Assert that a keyframe array is well-formed. Dev-only; callers
 *  should invoke this when loading keyframe data, not in the hot
 *  path. Throws on malformed input. */
export function validateKeyframes(kf, channelName = '?') {
  if (!Array.isArray(kf)) throw new Error(`kf for ${channelName} is not an array`);
  if (kf.length === 0)   throw new Error(`kf for ${channelName} is empty`);
  for (let i = 0; i < kf.length; i++) {
    const k = kf[i];
    if (typeof k.t !== 'number' || !Number.isFinite(k.t)) {
      throw new Error(`kf[${i}] for ${channelName}: bad t`);
    }
    if (typeof k.v !== 'number' || !Number.isFinite(k.v)) {
      throw new Error(`kf[${i}] for ${channelName}: bad v`);
    }
    if (i > 0 && kf[i - 1].t > k.t) {
      throw new Error(`kf for ${channelName} not sorted: kf[${i - 1}].t > kf[${i}].t`);
    }
  }
}
