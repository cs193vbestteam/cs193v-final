import { createHmac, randomBytes } from "node:crypto";

/**
 * Pairwise-masked sums: a group of members each hold a private vector of small
 * integers, and someone who collects one message from each learns the SUM of
 * the vectors and nothing about any single one.
 *
 *   every pair (i, j) shares a key the collector never sees
 *   member i sends   value_i + Σ_{j>i} mask(i,j) − Σ_{j<i} mask(j,i)   (mod 2^32)
 *   added up over all members, every mask appears once with + and once with −
 *
 * Each message on its own is uniformly random to anyone without the pair keys,
 * so the collector's view contains no individual value. This is the masking
 * step of secure aggregation (Bonawitz et al., 2017) without the dropout
 * recovery: here every member always answers.
 *
 * The final pick uses it on Nash products. A bucket from 1 to 5 is a product
 * of 2s, 3s and 5s, so it is sent as its three exponents, and a sum of
 * exponents is exactly a product of buckets.
 */

export const MODULUS = 2 ** 32;

/** Exponents of 2, 3 and 5. */
export type Exponents = readonly [number, number, number];

const FACTORS: Record<number, Exponents> = {
  1: [0, 0, 0],
  2: [1, 0, 0],
  3: [0, 1, 0],
  4: [2, 0, 0],
  5: [0, 0, 1],
};

/** A 1..5 bucket as exponents of 2, 3 and 5. Anything else counts as 1. */
export const exponentsOf = (bucket: number): Exponents => FACTORS[bucket] ?? FACTORS[1];

/** log of 2^a · 3^b · 5^c. */
export const logOf = ([a, b, c]: readonly number[]): number => a * Math.log(2) + b * Math.log(3) + c * Math.log(5);

/** keys[i][j] === keys[j][i] is the secret members i and j share. One fresh set per group. */
export type PairKeys = Buffer[][];

export function pairKeys(members: number): PairKeys {
  const keys: PairKeys = Array.from({ length: members }, () => Array<Buffer>(members));
  for (let i = 0; i < members; i++) for (let j = i + 1; j < members; j++) keys[i][j] = keys[j][i] = randomBytes(32);
  return keys;
}

/** A pseudorandom number below 2^32 that both members of a pair can compute for one slot of one question. */
function mask(key: Buffer, context: string, slot: number): number {
  return createHmac("sha256", key).update(`${context}#${slot}`).digest().readUInt32BE(0);
}

const mod = (x: number) => ((x % MODULUS) + MODULUS) % MODULUS;

/**
 * Member `i`'s message for `values`. `context` names the question being
 * answered, so the masks of one question can never cancel against another's.
 */
export function maskValues(i: number, keys: PairKeys, context: string, values: readonly number[]): number[] {
  return values.map((value, slot) => {
    let out = value;
    for (let j = 0; j < keys.length; j++) {
      if (j === i) continue;
      const m = mask(keys[i][j], context, slot);
      out += i < j ? m : -m;
    }
    return mod(out);
  });
}

/**
 * The sum of everyone's values, from everyone's messages. Sums are read as
 * signed (differences can be negative), which is exact while they stay far
 * below 2^31, as sums of bucket exponents always do.
 */
export function sumMasked(messages: readonly (readonly number[])[]): number[] {
  if (messages.length === 0) return [];
  return messages[0].map((_, slot) => {
    const total = mod(messages.reduce((acc, m) => acc + m[slot], 0));
    return total >= MODULUS / 2 ? total - MODULUS : total;
  });
}
