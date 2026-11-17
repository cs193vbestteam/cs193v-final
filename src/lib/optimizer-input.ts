import { z } from "zod";

/**
 * What the optimizer is given (issue #82): the plan, each person's preferences as the
 * private assistant extracted them, and the candidate restaurants built from Google Places.
 *
 * This file is only the format and its rules. Nothing here talks to a model, and the
 * numbers behind "strong" and "mild" belong to the optimizer, not to this file.
 *
 * Reading a person's preferences:
 *   - A missing field means the person has no constraint on it.
 *   - `must` turns the wanted part of a block into a filter. `strong` and `mild` only rank.
 *   - `time.unavailable`, `dietary`, `cuisine.excluded`, `style.excluded` and
 *     `excludedRestaurants` always filter, whatever the strength.
 */

export const STRENGTHS = ["must", "strong", "mild"] as const;
export type Strength = (typeof STRENGTHS)[number];

/** Diets we can check against Google Places. Anything else a person says goes to `notes`. */
export const DIETARY_NEEDS = ["vegetarian", "vegan", "halal"] as const;
export type DietaryNeed = (typeof DIETARY_NEEDS)[number];

/** The kind of place, derived by code from Google types. Independent of cuisine. */
export const STYLES = ["fast_food", "casual", "fine_dining", "cafe", "bar"] as const;
export type Style = (typeof STYLES)[number];

export const PRIORITY_DIMS = ["time", "budget", "travel", "cuisine", "style"] as const;
export type PriorityDim = (typeof PRIORITY_DIMS)[number];

/** A meal can start on the hour, from 10:00 to 23:00, on the plan's date. */
export const START_TIMES = [
  "10:00",
  "11:00",
  "12:00",
  "13:00",
  "14:00",
  "15:00",
  "16:00",
  "17:00",
  "18:00",
  "19:00",
  "20:00",
  "21:00",
  "22:00",
  "23:00",
] as const;
export type StartTime = (typeof START_TIMES)[number];

/** Used when nobody in the group says anything about time. */
export const DEFAULT_START_TIME: StartTime = "18:00";

export const MEALS = ["brunch", "lunch", "afternoon_tea", "dinner", "late_night"] as const;
export type Meal = (typeof MEALS)[number];

/** A range of start times, both ends included. */
export type TimeRange = { from: StartTime; to: StartTime };

/** What a meal word means in start times. Decided here, never by the model. */
export const MEAL_RANGES: Record<Meal, TimeRange> = {
  brunch: { from: "10:00", to: "11:00" },
  lunch: { from: "11:00", to: "13:00" },
  afternoon_tea: { from: "14:00", to: "16:00" },
  dinner: { from: "17:00", to: "20:00" },
  late_night: { from: "21:00", to: "23:00" },
};

export const LIMITS = {
  noteChars: 200,
  notes: 10,
  nameChars: 100,
  namedRestaurants: 5,
  // Room for every cuisine the table has (cuisine-table.ts): "Asian or Western" is 36 of them.
  // Dishes rarely add to it, because a dish scored like its cuisine is not stored (compactScores).
  cuisines: 64,
  maxBudget: 1000,
  maxTravelMin: 180,
} as const;

/** Every start time inside a range, both ends included. */
export function startTimesIn(range: TimeRange): StartTime[] {
  const from = START_TIMES.indexOf(range.from);
  const to = START_TIMES.indexOf(range.to);
  return START_TIMES.slice(from, to + 1);
}

export function mealStartTimes(meal: Meal): StartTime[] {
  return startTimesIn(MEAL_RANGES[meal]);
}

/**
 * Weights from the order a person gave. Three named dimensions score 3, 2, 1; a dimension
 * the person did not name scores 1, the same as the last one they did. No order at all
 * means equal weights. The result sums to 1.
 */
export function priorityWeights(priority: readonly PriorityDim[] = []): Record<PriorityDim, number> {
  const points = PRIORITY_DIMS.map((dim) => {
    const rank = priority.indexOf(dim);
    return rank === -1 ? 1 : priority.length - rank;
  });
  const total = points.reduce((a, b) => a + b, 0);
  return Object.fromEntries(PRIORITY_DIMS.map((dim, i) => [dim, points[i]! / total])) as Record<PriorityDim, number>;
}

// ---------------------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------------------

const hasDuplicates = (xs: readonly string[]) => new Set(xs).size !== xs.length;
const overlap = (a: readonly string[], b: readonly string[]) => a.filter((x) => b.includes(x));

const StrengthSchema = z.enum(STRENGTHS).default("mild");
const StartTimeSchema = z.enum(START_TIMES);

const TimeRangeSchema = z
  .strictObject({ from: StartTimeSchema, to: StartTimeSchema })
  .refine((r) => r.from <= r.to, { message: "a time range must not end before it starts" });

/** A Google Places type name, such as `korean_restaurant`. Only the shape is checked here. */
const PlaceTypeSchema = z.string().regex(/^[a-z][a-z0-9_]{1,49}$/, "expected a Google Places type name");

const uniqueList = <T extends z.ZodType<string>>(item: T, max: number) =>
  z
    .array(item)
    .max(max)
    .refine((xs) => !hasDuplicates(xs), { message: "must not repeat a value" });

const TimeSchema = z
  .strictObject({
    unavailable: z.array(TimeRangeSchema).max(START_TIMES.length).optional(),
    preferred: z.array(TimeRangeSchema).max(START_TIMES.length).optional(),
    strength: StrengthSchema,
  })
  .superRefine((t, ctx) => {
    const blocked = (t.unavailable ?? []).flatMap(startTimesIn);
    const wanted = (t.preferred ?? []).flatMap(startTimesIn);
    const both = overlap(wanted, blocked);
    if (both.length > 0) {
      ctx.addIssue({ code: "custom", message: `preferred and unavailable both include ${both[0]}` });
    }
  });

const BudgetSchema = z
  .strictObject({
    ideal: z.number().positive().max(LIMITS.maxBudget).optional(),
    max: z.number().positive().max(LIMITS.maxBudget).optional(),
    strength: StrengthSchema,
  })
  .superRefine((b, ctx) => {
    if (b.ideal === undefined && b.max === undefined) {
      ctx.addIssue({ code: "custom", message: "budget needs an ideal or a max; leave budget out for no constraint" });
    }
    if (b.ideal !== undefined && b.max !== undefined && b.ideal > b.max) {
      ctx.addIssue({ code: "custom", message: "budget ideal must not be above max" });
    }
    if (b.strength === "must" && b.max === undefined) {
      ctx.addIssue({ code: "custom", message: "a must budget needs a max" });
    }
  });

const travelMinutes = z.number().int().positive().max(LIMITS.maxTravelMin);

const TravelSchema = z
  .strictObject({ idealMin: travelMinutes.optional(), maxMin: travelMinutes.optional(), strength: StrengthSchema })
  .superRefine((t, ctx) => {
    if (t.idealMin === undefined && t.maxMin === undefined) {
      ctx.addIssue({ code: "custom", message: "travel needs an ideal or a max; leave travel out for no constraint" });
    }
    if (t.idealMin !== undefined && t.maxMin !== undefined && t.idealMin > t.maxMin) {
      ctx.addIssue({ code: "custom", message: "travel ideal must not be above max" });
    }
    if (t.strength === "must" && t.maxMin === undefined) {
      ctx.addIssue({ code: "custom", message: "a must travel limit needs a max" });
    }
  });

const CuisineSchema = z
  .strictObject({
    scores: z.record(PlaceTypeSchema, z.number().gt(0).max(1)).optional(),
    excluded: uniqueList(PlaceTypeSchema, LIMITS.cuisines).optional(),
    strength: StrengthSchema,
  })
  .superRefine((c, ctx) => {
    const scored = Object.keys(c.scores ?? {});
    if (scored.length > LIMITS.cuisines) {
      ctx.addIssue({ code: "custom", message: `at most ${LIMITS.cuisines} cuisines can be scored` });
    }
    const both = overlap(scored, c.excluded ?? []);
    if (both.length > 0) ctx.addIssue({ code: "custom", message: `${both[0]} is both wanted and excluded` });
  });

const StyleSchema = z
  .strictObject({
    wanted: uniqueList(z.enum(STYLES), STYLES.length).optional(),
    excluded: uniqueList(z.enum(STYLES), STYLES.length).optional(),
    strength: StrengthSchema,
  })
  .superRefine((s, ctx) => {
    const both = overlap(s.wanted ?? [], s.excluded ?? []);
    if (both.length > 0) ctx.addIssue({ code: "custom", message: `${both[0]} is both wanted and excluded` });
  });

/** The name as the person typed it, and the candidate it was matched to by code (or null). */
const NamedRestaurantSchema = z.strictObject({
  name: z.string().trim().min(1).max(LIMITS.nameChars),
  id: z.string().min(1).nullable(),
});
export type NamedRestaurant = z.infer<typeof NamedRestaurantSchema>;

const NoteSchema = z.strictObject({
  type: z.enum(["allergy", "other"]),
  text: z.string().trim().min(1).max(LIMITS.noteChars),
});

const restaurantKey = (r: NamedRestaurant) => r.id ?? `name:${r.name.toLowerCase()}`;

export const PersonPreferencesSchema = z
  .strictObject({
    version: z.literal(1),
    time: TimeSchema.optional(),
    budget: BudgetSchema.optional(),
    travel: TravelSchema.optional(),
    dietary: uniqueList(z.enum(DIETARY_NEEDS), DIETARY_NEEDS.length).optional(),
    cuisine: CuisineSchema.optional(),
    style: StyleSchema.optional(),
    priority: uniqueList(z.enum(PRIORITY_DIMS), PRIORITY_DIMS.length).optional(),
    wantedRestaurants: z.array(NamedRestaurantSchema).max(LIMITS.namedRestaurants).optional(),
    excludedRestaurants: z.array(NamedRestaurantSchema).max(LIMITS.namedRestaurants).optional(),
    notes: z.array(NoteSchema).max(LIMITS.notes).optional(),
  })
  .superRefine((p, ctx) => {
    const wanted = (p.wantedRestaurants ?? []).map(restaurantKey);
    const excluded = (p.excludedRestaurants ?? []).map(restaurantKey);
    if (overlap(wanted, excluded).length > 0) {
      ctx.addIssue({ code: "custom", message: "a restaurant is both wanted and excluded" });
    }
  });
export type PersonPreferences = z.infer<typeof PersonPreferencesSchema>;

const isRealDate = (s: string) => {
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

export const PlanSchema = z.strictObject({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD")
    .refine(isRealDate, { message: "not a real date" }),
  startTimes: uniqueList(StartTimeSchema, START_TIMES.length).refine((xs) => xs.length > 0, {
    message: "a plan needs at least one start time",
  }),
  anchor: z.strictObject({
    label: z.string().trim().min(1).max(LIMITS.nameChars),
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
  }),
});
export type Plan = z.infer<typeof PlanSchema>;

/**
 * A candidate restaurant. `price`, `servesVegetarian` and `openAt` are null when Google
 * does not say. `travelMin` is keyed by person and is all the optimizer learns about
 * where anyone starts from. `primaryType` is the one of `types` Google calls the place's
 * main one; it is left out when Google names none, and for pools stored before it was kept.
 */
export const CandidateRestaurantSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
  types: z.array(PlaceTypeSchema),
  primaryType: PlaceTypeSchema.optional(),
  style: uniqueList(z.enum(STYLES), STYLES.length),
  price: z
    .strictObject({ low: z.number().nonnegative(), high: z.number().nonnegative() })
    .refine((p) => p.low <= p.high, { message: "price low must not be above high" })
    .nullable(),
  servesVegetarian: z.boolean().nullable(),
  openAt: uniqueList(StartTimeSchema, START_TIMES.length).nullable(),
  travelMin: z.record(z.string().min(1), z.number().nonnegative()),
});
export type CandidateRestaurant = z.infer<typeof CandidateRestaurantSchema>;

/** A restaurant with no known opening hours is never chosen: it might be closed. */
export function isSelectable(r: CandidateRestaurant): boolean {
  return r.openAt !== null && r.openAt.length > 0;
}
