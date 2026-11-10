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

/**
 * Follow-up questions, as stored in probesAsked / pending. The two trade-off questions are no longer
 * asked (#48: people found them redundant) but stay in the enum so chats saved before that still parse.
 */
export const PROBES = [
  "cuisine",
  "start_point",
  "tradeoff_budget_travel",
  "tradeoff_cuisine_travel",
  "concession",
] as const;
export type Probe = (typeof PROBES)[number];
/** The follow-ups actually asked once the essentials are known, in order. */
export const ASKED_PROBES: readonly Probe[] = ["cuisine", "start_point", "concession"];
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
  /** They said they don't mind what it costs. An answer, not a gap: budget is settled with no ceiling. */
  budgetNoLimit: z.boolean().default(false),
  /** "At least $50 a person": they would rather not go cheaper. A preference, never a hard rule. */
  budgetMin: z.number().int().positive().nullable().default(null),
  /** How many dollars over budgetMax is "a stretch, but OK". */
  budgetFlex: z.number().int().min(0),
  /** null = not answered yet. */
  availableSlots: z.array(z.enum(SLOTS)).nullable(),
  dietary: z.array(z.enum(DIETARY)),
  /**
   * What they said they avoid, in their own words ("clams and crabs, anything with shells").
   * Kept so nothing they tell us is dropped and shown back to them; the negotiation only
   * filters on the `dietary` flags, because restaurants carry no finer data than that.
   */
  avoidNotes: z.array(z.string().trim().min(1).max(160)).max(10).default([]),
  /** True once the user has answered the dietary question, even with "none". */
  dietaryConfirmed: z.boolean(),
  /** Max one-way travel time in minutes. */
  maxTravelMin: z.number().int().positive().nullable(),
  /** They said they don't mind how far it is: distance is settled with no ceiling. */
  travelNoLimit: z.boolean().default(false),
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
  // An update says only what changed. The stored schema's defaults must not leak into it: a field
  // the message never mentioned would otherwise arrive as "false" or "null" and wipe what was recorded.
  budgetNoLimit: z.boolean().optional(),
  budgetMin: z.number().int().positive().nullable().optional(),
  travelNoLimit: z.boolean().optional(),
  avoidNotes: z.array(z.string().trim().min(1).max(160)).max(10).optional(),
  startPoint: StartPointSchema.nullable().optional(),
  concessionOrder: z.array(z.enum(SOFT_DIMS)).nullable().optional(),
  probesAsked: z.array(z.enum(PROBES)).optional(),
  pending: z.enum(PENDING).nullable().optional(),
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
    budgetNoLimit: false,
    budgetMin: null,
    budgetFlex: 0,
    availableSlots: null,
    dietary: [],
    avoidNotes: [],
    dietaryConfirmed: false,
    maxTravelMin: null,
    travelNoLimit: false,
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
  // "No limit" and a number are two answers to the same question: the later one replaces the earlier.
  if (update.budgetNoLimit !== undefined) next.budgetNoLimit = update.budgetNoLimit;
  if (update.budgetNoLimit === true) {
    next.budgetMax = null;
    next.budgetFlex = 0;
  }
  if (update.budgetMax !== undefined) next.budgetMax = update.budgetMax;
  if (typeof update.budgetMax === "number") next.budgetNoLimit = false;
  if (update.budgetFlex !== undefined) next.budgetFlex = update.budgetFlex;
  if (update.budgetMin !== undefined) next.budgetMin = update.budgetMin;
  // A floor above the ceiling cannot both hold; keep whichever this message stated.
  if (next.budgetMin !== null && next.budgetMax !== null && next.budgetMin > next.budgetMax + next.budgetFlex) {
    if (typeof update.budgetMin === "number") {
      next.budgetMax = null;
      next.budgetFlex = 0;
    } else next.budgetMin = null;
  }
  if (update.availableSlots !== undefined) {
    next.availableSlots = update.availableSlots === null ? null : uniq(update.availableSlots);
  }
  if (update.travelNoLimit !== undefined) next.travelNoLimit = update.travelNoLimit;
  if (update.travelNoLimit === true) next.maxTravelMin = null;
  if (update.maxTravelMin !== undefined) next.maxTravelMin = update.maxTravelMin;
  if (typeof update.maxTravelMin === "number") next.travelNoLimit = false;
  if (update.startPoint !== undefined) next.startPoint = update.startPoint;
  // Unresolved text carries no coordinates, so it changes nothing; only an explicit null clears.
  if (update.startText === null) next.startPoint = null;
  if (update.dietary !== undefined) {
    next.dietary = uniq([...base.dietary, ...update.dietary]);
    next.dietaryConfirmed = true;
  }
  if (update.avoidNotes !== undefined) {
    next.avoidNotes = uniq([...base.avoidNotes, ...update.avoidNotes]).slice(-10);
    if (update.avoidNotes.length) next.dietaryConfirmed = true;
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

/**
 * The range each number an extractor records must fall in. The schema above
 * only says "a positive integer"; these say what is plausible for a meal, so a
 * typo, a hallucination or a deliberate "$1,000,000" cannot become someone's
 * constraint. Weights are relative importances and are normalised later, so
 * anything outside 0..1 is noise.
 */
export const UPDATE_LIMITS = {
  budgetMax: { min: 1, max: 500 },
  budgetMin: { min: 1, max: 500 },
  budgetFlex: { min: 0, max: 200 },
  maxTravelMin: { min: 1, max: 180 },
  weight: { min: 0, max: 1 },
} as const;

export type LimitedField = "budgetMax" | "budgetMin" | "budgetFlex" | "maxTravelMin" | "weights";

const outside = (x: number, { min, max }: { min: number; max: number }) => !Number.isFinite(x) || x < min || x > max;

/**
 * Drop the out-of-range numbers from an extractor's update and say which were
 * dropped. Everything else in the update is kept, so one bad number does not
 * cost the person the rest of what they said.
 */
export function withinLimits(update: ConstraintsUpdate): { update: ConstraintsUpdate; dropped: LimitedField[] } {
  const dropped: LimitedField[] = [];
  for (const field of ["budgetMax", "budgetMin", "budgetFlex", "maxTravelMin"] as const) {
    const value = update[field];
    if (typeof value === "number" && outside(value, UPDATE_LIMITS[field])) dropped.push(field);
  }
  const weights = Object.values(update.weights ?? {});
  if (weights.some((w) => typeof w === "number" && outside(w, UPDATE_LIMITS.weight))) dropped.push("weights");
  if (dropped.length === 0) return { update, dropped };
  const kept = Object.fromEntries(Object.entries(update).filter(([key]) => !dropped.includes(key as LimitedField)));
  return { update: kept as ConstraintsUpdate, dropped };
}

export type MissingField = "time" | "budget" | "distance" | "diet";

/** Hard constraints we must have before the user counts as "ready". */
export function missingFields(c: Constraints): MissingField[] {
  const missing: MissingField[] = [];
  if (!c.availableSlots || c.availableSlots.length === 0) missing.push("time");
  // "I don't mind" and "at least $50" both answer the budget question; neither leaves a ceiling.
  if (c.budgetMax === null && !c.budgetNoLimit && c.budgetMin === null) missing.push("budget");
  if (c.maxTravelMin === null && !c.travelNoLimit) missing.push("distance");
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
  else if (c.budgetNoLimit || c.budgetMin !== null) lines.push("Budget: no limit");
  if (c.budgetMin !== null) lines.push(`Would rather spend at least $${c.budgetMin}/person`);
  if (c.maxTravelMin !== null) lines.push(`Travel: up to ${c.maxTravelMin} min`);
  else if (c.travelNoLimit) lines.push("Travel: any distance");
  if (c.startPoint) lines.push(`Coming from: ${c.startPoint.label}`);
  if (c.dietaryConfirmed) {
    const diet = c.dietary.length
      ? c.dietary.map((d) => DIETARY_LABELS[d]).join(", ")
      : c.avoidNotes.length
        ? "see below"
        : "no restrictions";
    lines.push(`Diet: ${diet}`);
  }
  if (c.avoidNotes.length) lines.push(`Avoids: ${c.avoidNotes.join("; ")}`);
  if (c.likedCuisines.length) lines.push(`Would like: ${c.likedCuisines.join(", ")}`);
  else if (!c.dislikedCuisines.length && c.probesAsked.includes("cuisine") && c.pending !== "cuisine")
    lines.push("Cuisine: no preference");
  if (c.dislikedCuisines.length) lines.push(`Rather not: ${c.dislikedCuisines.join(", ")}`);
  if ((Object.keys(DEFAULT_WEIGHTS) as SoftDim[]).some((d) => c.weights[d] !== DEFAULT_WEIGHTS[d])) {
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
  return remainingProbes(c, context)[0] ?? null;
}

/**
 * The optional questions not yet asked, in order. Cuisine is skipped once they have named any, and
 * the start point when the plan can't use it or they already said.
 */
export function remainingProbes(c: Constraints, context: ProbeContext = {}): Probe[] {
  const skip = (p: Probe) =>
    (p === "cuisine" && (c.likedCuisines.length > 0 || c.dislikedCuisines.length > 0)) ||
    (p === "start_point" && (!context.askStart || c.startPoint !== null));
  return ASKED_PROBES.filter((p) => !c.probesAsked.includes(p) && !skip(p));
}
