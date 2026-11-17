import { matchCuisine } from "./cuisine-table";
import { MAX_ALTERNATIVES, type Choice, type OptimizerInput, type OptimizerResult } from "./optimizer-handoff";
import {
  DEFAULT_START_TIME,
  START_TIMES,
  isSelectable,
  MEAL_RANGES,
  PRIORITY_DIMS,
  startTimesIn,
  type CandidateRestaurant,
  type PersonPreferences,
  type PriorityDim,
  type StartTime,
} from "./optimizer-input";

/**
 * The optimizer: picks the place and start time for a plan. No model is involved and nothing
 * is random: the same input always gives the same result.
 *
 * It scores every (restaurant, start time) the pool allows. With the pool capped at 160 places
 * and 14 start times that is at most 2,240 options, so looking at all of them is exact and
 * takes milliseconds; there is nothing here for a solver to search.
 *
 * How options are ordered:
 *   1. Fewest people who cannot come. A person cannot come when the option breaks one of
 *      their hard rules (`canAttend`). This always wins over everything below.
 *   2. Highest group welfare among the people who can come: the product of their
 *      satisfactions (Nash product), so one unhappy person costs more than one delighted
 *      person gains.
 *   3. Ties: the option that leaves people least far below the welfare floor (see below),
 *      then the one that suits whoever finished first, then a place whose main Google
 *      type is food somebody asked for, then a start time in the dinner hours (17:00 to
 *      20:00) over one outside them, then least total travel, then the start time nearest
 *      18:00, then the cheaper place, then id and time, so the order never depends on the
 *      order of the input.
 *
 * Dinner hours before travel: when nobody asked for a time, a place that is only open at
 * 23:00 or at 10:00 must not win because it is a minute closer. Inside the dinner hours every
 * time is as good as another and travel decides; anyone who wants lunch says so, and that is
 * scored, not a tie-break.
 *
 * Below the floor: a satisfaction can be negative (several musts missed), and negative is
 * worse than zero. The product cannot hold a negative number, so there everyone counts as at
 * least `WELFARE_FLOOR`; that also stops one person's pile of musts from outweighing the whole
 * group. But two options that leave someone at the floor are not the same to that person: one
 * may break their must budget tenfold and the other keep it. So between options of equal
 * welfare, the one whose people are less far below the floor comes first.
 *
 * Finished first: when two options are worth exactly the same to the group but not to the
 * same people ("must be Mexican" against "must be Italian"), something has to choose. It goes
 * to the person who finished telling their assistant first, then the second, and so on. This
 * only orders exact ties: answering early never outweighs anybody's stronger wish. People who
 * finished at the same moment speak with one voice: their scores are added, so neither is
 * ahead of the other and the order they are listed in means nothing.
 *
 * Why the first tie-break: Google tags places generously (a burger chain is also tagged
 * Mexican, a steakhouse Japanese), and scoring counts any tag as a match, because a place
 * really can serve several cuisines. So a taqueria and that burger chain can score the same
 * for someone who asked for Mexican. Between equals, the taqueria is the better answer. This
 * only orders options that already tie; it never changes a score or who can come.
 *
 * How one person is scored (`satisfaction`): they start at 1 and lose points only for what
 * they said. Each of the five dimensions starts with a fifth of the weight. A person's
 * priority order then moves weight between the dimensions they said something about, and only
 * those (`wishWeights`): with three wishes ranked, the 3/5 they hold is split 3 : 2 : 1.
 * Ranking a dimension they have no wish on does nothing, and someone with a single wish has a
 * fifth on it whatever order they give, so a priority list cannot be used to make one wish
 * louder than the next person's. Missing a strong wish costs the whole weight, missing a mild
 * one half of it, and a dimension they never mentioned costs nothing. So one mild wish moves a
 * person between about 0.9 and 1, and cannot outweigh several strong ones.
 *
 * `must` is the heaviest weight, not a filter. Two people's musts can contradict each other
 * ("must be Japanese", "must be Indian"), and a filter would then have to leave one of them
 * out of a dinner they could in fact eat at. So a missed must costs three times the weight:
 * the optimizer goes a long way to honour it, and a person is only ever counted as unable to
 * come for a reason that really stops them (`canAttend`). This is narrower than the note in
 * optimizer-input.ts, which reads `must` as a filter.
 *
 * The numbers below are this file's to choose (issue #82: "the optimizer decides what each
 * level is worth"). Per-person scores never leave this module in a result: `OptimizerResult`
 * carries the place, the time and a count.
 */

/** What a missed wish costs, as a multiple of the dimension's weight. */
export const STRENGTH_COST = { must: 3, strong: 1, mild: 0.5 } as const;
/**
 * The satisfaction of a dimension Google says nothing about: a place with no price. A little
 * under what a place at the top of a typical budget scores, so a place known to be within the
 * limit comes before one that could cost anything.
 */
export const UNKNOWN_SATISFACTION = 0.4;
/** Taken off when a vegetarian or vegan cannot be sure of the menu (Google does not say, or it is not a vegan place). */
export const UNSURE_DIET_PENALTY = 0.1;
/** Added when the place is one the person asked for by name. */
export const NAMED_WISH_BONUS = 0.1;
/** A start time this many hours from what a person prefers is worth nothing on time. */
export const TIME_FALLOFF_HOURS = 3;
/**
 * Where a price or a trip stops being worth anything. A max is a limit people still stretch a
 * little, so satisfaction reaches zero at `SOFT_MAX_OVERRUN` times the max, whether or not an
 * ideal was given as well. With only an ideal, it reaches zero at `IDEAL_ONLY_ZERO_AT` times it.
 */
export const IDEAL_ONLY_ZERO_AT = 2;
export const SOFT_MAX_OVERRUN = 1.5;
/** No one's satisfaction counts as less than this in the product, so one zero or negative does not hide everyone else. */
export const WELFARE_FLOOR = 0.05;

const VEGETARIAN_PLACE = /^(vegetarian|vegan)_restaurant$/;
const hourOf = (t: StartTime) => START_TIMES.indexOf(t);
const midPrice = (r: CandidateRestaurant) => (r.price ? (r.price.low + r.price.high) / 2 : null);

/**
 * Whether one person can come to this place at this time: true unless it breaks a hard rule.
 *
 * Hard rules are the things that really stop someone, whatever strength they gave: a time
 * they are unavailable, a diet, and a cuisine, kind of place or restaurant they ruled out.
 * A wish marked `must` is not one of them (see the top of this file).
 *
 * - Vegetarian: left out only when Google says the place serves no vegetarian food.
 * - Vegan and halal have no field of their own, so they need the Google type: a vegan or
 *   vegetarian restaurant, or a halal restaurant.
 */
export function canAttend(prefs: PersonPreferences, r: CandidateRestaurant, startTime: StartTime): boolean {
  if ((prefs.time?.unavailable ?? []).flatMap(startTimesIn).includes(startTime)) return false;

  const vegetarianPlace = r.types.some((t) => VEGETARIAN_PLACE.test(t));
  for (const need of prefs.dietary ?? []) {
    if (need === "vegetarian" && r.servesVegetarian === false && !vegetarianPlace) return false;
    if (need === "vegan" && !vegetarianPlace) return false;
    if (need === "halal" && !r.types.includes("halal_restaurant")) return false;
  }

  if (prefs.cuisine && matchCuisine(r.types, prefs.cuisine).excluded) return false;
  if ((prefs.style?.excluded ?? []).some((s) => r.style.includes(s))) return false;
  if ((prefs.excludedRestaurants ?? []).some((x) => x.id === r.id)) return false;
  return true;
}

/**
 * 1 at or under the ideal (the max, when no ideal was given), falling in a straight line to 0
 * a little past the max. So the max itself means the same with and without an ideal: still
 * acceptable, and 1 only when there is no ideal below it to fall short of.
 */
function ramp(x: number, ideal: number | undefined, max: number | undefined): number {
  const from = ideal ?? max!;
  const to = max === undefined ? ideal! * IDEAL_ONLY_ZERO_AT : max * SOFT_MAX_OVERRUN;
  return x <= from ? 1 : Math.max(0, 1 - (x - from) / (to - from));
}

/**
 * The weight of each dimension a person said something about (`stated`). Every dimension starts
 * with a fifth; the priority order moves weight only between the stated ones. Among those, the
 * ones the person ranked score from the top down, the last of them 1, and one more each when
 * there are stated dimensions they left unranked, which score 1: so "cuisine matters most" from
 * someone who also has a budget is 2 against 1. The weights returned add up to a fifth per
 * stated dimension.
 */
export function wishWeights(
  priority: readonly PriorityDim[],
  stated: readonly PriorityDim[],
): Partial<Record<PriorityDim, number>> {
  const ranked = priority.filter((dim) => stated.includes(dim));
  const lift = stated.length > ranked.length ? 1 : 0;
  const points = stated.map((dim) => {
    const rank = ranked.indexOf(dim);
    return rank === -1 ? 1 : ranked.length - rank + lift;
  });
  const total = points.reduce((a, b) => a + b, 0);
  // One division, so that with no order each weight is exactly a fifth.
  const whole = total * PRIORITY_DIMS.length;
  return Object.fromEntries(stated.map((dim, i) => [dim, (points[i] * stated.length) / whole]));
}

/**
 * How well a place and time suit one person who can come: 1 when nothing they said is missed,
 * a little over 1 at a place they named, and below 0 when several musts are missed (negative
 * is worse than zero; it is not cut off). Only what the person said counts; someone who said
 * nothing scores 1 everywhere, so only their travel time can matter, and only between ties.
 */
export function satisfaction(
  prefs: PersonPreferences,
  personId: string,
  r: CandidateRestaurant,
  startTime: StartTime,
): number {
  const { time, budget, travel, cuisine, style } = prefs;
  const got: Partial<Record<PriorityDim, number>> = {};

  const preferred = (time?.preferred ?? []).flatMap(startTimesIn);
  if (preferred.length > 0) {
    const away = Math.min(...preferred.map((t) => Math.abs(hourOf(t) - hourOf(startTime))));
    got.time = Math.max(0, 1 - away / TIME_FALLOFF_HOURS);
  }
  if (budget) {
    const price = midPrice(r);
    got.budget = price === null ? UNKNOWN_SATISFACTION : ramp(price, budget.ideal, budget.max);
  }
  if (travel) got.travel = ramp(r.travelMin[personId] ?? 0, travel.idealMin, travel.maxMin);
  if (cuisine && Object.keys(cuisine.scores ?? {}).length > 0) got.cuisine = matchCuisine(r.types, cuisine).score;
  if (style?.wanted?.length) got.style = style.wanted.some((s) => r.style.includes(s)) ? 1 : 0;

  const stated = Object.keys(got) as PriorityDim[];
  const weights = wishWeights(prefs.priority ?? [], stated);
  let score = 1;
  for (const dim of stated) {
    score -= weights[dim]! * STRENGTH_COST[prefs[dim]!.strength] * (1 - got[dim]!);
  }

  const diet = prefs.dietary ?? [];
  const vegetarianPlace = r.types.some((t) => VEGETARIAN_PLACE.test(t));
  const unsure =
    (diet.includes("vegetarian") && r.servesVegetarian === null && !vegetarianPlace) ||
    (diet.includes("vegan") && !r.types.includes("vegan_restaurant"));
  if (unsure) score -= UNSURE_DIET_PENALTY;
  if ((prefs.wantedRestaurants ?? []).some((x) => x.id === r.id)) score += NAMED_WISH_BONUS;
  return score;
}

/**
 * One option with everything the ordering looks at. `scores` has one entry per person in the
 * input's order, null for someone who cannot come. It holds what each person privately feels
 * about the option, so it is for this module, tests and offline evaluation only: never a
 * page, a log or a result.
 */
export type RankedOption = {
  restaurantId: string;
  startTime: StartTime;
  cannotCome: number;
  scores: (number | null)[];
  welfare: number;
  /** How far the people who can come are below `WELFARE_FLOOR`, added up: 0 or negative. */
  belowFloor: number;
  /** The place's main Google type is a cuisine or dish somebody who can come asked for. */
  mainTypeAskedFor: boolean;
  totalTravel: number;
};

/**
 * Two numbers that should be equal can differ in their last digits, depending on how they were
 * worked out. Everything the ordering compares is therefore first put on a grid this fine, and
 * the grid values are compared exactly. (Comparing a difference with a tolerance instead is
 * not an ordering: a ties with b, b ties with c, and a still beats c.)
 */
const GRAIN = 1e-9;
const onGrid = (x: number) => Math.round(x / GRAIN);
/** A sum that does not depend on the order of its terms: floating-point addition does. */
const sum = (xs: readonly number[]) => [...xs].sort((a, b) => a - b).reduce((total, x) => total + x, 0);
/** Larger first. Safe for infinities, where a subtraction would give NaN. */
const larger = (a: number, b: number) => (a === b ? 0 : a > b ? -1 : 1);

/** Whether this type is food the person asked for outright (a score of 1), a dish counting as its cuisine. */
function askedFor(prefs: PersonPreferences, type: string): boolean {
  const asked = Object.entries(prefs.cuisine?.scores ?? {}).filter(([, score]) => score === 1);
  return asked.length > 0 && matchCuisine([type], { scores: Object.fromEntries(asked) }).score === 1;
}
const idOrder = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Every option the pool allows, best first. */
export function rankOptions(input: OptimizerInput): RankedOption[] {
  const price = new Map<string, number>();
  const options: RankedOption[] = [];
  for (const r of input.candidates) {
    if (!isSelectable(r)) continue;
    price.set(r.id, midPrice(r) ?? Number.POSITIVE_INFINITY);
    for (const startTime of input.plan.startTimes) {
      if (!r.openAt!.includes(startTime)) continue;
      const scores = input.people.map((p) =>
        canAttend(p.prefs, r, startTime) ? satisfaction(p.prefs, p.id, r, startTime) : null,
      );
      const coming = scores.filter((s) => s !== null);
      const welfare = sum(coming.map((s) => Math.log(Math.max(WELFARE_FLOOR, s))));
      const belowFloor = sum(coming.map((s) => Math.min(0, s - WELFARE_FLOOR)));
      const totalTravel = sum(input.people.flatMap((p, i) => (scores[i] === null ? [] : [r.travelMin[p.id] ?? 0])));
      const cannotCome = scores.length - coming.length;
      const main = r.primaryType;
      const mainTypeAskedFor =
        main !== undefined && input.people.some((p, i) => scores[i] !== null && askedFor(p.prefs, main));
      options.push({
        restaurantId: r.id,
        startTime,
        cannotCome,
        scores,
        welfare,
        belowFloor,
        mainTypeAskedFor,
        totalTravel,
      });
    }
  }
  const fromDefault = (t: StartTime) => Math.abs(hourOf(t) - hourOf(DEFAULT_START_TIME));
  // How many hours a start time is outside the dinner hours; 0 inside them.
  const dinner = MEAL_RANGES.dinner;
  const outsideDinner = (t: StartTime) => Math.max(0, hourOf(dinner.from) - hourOf(t), hourOf(t) - hourOf(dinner.to));
  // The people at each known finishing place (their indexes), first to finish first. People who
  // share a place speak with one voice: their scores are added, so how they are listed means
  // nothing. Someone who cannot come counts as worse off than anyone who can.
  const atPlace = new Map<number, number[]>();
  input.people.forEach((p, i) => {
    if (p.finished !== undefined) atPlace.set(p.finished, [...(atPlace.get(p.finished) ?? []), i]);
  });
  const finishOrder = [...atPlace.entries()].sort((a, b) => a[0] - b[0]).map(([, people]) => people);

  // What the ordering compares, on the grid, worked out once per option.
  const keys = new Map(
    options.map((o) => [
      o,
      {
        welfare: onGrid(o.welfare),
        belowFloor: onGrid(o.belowFloor),
        finished: finishOrder.map((people) => onGrid(sum(people.map((i) => o.scores[i] ?? Number.NEGATIVE_INFINITY)))),
        travel: onGrid(o.totalTravel),
      },
    ]),
  );
  return options.sort((a, b) => {
    const ka = keys.get(a)!;
    const kb = keys.get(b)!;
    return (
      a.cannotCome - b.cannotCome ||
      larger(ka.welfare, kb.welfare) ||
      larger(ka.belowFloor, kb.belowFloor) ||
      // Whoever finished first: the first finishing place whose holders prefer one of the two.
      ka.finished.reduce((found, mine, i) => found || larger(mine, kb.finished[i]), 0) ||
      Number(b.mainTypeAskedFor) - Number(a.mainTypeAskedFor) ||
      outsideDinner(a.startTime) - outsideDinner(b.startTime) ||
      larger(kb.travel, ka.travel) ||
      fromDefault(a.startTime) - fromDefault(b.startTime) ||
      larger(price.get(b.restaurantId)!, price.get(a.restaurantId)!) ||
      idOrder(a.restaurantId, b.restaurantId) ||
      hourOf(a.startTime) - hourOf(b.startTime)
    );
  });
}

const toChoice = (o: RankedOption): Choice => ({
  restaurantId: o.restaurantId,
  startTime: o.startTime,
  cannotCome: o.cannotCome,
});

/**
 * The plan for a group, with up to `MAX_ALTERNATIVES` other choices.
 *
 * Alternatives are the next best options at other restaurants, one per restaurant, and only
 * ones the same number of people can come to. Showing "everyone can come here, one person
 * cannot come there" side by side would say something about that one person's rules; a
 * shorter list says nothing. They are listed best first.
 *
 * A restaurant appears once in a result, at its best start time: the choice and the
 * alternatives are always different places, even when that makes the list short. The other
 * times a listed place can take are not other recommendations (`otherStartTimes`).
 *
 * When no option suits everyone the closest one is still returned, with `cannotCome` above
 * zero. `restaurantId: null` is for when there is no plan to give: a pool with nothing open
 * (`no_candidates`), or one where every option keeps out every single person
 * (`nobody_can_come`). A dinner nobody can attend is not a plan.
 */
export function optimize(input: OptimizerInput): OptimizerResult {
  const ranked = rankOptions(input);
  const best = ranked[0];
  if (!best) return { restaurantId: null, reason: "no_candidates" };
  if (best.cannotCome === input.people.length) return { restaurantId: null, reason: "nobody_can_come" };

  const sameAttendance = ranked.slice(1).filter((o) => o.cannotCome === best.cannotCome);
  const alternatives: RankedOption[] = [];
  const places = new Set([best.restaurantId]);
  for (const o of sameAttendance) {
    if (alternatives.length === MAX_ALTERNATIVES) break;
    if (places.has(o.restaurantId)) continue;
    places.add(o.restaurantId);
    alternatives.push(o);
  }
  return { ...toChoice(best), alternatives: alternatives.map(toChoice) };
}

/**
 * The other start times a chosen place can take with the same number of people able to come,
 * in clock order. For showing "also at 20:00 to 23:00" beside a recommendation; the result
 * itself names one time per place.
 */
export function otherStartTimes(ranked: readonly RankedOption[], choice: Choice): StartTime[] {
  return ranked
    .filter(
      (o) =>
        o.restaurantId === choice.restaurantId &&
        o.startTime !== choice.startTime &&
        o.cannotCome === choice.cannotCome,
    )
    .map((o) => o.startTime)
    .sort((a, b) => hourOf(a) - hourOf(b));
}
