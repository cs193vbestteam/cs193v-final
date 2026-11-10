import {
  CUISINES,
  SLOTS,
  SOFT_DIMS,
  emptyConstraints,
  mergeConstraints,
  type Constraints,
  type Cuisine,
  type Dietary,
  type Slot,
  type SoftDim,
} from "../../src/lib/constraints";
import { utility } from "../../src/lib/evaluate";
import { KM_PER_MIN, haversineKm, travelMinutes, type LatLng } from "../../src/lib/geo";
import { compile } from "../../src/lib/preferences";
import type { Restaurant } from "../../src/lib/restaurants";
import type { Rng } from "../rng";
import type { YelpRestaurant } from "./businesses";

/**
 * Real reviewers → the constraints the private chat would have collected.
 *
 * What the reviews can tell us, and how:
 *   cuisine   liked = cuisines they return to and rate at least as well as their own average;
 *             disliked = cuisines they tried more than once and rated poorly
 *   budget    the price band they are usually content with (75th percentile of places rated 3+),
 *             with the distance to the 95th percentile as "a stretch"
 *   travel    how far from their own centre they usually go (75th percentile), as minutes
 *   weights   how selective they are on each of those, relative to the others
 *   diet      vegetarian / halal only when most of where they eat is categorised that way
 *
 * What the reviews cannot tell us: when someone is free. Availability is drawn
 * from the same distribution as the synthetic people (sim/synth.ts), and that
 * is the one synthetic ingredient left in a Yelp persona.
 *
 * Personas are built from each reviewer's earlier reviews only; the latest
 * ones are held out to check the persona against (validate()).
 */

export type Visit = { restaurant: YelpRestaurant; stars: number; date: string };

export type Persona = {
  userId: string;
  /** Centre of where they eat: stands in for where they start from. Never leaves the simulation. */
  home: LatLng;
  constraints: Constraints;
  trainVisits: number;
  heldOut: Visit[];
};

export const MIN_REVIEWS = 20;
export const HOLD_OUT_SHARE = 0.2;

const quantile = (xs: readonly number[], q: number): number => {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
};
const median = (xs: readonly number[]) => quantile(xs, 0.5);
const mean = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** 0 when spread evenly over `k` options, 1 when everything is in one. */
function concentration(counts: readonly number[], k: number): number {
  const total = counts.reduce((a, b) => a + b, 0);
  if (total === 0 || k < 2) return 0;
  let h = 0;
  for (const c of counts) if (c > 0) h -= (c / total) * Math.log(c / total);
  return 1 - h / Math.log(k);
}

/** Earlier reviews to learn from, latest ones to test on. */
export function splitVisits(
  visits: readonly Visit[],
  holdOutShare = HOLD_OUT_SHARE,
): { train: Visit[]; test: Visit[] } {
  const sorted = [...visits].sort(
    (a, b) => a.date.localeCompare(b.date) || a.restaurant.id.localeCompare(b.restaurant.id),
  );
  const nTest = Math.max(1, Math.round(sorted.length * holdOutShare));
  return { train: sorted.slice(0, sorted.length - nTest), test: sorted.slice(sorted.length - nTest) };
}

/** Same availability model as synthPerson: 45% free all weekend, otherwise 2..4 slots. */
function drawSlots(rng: Rng): Slot[] {
  return rng.chance(0.45) ? [...SLOTS] : rng.sample(SLOTS, rng.int(2, 4));
}

export function derivePersona(userId: string, visits: readonly Visit[], rng: Rng): Persona | null {
  if (visits.length < MIN_REVIEWS) return null;
  const { train, test } = splitVisits(visits);

  const home: LatLng = {
    lat: median(train.map((v) => v.restaurant.location.lat)),
    lng: median(train.map((v) => v.restaurant.location.lng)),
  };

  // Cuisine.
  const overall = mean(train.map((v) => v.stars));
  const byCuisine = new Map<Cuisine, number[]>();
  for (const v of train) byCuisine.set(v.restaurant.cuisine, [...(byCuisine.get(v.restaurant.cuisine) ?? []), v.stars]);
  const cuisineStats = [...byCuisine.entries()]
    .map(([cuisine, stars]) => ({ cuisine, n: stars.length, mean: mean(stars) }))
    .sort((a, b) => b.n - a.n || a.cuisine.localeCompare(b.cuisine));
  const likedCuisines = cuisineStats
    .filter((c) => c.n >= 3 && c.mean >= Math.max(3.5, overall))
    .slice(0, 2)
    .map((c) => c.cuisine);
  const dislikedCuisines = cuisineStats
    .filter((c) => c.n >= 2 && c.mean <= 2.5 && !likedCuisines.includes(c.cuisine))
    .slice(0, 2)
    .map((c) => c.cuisine);

  // Budget: what they paid where they were at least content.
  const content = train.filter((v) => v.stars >= 3);
  const prices = (content.length >= 5 ? content : train).map((v) => v.restaurant.pricePerPerson);
  const budgetMax = quantile(prices, 0.75);
  const budgetFlex = clamp(quantile(prices, 0.95) - budgetMax, 0, 25);

  // Travel: how far from their own centre they usually go.
  const km = train.map((v) => haversineKm(home, v.restaurant.location));
  const usualKm = quantile(km, 0.75);
  const maxTravelMin = clamp(Math.round(usualKm / KM_PER_MIN), 8, 45);

  // Weights: selectiveness on each dimension, floored so nothing is ignored outright.
  const raw: Record<SoftDim, number> = {
    budget:
      0.1 +
      concentration(
        [1, 2, 3, 4].map((b) => train.filter((v) => v.restaurant.priceLevel === b).length),
        4,
      ),
    travel: 0.1 + (1 - clamp(usualKm / 15, 0, 1)),
    cuisine:
      0.1 +
      concentration(
        CUISINES.map((c) => byCuisine.get(c)?.length ?? 0),
        CUISINES.length,
      ),
  };
  const total = raw.budget + raw.travel + raw.cuisine;
  const weights = { budget: raw.budget / total, travel: raw.travel / total, cuisine: raw.cuisine / total };
  // What matters least goes first.
  const concessionOrder = [...SOFT_DIMS].sort((a, b) => weights[a] - weights[b] || a.localeCompare(b));

  const share = (flag: (r: YelpRestaurant) => boolean) => train.filter((v) => flag(v.restaurant)).length / train.length;
  const dietary: Dietary[] = [];
  if (share((r) => r.vegetarianFriendly) >= 0.6) dietary.push("vegetarian");
  if (share((r) => r.halal) >= 0.6) dietary.push("halal");

  const constraints = mergeConstraints(emptyConstraints(), {
    availableSlots: drawSlots(rng),
    budgetMax,
    budgetFlex,
    maxTravelMin,
    dietary,
    dietaryConfirmed: true,
    likedCuisines,
    dislikedCuisines,
    weights,
    concessionOrder,
  });
  return { userId, home, constraints, trainVisits: train.length, heldOut: test };
}

/** A restaurant as one person meets it: travel measured from `from`. */
export function seenFrom(r: YelpRestaurant, from: LatLng): Restaurant {
  return {
    id: r.id,
    name: r.name,
    cuisine: r.cuisine,
    pricePerPerson: r.pricePerPerson,
    travelMin: travelMinutes(from, r.location),
    spicy: r.spicy,
    vegetarianFriendly: r.vegetarianFriendly,
    seafoodHeavy: r.seafoodHeavy,
    halal: r.halal,
    open: r.open,
  };
}

export type Validation = {
  personas: number;
  heldOutVisits: number;
  /** Share of held-out places the persona's hard rules allow, against the same for random places in the city. */
  hardPassVisited: number;
  hardPassRandom: number;
  /** P(utility of a place they later went to > utility of a random place). 0.5 = the persona knows nothing. */
  aucVisitedVsRandom: number;
  /** P(utility of a later 4-5 star place > utility of a later 1-2 star place), within a person. */
  aucLikedVsDisliked: number | null;
  likedDislikedPairs: number;
};

/**
 * Does a persona built from earlier reviews say anything about later ones?
 * Time is left out of the check (every slot open, everyone free) because
 * availability is not something the reviews carry.
 */
export function validate(personas: readonly Persona[], city: readonly YelpRestaurant[], rng: Rng): Validation {
  const anySlot: Slot = "sat_dinner";
  let visits = 0;
  let passVisited = 0;
  let passRandom = 0;
  let wins = 0;
  let pairWins = 0;
  let pairs = 0;
  for (const p of personas) {
    const prefs = compile({ ...p.constraints, availableSlots: [...SLOTS] });
    const score = (r: YelpRestaurant) => utility(prefs, { ...seenFrom(r, p.home), open: [...SLOTS] }, anySlot);
    const scored = p.heldOut.map((v) => ({ stars: v.stars, u: score(v.restaurant) }));
    for (const s of scored) {
      const other = score(rng.pick(city));
      visits++;
      if (s.u.violated === null) passVisited++;
      if (other.violated === null) passRandom++;
      wins += s.u.value > other.value ? 1 : s.u.value === other.value ? 0.5 : 0;
    }
    for (const liked of scored.filter((s) => s.stars >= 4))
      for (const disliked of scored.filter((s) => s.stars <= 2)) {
        pairs++;
        pairWins += liked.u.value > disliked.u.value ? 1 : liked.u.value === disliked.u.value ? 0.5 : 0;
      }
  }
  return {
    personas: personas.length,
    heldOutVisits: visits,
    hardPassVisited: visits ? passVisited / visits : 0,
    hardPassRandom: visits ? passRandom / visits : 0,
    aucVisitedVsRandom: visits ? wins / visits : 0,
    aucLikedVsDisliked: pairs ? pairWins / pairs : null,
    likedDislikedPairs: pairs,
  };
}
