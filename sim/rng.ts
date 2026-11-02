/**
 * Tiny seedable PRNG (mulberry32) so every simulation run is reproducible.
 * Not cryptographic; it only needs to be fast and deterministic.
 */
export type Rng = {
  /** Uniform float in [0, 1). */
  next(): number;
  /** Uniform integer in [lo, hi], inclusive on both ends. */
  int(lo: number, hi: number): number;
  /** True with probability p. */
  chance(p: number): boolean;
  pick<T>(xs: readonly T[]): T;
  /** New array, Fisher-Yates shuffled. */
  shuffle<T>(xs: readonly T[]): T[];
  /** k distinct elements, in random order. */
  sample<T>(xs: readonly T[], k: number): T[];
};

export function makeRng(seed: number): Rng {
  let a = seed >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const rng: Rng = {
    next,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    chance: (p) => next() < p,
    pick: (xs) => xs[Math.floor(next() * xs.length)],
    shuffle: (xs) => {
      const out = [...xs];
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
      }
      return out;
    },
    sample: (xs, k) => rng.shuffle(xs).slice(0, Math.max(0, Math.min(k, xs.length))),
  };
  return rng;
}
