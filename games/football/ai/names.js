/**
 * Player name pool. Each match picks two distinct names from a seeded
 * shuffle; main.js consumes via state.matchNames.
 */

export const SURNAMES = [
  'Messi', 'Ronaldo', 'Neymar', 'Mbappe', 'Salah', 'Bruyne', 'Haaland',
  'Modric', 'Kroos', 'Benzema', 'Lewandowski', 'Iniesta', 'Xavi', 'Pele',
  'Maradona', 'Zidane', 'Beckham', 'Figo', 'Kaka', 'Ronaldinho',
];

/** Pick two distinct names from SURNAMES using rng (a 0..1 number source). */
export function pickMatchNames(rng) {
  const i = Math.floor(rng() * SURNAMES.length) % SURNAMES.length;
  let j = Math.floor(rng() * (SURNAMES.length - 1)) % (SURNAMES.length - 1);
  if (j >= i) j += 1;
  return { p1: SURNAMES[i], p2: SURNAMES[j] };
}
