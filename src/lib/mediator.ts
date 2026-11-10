import { SLOTS, type Slot } from "./constraints";
import type { Dim, Proposal, Verdict } from "./evaluate";
import type { Restaurant } from "./restaurants";

/**
 * The proposer. It never receives anyone's preferences: its only inputs are
 * the public candidate pool and anonymised tallies from earlier rounds.
 * Picking is pure code so every run is reproducible; an optional `Selector`
 * (e.g. an LLM) may re-rank the shortlist the code produces, never widen it.
 */

export type Tally = {
  accept: number;
  reluctant: number;
  reject: number;
  /** Dimension names given with reluctant verdicts. */
  dims: Partial<Record<Dim, number>>;
  /** Dimension names given with reject verdicts. */
  rejectDims: Partial<Record<Dim, number>>;
};

export type RoundFeedback = {
  round: number;
  /** Concession steps every assistant was asked to take this round. */
  level: number;
  /** Set on a round run after the group had already agreed, to look for something better (`exploreRounds`). */
  exploring?: true;
  /** `retried`: an earlier near-miss asked again after a concession step. */
  proposals: { proposal: Proposal; tally: Tally; retried?: boolean }[];
};

export type Candidate = { r: Restaurant; slot: Slot };

export type Selector = (
  shortlist: Candidate[],
  history: RoundFeedback[],
  k: number,
) => Candidate[] | Promise<Candidate[]>;

export const key = (p: Proposal) => `${p.restaurantId}@${p.slot}`;
export const candidateKey = (c: Candidate) => `${c.r.id}@${c.slot}`;

export function emptyTally(): Tally {
  return { accept: 0, reluctant: 0, reject: 0, dims: {}, rejectDims: {} };
}

export function tallyOf(judgements: { verdict: Verdict; dim?: Dim }[]): Tally {
  const t = emptyTally();
  for (const j of judgements) {
    t[j.verdict]++;
    if (!j.dim) continue;
    const bag = j.verdict === "reject" ? t.rejectDims : t.dims;
    bag[j.dim] = (bag[j.dim] ?? 0) + 1;
  }
  return t;
}

/** Every (open restaurant, slot) pair. Public information. */
export function candidatePool(restaurants: Restaurant[], slots: readonly Slot[] = SLOTS): Candidate[] {
  const out: Candidate[] = [];
  for (const r of restaurants) for (const slot of slots) if (r.open.includes(slot)) out.push({ r, slot });
  return out;
}

type Hints = {
  priceCeiling: number;
  priceSoftCeiling: number;
  travelCeiling: number;
  travelSoftCeiling: number;
  badSlots: Set<Slot>;
  badRestaurants: Set<string>;
  riskyFlags: { spicy: number; seafoodHeavy: number; notVeg: number; notHalal: number };
  mehCuisines: Map<string, number>;
};

/** Everything the mediator may infer, from tallies alone. */
function learn(history: RoundFeedback[], lookup: (id: string) => Restaurant | undefined): Hints {
  const h: Hints = {
    priceCeiling: Infinity,
    priceSoftCeiling: Infinity,
    travelCeiling: Infinity,
    travelSoftCeiling: Infinity,
    badSlots: new Set(),
    badRestaurants: new Set(),
    riskyFlags: { spicy: 0, seafoodHeavy: 0, notVeg: 0, notHalal: 0 },
    mehCuisines: new Map(),
  };
  for (const round of history) {
    for (const { proposal, tally } of round.proposals) {
      const r = lookup(proposal.restaurantId);
      if (!r) continue;
      if (tally.rejectDims.price) h.priceCeiling = Math.min(h.priceCeiling, r.pricePerPerson);
      if (tally.dims.price) h.priceSoftCeiling = Math.min(h.priceSoftCeiling, r.pricePerPerson);
      if (tally.rejectDims.distance) h.travelCeiling = Math.min(h.travelCeiling, r.travelMin);
      if (tally.dims.distance) h.travelSoftCeiling = Math.min(h.travelSoftCeiling, r.travelMin);
      // The pool only holds open slots, so a time reject means a person can't make it.
      if (tally.rejectDims.time) h.badSlots.add(proposal.slot);
      if (tally.rejectDims.diet) {
        h.badRestaurants.add(r.id);
        if (r.spicy) h.riskyFlags.spicy++;
        if (r.seafoodHeavy) h.riskyFlags.seafoodHeavy++;
        if (!r.vegetarianFriendly) h.riskyFlags.notVeg++;
        if (!r.halal) h.riskyFlags.notHalal++;
      }
      const cuisineMisses = (tally.dims.cuisine ?? 0) + (tally.rejectDims.cuisine ?? 0);
      if (cuisineMisses) h.mehCuisines.set(r.cuisine, (h.mehCuisines.get(r.cuisine) ?? 0) + cuisineMisses);
    }
  }
  return h;
}

/** Lower is better. */
function score(h: Hints, c: Candidate): number {
  const { r, slot } = c;
  let s = 0;
  if (r.pricePerPerson >= h.priceCeiling) s += 1000;
  else if (r.pricePerPerson >= h.priceSoftCeiling) s += 50;
  if (r.travelMin >= h.travelCeiling) s += 1000;
  else if (r.travelMin >= h.travelSoftCeiling) s += 50;
  if (h.badSlots.has(slot)) s += 1000;
  if (h.badRestaurants.has(r.id)) s += 1000;
  if (r.spicy) s += 40 * h.riskyFlags.spicy;
  if (r.seafoodHeavy) s += 40 * h.riskyFlags.seafoodHeavy;
  if (!r.vegetarianFriendly) s += 40 * h.riskyFlags.notVeg;
  if (!r.halal) s += 40 * h.riskyFlags.notHalal;
  s += 15 * (h.mehCuisines.get(r.cuisine) ?? 0);
  // Mild prior: mid-priced and nearby first, so early rounds are informative.
  s += Math.abs(r.pricePerPerson - 30) * 0.3 + r.travelMin * 0.2;
  // Among otherwise similar options, try the better-reviewed first. A public rating, nobody's preference;
  // it only breaks near-ties, so what the tallies say always outweighs it. Too few reviews say nothing.
  if (r.rating !== undefined && (r.ratingCount ?? 0) >= 20) s -= (r.rating - 4) * 6;
  return s;
}

/** How different two candidates feel; used to spread the first round out. */
function distance(a: Candidate, b: Candidate): number {
  let d = 0;
  d += Math.abs(a.r.pricePerPerson - b.r.pricePerPerson) / 30;
  d += Math.abs(a.r.travelMin - b.r.travelMin) / 15;
  if (a.r.cuisine !== b.r.cuisine) d += 1;
  if (a.slot !== b.slot) d += 0.7;
  return d;
}

/**
 * Rank the untried pool and shortlist `k` distinct restaurants.
 * Round 1 (no history): a diverse spread. Later: what the tallies point to.
 */
export function shortlist(
  pool: Candidate[],
  history: RoundFeedback[],
  k: number,
  lookup: (id: string) => Restaurant | undefined,
): Candidate[] {
  const hints = learn(history, lookup);
  const ranked = pool
    .map((c, i) => ({ c, s: score(hints, c), i }))
    .sort((a, b) => a.s - b.s || a.i - b.i)
    .map((x) => x.c);
  if (ranked.length === 0) return [];

  const picks: Candidate[] = [];
  if (history.length === 0) {
    // Farthest-first: start from the prior's favourite, then keep adding whatever is least like the picks so far.
    picks.push(ranked[0]);
    const limit = Math.min(ranked.length, Math.max(k * 6, 30));
    while (picks.length < k) {
      let best: Candidate | null = null;
      let bestD = -1;
      for (const c of ranked.slice(0, limit)) {
        if (picks.some((p) => p.r.id === c.r.id)) continue;
        const d = Math.min(...picks.map((p) => distance(p, c)));
        if (d > bestD) {
          bestD = d;
          best = c;
        }
      }
      if (!best) break;
      picks.push(best);
    }
    return picks;
  }
  for (const c of ranked) {
    if (picks.length >= k) break;
    if (!picks.some((p) => p.r.id === c.r.id)) picks.push(c);
  }
  return picks;
}

export async function propose(
  pool: Candidate[],
  history: RoundFeedback[],
  k: number,
  lookup: (id: string) => Restaurant | undefined,
  selector?: Selector,
): Promise<Candidate[]> {
  // Give an external selector a little room to choose from, never beyond the code's ranking.
  const list = shortlist(pool, history, selector ? k * 2 : k, lookup);
  if (!selector || list.length <= k) return list.slice(0, k);
  const chosen = await selector(list, history, k);
  const allowed = new Set(list.map(candidateKey));
  const valid = chosen.filter(
    (c, i, arr) => allowed.has(candidateKey(c)) && arr.findIndex((o) => candidateKey(o) === candidateKey(c)) === i,
  );
  return valid.length ? valid.slice(0, k) : list.slice(0, k);
}
