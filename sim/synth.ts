import {
  CUISINES,
  DIETARY,
  SOFT_DIMS,
  emptyConstraints,
  mergeConstraints,
  type Constraints,
  type Cuisine,
  type Dietary,
  type Slot,
  type SoftDim,
} from "../src/lib/constraints";
import type { Restaurant } from "../src/lib/restaurants";
import type { Rng } from "./rng";

/**
 * Synthetic restaurants and people. Everything is drawn from `rng`, so a
 * seed fully determines a scenario. The distributions are tuned so that
 * conflicts are common but most groups still have at least one plan that
 * works for everyone (see sim/README.md for the measured rate).
 */

/**
 * The start times the synthetic world uses. Five of them, as there were five weekend slots
 * when the distributions were tuned, and a place is open for all five, for three of them or
 * for the other two, in the same positions as before. That keeps every scenario, and so every
 * published number, exactly what it was; only the labels changed.
 */
export const SIM_SLOTS: Slot[] = ["12:00", "13:00", "18:00", "19:00", "20:00"];
const ALL: Slot[] = [...SIM_SLOTS];
const THREE_OF_FIVE: Slot[] = [SIM_SLOTS[0], SIM_SLOTS[2], SIM_SLOTS[4]];
const OTHER_TWO: Slot[] = [SIM_SLOTS[1], SIM_SLOTS[3]];

const SPICY_CUISINES: ReadonlySet<Cuisine> = new Set<Cuisine>(["thai", "indian", "korean", "chinese", "mexican"]);
const HALAL_LEANING: ReadonlySet<Cuisine> = new Set<Cuisine>(["mediterranean", "indian"]);

export function synthRestaurants(rng: Rng, n = 30): Restaurant[] {
  const out: Restaurant[] = [];
  for (let i = 1; i <= n; i++) {
    const cuisine = rng.pick(CUISINES);
    // Skew prices towards the affordable end: two draws, take the lower one 60% of the time.
    const p1 = rng.int(12, 70);
    const p2 = rng.int(12, 70);
    const pricePerPerson = rng.chance(0.6) ? Math.min(p1, p2) : p1;
    const travelMin = rng.int(4, 35);
    const openRoll = rng.next();
    const open = openRoll < 0.6 ? ALL : openRoll < 0.85 ? THREE_OF_FIVE : OTHER_TWO;
    out.push({
      id: `r${i}`,
      name: `Restaurant ${i}`,
      cuisine,
      pricePerPerson,
      travelMin,
      spicy: rng.chance(SPICY_CUISINES.has(cuisine) ? 0.55 : 0.08),
      vegetarianFriendly: rng.chance(0.7),
      seafoodHeavy: rng.chance(cuisine === "japanese" ? 0.4 : 0.12),
      halal: rng.chance(HALAL_LEANING.has(cuisine) ? 0.6 : 0.2),
      open: [...open],
    });
  }
  return out;
}

export function synthPerson(rng: Rng): Constraints {
  // Availability: 45% free at any of the times, otherwise 2..4 of the 5.
  const availableSlots: Slot[] = rng.chance(0.45) ? [...SIM_SLOTS] : rng.sample(SIM_SLOTS, rng.int(2, 4));

  const budgetMax = rng.int(18, 65);
  const budgetFlex = rng.int(0, 15);
  const maxTravelMin = rng.int(8, 35);

  // 10-25% of people carry one dietary rule.
  const dietary: Dietary[] = rng.chance(0.18) ? [rng.pick(DIETARY)] : [];

  const cuisinePool = rng.shuffle(CUISINES);
  const nLiked = rng.int(0, 2);
  const nDisliked = rng.int(0, 2);
  const likedCuisines = cuisinePool.slice(0, nLiked);
  const dislikedCuisines = cuisinePool.slice(nLiked, nLiked + nDisliked);

  // Raw weights in [0.1, 1], normalised to sum to 1.
  const raw: Record<SoftDim, number> = { budget: 0, travel: 0, cuisine: 0 };
  let sum = 0;
  for (const d of SOFT_DIMS) {
    raw[d] = 0.1 + rng.next() * 0.9;
    sum += raw[d];
  }
  const weights: Record<SoftDim, number> = {
    budget: raw.budget / sum,
    travel: raw.travel / sum,
    cuisine: raw.cuisine / sum,
  };

  const concessionOrder: SoftDim[] = rng.shuffle(SOFT_DIMS);

  return mergeConstraints(emptyConstraints(), {
    availableSlots,
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
}

/** `size` people (3..6 in the harness, but any positive size works). */
export function synthGroup(rng: Rng, size: number): Constraints[] {
  const out: Constraints[] = [];
  for (let i = 0; i < size; i++) out.push(synthPerson(rng));
  return out;
}
