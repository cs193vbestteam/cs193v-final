import type { Slot } from "../src/lib/constraints";
import { utility, type Proposal } from "../src/lib/evaluate";
import { candidatePool } from "../src/lib/mediator";
import type { Preferences } from "../src/lib/preferences";
import type { Restaurant } from "../src/lib/restaurants";

/**
 * The no-privacy upper bound: a planner that can read every preference file
 * enumerates every (restaurant, open slot) and scores it with the true
 * utilities. The protocol can at best match this; it can never beat it.
 *
 * "True utility" means the unrelaxed (concession level 0) utility.
 */

export type Oracle = {
  candidateCount: number;
  feasibleCount: number;
  /** max over feasible candidates of prod(utilities); 0 when nothing is feasible. */
  bestNash: number;
  bestNashProposal: Proposal | null;
  /** max over feasible candidates of min(utilities); 0 when nothing is feasible. */
  bestMaxMin: number;
  bestMaxMinProposal: Proposal | null;
};

export const nashOf = (utilities: readonly number[]): number => utilities.reduce((acc, u) => acc * u, 1);
export const minOf = (utilities: readonly number[]): number => (utilities.length ? Math.min(...utilities) : 0);

/** True utility of every person for one proposal, in member order. */
export function utilitiesOf(group: readonly Preferences[], restaurants: readonly Restaurant[], proposal: Proposal): number[] {
  const r = restaurants.find((x) => x.id === proposal.restaurantId);
  if (!r) return group.map(() => 0);
  return group.map((p) => utility(p, r, proposal.slot).value);
}

/** True when no member has a hard rule violated by this proposal. */
export function isFeasible(group: readonly Preferences[], restaurants: readonly Restaurant[], proposal: Proposal): boolean {
  const r = restaurants.find((x) => x.id === proposal.restaurantId);
  if (!r) return false;
  return group.every((p) => utility(p, r, proposal.slot).violated === null);
}

export function oracle(group: readonly Preferences[], restaurants: readonly Restaurant[]): Oracle {
  const pool = candidatePool([...restaurants]);
  const out: Oracle = {
    candidateCount: pool.length,
    feasibleCount: 0,
    bestNash: 0,
    bestNashProposal: null,
    bestMaxMin: 0,
    bestMaxMinProposal: null,
  };
  for (const { r, slot } of pool) {
    const us = group.map((p) => utility(p, r, slot as Slot));
    if (us.some((u) => u.violated !== null)) continue;
    out.feasibleCount++;
    const values = us.map((u) => u.value);
    const nash = nashOf(values);
    const mn = minOf(values);
    const proposal: Proposal = { restaurantId: r.id, slot };
    if (out.bestNashProposal === null || nash > out.bestNash) {
      out.bestNash = nash;
      out.bestNashProposal = proposal;
    }
    if (out.bestMaxMinProposal === null || mn > out.bestMaxMin) {
      out.bestMaxMin = mn;
      out.bestMaxMinProposal = proposal;
    }
  }
  return out;
}
