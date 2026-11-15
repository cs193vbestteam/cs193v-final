import { z } from "zod";
import { LEGACY_CUISINE_TYPE } from "./cuisine-table";
import { centroid, travelMinutes, type LatLng } from "./geo";
import {
  CandidateRestaurantSchema,
  PersonPreferencesSchema,
  PlanSchema,
  START_TIMES,
  isSelectable,
  type CandidateRestaurant,
  type PersonPreferences,
} from "./optimizer-input";
import type { Place } from "./restaurants";

/**
 * The handoff between the private chats and the optimizer (#107).
 *
 *   in   OptimizerInput   the plan, everyone's preferences, the candidate restaurants
 *   out  OptimizerResult  the place and start time it chose, and how many people cannot come
 *
 * This file is pure: it turns data it is given into the optimizer's format and checks what
 * comes back. Reading a plan's data out of storage is optimizer-source.ts.
 *
 * What the optimizer does NOT get: names, user ids, chat text, or where anyone starts from.
 * People are `p1`, `p2`, … in the order they joined, and a start point has already been
 * turned into travel minutes by the time the input exists.
 */

/** One person: an id that means nothing outside this input, and what their chat recorded. */
const PersonSchema = z.strictObject({
  id: z.string().regex(/^p[1-9]\d*$/, "expected p1, p2, …"),
  prefs: PersonPreferencesSchema,
});

export const OptimizerInputSchema = z
  .strictObject({
    plan: PlanSchema,
    people: z.array(PersonSchema).min(1),
    candidates: z.array(CandidateRestaurantSchema),
  })
  .superRefine((input, ctx) => {
    const ids = input.people.map((p) => p.id);
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", message: "person ids must be unique" });
    const seen = new Set<string>();
    for (const c of input.candidates) {
      if (seen.has(c.id)) ctx.addIssue({ code: "custom", message: `candidate ${c.id} appears twice` });
      seen.add(c.id);
      const keys = Object.keys(c.travelMin);
      if (keys.length !== ids.length || ids.some((id) => !(id in c.travelMin)))
        ctx.addIssue({ code: "custom", message: `candidate ${c.id} needs travel minutes for exactly the people` });
    }
  });
export type OptimizerInput = z.infer<typeof OptimizerInputSchema>;

/** How many other choices the optimizer may return beside the one it picked. */
export const MAX_ALTERNATIVES = 5;

/** A place and a start time. `cannotCome` is a count and never says who. */
const ChoiceSchema = z.strictObject({
  restaurantId: z.string().min(1),
  startTime: z.enum(START_TIMES),
  cannotCome: z.number().int().min(0),
});
export type Choice = z.infer<typeof ChoiceSchema>;

/** Why nothing was chosen. `no_candidates`: no restaurant can take any start time on the day. */
export const NO_RESULT_REASONS = ["no_candidates"] as const;

/**
 * What the optimizer returns. When no plan suits everyone it still returns the closest one,
 * with `cannotCome` above zero; `restaurantId: null` is only for when there is nothing to pick from.
 */
export const OptimizerResultSchema = z.union([
  ChoiceSchema.extend({ alternatives: z.array(ChoiceSchema).max(MAX_ALTERNATIVES) }),
  z.strictObject({ restaurantId: z.null(), reason: z.enum(NO_RESULT_REASONS) }),
]);
export type OptimizerResult = z.infer<typeof OptimizerResultSchema>;

/**
 * Whether a result is one this input allows: a known restaurant, at a start time of the plan
 * that the restaurant can take, with no more absentees than there are people. Returns what is
 * wrong, in words; an empty list means the result can be shown.
 */
export function checkResult(input: OptimizerInput, result: OptimizerResult): string[] {
  if (result.restaurantId === null) {
    return input.candidates.some(isSelectable) ? ["said there is no candidate, but one can be selected"] : [];
  }
  const problems: string[] = [];
  const check = (c: Choice, what: string) => {
    const r = input.candidates.find((x) => x.id === c.restaurantId);
    if (!r) return problems.push(`${what}: ${c.restaurantId} is not a candidate`);
    if (!input.plan.startTimes.includes(c.startTime))
      problems.push(`${what}: ${c.startTime} is not a start time of the plan`);
    if (!r.openAt?.includes(c.startTime)) problems.push(`${what}: ${r.id} cannot take ${c.startTime}`);
    if (c.cannotCome > input.people.length) problems.push(`${what}: more people cannot come than there are`);
  };
  check(result, "choice");
  result.alternatives.forEach((a, i) => check(a, `alternative ${i + 1}`));
  const key = (c: Choice) => `${c.restaurantId}@${c.startTime}`;
  const all = [result, ...result.alternatives].map(key);
  if (new Set(all).size !== all.length) problems.push("the same place and time appears twice");
  return problems;
}

/** One member as storage holds them: what they said, and where they start from if they said. */
export type HandoffMember = { prefs: PersonPreferences; startPoint: LatLng | null };

/** Where the made-up seed restaurants are measured from: the middle of the Stanford campus. */
export const SEED_ANCHOR = { label: "Stanford campus", lat: 37.4275, lng: -122.1697 };

const TYPE_NAME = /^[a-z][a-z0-9_]{1,49}$/;
const uniq = <T>(xs: readonly T[]) => Array.from(new Set(xs));

/**
 * One restaurant from a plan's pool in the optimizer's format.
 *
 * "Google does not say" stays null and is never turned into a guess: a place with no price is
 * not a $30 place, and a place Google says nothing about for vegetarians is not one that
 * serves none. The seed restaurants are made up, so their values are taken as known.
 */
export function toCandidate(r: Place, travelMin: Record<string, number>): CandidateRestaurant {
  const fromGoogle = r.location !== undefined;
  const price = r.price !== undefined ? r.price : fromGoogle ? null : { low: r.pricePerPerson, high: r.pricePerPerson };
  const servesVegetarian =
    r.servesVegetarian !== undefined
      ? r.servesVegetarian
      : fromGoogle
        ? r.vegetarianFriendly || null
        : r.vegetarianFriendly;
  return {
    id: r.id,
    name: r.name,
    types: uniq(r.types ?? (r.cuisine ? [LEGACY_CUISINE_TYPE[r.cuisine]] : [])).filter((t) => TYPE_NAME.test(t)),
    style: uniq(r.style ?? []),
    price,
    servesVegetarian,
    // The pool stores the start times already worked out for the plan's date (openOn).
    openAt: r.hours || r.open.length ? uniq(r.open) : null,
    travelMin,
  };
}

/**
 * Put a plan's stored pieces together as the optimizer's input.
 *
 * Travel: a person who gave a start point is measured from there to each place; anyone else,
 * and every place without coordinates, uses the pool's own figure, which is from the plan's
 * location. The start point is used here and goes no further.
 */
export function assembleOptimizerInput(parts: {
  date: string;
  location: string | null;
  restaurants: readonly Place[];
  members: readonly HandoffMember[];
}): OptimizerInput {
  const people = parts.members.map((m, i) => ({ id: `p${i + 1}`, prefs: m.prefs }));
  const candidates = parts.restaurants.map((r) => {
    const travel: Record<string, number> = {};
    parts.members.forEach((m, i) => {
      travel[people[i].id] = m.startPoint && r.location ? travelMinutes(m.startPoint, r.location) : r.travelMin;
    });
    return toCandidate(r, travel);
  });
  // The plan's own coordinates are not stored; the middle of its candidates stands in for them.
  // Nothing is measured from the anchor: every distance the optimizer needs is in travelMin.
  const middle = centroid(parts.restaurants.flatMap((r) => (r.location ? [r.location] : [])));
  const anchor = middle ? { label: parts.location?.trim() || "The plan's area", ...middle } : SEED_ANCHOR;
  return OptimizerInputSchema.parse({
    plan: { date: parts.date, startTimes: [...START_TIMES], anchor },
    people,
    candidates,
  });
}
