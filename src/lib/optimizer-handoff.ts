import { z } from "zod";
import { LEGACY_CUISINE_TYPE } from "./cuisine-table";
import { centroid, travelMinutes, type LatLng } from "./geo";
import { canAttend } from "./optimizer";
import {
  CandidateRestaurantSchema,
  PersonPreferencesSchema,
  PlanSchema,
  START_TIMES,
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

/**
 * One person: an id that means nothing outside this input, and what their chat recorded.
 * `finished` is their place in the order people finished: 1 for the first to be done. It is a
 * rank and never a time, it is left out for anyone who is not done or whose time was not
 * recorded, and the optimizer uses it only to settle exact ties.
 */
const PersonSchema = z.strictObject({
  id: z.string().regex(/^p[1-9]\d*$/, "expected p1, p2, …"),
  prefs: PersonPreferencesSchema,
  finished: z.number().int().positive().optional(),
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

/**
 * Why nothing was chosen.
 * - `no_candidates`: no restaurant can take any start time of the plan.
 * - `nobody_can_come`: places are open, but every one of them, at every time, breaks a hard rule
 *   of every person. It says nothing about which rules or whose.
 */
export const NO_RESULT_REASONS = ["no_candidates", "nobody_can_come"] as const;

/**
 * What the optimizer returns. When no plan suits everyone it still returns the closest one,
 * with `cannotCome` above zero; `restaurantId: null` is for when there is nothing to pick from,
 * or nothing that even one person can come to (`NO_RESULT_REASONS`).
 */
export const OptimizerResultSchema = z.union([
  ChoiceSchema.extend({ alternatives: z.array(ChoiceSchema).max(MAX_ALTERNATIVES) }),
  z.strictObject({ restaurantId: z.null(), reason: z.enum(NO_RESULT_REASONS) }),
]);
export type OptimizerResult = z.infer<typeof OptimizerResultSchema>;

/**
 * Whether a result is one this input allows. Returns what is wrong, in words; an empty list
 * means the result can be shown.
 *
 * - "Nothing to pick from" is only true when no restaurant can take a start time of the plan,
 *   and "nobody can come" only when places are open and each keeps everyone out.
 * - Every place is a known restaurant, at a start time of the plan that the restaurant can take.
 * - Every count is the number of people a hard rule keeps out of that place and time (`canAttend`).
 * - A restaurant appears once, and every alternative has as many people able to come as the
 *   choice: a list that mixed them would say something about one person's rules.
 */
export function checkResult(input: OptimizerInput, result: OptimizerResult): string[] {
  if (result.restaurantId === null) {
    const open = input.candidates.flatMap((r) =>
      (r.openAt ?? []).filter((t) => input.plan.startTimes.includes(t)).map((t) => ({ r, t })),
    );
    if (result.reason === "no_candidates") {
      return open.length > 0 ? ["said there is no candidate, but one can be selected"] : [];
    }
    if (open.length === 0) return ["said nobody can come, but there is no candidate at all"];
    const somebody = open.some(({ r, t }) => input.people.some((p) => canAttend(p.prefs, r, t)));
    return somebody ? ["said nobody can come, but somebody can come to one of the candidates"] : [];
  }
  const problems: string[] = [];
  const check = (c: Choice, what: string) => {
    const r = input.candidates.find((x) => x.id === c.restaurantId);
    if (!r) return problems.push(`${what}: ${c.restaurantId} is not a candidate`);
    if (!input.plan.startTimes.includes(c.startTime))
      problems.push(`${what}: ${c.startTime} is not a start time of the plan`);
    if (!r.openAt?.includes(c.startTime)) problems.push(`${what}: ${r.id} cannot take ${c.startTime}`);
    const out = input.people.filter((p) => !canAttend(p.prefs, r, c.startTime)).length;
    if (c.cannotCome > input.people.length) problems.push(`${what}: more people cannot come than there are`);
    else if (out === input.people.length) problems.push(`${what}: nobody can come, which is not a plan`);
    else if (c.cannotCome !== out) problems.push(`${what}: says ${c.cannotCome} cannot come, but it is ${out}`);
  };
  check(result, "choice");
  result.alternatives.forEach((a, i) => {
    check(a, `alternative ${i + 1}`);
    if (a.cannotCome !== result.cannotCome)
      problems.push(`alternative ${i + 1}: not as many people can come as to the choice`);
  });
  const places = [result, ...result.alternatives].map((c) => c.restaurantId);
  if (new Set(places).size !== places.length) problems.push("the same restaurant appears twice");
  return problems;
}

/**
 * One member as storage holds them: what they said, where they start from if they said, and
 * when they finished (any number that grows with time; null or absent when unknown).
 */
export type HandoffMember = { prefs: PersonPreferences; startPoint: LatLng | null; finishedAt?: number | null };

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
  // The optimizer reads halal from the Google type (optimizer.ts). A place known to be halal some
  // other way, the seed places and one with "halal" in its name, is given that type here.
  const types = uniq(r.types ?? (r.cuisine ? [LEGACY_CUISINE_TYPE[r.cuisine]] : [])).filter((t) => TYPE_NAME.test(t));
  if (r.halal && !types.includes("halal_restaurant")) types.push("halal_restaurant");
  return {
    id: r.id,
    name: r.name,
    types,
    ...(r.primaryType && TYPE_NAME.test(r.primaryType) ? { primaryType: r.primaryType } : {}),
    ...(r.features ? { features: r.features } : {}),
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
  // The time someone finished becomes a place in the order here and goes no further. A value
  // that is not a real number (a damaged row) counts as unknown, like a missing one.
  const known = (t: number | null | undefined): t is number => typeof t === "number" && Number.isFinite(t);
  const times = uniq(parts.members.flatMap((m) => (known(m.finishedAt) ? [m.finishedAt] : [])));
  times.sort((a, b) => a - b);
  const people = parts.members.map((m, i) => ({
    id: `p${i + 1}`,
    prefs: m.prefs,
    ...(known(m.finishedAt) ? { finished: times.indexOf(m.finishedAt) + 1 } : {}),
  }));
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
