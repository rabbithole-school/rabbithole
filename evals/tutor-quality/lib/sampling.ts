/**
 * Sampling for the weekly tutor-quality judge. Judge calls cost money (treat
 * Copilot-seat calls as if they do), and the per-turn judge re-reads the whole
 * conversation up to each turn, so a long session's cost grows with the square
 * of its length. Two budgets bound a run:
 *
 *   - sessions: a random sample of the week's eligible sessions, with
 *     observer-flagged ones taking up to half the slots, so concerns are still
 *     seen first without the sample becoming all concerns;
 *   - turns: at most `cap` tutor turns judged per session, spread evenly from
 *     the first to the last so the opening, middle and wrap-up are all seen.
 *
 * The sample is seeded (default: the run date), so a rerun on the same day
 * judges the same sessions. Pure helpers, unit-tested in
 * __tests__/sampling.test.ts.
 */

/** mulberry32: a small seeded PRNG. Enough for sampling, not for crypto. */
export function seededRandom(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `k` items drawn without replacement (partial Fisher–Yates), in draw order. */
export function sampleWithoutReplacement<T>(items: readonly T[], k: number, rand: () => number): T[] {
  const pool = [...items];
  const n = Math.min(Math.max(k, 0), pool.length);
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(rand() * (pool.length - i));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, n);
}

/**
 * Pick up to `budget` rows: flagged rows fill at most half the slots (rounded
 * up), then unflagged rows fill the rest, then any leftover flagged rows fill
 * slots the unflagged pool could not. Flagged picks come first in the result.
 */
export function sampleSessions<T>(
  rows: readonly T[],
  budget: number,
  isFlagged: (row: T) => boolean,
  rand: () => number,
): T[] {
  const flagged = sampleWithoutReplacement(rows.filter(isFlagged), rows.length, rand);
  const plain = sampleWithoutReplacement(rows.filter((r) => !isFlagged(r)), rows.length, rand);
  const flaggedShare = Math.min(flagged.length, Math.ceil(budget / 2));
  const plainShare = Math.min(plain.length, budget - flaggedShare);
  const extraFlagged = Math.min(flagged.length - flaggedShare, budget - flaggedShare - plainShare);
  return [
    ...flagged.slice(0, flaggedShare + extraFlagged),
    ...plain.slice(0, plainShare),
  ];
}

/**
 * Which of `n` tutor turns to judge (0-based positions among the tutor
 * turns): all of them when n <= cap, otherwise `cap` positions spread evenly
 * from the first turn to the last.
 */
export function spreadTurnPositions(n: number, cap: number): number[] {
  if (n <= 0 || cap <= 0) return [];
  if (n <= cap) return Array.from({ length: n }, (_, i) => i);
  if (cap === 1) return [n - 1];
  const picks = new Set<number>();
  for (let i = 0; i < cap; i++) picks.add(Math.round((i * (n - 1)) / (cap - 1)));
  return [...picks].sort((a, b) => a - b);
}
