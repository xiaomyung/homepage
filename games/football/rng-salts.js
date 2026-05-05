/**
 * Shared seed-derivation salts. main.js and tests both XOR the match
 * seed with these to derive correlated-but-distinct streams (personality,
 * names). Salts must stay distinct so the streams don't correlate.
 */

export const RNG_SALT_PERSONALITY = 0x5A5A5A5A;
export const RNG_SALT_NAMES       = 0x12345678;
