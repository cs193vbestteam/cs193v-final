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

/** Dimensions a person can trade off or concede. Time and diet are hard-only. */
export const SOFT_DIMS = ["budget", "travel", "cuisine"] as const;
export type SoftDim = (typeof SOFT_DIMS)[number];
export const SOFT_DIM_LABELS: Record<SoftDim, string> = { budget: "budget", travel: "distance", cuisine: "cuisine" };

export const DEFAULT_WEIGHTS: Record<SoftDim, number> = { budget: 0.35, travel: 0.3, cuisine: 0.35 };
export const DEFAULT_CONCESSION_ORDER: SoftDim[] = ["cuisine", "travel", "budget"];

/** Extra questions the assistant asks once the essentials are known. */
export const PROBES = ["start_point", "tradeoff_budget_travel", "tradeoff_cuisine_travel", "concession"] as const;
export type Probe = (typeof PROBES)[number];
/** Questions that need the next answer read in context: a vague-answer follow-up, or a probe. */
export const PENDING = ["vague_budget", "vague_distance", ...PROBES] as const;
export type Pending = (typeof PENDING)[number];

/**
 * Where a person will be travelling from. `label` is what they typed; the
 * coordinates come from geocoding it (start-point.ts), never from the model.
 * Private like every other constraint: only their own assistant reads it.
 */
export const StartPointSchema = z.object({
  label: z.string().min(1).max(120),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});
export type StartPoint = z.infer<typeof StartPointSchema>;

/** What the plan can support, which decides which follow-ups are worth asking. */
export type ProbeContext = {
  /** The plan has candidate coordinates and a geocoder, so a start point can be used. */ askStart?: boolean;
};

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
  /** Their own starting point; null = measure travel from the plan's location. */
  startPoint: StartPointSchema.nullable().default(null),
  likedCuisines: z.array(z.enum(CUISINES)),
  dislikedCuisines: z.array(z.enum(CUISINES)),
  /** Relative importance of each soft dimension (normalised at compile time). */
  weights: z
    .object({ budget: z.number().min(0), travel: z.number().min(0), cuisine: z.number().min(0) })
    .default({ ...DEFAULT_WEIGHTS }),
  /** "If something has to give, what goes first?" null = not asked yet. */
  concessionOrder: z.array(z.enum(SOFT_DIMS)).nullable().default(null),
  /** Follow-up questions already asked, so the assistant never nags twice. */
  probesAsked: z.array(z.enum(PROBES)).default([]),
  /** The question the assistant asked last and is still waiting on. */
  pending: z.enum(PENDING).nullable().default(null),
});
export type Constraints = z.infer<typeof ConstraintsSchema>;

export const ConstraintsUpdateSchema = ConstraintsSchema.partial().extend({
  weights: z
    .object({ budget: z.number().min(0), travel: z.number().min(0), cuisine: z.number().min(0) })
    .partial()
    .optional(),
  /** The place the person named as their start, still as text; null = forget it. Resolved by start-point.ts. */
  startText: z.string().trim().min(2).max(120).nullable().optional(),
});
export type ConstraintsUpdate = z.infer<typeof ConstraintsUpdateSchema>;

export function emptyConstraints(): Constraints {
  return {
    budgetMax: null,
    budgetFlex: 0,
    availableSlots: null,
    dietary: [],
    dietaryConfirmed: false,
    maxTravelMin: null,
    startPoint: null,
    likedCuisines: [],
    dislikedCuisines: [],
    weights: { ...DEFAULT_WEIGHTS },
    concessionOrder: null,
    probesAsked: [],
    pending: null,
  };
}

const uniq = <T>(xs: T[]) => Array.from(new Set(xs));

/** Apply an update from the extractor. Scalars overwrite; dietary needs accumulate. */
export function mergeConstraints(base: Constraints, update: ConstraintsUpdate): Constraints {
  const next: Constraints = { ...base };
  if (update.budgetMax !== undefined) next.budgetMax = update.budgetMax;
  if (update.budgetFlex !== undefined) next.budgetFlex = update.budgetFlex;
  if (update.availableSlots !== undefined) {
    next.availableSlots = update.availableSlots === null ? null : uniq(update.availableSlots);
  }
  if (update.maxTravelMin !== undefined) next.maxTravelMin = update.maxTravelMin;
  if (update.startPoint !== undefined) next.startPoint = update.startPoint;
  // Unresolved text carries no coordinates, so it changes nothing; only an explicit null clears.
  if (update.startText === null) next.startPoint = null;
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
  if (update.weights !== undefined) next.weights = { ...base.weights, ...update.weights };
  if (update.concessionOrder !== undefined) {
    next.concessionOrder = update.concessionOrder === null ? null : uniq(update.concessionOrder);
  }
  if (update.probesAsked !== undefined) next.probesAsked = uniq([...base.probesAsked, ...update.probesAsked]);
  if (update.pending !== undefined) next.pending = update.pending;
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
    lines.push(
      `Budget: up to $${c.budgetMax}/person${c.budgetFlex ? ` (can stretch to $${c.budgetMax + c.budgetFlex})` : ""}`,
    );
  if (c.maxTravelMin !== null) lines.push(`Travel: up to ${c.maxTravelMin} min`);
  if (c.startPoint) lines.push(`Coming from: ${c.startPoint.label}`);
  if (c.dietaryConfirmed)
    lines.push(`Diet: ${c.dietary.length ? c.dietary.map((d) => DIETARY_LABELS[d]).join(", ") : "no restrictions"}`);
  if (c.likedCuisines.length) lines.push(`Would like: ${c.likedCuisines.join(", ")}`);
  if (c.dislikedCuisines.length) lines.push(`Rather not: ${c.dislikedCuisines.join(", ")}`);
  if (c.probesAsked.some((p) => p.startsWith("tradeoff"))) {
    const top = (Object.entries(c.weights) as [SoftDim, number][]).sort((a, b) => b[1] - a[1])[0][0];
    lines.push(`Cares most about: ${SOFT_DIM_LABELS[top]}`);
  }
  if (c.concessionOrder && c.concessionOrder.length) {
    lines.push(`Would give up first: ${c.concessionOrder.map((d) => SOFT_DIM_LABELS[d]).join(", then ")}`);
  }
  return lines;
}

/** The next optional question worth asking once the essentials are in. */
export function nextProbe(c: Constraints, context: ProbeContext = {}): Probe | null {
  if (missingFields(c).length > 0) return null;
  // Asking where someone is coming from is pointless when the plan can't use it, or when they already said.
  const skipStart = !context.askStart || c.startPoint !== null;
  return PROBES.find((p) => !c.probesAsked.includes(p) && !(p === "start_point" && skipStart)) ?? null;
}
