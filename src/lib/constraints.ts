import { z } from "zod";

/**
 * The constraint schema for the "plan a meal" scenario.
 * This is the contract between the private-chat extractor (writes it)
 * and the negotiation engine (reads it via each member's assistant).
 */

export const SLOTS = ["fri_dinner", "sat_lunch", "sat_dinner", "sun_lunch", "sun_dinner"] as const;
export type Slot = (typeof SLOTS)[number];

export const SLOT_LABELS: Record<Slot, string> = {
  fri_dinner: "Fri dinner",
  sat_lunch: "Sat lunch",
  sat_dinner: "Sat dinner",
  sun_lunch: "Sun lunch",
  sun_dinner: "Sun dinner",
};

export const DIETARY = ["no_spicy", "vegetarian", "no_seafood", "halal"] as const;
export type Dietary = (typeof DIETARY)[number];

export const DIETARY_LABELS: Record<Dietary, string> = {
  no_spicy: "No spicy food",
  vegetarian: "Vegetarian",
  no_seafood: "No seafood",
  halal: "Halal",
};

export const CUISINES = [
  "japanese",
  "chinese",
  "korean",
  "thai",
  "vietnamese",
  "indian",
  "mexican",
  "italian",
  "american",
  "mediterranean",
] as const;
export type Cuisine = (typeof CUISINES)[number];

export const ConstraintsSchema = z.object({
  /** Hard ceiling, in dollars per person. */
  budgetMax: z.number().int().positive().nullable(),
  /** How many dollars over budgetMax is "a stretch, but OK". */
  budgetFlex: z.number().int().min(0),
  /** null = not answered yet. */
  availableSlots: z.array(z.enum(SLOTS)).nullable(),
  dietary: z.array(z.enum(DIETARY)),
  /** True once the user has answered the dietary question, even with "none". */
  dietaryConfirmed: z.boolean(),
  /** Max one-way travel time in minutes. */
  maxTravelMin: z.number().int().positive().nullable(),
  likedCuisines: z.array(z.enum(CUISINES)),
  dislikedCuisines: z.array(z.enum(CUISINES)),
});
export type Constraints = z.infer<typeof ConstraintsSchema>;

export const ConstraintsUpdateSchema = ConstraintsSchema.partial();
export type ConstraintsUpdate = z.infer<typeof ConstraintsUpdateSchema>;

export function emptyConstraints(): Constraints {
  return {
    budgetMax: null,
    budgetFlex: 0,
    availableSlots: null,
    dietary: [],
    dietaryConfirmed: false,
    maxTravelMin: null,
    likedCuisines: [],
    dislikedCuisines: [],
  };
}

const uniq = <T,>(xs: T[]) => Array.from(new Set(xs));

/** Apply an update from the extractor. Scalars overwrite; dietary needs accumulate. */
export function mergeConstraints(base: Constraints, update: ConstraintsUpdate): Constraints {
  const next: Constraints = { ...base };
  if (update.budgetMax !== undefined) next.budgetMax = update.budgetMax;
  if (update.budgetFlex !== undefined) next.budgetFlex = update.budgetFlex;
  if (update.availableSlots !== undefined) {
    next.availableSlots = update.availableSlots === null ? null : uniq(update.availableSlots);
  }
  if (update.maxTravelMin !== undefined) next.maxTravelMin = update.maxTravelMin;
  if (update.dietary !== undefined) {
    next.dietary = uniq([...base.dietary, ...update.dietary]);
    next.dietaryConfirmed = true;
  }
  if (update.dietaryConfirmed !== undefined) next.dietaryConfirmed = next.dietaryConfirmed || update.dietaryConfirmed;
  if (update.likedCuisines !== undefined) {
    next.likedCuisines = uniq([...base.likedCuisines, ...update.likedCuisines]);
    next.dislikedCuisines = next.dislikedCuisines.filter((c) => !update.likedCuisines!.includes(c));
  }
  if (update.dislikedCuisines !== undefined) {
    next.dislikedCuisines = uniq([...next.dislikedCuisines, ...update.dislikedCuisines]);
    next.likedCuisines = next.likedCuisines.filter((c) => !update.dislikedCuisines!.includes(c));
  }
  return ConstraintsSchema.parse(next);
}

export type MissingField = "time" | "budget" | "distance" | "diet";

/** Hard constraints we must have before the user counts as "ready". */
export function missingFields(c: Constraints): MissingField[] {
  const missing: MissingField[] = [];
  if (!c.availableSlots || c.availableSlots.length === 0) missing.push("time");
  if (c.budgetMax === null) missing.push("budget");
  if (c.maxTravelMin === null) missing.push("distance");
  if (!c.dietaryConfirmed) missing.push("diet");
  return missing;
}

/** Human-readable summary, shown ONLY to the owner of these constraints. */
export function describeConstraints(c: Constraints): string[] {
  const lines: string[] = [];
  if (c.availableSlots) lines.push(`Free: ${c.availableSlots.map((s) => SLOT_LABELS[s]).join(", ") || "nothing yet"}`);
  if (c.budgetMax !== null)
    lines.push(`Budget: up to $${c.budgetMax}/person${c.budgetFlex ? ` (can stretch to $${c.budgetMax + c.budgetFlex})` : ""}`);
  if (c.maxTravelMin !== null) lines.push(`Travel: up to ${c.maxTravelMin} min`);
  if (c.dietaryConfirmed)
    lines.push(`Diet: ${c.dietary.length ? c.dietary.map((d) => DIETARY_LABELS[d]).join(", ") : "no restrictions"}`);
  if (c.likedCuisines.length) lines.push(`Would like: ${c.likedCuisines.join(", ")}`);
  if (c.dislikedCuisines.length) lines.push(`Rather not: ${c.dislikedCuisines.join(", ")}`);
  return lines;
}
