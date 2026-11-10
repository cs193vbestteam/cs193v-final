import type { Slot } from "./constraints";
import { NEUTRAL_CUISINE, relax, type Preferences, type SoftRule } from "./preferences";
import type { Restaurant } from "./restaurants";

/**
 * A member's assistant judging one proposal.
 *
 * Deterministic and LLM-free on purpose. The only thing that ever leaves this
 * module is a verdict and (optionally) ONE dimension name: never a number,
 * never the preferences themselves.
 *
 *   utility = weighted mean of soft satisfactions, 0..1
 *   >= ACCEPT_AT    → accept
 *   >= RELUCTANT_AT → reluctant (+ weakest dimension)
 *   otherwise       → reject    (+ weakest dimension)
 *   any hard rule violated → reject (+ that dimension), utility not consulted
 */

export type Proposal = { restaurantId: string; slot: Slot };

export type Verdict = "accept" | "reluctant" | "reject";
export type Dim = "time" | "price" | "diet" | "distance" | "cuisine";
export type Judgement = { verdict: Verdict; dim?: Dim };

export const ACCEPT_AT = 0.7;
export const RELUCTANT_AT = 0.4;

export type Bucket = 1 | 2 | 3 | 4 | 5;

function violated(p: Preferences, r: Restaurant, slot: Slot): Dim | null {
  if (!r.open.includes(slot)) return "time";
  for (const h of p.hard) {
    switch (h.dim) {
      case "time":
        if (!h.val.includes(slot)) return "time";
        break;
      case "diet":
        for (const d of h.val) {
          if (
            (d === "no_spicy" && r.spicy) ||
            (d === "vegetarian" && !r.vegetarianFriendly) ||
            (d === "no_seafood" && r.seafoodHeavy) ||
            (d === "halal" && !r.halal)
          )
            return "diet";
        }
        break;
      case "price":
        if (r.pricePerPerson > h.val) return "price";
        break;
      case "distance":
        if (r.travelMin > h.val) return "distance";
        break;
    }
  }
  return null;
}

/** 1 at or above the floor they asked for, then linear to 0 at half of it. No floor: always 1. */
function aboveFloor(x: number, floor: number | undefined): number {
  if (floor === undefined || x >= floor) return 1;
  return Math.max(0, 1 - (floor - x) / (floor / 2));
}

/** 1 at or below ideal, then linear to 0 at ideal + tolerance. */
function ramp(x: number, ideal: number, tolerance: number): number {
  if (x <= ideal) return 1;
  if (tolerance <= 0) return 0;
  return Math.max(0, 1 - (x - ideal) / tolerance);
}

export function satisfaction(s: SoftRule, r: Restaurant): number {
  switch (s.dim) {
    case "price":
      return Math.min(ramp(r.pricePerPerson, s.ideal, s.tolerance), aboveFloor(r.pricePerPerson, s.floor));
    case "distance":
      return ramp(r.travelMin, s.ideal, s.tolerance);
    case "cuisine":
      if (s.prefer.includes(r.cuisine)) return 1;
      if (s.avoid.includes(r.cuisine)) return s.avoidScore;
      return NEUTRAL_CUISINE;
  }
}

export type Utility = { value: number; perDim: Partial<Record<Dim, number>>; violated: Dim | null };

/** The full picture. Stays inside the assistant; only evaluate()/bucket() leave. */
export function utility(p: Preferences, r: Restaurant, slot: Slot): Utility {
  const v = violated(p, r, slot);
  const perDim: Partial<Record<Dim, number>> = {};
  let num = 0;
  let den = 0;
  for (const s of p.soft) {
    const sat = satisfaction(s, r);
    perDim[s.dim] = sat;
    num += s.weight * sat;
    den += s.weight;
  }
  const value = v ? 0 : den > 0 ? num / den : 1;
  return { value, perDim, violated: v };
}

function weakest(p: Preferences, u: Utility): Dim | undefined {
  let worst: { dim: Dim; shortfall: number } | null = null;
  for (const s of p.soft) {
    const shortfall = s.weight * (1 - (u.perDim[s.dim] ?? 1));
    if (!worst || shortfall > worst.shortfall) worst = { dim: s.dim, shortfall };
  }
  return worst && worst.shortfall > 0 ? worst.dim : undefined;
}

/**
 * The verdict the mediator is allowed to see.
 * `level` is how many concession steps this person has been asked to make.
 */
export function evaluate(prefs: Preferences, r: Restaurant, slot: Slot, level = 0): Judgement {
  const p = relax(prefs, level);
  const u = utility(p, r, slot);
  if (u.violated) return { verdict: "reject", dim: u.violated };
  if (u.value >= ACCEPT_AT) return { verdict: "accept" };
  const dim = weakest(p, u);
  if (u.value >= RELUCTANT_AT) return { verdict: "reluctant", dim };
  return { verdict: "reject", dim };
}

/** Coarse utility for the final fairness step: 5 buckets, never the number. */
export function bucket(prefs: Preferences, r: Restaurant, slot: Slot, level = 0): Bucket {
  const u = utility(relax(prefs, level), r, slot);
  if (u.violated) return 1;
  return Math.min(5, Math.floor(u.value * 5 + 1e-9) + 1) as Bucket;
}
