import type { Constraints, Slot } from "./constraints";
import type { Restaurant } from "./restaurants";

/**
 * A member's assistant judging one proposal.
 * Deterministic and LLM-free on purpose: no private numbers ever leave this function,
 * only a verdict and (optionally) a coarse reason category.
 */

export type Proposal = { restaurantId: string; slot: Slot };

export type Verdict = "yes" | "meh" | "no";
export type Reason = "time" | "price" | "diet" | "distance" | "cuisine";

export type Judgement = { verdict: Verdict; reason?: Reason };

/** Minutes past maxTravelMin that still count as "a stretch, but OK". */
export const TRAVEL_GRACE_MIN = 10;

const RANK: Record<Verdict, number> = { yes: 0, meh: 1, no: 2 };

export function evaluate(c: Constraints, restaurant: Restaurant, slot: Slot): Judgement {
  const issues: Judgement[] = [];

  // Time (hard)
  if (!restaurant.open.includes(slot)) issues.push({ verdict: "no", reason: "time" });
  if (c.availableSlots && !c.availableSlots.includes(slot)) issues.push({ verdict: "no", reason: "time" });

  // Diet (hard)
  const d = c.dietary;
  if (
    (d.includes("no_spicy") && restaurant.spicy) ||
    (d.includes("vegetarian") && !restaurant.vegetarianFriendly) ||
    (d.includes("no_seafood") && restaurant.seafoodHeavy) ||
    (d.includes("halal") && !restaurant.halal)
  ) {
    issues.push({ verdict: "no", reason: "diet" });
  }

  // Price (soft up to budgetFlex)
  if (c.budgetMax !== null && restaurant.pricePerPerson > c.budgetMax) {
    const verdict = restaurant.pricePerPerson <= c.budgetMax + c.budgetFlex ? "meh" : "no";
    issues.push({ verdict, reason: "price" });
  }

  // Distance (soft up to grace)
  if (c.maxTravelMin !== null && restaurant.travelMin > c.maxTravelMin) {
    const verdict = restaurant.travelMin <= c.maxTravelMin + TRAVEL_GRACE_MIN ? "meh" : "no";
    issues.push({ verdict, reason: "distance" });
  }

  // Cuisine (preference only)
  if (c.dislikedCuisines.includes(restaurant.cuisine)) issues.push({ verdict: "meh", reason: "cuisine" });

  if (issues.length === 0) return { verdict: "yes" };
  // Report only the single worst issue: the system learns as little as possible.
  return issues.reduce((worst, j) => (RANK[j.verdict] > RANK[worst.verdict] ? j : worst));
}
