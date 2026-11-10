import { z } from "zod";
import {
  CUISINES,
  DEFAULT_CONCESSION_ORDER,
  DIETARY,
  SLOTS,
  SOFT_DIMS,
  UPDATE_LIMITS,
  type Constraints,
  type SoftDim,
} from "./constraints";

/**
 * A person's preferences as the negotiation sees them: a private JSON that
 * only their own assistant (evaluate.ts) ever reads.
 *
 *   hard             violate one → reject, full stop
 *   soft             each gives a 0..1 satisfaction; weighted mean = utility
 *   concession_order what the person is willing to loosen first, in order
 *
 * This is the contract between elicitation (which writes it, via compile())
 * and evaluation (which reads it). Nothing else should touch it.
 */

export const HardRuleSchema = z.discriminatedUnion("dim", [
  z.object({ dim: z.literal("time"), op: z.literal("in"), val: z.array(z.enum(SLOTS)) }),
  z.object({ dim: z.literal("price"), op: z.literal("<="), val: z.number().positive() }),
  z.object({ dim: z.literal("distance"), op: z.literal("<="), val: z.number().positive() }),
  z.object({ dim: z.literal("diet"), op: z.literal("requires"), val: z.array(z.enum(DIETARY)) }),
]);
export type HardRule = z.infer<typeof HardRuleSchema>;

export const SoftRuleSchema = z.discriminatedUnion("dim", [
  /**
   * 1 at or below `ideal`, falling linearly to 0 at `ideal + tolerance`. With a `floor` ("at least
   * $50 a person") also 1 at or above it, falling to 0 at half of it: cheaper is worse, never ruled out.
   */
  z.object({
    dim: z.literal("price"),
    ideal: z.number().positive(),
    tolerance: z.number().min(0),
    floor: z.number().positive().optional(),
    weight: z.number().min(0),
  }),
  z.object({
    dim: z.literal("distance"),
    ideal: z.number().positive(),
    tolerance: z.number().min(0),
    weight: z.number().min(0),
  }),
  /** 1 for a preferred cuisine, `avoidScore` for an avoided one, neutral otherwise. */
  z.object({
    dim: z.literal("cuisine"),
    prefer: z.array(z.enum(CUISINES)),
    avoid: z.array(z.enum(CUISINES)),
    avoidScore: z.number().min(0).max(1),
    weight: z.number().min(0),
  }),
]);
export type SoftRule = z.infer<typeof SoftRuleSchema>;

export const PreferencesSchema = z.object({
  hard: z.array(HardRuleSchema),
  soft: z.array(SoftRuleSchema),
  concession_order: z.array(z.enum(SOFT_DIMS)),
});
export type Preferences = z.infer<typeof PreferencesSchema>;

/** Soft-dim names as they appear inside Preferences (distance, not travel). */
export const SOFT_DIM_TO_RULE: Record<SoftDim, SoftRule["dim"]> = {
  budget: "price",
  travel: "distance",
  cuisine: "cuisine",
};

/** A cuisine nobody mentioned is not a problem, just not a treat. */
export const NEUTRAL_CUISINE = 0.85;
/** Minutes past the stated max that still count as "a stretch, but OK". */
export const TRAVEL_GRACE_MIN = 10;
/** How much a conceded dimension loosens per step. */
export const CONCESSION_FACTOR = 1.5;

/** Turn what the private chat collected into the negotiation contract. */
export function compile(c: Constraints): Preferences {
  const hard: HardRule[] = [];
  const soft: SoftRule[] = [];

  if (c.availableSlots && c.availableSlots.length) hard.push({ dim: "time", op: "in", val: c.availableSlots });
  if (c.dietary.length) hard.push({ dim: "diet", op: "requires", val: c.dietary });
  // "No limit" writes no price rule at all: this person's assistant never objects on price.
  if (c.budgetMax !== null) hard.push({ dim: "price", op: "<=", val: c.budgetMax + c.budgetFlex });
  if (c.budgetMax !== null || c.budgetMin !== null) {
    soft.push({
      dim: "price",
      // No ceiling of their own: every price we could have recorded is at or below this.
      ideal: c.budgetMax ?? UPDATE_LIMITS.budgetMax.max,
      tolerance: c.budgetMax !== null ? c.budgetFlex : 0,
      ...(c.budgetMin !== null ? { floor: c.budgetMin } : {}),
      weight: c.weights.budget,
    });
  }
  if (c.maxTravelMin !== null) {
    hard.push({ dim: "distance", op: "<=", val: c.maxTravelMin + TRAVEL_GRACE_MIN });
    soft.push({ dim: "distance", ideal: c.maxTravelMin, tolerance: TRAVEL_GRACE_MIN, weight: c.weights.travel });
  }
  soft.push({
    dim: "cuisine",
    prefer: c.likedCuisines,
    avoid: c.dislikedCuisines,
    avoidScore: 0,
    weight: c.weights.cuisine,
  });

  const order = c.concessionOrder && c.concessionOrder.length ? c.concessionOrder : DEFAULT_CONCESSION_ORDER;
  const concession_order = [...order, ...DEFAULT_CONCESSION_ORDER.filter((d) => !order.includes(d))];
  return PreferencesSchema.parse({ hard, soft, concession_order });
}

/**
 * Concede `level` steps: loosen the first `level` dimensions of the
 * concession order. Only soft rules move; hard rules never do, so a
 * concession can turn "reluctant" into "accept" but never "reject" into
 * anything else. Pure: returns a new object.
 */
export function relax(p: Preferences, level: number): Preferences {
  if (level <= 0) return p;
  const loosened = new Set(p.concession_order.slice(0, level).map((d) => SOFT_DIM_TO_RULE[d]));
  const factor = CONCESSION_FACTOR;
  return {
    ...p,
    soft: p.soft.map((s) => {
      if (!loosened.has(s.dim)) return s;
      if (s.dim === "cuisine")
        return { ...s, avoidScore: Math.max(s.avoidScore, 1 - 1 / factor), weight: s.weight / factor };
      // A zero tolerance has nothing to multiply: open a small band instead.
      const tolerance = s.tolerance > 0 ? s.tolerance * factor : s.ideal * 0.1;
      // Conceding on budget also means accepting somewhere cheaper than they hoped.
      if (s.dim === "price" && s.floor !== undefined) return { ...s, tolerance, floor: s.floor / factor };
      return { ...s, tolerance };
    }),
  };
}
