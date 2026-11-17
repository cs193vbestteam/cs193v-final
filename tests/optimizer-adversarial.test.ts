import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { createUser } from "@/lib/auth";
import { resetDbForTests } from "@/lib/db";
import { createEvent, joinEvent, sendMessage, setReady } from "@/lib/events";
import { canAttend, optimize, otherStartTimes, rankOptions, satisfaction, wishWeights } from "@/lib/optimizer";
import {
  MAX_ALTERNATIVES,
  OptimizerInputSchema,
  OptimizerResultSchema,
  assembleOptimizerInput,
  checkResult,
  type OptimizerInput,
  type OptimizerResult,
} from "@/lib/optimizer-handoff";
import {
  DIETARY_NEEDS,
  PRIORITY_DIMS,
  START_TIMES,
  STRENGTHS,
  STYLES,
  priorityWeights,
  type CandidateRestaurant,
  type PersonPreferences,
  type StartTime,
  type Strength,
} from "@/lib/optimizer-input";
import { loadOptimizerInput } from "@/lib/optimizer-source";
import { RESTAURANTS } from "@/lib/restaurants";
import { AREAS, CASES_DIR, buildInput, type CaseMember, type PlacesFile } from "../sim/optimizer-cases";

/**
 * Adversarial tests for the optimizer (src/lib/optimizer.ts): attempts to make it crash, break
 * a guarantee its header states, or return a plan a reasonable person would call wrong.
 *
 * How to read this file:
 *   - `it(...)`        behaviour that holds. Where the behaviour is defensible but surprising,
 *                      the name or a comment starts with QUESTIONABLE and says why.
 *   - "Was QUESTIONABLE" a design choice that was changed after this file was written; the
 *                      comment says what it used to do.
 *   - "Was a defect"   a comment above a test that failed when this file was written. The
 *                      defect has been fixed and the test now holds the fix in place.
 *
 * Nothing here touches the network, and every random input comes from a fixed seed.
 */

// ---------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------

const NOTHING: PersonPreferences = { version: 1 };
const copy = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

const place = (id: string, extra: Partial<CandidateRestaurant> = {}): CandidateRestaurant => ({
  id,
  name: id,
  types: ["restaurant"],
  style: ["casual"],
  price: { low: 20, high: 30 },
  servesVegetarian: true,
  openAt: ["18:00", "19:00"],
  travelMin: {},
  ...extra,
});

type GroupOptions = { startTimes?: StartTime[]; finished?: (number | undefined)[] };
/** People `p1..pn` in the order given; a place's missing travel time is 10 minutes. */
function group(people: PersonPreferences[], candidates: CandidateRestaurant[], o: GroupOptions = {}): OptimizerInput {
  const ids = people.map((_, i) => `p${i + 1}`);
  return OptimizerInputSchema.parse({
    plan: {
      date: "2026-11-21",
      startTimes: o.startTimes ?? [...START_TIMES],
      anchor: { label: "Test", lat: 37.43, lng: -122.17 },
    },
    people: people.map((prefs, i) => ({
      id: ids[i],
      prefs,
      ...(o.finished?.[i] !== undefined ? { finished: o.finished[i] } : {}),
    })),
    candidates: candidates.map((c) => ({
      ...c,
      travelMin: Object.fromEntries(ids.map((id) => [id, c.travelMin[id] ?? 10])),
    })),
  });
}

type Chosen = Extract<OptimizerResult, { alternatives: unknown }>;
/** The result, checked against its schema and `checkResult`; throws when nothing was chosen. */
function chosen(input: OptimizerInput): Chosen {
  const result = optimize(input);
  expect(OptimizerResultSchema.safeParse(result).success).toBe(true);
  expect(checkResult(input, result)).toEqual([]);
  if (result.restaurantId === null) throw new Error("no choice");
  return result;
}
const pick = (input: OptimizerInput) => chosen(input).restaurantId;
const keyOf = (c: { restaurantId: string; startTime: string }) => `${c.restaurantId}@${c.startTime}`;

const wants = (type: string, strength: Strength, extra: Partial<PersonPreferences> = {}): PersonPreferences => ({
  version: 1,
  cuisine: { scores: { [type]: 1 }, strength },
  ...extra,
});
const FULL_PRIORITY = (first: (typeof PRIORITY_DIMS)[number]) => [first, ...PRIORITY_DIMS.filter((d) => d !== first)];

/** A small seeded generator (mulberry32): the same seed always gives the same inputs. */
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1));
  const chance = (p: number) => next() < p;
  const one = <T>(xs: readonly T[]): T => xs[int(0, xs.length - 1)];
  const shuffled = <T>(xs: readonly T[]): T[] => {
    const out = [...xs];
    for (let i = out.length - 1; i > 0; i--) {
      const j = int(0, i);
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  };
  const some = <T>(xs: readonly T[], max: number): T[] => shuffled(xs).slice(0, int(0, Math.min(max, xs.length)));
  return { next, int, chance, one, shuffled, some };
}
type Rng = ReturnType<typeof rng>;

// Cuisines with some of their dishes, so that inheritance is exercised, and a few other types.
const FOOD = [
  "japanese_restaurant",
  "sushi_restaurant",
  "ramen_restaurant",
  "chinese_restaurant",
  "hot_pot_restaurant",
  "mexican_restaurant",
  "taco_restaurant",
  "italian_restaurant",
  "pizza_restaurant",
  "indian_restaurant",
  "thai_restaurant",
  "korean_restaurant",
] as const;
const OTHER = ["restaurant", "halal_restaurant", "vegan_restaurant", "vegetarian_restaurant", "bar", "mystery_place"];

/** Any preferences the format allows. Numbers are whole so that only real ties are ties. */
function randomPrefs(r: Rng, restaurantIds: readonly string[]): PersonPreferences {
  const prefs: Record<string, unknown> = { version: 1 };
  const strength = () => r.one(STRENGTHS);
  if (r.chance(0.4)) {
    const time: Record<string, unknown> = { strength: strength() };
    const split = r.int(1, 6); // unavailable stays before `split`, preferred from it on
    if (r.chance(0.5)) time.unavailable = [{ from: START_TIMES[0], to: START_TIMES[r.int(0, split - 1)] }];
    if (r.chance(0.7)) {
      const from = r.int(split, 13);
      time.preferred = [{ from: START_TIMES[from], to: START_TIMES[r.int(from, 13)] }];
    }
    prefs.time = time;
  }
  if (r.chance(0.5)) {
    const s = strength();
    const ideal = r.chance(0.6) ? r.int(10, 60) : undefined;
    const max =
      s === "must" || ideal === undefined || r.chance(0.6) ? (ideal ?? r.int(10, 60)) + r.int(0, 40) : undefined;
    prefs.budget = { ...(ideal !== undefined ? { ideal } : {}), ...(max !== undefined ? { max } : {}), strength: s };
  }
  if (r.chance(0.5)) {
    const s = strength();
    const idealMin = r.chance(0.6) ? r.int(5, 40) : undefined;
    const maxMin =
      s === "must" || idealMin === undefined || r.chance(0.6) ? (idealMin ?? r.int(5, 40)) + r.int(0, 30) : undefined;
    prefs.travel = {
      ...(idealMin !== undefined ? { idealMin } : {}),
      ...(maxMin !== undefined ? { maxMin } : {}),
      strength: s,
    };
  }
  if (r.chance(0.3)) prefs.dietary = DIETARY_NEEDS.filter(() => r.chance(0.35));
  if (r.chance(0.6)) {
    const types = r.shuffled(FOOD);
    const scored = types.slice(0, r.int(0, 4));
    const excluded = types.slice(4, 4 + r.int(0, 2));
    prefs.cuisine = {
      ...(scored.length ? { scores: Object.fromEntries(scored.map((t) => [t, r.one([0.25, 0.5, 1])])) } : {}),
      ...(excluded.length ? { excluded } : {}),
      strength: strength(),
    };
  }
  if (r.chance(0.3)) {
    const styles = r.shuffled(STYLES);
    prefs.style = {
      wanted: styles.slice(0, r.int(0, 2)),
      excluded: styles.slice(2, 2 + r.int(0, 1)),
      strength: strength(),
    };
  }
  if (r.chance(0.5)) prefs.priority = r.some(PRIORITY_DIMS, 5);
  if (restaurantIds.length >= 2 && r.chance(0.3)) {
    const ids = r.shuffled(restaurantIds);
    if (r.chance(0.7)) prefs.wantedRestaurants = [{ name: "Wanted", id: r.chance(0.85) ? ids[0] : null }];
    if (r.chance(0.5)) prefs.excludedRestaurants = [{ name: "Not that one", id: ids[1] }];
  }
  return prefs as PersonPreferences;
}

function randomCandidate(r: Rng, id: string): CandidateRestaurant {
  const types = [...new Set([r.one(FOOD), ...r.some(FOOD, 1), ...r.some(OTHER, 2)])];
  const low = r.int(5, 80);
  const from = r.int(0, 13);
  return {
    id,
    name: id,
    types: r.chance(0.05) ? [] : types,
    ...(r.chance(0.7) ? { primaryType: types[0] } : {}),
    style: r.some(STYLES, 2),
    price: r.chance(0.15) ? null : { low, high: low + r.int(0, 40) },
    servesVegetarian: r.one([true, true, false, null]),
    openAt: r.chance(0.08) ? null : r.chance(0.05) ? [] : START_TIMES.slice(from, r.int(from, 13) + 1),
    travelMin: {},
  };
}

function randomInput(r: Rng): OptimizerInput {
  const nPeople = r.int(1, 6);
  const ids = Array.from({ length: nPeople }, (_, i) => `p${i + 1}`);
  const candidates = Array.from({ length: r.int(1, 12) }, (_, i) =>
    randomCandidate(r, `r${String(i).padStart(2, "0")}`),
  );
  // Distinct finishing places, for some of the people or none: equal places are a known defect (below).
  const order = r.shuffled(ids.map((_, i) => i + 1));
  const withOrder = r.chance(0.6);
  return OptimizerInputSchema.parse({
    plan: {
      date: "2026-11-21",
      startTimes: r.chance(0.7) ? [...START_TIMES] : START_TIMES.filter((t) => t === "20:00" || r.chance(0.5)),
      anchor: { label: "Fuzz", lat: 37.43, lng: -122.17 },
    },
    people: ids.map((id, i) => ({
      id,
      prefs: randomPrefs(
        r,
        candidates.map((c) => c.id),
      ),
      ...(withOrder && r.chance(0.8) ? { finished: order[i] } : {}),
    })),
    candidates: candidates.map((c) => ({ ...c, travelMin: Object.fromEntries(ids.map((id) => [id, r.int(0, 60)])) })),
  });
}

/** The same group with the people listed in another order and given other ids, consistently. */
function relabelled(input: OptimizerInput, r: Rng): OptimizerInput {
  const newIds = r.shuffled(input.people.map((p) => p.id));
  const rename = new Map(input.people.map((p, i) => [p.id, newIds[i]]));
  const out = copy(input);
  out.people = r.shuffled(out.people.map((p) => ({ ...p, id: rename.get(p.id)! })));
  for (const c of out.candidates) {
    c.travelMin = Object.fromEntries(Object.entries(c.travelMin).map(([id, min]) => [rename.get(id)!, min]));
  }
  return OptimizerInputSchema.parse(out);
}

/** Everything the header of optimizer.ts promises about one result, checked against the full ranking. */
function expectSound(input: OptimizerInput) {
  const result = optimize(input);
  expect(OptimizerResultSchema.safeParse(result).success).toBe(true);
  expect(checkResult(input, result)).toEqual([]);
  expect(optimize(input)).toEqual(result); // running twice

  const ranked = rankOptions(input);
  const byId = new Map(input.candidates.map((c) => [c.id, c]));
  for (const o of ranked) {
    const r = byId.get(o.restaurantId)!;
    expect(input.plan.startTimes).toContain(o.startTime);
    expect(r.openAt).toContain(o.startTime);
    const out = input.people.filter((p) => !canAttend(p.prefs, r, o.startTime));
    expect(o.cannotCome).toBe(out.length);
    // Nobody counted as coming breaks a hard rule, and nobody kept out has a score.
    input.people.forEach((p, i) => expect(o.scores[i] === null).toBe(out.includes(p)));
    expect(Number.isFinite(o.welfare)).toBe(true);
    for (const s of o.scores) if (s !== null) expect(s <= 1.1 + 1e-9).toBe(true); // may be negative
  }
  expect(new Set(ranked.map(keyOf)).size).toBe(ranked.length);

  if (result.restaurantId === null) {
    // No plan: either nothing is open, or every option keeps every person out.
    if (result.reason === "no_candidates") expect(ranked).toHaveLength(0);
    else expect(ranked.length > 0 && ranked.every((o) => o.cannotCome === input.people.length)).toBe(true);
    return result;
  }
  expect(result.cannotCome).toBeLessThan(input.people.length);
  expect(keyOf(result)).toBe(keyOf(ranked[0]));
  expect(Math.min(...ranked.map((o) => o.cannotCome))).toBe(result.cannotCome);

  // The alternatives are exactly the next restaurants in ranking order with the same attendance.
  const expected: string[] = [];
  const seen = new Set([result.restaurantId]);
  for (const o of ranked) {
    if (o.cannotCome !== result.cannotCome || seen.has(o.restaurantId)) continue;
    seen.add(o.restaurantId);
    if (expected.length < MAX_ALTERNATIVES) expected.push(keyOf(o));
  }
  expect(result.alternatives.map(keyOf)).toEqual(expected);
  expect(result.alternatives.length).toBeLessThanOrEqual(MAX_ALTERNATIVES);
  expect(result.alternatives.every((a) => a.cannotCome === result.cannotCome)).toBe(true);
  return result;
}

/** Where a restaurant first appears in the ranking, counting restaurants: 0 is the chosen one. */
function standing(input: OptimizerInput, restaurantId: string): number {
  const order = [...new Set(rankOptions(input).map((o) => o.restaurantId))];
  return order.indexOf(restaurantId);
}

// ---------------------------------------------------------------------------------------
// Invariants under fuzzing
// ---------------------------------------------------------------------------------------

describe("fuzzing: made-up inputs (fixed seed)", () => {
  const ROUNDS = 400;

  it("keeps every stated guarantee, and the same answer whatever the input order", () => {
    const r = rng(20261116);
    let withChoice = 0;
    for (let round = 0; round < ROUNDS; round++) {
      const input = randomInput(r);
      const result = expectSound(input);

      // Restaurants in another order, people in another order under other ids: the same ranking.
      const shuffledPlaces = { ...input, candidates: r.shuffled(input.candidates) };
      expect(rankOptions(shuffledPlaces).map(keyOf)).toEqual(rankOptions(input).map(keyOf));
      expect(optimize(shuffledPlaces)).toEqual(result);
      expect(optimize(relabelled(input, r))).toEqual(result);

      if (result.restaurantId === null) continue;
      withChoice++;

      // Taking away a restaurant that was neither chosen nor offered changes nothing.
      const listed = new Set([result.restaurantId, ...result.alternatives.map((a) => a.restaurantId)]);
      const unlisted = input.candidates.filter((c) => !listed.has(c.id));
      if (unlisted.length > 0) {
        const gone = r.one(unlisted).id;
        expect(optimize({ ...input, candidates: input.candidates.filter((c) => c.id !== gone) })).toEqual(result);
      }

      // A newcomer with no preferences, as far from every place as from any other, changes nothing.
      const newcomer = `p${input.people.length + 1}`;
      const plusOne = copy(input);
      plusOne.people.push({ id: newcomer, prefs: NOTHING });
      for (const c of plusOne.candidates) c.travelMin[newcomer] = 15;
      expect(optimize(OptimizerInputSchema.parse(plusOne))).toEqual(result);
    }
    expect(withChoice).toBeGreaterThan(ROUNDS * 0.8);
  });

  it("never ranks a restaurant lower for becoming cheaper or nearer for somebody", () => {
    const r = rng(8675309);
    let tried = 0;
    for (let round = 0; round < ROUNDS; round++) {
      const input = randomInput(r);
      const open = input.candidates.filter((c) => standing(input, c.id) >= 0);
      if (open.length < 2) continue;
      const target = r.one(open);
      const before = standing(input, target.id);

      const better = copy(input);
      const t = better.candidates.find((c) => c.id === target.id)!;
      if (t.price && r.chance(0.5)) {
        const off = r.int(0, t.price.low);
        t.price = { low: t.price.low - off, high: t.price.high - off };
      } else {
        const who = r.one(input.people).id;
        t.travelMin[who] = r.int(0, t.travelMin[who]);
      }
      tried++;
      expect(standing(OptimizerInputSchema.parse(better), target.id)).toBeLessThanOrEqual(before);
    }
    expect(tried).toBeGreaterThan(ROUNDS * 0.6);
  });

  it("never ranks a restaurant lower for gaining the cuisine somebody asked for", () => {
    const r = rng(424242);
    let tried = 0;
    for (let round = 0; round < ROUNDS; round++) {
      const input = randomInput(r);
      // A cuisine at least one person scored and nobody excluded outright (dish bans are caught below).
      const banned = new Set(input.people.flatMap((p) => p.prefs.cuisine?.excluded ?? []));
      const asked = input.people
        .flatMap((p) => Object.keys(p.prefs.cuisine?.scores ?? {}))
        .filter((t) => !banned.has(t));
      const open = input.candidates.filter((c) => standing(input, c.id) >= 0);
      if (asked.length === 0 || open.length < 2) continue;
      const target = r.one(open);
      const type = r.one(asked);
      if (target.types.includes(type)) continue;
      const better = copy(input);
      better.candidates.find((c) => c.id === target.id)!.types.push(type);
      // Only a gain when it keeps nobody out who could come before (an added tag can be someone's ban).
      const parsed = OptimizerInputSchema.parse(better);
      const outBefore = rankOptions(input).find((o) => o.restaurantId === target.id)!.cannotCome;
      const outAfter = rankOptions(parsed).find((o) => o.restaurantId === target.id)!.cannotCome;
      if (outAfter !== outBefore) continue;
      tried++;
      expect(standing(parsed, target.id)).toBeLessThanOrEqual(standing(input, target.id));
    }
    expect(tried).toBeGreaterThan(50);
  });
});

describe("fuzzing: random groups on the three recorded pools", () => {
  const read = (id: string) =>
    JSON.parse(readFileSync(path.join(CASES_DIR, `${id}.places.json`), "utf8")) as PlacesFile;

  it.each(AREAS)("keeps every stated guarantee on $label", (area) => {
    const file = read(area.id);
    const r = rng(area.id.length * 7919);
    const ids = buildInput(area, file, [{ prefs: NOTHING, startPoint: null }]).candidates.map((c) => c.id);
    for (let round = 0; round < 12; round++) {
      const members: CaseMember[] = Array.from({ length: r.int(1, 8) }, (_, i) => ({
        prefs: randomPrefs(r, ids),
        startPoint: r.chance(0.7)
          ? { lat: file.center.lat + (r.next() - 0.5) * 0.08, lng: file.center.lng + (r.next() - 0.5) * 0.08 }
          : null,
        ...(r.chance(0.6) ? { finishedAt: 1000 + i * 7 + r.int(0, 3) * 100 } : {}),
      }));
      // Distinct finishing times only: equal ones are a known defect (below).
      const times = members.flatMap((m) => (m.finishedAt === undefined ? [] : [m.finishedAt]));
      if (new Set(times).size !== times.length) continue;
      const input = buildInput(area, file, members);
      const result = expectSound(input);
      expect(optimize({ ...input, candidates: r.shuffled(input.candidates) })).toEqual(result);
      expect(optimize(relabelled(input, r))).toEqual(result);
    }
  });

  it("QUESTIONABLE: a pair who said nothing is sent to whatever is nearest, which can be a juice bar or a deli", () => {
    // Nothing is scored for people with no wishes, so the first tie-break that bites is total
    // travel. The pools contain places nobody would call dinner. Upstream data as much as scoring.
    const silent: CaseMember[] = [
      { prefs: NOTHING, startPoint: null },
      { prefs: NOTHING, startPoint: null },
    ];
    const mainType = (areaId: string) => {
      const area = AREAS.find((a) => a.id === areaId)!;
      const input = buildInput(area, read(areaId), silent);
      const result = chosen(input);
      expect(result.startTime).toBe("18:00");
      return input.candidates.find((c) => c.id === result.restaurantId)!.primaryType;
    };
    expect(mainType("wicker-park")).toBe("juice_shop");
    expect(mainType("long-island-city")).toBe("deli");
    expect(mainType("palo-alto-mountain-view")).toBe("sandwich_shop");
  });

  it("finds a place for one person with all three diets where a pool has one, and counts them out where it has none", () => {
    const strict: CaseMember[] = [
      { prefs: { version: 1, dietary: ["vegetarian", "vegan", "halal"] }, startPoint: null },
      { prefs: NOTHING, startPoint: null },
    ];
    for (const area of AREAS) {
      const input = buildInput(area, read(area.id), strict);
      const both = input.candidates.filter(
        (c) => c.types.includes("halal_restaurant") && c.types.some((t) => /^(vegan|vegetarian)_restaurant$/.test(t)),
      );
      const result = chosen(input);
      expect(result.cannotCome).toBe(both.length > 0 ? 0 : 1);
      if (both.length > 0) expect(both.map((c) => c.id)).toContain(result.restaurantId);
      // The list is as short as the pool is thin: at most the other places that suit that one person.
      expect(result.alternatives.length).toBeLessThanOrEqual(Math.max(0, both.length - 1));
    }
  });
});

// ---------------------------------------------------------------------------------------
// The ordering: is it one consistent order?
// ---------------------------------------------------------------------------------------

describe("the ordering itself", () => {
  // Was a defect: welfare was compared with a tolerance (|a - b| > 1e-9), which is not an
  // ordering. Three places 6.5e-10 apart were "equal" pairwise but not end to end, the
  // comparator had a cycle, and the choice followed the order of the candidates. Values are now
  // put on a 1e-9 grid and compared exactly.
  it("gives the same choice for every order of three nearly tied places", () => {
    const frugal: PersonPreferences = { version: 1, budget: { ideal: 10, max: 110, strength: "strong" } };
    const at = (id: string, price: number, travel: number) =>
      place(id, { price: { low: price, high: price }, travelMin: { p1: travel }, openAt: ["18:00"] });
    const a = at("a", 50, 3);
    const b = at("b", 50 + 3e-7, 2);
    const c = at("c", 50 + 6e-7, 1);
    const picks = [
      [a, b, c],
      [a, c, b],
      [b, a, c],
      [b, c, a],
      [c, a, b],
      [c, b, a],
    ].map((order) => pick(group([frugal], order)));
    expect(new Set(picks).size).toBe(1);
  });

  // Was a defect: equal finishing places used to fall back to the order of the input (who
  // joined first). People who share a place now speak with one voice (their scores are added).
  it("does not let the order of the people decide between two who finished at the same moment", () => {
    const places = [
      place("mexican", { types: ["mexican_restaurant"], travelMin: { p1: 5, p2: 5 }, openAt: ["18:00"] }),
      place("italian", { types: ["italian_restaurant"], openAt: ["18:00"] }),
    ];
    const mexican = wants("mexican_restaurant", "must");
    const italian = wants("italian_restaurant", "must");
    const noOrder = pick(group([italian, mexican], places));
    expect(noOrder).toBe("mexican"); // the shorter trip
    expect(pick(group([mexican, italian], places, { finished: [1, 1] }))).toBe(noOrder);
    expect(pick(group([italian, mexican], places, { finished: [1, 1] }))).toBe(noOrder);
    // Three people, two of them level. The pair would rather have either of their own places
    // than the third person's, and between those two it has no view: the shorter trip decides,
    // however the three are listed.
    const thai = wants("thai_restaurant", "must");
    const three = [...places, place("thai", { types: ["thai_restaurant"], openAt: ["18:00"] })];
    expect(pick(group([italian, mexican, thai], three, { finished: [1, 1, 2] }))).toBe("mexican");
    expect(pick(group([mexican, thai, italian], three, { finished: [1, 2, 1] }))).toBe("mexican");
    // Someone who finished before the pair still goes first.
    expect(pick(group([italian, mexican, thai], three, { finished: [2, 2, 1] }))).toBe("thai");
    // A pair that agrees still goes first.
    expect(pick(group([italian, italian, thai], three, { finished: [1, 1, 2] }))).toBe("italian");
  });

  // Was a defect: total travel was added in the order of the people and compared exactly, and
  // 0.1 + 0.2 + 0.3 is not 0.3 + 0.2 + 0.1. Sums no longer depend on the order of their terms.
  it("does not let the order of the people decide a tie on total travel", () => {
    const a = place("a", { travelMin: { p1: 0.1, p2: 0.2, p3: 0.3 }, openAt: ["18:00"] });
    const b = place("b", { travelMin: { p1: 0.3, p2: 0.2, p3: 0.1 }, openAt: ["18:00"] });
    const input = group([NOTHING, NOTHING, NOTHING], [a, b]);
    const reversed = OptimizerInputSchema.parse({ ...input, people: [...input.people].reverse() });
    expect(pick(reversed)).toBe(pick(input));
  });

  // Was a defect: `matchCuisine` read `scores[type]` on a plain object, so a type named
  // "constructor" came back as a function, the score was NaN, and NaN tied with everything.
  it("is not thrown by a place type named like an object's built-in property", () => {
    const thai = wants("thai_restaurant", "must");
    const input = group(
      [thai],
      [place("thai", { types: ["thai_restaurant"] }), place("odd", { types: ["constructor"], travelMin: { p1: 1 } })],
    );
    expect(rankOptions(input).every((o) => Number.isFinite(o.welfare))).toBe(true);
    expect(pick(input)).toBe("thai");
    const banned: PersonPreferences = { version: 1, cuisine: { excluded: ["constructor"], strength: "mild" } };
    expect(canAttend(banned, input.candidates[1], "18:00")).toBe(false);
    expect(canAttend(banned, input.candidates[0], "18:00")).toBe(true);
  });

  it("orders two places with no price by id, not by Infinity minus Infinity", () => {
    const input = group([NOTHING], [place("b", { price: null }), place("a", { price: null })]);
    expect([chosen(input), ...chosen(input).alternatives].map(keyOf)).toEqual(["a@18:00", "b@18:00"]);
    // A known price comes before an unknown one in the tie-break.
    expect(pick(group([NOTHING], [place("a", { price: null }), place("z", { price: { low: 900, high: 900 } })]))).toBe(
      "z",
    );
  });

  it("prefers 18:00, and the nearest time to it when the plan has no 18:00", () => {
    const allDay = place("a", { openAt: [...START_TIMES] });
    expect(chosen(group([NOTHING], [allDay])).startTime).toBe("18:00");
    expect(chosen(group([NOTHING], [allDay], { startTimes: ["10:00", "12:00", "21:00"] })).startTime).toBe("21:00");
    // 17:00 and 19:00 are equally near: the earlier one, by the last tie-break.
    expect(chosen(group([NOTHING], [allDay], { startTimes: ["19:00", "17:00"] })).startTime).toBe("17:00");
    expect(chosen(group([NOTHING], [allDay], { startTimes: ["23:00"] })).startTime).toBe("23:00");
  });

  it("keeps a group that said nothing in the dinner hours, however near a late or early place is", () => {
    // Was QUESTIONABLE: total travel used to be settled before the time, so a place open only at
    // 23:00 (or 10:00) won on a one-minute advantage. Dinner hours, 17:00 to 20:00, now come first.
    const six = place("six");
    const late = group([NOTHING, NOTHING], [place("late", { openAt: ["23:00"], travelMin: { p1: 1, p2: 1 } }), six]);
    expect(chosen(late)).toMatchObject({ restaurantId: "six", startTime: "18:00" });
    const early = group([NOTHING, NOTHING], [place("early", { openAt: ["10:00"], travelMin: { p1: 1, p2: 1 } }), six]);
    expect(chosen(early)).toMatchObject({ restaurantId: "six", startTime: "18:00" });
    // Inside the dinner hours every time is as good as another: the shorter trip decides.
    const eight = place("eight", { openAt: ["20:00"], travelMin: { p1: 9 } });
    expect(chosen(group([NOTHING, NOTHING], [eight, six]))).toMatchObject({
      restaurantId: "eight",
      startTime: "20:00",
    });
    // Outside them, the nearer to them: 21:00 before 23:00, whatever the trip.
    const nine = place("nine", { openAt: ["21:00"], travelMin: { p1: 60, p2: 60 } });
    const eleven = place("eleven", { openAt: ["23:00"] });
    expect(chosen(group([NOTHING, NOTHING], [eleven, nine]))).toMatchObject({
      restaurantId: "nine",
      startTime: "21:00",
    });
    // It is a tie-break: one mild wish for a late dinner still gets the late place.
    const nightOwl: PersonPreferences = {
      version: 1,
      time: { preferred: [{ from: "23:00", to: "23:00" }], strength: "mild" },
    };
    expect(pick(group([nightOwl, NOTHING], [eleven, six]))).toBe("eleven");
  });
});

// ---------------------------------------------------------------------------------------
// Claims in the header that do not quite hold
// ---------------------------------------------------------------------------------------

describe("claims made in comments", () => {
  // The comment on `satisfaction` used to say someone who said nothing "has no effect on the
  // choice". Their travel time does count, in the total-travel tie-break, and that is right: it
  // is the comment that was changed. A silent person never changes anybody's score.
  it("lets a person who said nothing move the choice only through their travel time, between ties", () => {
    const a = place("a", { travelMin: { p1: 5, p2: 20 }, openAt: ["18:00"] });
    const b = place("b", { travelMin: { p1: 6, p2: 10 }, openAt: ["18:00"] });
    expect(pick(group([NOTHING], [a, b]))).toBe("a");
    expect(pick(group([NOTHING, NOTHING], [a, b]))).toBe("b"); // 16 minutes in all against 25
    // Not when anyone has a wish that separates the two places.
    const mild: PersonPreferences = { version: 1, wantedRestaurants: [{ name: "A", id: "a" }] };
    expect(pick(group([mild, NOTHING], [a, b]))).toBe("a");
  });

  // Was a defect: `checkResult` took "there was something to pick" from `isSelectable` alone and
  // rejected the optimizer's honest answer for a plan narrower than the day.
  it("has its own 'nothing is open' answer accepted when places open only outside the plan's times", () => {
    const input = group([NOTHING], [place("a", { openAt: ["18:00"] })], { startTimes: ["12:00"] });
    const result = optimize(input);
    expect(result).toEqual({ restaurantId: null, reason: "no_candidates" });
    expect(checkResult(input, result)).toEqual([]);
  });

  // Was a gap: `checkResult` did not look at the count or at what the optimizer promises about
  // alternatives. It now recomputes the count and compares restaurants and attendance.
  it("has a wrong count, a repeated restaurant or mixed attendance caught by checkResult", () => {
    const vegan: PersonPreferences = { version: 1, dietary: ["vegan"] };
    const input = group([vegan, NOTHING], [place("a"), place("b", { types: ["vegan_restaurant"] })]);
    const honest = chosen(input);
    expect(honest).toMatchObject({ restaurantId: "b", cannotCome: 0, alternatives: [] });
    const wrongCount = { ...honest, cannotCome: 2 };
    const sameTwice = { ...honest, alternatives: [{ restaurantId: "b", startTime: "19:00" as const, cannotCome: 0 }] };
    const mixed = { ...honest, alternatives: [{ restaurantId: "a", startTime: "18:00" as const, cannotCome: 1 }] };
    expect(checkResult(input, wrongCount)).toEqual(["choice: says 2 cannot come, but it is 0"]);
    expect(checkResult(input, { ...honest, cannotCome: 3 })).toEqual([
      "choice: more people cannot come than there are",
    ]);
    expect(checkResult(input, { ...honest, cannotCome: 1 })).toEqual(["choice: says 1 cannot come, but it is 0"]);
    expect(checkResult(input, sameTwice)).toEqual(["the same restaurant appears twice"]);
    expect(checkResult(input, mixed)).toEqual(["alternative 1: not as many people can come as to the choice"]);
  });

  it("holds 'only orders exact ties' for finishing first: a later finisher's stronger wish still wins", () => {
    const places = [place("m", { types: ["mexican_restaurant"] }), place("i", { types: ["italian_restaurant"] })];
    const mild = wants("mexican_restaurant", "mild");
    const strong = wants("italian_restaurant", "strong");
    expect(pick(group([mild, strong], places, { finished: [1, 2] }))).toBe("i");
    // Three people, a real tie between the first two; the third's place in the order is irrelevant.
    const must = (t: string) => wants(t, "must");
    const tie = [must("mexican_restaurant"), must("italian_restaurant"), NOTHING];
    expect(pick(group(tie, places, { finished: [2, 1, 3] }))).toBe("i");
    expect(pick(group(tie, places, { finished: [2, undefined, 1] }))).toBe("m"); // the only one of the two with a place
    expect(pick(group(tie, places, { finished: [undefined, undefined, 1] }))).toBe("i"); // by id: nobody who cares has a place
  });
});

// ---------------------------------------------------------------------------------------
// Strength, and what one person can do to the group
// ---------------------------------------------------------------------------------------

describe("strength and gaming", () => {
  const places = [place("j", { types: ["japanese_restaurant"] }), place("i", { types: ["indian_restaurant"] })];
  const many = (n: number, prefs: PersonPreferences) => Array.from({ length: n }, () => prefs);
  const japanese = (s: Strength, extra: Partial<PersonPreferences> = {}) => wants("japanese_restaurant", s, extra);
  const indian = (s: Strength) => wants("indian_restaurant", s);

  it("lets one must outweigh four strong wishes and no more", () => {
    // A missed must on one of five equal dimensions leaves 0.4; a missed strong wish leaves 0.8.
    // 0.8^4 = 0.41 > 0.4 > 0.8^5 = 0.33.
    expect(pick(group([japanese("must"), ...many(4, indian("strong"))], places))).toBe("j");
    expect(pick(group([japanese("must"), ...many(5, indian("strong"))], places))).toBe("i");
  });

  it("does not let a priority list make a single wish louder", () => {
    // Was QUESTIONABLE: a full priority list with the one real wish on top raised it from 1/5 to
    // 1/3 for free, so one such must outweighed 13 strong wishes and three other people's musts.
    // The order now moves weight only between dimensions the person said something about.
    const loud = japanese("must", { priority: FULL_PRIORITY("cuisine") });
    expect(satisfaction(loud, "p1", places[1], "18:00")).toBeCloseTo(0.4);
    expect(satisfaction(loud, "p1", places[1], "18:00")).toBe(satisfaction(japanese("must"), "p1", places[1], "18:00"));
    expect(pick(group([loud, ...many(4, indian("strong"))], places))).toBe("j");
    expect(pick(group([loud, ...many(5, indian("strong"))], places))).toBe("i");
    // Against another person's plain must it is an even tie, settled by id.
    expect(pick(group([loud, indian("must")], places))).toBe("i");
    expect(pick(group([loud, ...many(2, indian("must"))], places))).toBe("i");
  });

  it("moves weight between a person's own wishes by the order they give, and only those", () => {
    const fifth = 1 / 5;
    // One wish: a fifth, whatever the list says.
    expect(wishWeights([], ["cuisine"])).toEqual({ cuisine: fifth });
    expect(wishWeights(["cuisine"], ["cuisine"])).toEqual({ cuisine: fifth });
    expect(wishWeights(["budget", "time", "cuisine"], ["cuisine"])).toEqual({ cuisine: fifth });
    // No order: a fifth each.
    expect(wishWeights([], ["cuisine", "budget", "time"])).toEqual({ cuisine: fifth, budget: fifth, time: fifth });
    // Two wishes, both ranked: the 2/5 they hold is split 2 : 1.
    const two = wishWeights(["cuisine", "budget"], ["budget", "cuisine"]);
    expect(two.cuisine).toBeCloseTo(4 / 15);
    expect(two.budget).toBeCloseTo(2 / 15);
    // Was QUESTIONABLE: naming one dimension used to change nothing. "Cuisine matters most" from
    // someone who also has a budget is now 2 against 1; ranking travel, which they have no wish on, adds nothing.
    expect(wishWeights(["cuisine"], ["budget", "cuisine"])).toEqual(two);
    expect(wishWeights(["travel", "cuisine", "style"], ["budget", "cuisine"])).toEqual(two);
    // Three ranked, 3 : 2 : 1 of 3/5; and one ranked of three, 2 : 1 : 1.
    const three = wishWeights(["time", "cuisine", "budget"], ["cuisine", "budget", "time"]);
    expect([three.time, three.cuisine, three.budget].map((w) => Math.round(w! * 100))).toEqual([30, 20, 10]);
    const oneOfThree = wishWeights(["time"], ["cuisine", "budget", "time"]);
    expect([oneOfThree.time, oneOfThree.cuisine, oneOfThree.budget].map((w) => Math.round(w! * 100))).toEqual([
      30, 15, 15,
    ]);
    // The weights always add up to a fifth per wish.
    for (const w of [two, three, oneOfThree, wishWeights([...PRIORITY_DIMS], [...PRIORITY_DIMS])]) {
      const n = Object.keys(w).length;
      expect(Object.values(w).reduce((a, b) => a + b!, 0)).toBeCloseTo(n / 5);
    }
  });

  it("leaves `priorityWeights` in optimizer-input.ts as it was: the optimizer no longer uses it", () => {
    // Still used by legacy-adapter.ts. There a list of one is the same as no list.
    expect(priorityWeights(["cuisine"])).toEqual(priorityWeights([]));
    expect(priorityWeights(["cuisine", "time"]).cuisine).toBeCloseTo(1 / 3);
  });

  it("does not let a list of every cuisine at full score dominate: it is the same as saying nothing", () => {
    const everything: PersonPreferences = {
      version: 1,
      cuisine: { scores: Object.fromEntries(FOOD.map((t) => [t, 1])), strength: "must" },
      priority: FULL_PRIORITY("cuisine"),
    };
    expect(satisfaction(everything, "p1", places[0], "18:00")).toBe(1);
    expect(satisfaction(everything, "p1", places[1], "18:00")).toBe(1);
    expect(pick(group([everything, indian("mild")], places))).toBe("i");
    // It does cost them at a place with no cuisine type at all.
    expect(satisfaction(everything, "p1", place("plain"), "18:00")).toBeCloseTo(0.4);
  });

  it("gives a named restaurant a small edge only: it loses to one mild wish and never keeps anyone out", () => {
    const named: PersonPreferences = { version: 1, wantedRestaurants: [{ name: "J", id: "j" }] };
    expect(satisfaction(named, "p1", places[0], "18:00")).toBeCloseTo(1.1);
    expect(pick(group([named, NOTHING], places))).toBe("j");
    expect(pick(group([named, indian("mild")], places))).toBe("i"); // 1.1 x 0.9 < 1 x 1
    // Five names are the most the format allows; each is worth the same small edge at its own place.
    const vegan: PersonPreferences = { version: 1, dietary: ["vegan"] };
    const veganPlace = place("v", { types: ["vegan_restaurant"] });
    expect(chosen(group([named, vegan], [...places, veganPlace]))).toMatchObject({ restaurantId: "v", cannotCome: 0 });
    // A name the pool could not match (id null) does nothing.
    const unmatched: PersonPreferences = { version: 1, wantedRestaurants: [{ name: "Somewhere", id: null }] };
    expect(satisfaction(unmatched, "p1", places[0], "18:00")).toBe(1);
  });

  it("QUESTIONABLE: one person's exclusion is a veto over seven other people's musts", () => {
    // Ruling a cuisine out is a hard rule and attendance comes first, so it cannot be outvoted.
    // Somebody who rules out everything but their favourite decides the dinner alone.
    const veto: PersonPreferences = { version: 1, cuisine: { excluded: ["indian_restaurant"], strength: "mild" } };
    expect(chosen(group([veto, ...many(7, indian("must"))], places))).toMatchObject({
      restaurantId: "j",
      cannotCome: 0,
    });
    const onlyJapanese: PersonPreferences = {
      version: 1,
      cuisine: { excluded: FOOD.filter((t) => !/japanese|sushi|ramen/.test(t)), strength: "mild" },
    };
    const pool = FOOD.map((t) => place(t.replace("_restaurant", ""), { types: [t] }));
    const result = chosen(group([onlyJapanese, ...many(7, indian("must"))], pool));
    expect(result.cannotCome).toBe(0);
    expect([result, ...result.alternatives].map((c) => c.restaurantId).sort()).toEqual(["japanese", "ramen", "sushi"]);
  });

  it("settles two, three and four musts for different cuisines without leaving anyone out", () => {
    const types = ["japanese_restaurant", "indian_restaurant", "mexican_restaurant", "thai_restaurant"];
    const pool = types.map((t) => place(t.slice(0, 3), { types: [t] }));
    for (const n of [2, 3, 4]) {
      const people = types.slice(0, n).map((t) => wants(t, "must"));
      const plain = chosen(group(people, pool));
      expect(plain.cannotCome).toBe(0);
      // Each of them is the one let down n - 1 times out of n: the tie goes by id (alphabetical).
      expect(plain.restaurantId).toBe(
        types
          .slice(0, n)
          .map((t) => t.slice(0, 3))
          .sort()[0],
      );
      // With a finishing order, the last listed finished first and gets their place.
      const finished = people.map((_, i) => n - i);
      expect(pick(group(people, pool, { finished }))).toBe(types[n - 1].slice(0, 3));
    }
    // Somewhere none of them asked for is never the compromise.
    const people = types.slice(0, 3).map((t) => wants(t, "must"));
    expect(pick(group(people, [...pool, place("aaa-neutral")]))).not.toBe("aaa-neutral");
  });

  it("settles musts on different dimensions that cannot all hold, for whoever finished first", () => {
    const tight: PersonPreferences = { version: 1, budget: { max: 20, strength: "must" } };
    const fancy: PersonPreferences = { version: 1, style: { wanted: ["fine_dining"], strength: "must" } };
    const pool = [
      place("cheap", { price: { low: 10, high: 20 } }),
      place("dear", { style: ["fine_dining"], price: { low: 90, high: 110 } }),
    ];
    expect(chosen(group([tight, fancy], pool))).toMatchObject({ restaurantId: "cheap", cannotCome: 0 }); // by id
    expect(pick(group([tight, fancy], pool, { finished: [2, 1] }))).toBe("dear");
    // A third place that half-suits both beats either extreme: the product rewards the compromise.
    const middle = place("middle", { style: ["fine_dining"], price: { low: 20, high: 26 } });
    expect(pick(group([tight, fancy], [...pool, middle], { finished: [2, 1] }))).toBe("middle");
  });

  // Was a defect: a score used to stop at 0, so once someone had missed enough every place was
  // worth the same to them and a one-minute trip sent a $20 must budget to a $200 dinner. Scores
  // now go below zero, and between options of equal welfare the one that leaves people less far
  // below the floor comes first.
  it("still honours a must budget after the person's other musts have turned out to be unavailable", () => {
    const person: PersonPreferences = {
      version: 1,
      priority: ["cuisine", "budget", "style"],
      cuisine: { scores: { japanese_restaurant: 1 }, strength: "must" },
      budget: { max: 20, strength: "must" },
      style: { wanted: ["fine_dining"], strength: "must" },
    };
    const dear = place("dear", { types: ["indian_restaurant"], price: { low: 200, high: 200 }, travelMin: { p1: 5 } });
    const cheap = place("cheap", { types: ["indian_restaurant"], price: { low: 15, high: 15 }, travelMin: { p1: 6 } });
    // Cuisine (0.3) and style (0.1) are missed at both: 1 - 0.9 - 0.3. The budget (0.2) only at one.
    expect(satisfaction(person, "p1", cheap, "18:00")).toBeCloseTo(-0.2);
    expect(satisfaction(person, "p1", dear, "18:00")).toBeCloseTo(-0.8);
    const [first, second] = rankOptions(group([person], [dear, cheap]));
    expect(first.welfare).toBe(second.welfare); // both at the floor
    expect(pick(group([person], [dear, cheap]))).toBe("cheap");
    // In a group too: the second person has no view, so the first one's budget still steers.
    expect(pick(group([person, NOTHING], [dear, cheap]))).toBe("cheap");
    // It stays a tie-break: being far below the floor never outweighs someone else's wish.
    const other: PersonPreferences = { version: 1, wantedRestaurants: [{ name: "Dear", id: "dear" }] };
    expect(pick(group([person, other], [dear, cheap]))).toBe("dear");
  });

  it("QUESTIONABLE: a must budget is a heavy weight, not a wall, and a range counts by its middle", () => {
    const at = (low: number, high = low) => place("x", { price: { low, high } });
    const score = (budget: PersonPreferences["budget"], r: CandidateRestaurant) =>
      satisfaction({ version: 1, budget }, "p1", r, "18:00");
    // A must of "at most $30": $44 still keeps 0.44 of the score, and $31 costs 4%. This follows
    // from `must` being a weight; it is worthless only at one and a half times the limit.
    expect(score({ max: 30, strength: "must" }, at(44))).toBeCloseTo(0.44);
    expect(score({ max: 30, strength: "must" }, at(31))).toBeCloseTo(0.96);
    expect(score({ max: 30, strength: "must" }, at(45))).toBeCloseTo(0.4);
    // A range that straddles the limit counts by its middle: $20 to $40 is a perfect fit for $30.
    expect(score({ max: 30, strength: "must" }, at(20, 40))).toBe(1);
    expect(score({ max: 30, strength: "must" }, at(0, 1000))).toBeCloseTo(0.4);
    // No price at all is a little over half a miss, even for a must.
    expect(score({ max: 30, strength: "must" }, place("x", { price: null }))).toBeCloseTo(0.64);
  });

  it("gives a limit the same meaning with and without an ideal", () => {
    // Was QUESTIONABLE: at exactly the max the score was 1 with no ideal and 0 with one, and
    // ideal = max was a cliff. Both now run out at one and a half times the max.
    const at = (price: number) => place("x", { price: { low: price, high: price } });
    const got = (budget: PersonPreferences["budget"], price: number) =>
      (1 - satisfaction({ version: 1, budget: { ...budget!, strength: "strong" } }, "p1", at(price), "18:00")) / 0.2;
    // `got` is the share of the budget wish that is missed: 0 is a perfect fit, 1 a complete miss.
    expect(got({ max: 30, strength: "strong" }, 30)).toBeCloseTo(0);
    expect(got({ ideal: 10, max: 30, strength: "strong" }, 30)).toBeCloseTo(20 / 35); // short of the ideal, inside the limit
    expect(got({ ideal: 10, max: 30, strength: "strong" }, 45)).toBeCloseTo(1);
    expect(got({ max: 30, strength: "strong" }, 45)).toBeCloseTo(1);
    expect(got({ ideal: 30, max: 30, strength: "strong" }, 31)).toBeCloseTo(got({ max: 30, strength: "strong" }, 31));
    expect(got({ ideal: 30, max: 30, strength: "strong" }, 31)).toBeCloseTo(1 / 15);
    // With an ideal only, twice the ideal is the end.
    expect(got({ ideal: 20, strength: "strong" }, 30)).toBeCloseTo(0.5);
    expect(got({ ideal: 20, strength: "strong" }, 40)).toBeCloseTo(1);
    // The same for travel.
    const trip = (travel: PersonPreferences["travel"], min: number) =>
      satisfaction({ version: 1, travel }, "p1", place("x", { travelMin: { p1: min } }), "18:00");
    expect(trip({ idealMin: 20, maxMin: 20, strength: "strong" }, 25)).toBeCloseTo(0.9);
    expect(trip({ maxMin: 20, strength: "strong" }, 25)).toBeCloseTo(0.9);
  });

  it("puts a place known to be inside the person's limit before one with no price", () => {
    // Was QUESTIONABLE: unknown scored 0.5 and beat a known $31 against "ideally $20, at most
    // $40". Unknown is now 0.4, and anything inside the limit scores at least that unless the
    // ideal is under a quarter of the max.
    const prefs: PersonPreferences = { version: 1, budget: { ideal: 20, max: 40, strength: "strong" } };
    const unknown = place("unknown", { price: null });
    expect(pick(group([prefs], [place("known-31", { price: { low: 31, high: 31 } }), unknown]))).toBe("known-31");
    expect(pick(group([prefs], [place("known-40", { price: { low: 40, high: 40 } }), unknown]))).toBe("known-40");
    // Over the limit by enough, the unknown place is the better bet.
    expect(pick(group([prefs], [place("known-50", { price: { low: 50, high: 50 } }), unknown]))).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------------------
// Degenerate inputs
// ---------------------------------------------------------------------------------------

describe("degenerate inputs", () => {
  it("handles one person, and one candidate", () => {
    expect(chosen(group([NOTHING], [place("only")]))).toEqual({
      restaurantId: "only",
      startTime: "18:00",
      cannotCome: 0,
      alternatives: [],
    });
  });

  it("handles twelve people with ids that are not in order", () => {
    const input = group(
      Array.from({ length: 12 }, (_, i) => wants(FOOD[i], i % 2 ? "strong" : "mild")),
      FOOD.map((t) => place(t, { types: [t] })),
    );
    const renamed = copy(input);
    renamed.people.forEach((p, i) => (p.id = `p${100 - i}`));
    for (const c of renamed.candidates) {
      c.travelMin = Object.fromEntries(Object.values(c.travelMin).map((min, i) => [`p${100 - i}`, min]));
    }
    expect(expectSound(OptimizerInputSchema.parse(renamed))).toEqual(expectSound(input));
  });

  it("says there is nothing when no place has opening hours, or none are given", () => {
    const none = { restaurantId: null, reason: "no_candidates" };
    for (const pool of [
      [],
      [place("a", { openAt: null })],
      [place("a", { openAt: [] }), place("b", { openAt: null })],
    ]) {
      const input = group([NOTHING, NOTHING], pool);
      expect(optimize(input)).toEqual(none);
      expect(checkResult(input, optimize(input))).toEqual([]);
      expect(rankOptions(input)).toEqual([]);
    }
  });

  it("gives no plan, and says why, when every option keeps every person out", () => {
    // Was QUESTIONABLE: three vegans and no vegan place used to get a restaurant and a time with
    // cannotCome equal to the size of the group.
    const vegan: PersonPreferences = { version: 1, dietary: ["vegan"] };
    const nobody = { restaurantId: null, reason: "nobody_can_come" };
    const input = group([vegan, vegan, vegan], [place("a"), place("b")]);
    expect(optimize(input)).toEqual(nobody);
    expect(OptimizerResultSchema.safeParse(nobody).success).toBe(true);
    expect(checkResult(input, optimize(input))).toEqual([]);
    expect(optimize(group([vegan], [place("a")]))).toEqual(nobody);
    // One person able to come is a plan: "nobody" means nobody.
    const withOne = group([vegan, vegan, NOTHING], [place("a"), place("b")]);
    expect(chosen(withOne)).toMatchObject({ restaurantId: "a", cannotCome: 2 });
    // checkResult holds each answer to the facts.
    expect(checkResult(withOne, { restaurantId: null, reason: "nobody_can_come" })).toEqual([
      "said nobody can come, but somebody can come to one of the candidates",
    ]);
    expect(checkResult(input, { restaurantId: null, reason: "no_candidates" })).toEqual([
      "said there is no candidate, but one can be selected",
    ]);
    expect(checkResult(group([vegan], []), { restaurantId: null, reason: "nobody_can_come" })).toEqual([
      "said nobody can come, but there is no candidate at all",
    ]);
    expect(checkResult(input, { restaurantId: "a", startTime: "18:00", cannotCome: 3, alternatives: [] })).toEqual([
      "choice: nobody can come, which is not a plan",
    ]);
  });

  it("serves whoever is left when everyone but one is kept out, ignoring the wishes of those kept out", () => {
    const vegan = (extra: Partial<PersonPreferences>): PersonPreferences => ({
      version: 1,
      dietary: ["vegan"],
      ...extra,
    });
    const pool = [place("thai", { types: ["thai_restaurant"] }), place("pizza", { types: ["pizza_restaurant"] })];
    const people = [
      vegan(wants("pizza_restaurant", "must")),
      vegan(wants("pizza_restaurant", "must")),
      wants("thai_restaurant", "mild"),
    ];
    expect(chosen(group(people, pool))).toMatchObject({ restaurantId: "thai", cannotCome: 2 });
  });

  it("takes empty types, unknown types and a main type that is not among the types", () => {
    const thai = wants("thai_restaurant", "strong");
    const bare = place("bare", { types: [] });
    const unknown = place("unknown", { types: ["zorgon_restaurant", "point_of_interest"] });
    expect(satisfaction(thai, "p1", bare, "18:00")).toBeCloseTo(0.8);
    expect(satisfaction(thai, "p1", unknown, "18:00")).toBeCloseTo(0.8);
    expect(canAttend({ version: 1, cuisine: { excluded: ["thai_restaurant"], strength: "mild" } }, bare, "18:00")).toBe(
      true,
    );
    // QUESTIONABLE (data): the main type is trusted on its own. A place that is "mainly Thai"
    // but has no Thai among its types scores as a miss, and still takes the tie-break meant for
    // places whose main type was asked for.
    const mislabelled = place("z-mislabelled", { types: ["bar"], primaryType: "thai_restaurant" });
    const ranked = rankOptions(group([thai], [mislabelled, place("a-plain")]));
    expect(ranked[0]).toMatchObject({ restaurantId: "z-mislabelled", mainTypeAskedFor: true });
    expect(ranked[0].scores[0]).toBeCloseTo(0.8);
  });

  it("takes a free place, an absurdly expensive one, and travel of 0 and 180 minutes", () => {
    const prefs: PersonPreferences = {
      version: 1,
      budget: { ideal: 1000, max: 1000, strength: "must" },
      travel: { idealMin: 180, maxMin: 180, strength: "must" },
    };
    const free = place("free", { price: { low: 0, high: 0 }, travelMin: { p1: 0 } });
    const absurd = place("absurd", { price: { low: 1e9, high: 1e12 }, travelMin: { p1: 180 } });
    expect(satisfaction(prefs, "p1", free, "18:00")).toBe(1);
    expect(satisfaction(prefs, "p1", absurd, "18:00")).toBeCloseTo(0.4); // travel is fine at the limit; the price is not
    expect(pick(group([prefs], [absurd, free]))).toBe("free");
    // A price of 0 is a price, not "unknown": it wins the cheaper tie-break.
    expect(pick(group([NOTHING], [place("a"), place("z-free", { price: { low: 0, high: 0 } })]))).toBe("z-free");
  });

  it("keeps a restaurant one person named and another ruled out away from the one who ruled it out", () => {
    const fan: PersonPreferences = { version: 1, wantedRestaurants: [{ name: "A", id: "a" }] };
    const foe: PersonPreferences = { version: 1, excludedRestaurants: [{ name: "A", id: "a" }] };
    expect(chosen(group([fan, foe], [place("a"), place("b")]))).toMatchObject({
      restaurantId: "b",
      cannotCome: 0,
      alternatives: [],
    });
    // With nothing else open, the plan is the named place and one person is counted out.
    expect(chosen(group([fan, foe], [place("a")]))).toMatchObject({ restaurantId: "a", cannotCome: 1 });
  });

  it("treats two branches of a chain as two restaurants, and can offer both", () => {
    const branch = (id: string, travel: number) => ({ ...place(id, { travelMin: { p1: travel } }), name: "Same Name" });
    const foe: PersonPreferences = { version: 1, excludedRestaurants: [{ name: "Same Name", id: "branch-1" }] };
    const result = chosen(group([NOTHING], [branch("branch-2", 20), branch("branch-1", 5)]));
    expect([result.restaurantId, ...result.alternatives.map((a) => a.restaurantId)]).toEqual(["branch-1", "branch-2"]);
    // QUESTIONABLE (data): ruling out "Same Name" rules out only the branch the name was matched to.
    expect(chosen(group([foe], [branch("branch-2", 20), branch("branch-1", 5)]))).toMatchObject({
      restaurantId: "branch-2",
      cannotCome: 0,
    });
  });

  it("takes preferences with every field present at once", () => {
    const full: PersonPreferences = {
      version: 1,
      time: {
        unavailable: [{ from: "10:00", to: "16:00" }],
        preferred: [{ from: "19:00", to: "20:00" }],
        strength: "must",
      },
      budget: { ideal: 25, max: 40, strength: "must" },
      travel: { idealMin: 10, maxMin: 30, strength: "strong" },
      dietary: ["vegetarian", "vegan", "halal"],
      cuisine: {
        scores: { thai_restaurant: 1, indian_restaurant: 0.5 },
        excluded: ["pizza_restaurant"],
        strength: "mild",
      },
      style: { wanted: ["casual"], excluded: ["bar"], strength: "strong" },
      priority: [...PRIORITY_DIMS],
      wantedRestaurants: [{ name: "Good", id: "good" }],
      excludedRestaurants: [{ name: "Bad", id: "bad" }],
      notes: [{ type: "allergy", text: "peanuts" }],
    };
    const ok = { types: ["thai_restaurant", "halal_restaurant", "vegan_restaurant"], openAt: [...START_TIMES] };
    const input = group(
      [full, NOTHING],
      [place("good", ok), place("bad", ok), place("meh", { openAt: [...START_TIMES] })],
    );
    expect(chosen(input)).toEqual({ restaurantId: "good", startTime: "19:00", cannotCome: 0, alternatives: [] });
    expect(satisfaction(full, "p1", input.candidates[0], "19:00")).toBeCloseTo(1.1);
  });

  it("counts out a person who is unavailable at every time of the plan, and carries on for the rest", () => {
    const never: PersonPreferences = {
      version: 1,
      time: { unavailable: [{ from: "10:00", to: "23:00" }], strength: "must" },
    };
    const result = chosen(
      group([never, wants("thai_restaurant", "mild")], [place("a"), place("t", { types: ["thai_restaurant"] })]),
    );
    expect(result).toMatchObject({ restaurantId: "t", cannotCome: 1 });
  });
});

// ---------------------------------------------------------------------------------------
// Diets and exclusions
// ---------------------------------------------------------------------------------------

describe("diets and exclusions", () => {
  const diet = (...needs: PersonPreferences["dietary"] & string[]): PersonPreferences => ({
    version: 1,
    dietary: needs,
  });
  const at = (types: string[], servesVegetarian: boolean | null) => place("x", { types, servesVegetarian });

  it("reads a vegetarian's options from Google's answer, with the type winning over a contradicting 'false'", () => {
    const veg = diet("vegetarian");
    expect(canAttend(veg, at(["restaurant"], false), "18:00")).toBe(false);
    expect(canAttend(veg, at(["restaurant"], null), "18:00")).toBe(true);
    expect(satisfaction(veg, "p1", at(["restaurant"], null), "18:00")).toBeCloseTo(0.9);
    expect(satisfaction(veg, "p1", at(["restaurant"], true), "18:00")).toBe(1);
    // A vegetarian restaurant that Google also says serves no vegetarian food: the type is believed.
    expect(canAttend(veg, at(["vegetarian_restaurant"], false), "18:00")).toBe(true);
    expect(satisfaction(veg, "p1", at(["vegetarian_restaurant"], false), "18:00")).toBe(1);
    expect(satisfaction(veg, "p1", at(["vegan_restaurant"], null), "18:00")).toBe(1);
  });

  it("lets a vegan into a vegetarian restaurant with a small doubt, and nowhere without one of the two types", () => {
    const vegan = diet("vegan");
    expect(canAttend(vegan, at(["vegetarian_restaurant"], true), "18:00")).toBe(true);
    expect(satisfaction(vegan, "p1", at(["vegetarian_restaurant"], true), "18:00")).toBeCloseTo(0.9);
    expect(satisfaction(vegan, "p1", at(["vegan_restaurant"], true), "18:00")).toBe(1);
    // QUESTIONABLE: `servesVegetarian: true` is not enough for a vegan. In pools where few places
    // carry the type, a vegan is counted out of most of the list (5 of 95 in Long Island City).
    expect(canAttend(vegan, at(["thai_restaurant"], true), "18:00")).toBe(false);
    // Both doubts at once are charged once.
    expect(satisfaction(diet("vegetarian", "vegan"), "p1", at(["vegetarian_restaurant"], null), "18:00")).toBeCloseTo(
      0.9,
    );
  });

  it("needs every diet in the group met at once: halal, vegan and vegetarian", () => {
    const people = [diet("halal"), diet("vegan"), diet("vegetarian")];
    const pool = [
      place("halal", { types: ["halal_restaurant"] }),
      place("vegan", { types: ["vegan_restaurant"] }),
      place("plain"),
      place("both", { types: ["halal_restaurant", "vegetarian_restaurant"], servesVegetarian: null }),
    ];
    expect(chosen(group(people, pool))).toMatchObject({ restaurantId: "both", cannotCome: 0, alternatives: [] });
    // Without the place that suits all three, one person is counted out, and it is not said who.
    const result = chosen(group(people, pool.slice(0, 3)));
    expect(result.cannotCome).toBe(1);
    // halal (vegan out) and vegan (halal out) tie; id decides. `plain` would lose two people.
    expect([result.restaurantId, ...result.alternatives.map((a) => a.restaurantId)]).toEqual(["halal", "vegan"]);
    // One person with all three needs a place with both types.
    const all = diet("vegetarian", "vegan", "halal");
    expect(pool.filter((r) => canAttend(all, r, "18:00")).map((r) => r.id)).toEqual(["both"]);
  });

  it("carries a ban on a cuisine down to its dishes, and not from a dish up or sideways", () => {
    const noChinese: PersonPreferences = {
      version: 1,
      cuisine: { excluded: ["chinese_restaurant"], strength: "mild" },
    };
    const noHotPot: PersonPreferences = { version: 1, cuisine: { excluded: ["hot_pot_restaurant"], strength: "mild" } };
    const types = (...t: string[]) => place("x", { types: t });
    expect(canAttend(noChinese, types("hot_pot_restaurant"), "18:00")).toBe(false);
    expect(canAttend(noChinese, types("restaurant", "bar", "hot_pot_restaurant"), "18:00")).toBe(false);
    expect(canAttend(noHotPot, types("chinese_restaurant"), "18:00")).toBe(true);
    expect(canAttend(noHotPot, types("chinese_restaurant", "hot_pot_restaurant"), "18:00")).toBe(false);
    expect(canAttend(noHotPot, types("dim_sum_restaurant"), "18:00")).toBe(true);
    // Google's generous tagging cuts both ways: one stray tag keeps the person out.
    expect(canAttend(noChinese, types("hamburger_restaurant", "chinese_restaurant"), "18:00")).toBe(false);
  });

  it("QUESTIONABLE (upstream): accepts a wanted dish under a banned cuisine, and a ban on 'restaurant'", () => {
    // The format only rejects the same type on both lists. "Hot pot, but no Chinese" passes, and
    // the ban wins: the person is kept out of the one place they asked for.
    const hotPotNotChinese: PersonPreferences = {
      version: 1,
      cuisine: { scores: { hot_pot_restaurant: 1 }, excluded: ["chinese_restaurant"], strength: "must" },
    };
    const hotPot = place("hot-pot", { types: ["hot_pot_restaurant"] });
    expect(() => group([hotPotNotChinese], [hotPot])).not.toThrow();
    expect(optimize(group([hotPotNotChinese], [hotPot]))).toEqual({ restaurantId: null, reason: "nobody_can_come" });
    expect(chosen(group([hotPotNotChinese, NOTHING], [hotPot])).cannotCome).toBe(1);
    // Any type name is accepted as a ban. "restaurant" is on nearly every place.
    const noRestaurants: PersonPreferences = { version: 1, cuisine: { excluded: ["restaurant"], strength: "mild" } };
    expect(canAttend(noRestaurants, place("x", { types: ["thai_restaurant", "restaurant"] }), "18:00")).toBe(false);
  });

  it("keeps a person out of a style they ruled out even when it is one of several", () => {
    const noBars: PersonPreferences = {
      version: 1,
      style: { excluded: ["bar"], wanted: ["casual"], strength: "must" },
    };
    expect(canAttend(noBars, place("x", { style: ["casual", "bar"] }), "18:00")).toBe(false);
    expect(canAttend(noBars, place("x", { style: [] }), "18:00")).toBe(true);
    expect(satisfaction(noBars, "p1", place("x", { style: [] }), "18:00")).toBeCloseTo(0.4);
  });
});

// ---------------------------------------------------------------------------------------
// Scale
// ---------------------------------------------------------------------------------------

describe("scale", () => {
  /** A full day at every place and people who use every field, so nothing is skipped. */
  function large(places: number, people: number): OptimizerInput {
    const r = rng(places * 31 + people);
    const ids = Array.from({ length: people }, (_, i) => `p${i + 1}`);
    const busy = (i: number): PersonPreferences => ({
      version: 1,
      time: {
        unavailable: [{ from: "10:00", to: "11:00" }],
        preferred: [{ from: "18:00", to: "19:00" }],
        strength: "strong",
      },
      budget: { ideal: 20 + i, max: 60, strength: "must" },
      travel: { idealMin: 10, maxMin: 40, strength: "mild" },
      cuisine: {
        scores: Object.fromEntries(FOOD.slice(0, 8).map((t, k) => [t, (((k + i) % 4) + 1) / 4])),
        excluded: [FOOD[8 + (i % 4)]],
        strength: "strong",
      },
      style: { wanted: ["casual"], excluded: ["bar"], strength: "mild" },
      priority: [...PRIORITY_DIMS],
      ...(i === 0 ? { dietary: ["vegetarian" as const] } : {}),
    });
    return OptimizerInputSchema.parse({
      plan: { date: "2026-11-21", startTimes: [...START_TIMES], anchor: { label: "Big", lat: 37.43, lng: -122.17 } },
      people: ids.map((id, i) => ({ id, prefs: busy(i), finished: i + 1 })),
      candidates: Array.from({ length: places }, (_, k) => ({
        ...randomCandidate(r, `r${String(k).padStart(4, "0")}`),
        openAt: [...START_TIMES],
        travelMin: Object.fromEntries(ids.map((id) => [id, r.int(0, 60)])),
      })),
    });
  }
  const timed = (input: OptimizerInput) => {
    optimize(input); // once to warm up
    const start = performance.now();
    const result = optimize(input);
    return { ms: performance.now() - start, result };
  };

  it("ranks the largest real pool (160 places, 14 times, 8 people) in well under a second", () => {
    const input = large(160, 8);
    expect(rankOptions(input)).toHaveLength(160 * 14);
    const { ms, result } = timed(input);
    expect(result.restaurantId).not.toBeNull();
    // Measured at about 30 ms on a laptop; the bound leaves room for a loaded test run.
    expect(ms).toBeLessThan(750);
  });

  it("stays roughly linear at 1,000 places and at 1,000 places with 20 people", () => {
    // Measured at about 170 ms and 370 ms: six times the places, six times the time. Nothing in the hot path is quadratic: the lookups by
    // `indexOf` are into the 14 start times, and the comparator reads a Map.
    expect(timed(large(1000, 8)).ms).toBeLessThan(3000);
    const { ms, result } = timed(large(1000, 20));
    expect(ms).toBeLessThan(6000);
    expect(checkResult(large(1000, 20), result)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------
// What a result gives away (report only: nothing here is a change request by itself)
// ---------------------------------------------------------------------------------------

describe("what a participant can work out from a result", () => {
  const pool = [
    ...["a", "b", "c", "d", "e", "f"].map((id) => place(id)),
    place("h1", { types: ["halal_restaurant"], travelMin: { p1: 30, p2: 30, p3: 30 } }),
    place("h2", { types: ["halal_restaurant"], travelMin: { p1: 30, p2: 30, p3: 30 } }),
  ];
  const halal: PersonPreferences = { version: 1, dietary: ["halal"] };

  it("LEAK: in a pair, a count of one tells the person who can come that the other cannot", () => {
    // p1 said nothing and knows it, so the one who cannot come is p2. No name is needed.
    const result = chosen(group([NOTHING, halal], pool.slice(0, 6)));
    expect(result.cannotCome).toBe(1);
  });

  it("LEAK: in a pair, the choice and the length of the list separate 'said nothing' from 'has a hard rule'", () => {
    // p1 can run the public pool through their own wishes: with a partner who said nothing they
    // would get the nearest place and five alternatives. What comes back instead is a far-away
    // halal place and exactly one alternative, the only other halal place. Restricting the
    // alternatives to the same attendance is what keeps the list honest, and it is also what
    // makes its length a signal.
    const expected = chosen(group([NOTHING, NOTHING], pool));
    const actual = chosen(group([NOTHING, halal], pool));
    expect(expected).toMatchObject({ restaurantId: "a", cannotCome: 0 });
    expect(expected.alternatives).toHaveLength(MAX_ALTERNATIVES);
    expect(actual).toMatchObject({ restaurantId: "h1", cannotCome: 0 });
    expect(actual.alternatives.map((x) => x.restaurantId)).toEqual(["h2"]);
  });

  it("LEAK: in a group of three, the same result narrows it to 'one of the other two', and two who compare notes know", () => {
    const actual = chosen(group([NOTHING, NOTHING, halal], pool));
    expect(actual).toMatchObject({ restaurantId: "h1", cannotCome: 0 });
    expect(actual.alternatives.map((x) => x.restaurantId)).toEqual(["h2"]);
    // And a count of two out of three tells the one who can come about both of the others.
    const vegan: PersonPreferences = { version: 1, dietary: ["vegan"] };
    expect(chosen(group([NOTHING, vegan, halal], pool.slice(0, 6))).cannotCome).toBe(2);
  });

  it("LEAK: an alternative, or another time at the same place, can leave out a different person than the choice does", () => {
    // Same count, different absentee. Shown side by side ("also at 19:00"), a person who is free
    // at 18:00 but not 19:00 sees a time listed as equivalent that they know they cannot make,
    // and learns that someone else cannot make 18:00.
    const not18: PersonPreferences = {
      version: 1,
      time: { unavailable: [{ from: "18:00", to: "18:00" }], strength: "mild" },
    };
    const not19: PersonPreferences = {
      version: 1,
      time: { unavailable: [{ from: "19:00", to: "19:00" }], strength: "mild" },
    };
    const input = group([not18, not19], [place("a")]);
    const result = chosen(input);
    expect(result).toMatchObject({ startTime: "18:00", cannotCome: 1 });
    expect(otherStartTimes(rankOptions(input), result)).toEqual(["19:00"]);
  });
});

// ---------------------------------------------------------------------------------------
// The plumbing around the optimizer
// ---------------------------------------------------------------------------------------

describe("the finishing order as the input is assembled", () => {
  const assemble = (...times: (number | null | undefined)[]) =>
    assembleOptimizerInput({
      date: "2026-11-21",
      location: null,
      restaurants: RESTAURANTS.slice(0, 2),
      members: times.map((finishedAt) => ({ prefs: NOTHING, startPoint: null, finishedAt })),
    }).people.map((p) => p.finished);

  it("gives dense ranks, shares a rank between equal times, and skips unknown ones", () => {
    expect(assemble(30, 10, 20)).toEqual([3, 1, 2]);
    expect(assemble(10, 10, 10)).toEqual([1, 1, 1]);
    expect(assemble(50, 10, 50, null, undefined, 10)).toEqual([2, 1, 2, undefined, undefined, 1]);
    expect(assemble(null, undefined)).toEqual([undefined, undefined]);
    expect(assemble(0, -5)).toEqual([2, 1]); // zero is a time, not "unknown"
  });

  // Was a defect: NaN is a "number", its rank came out as 0, and the schema rejected the plan.
  it("treats a time that is not a number as unknown rather than failing the whole plan", () => {
    expect(assemble(Number.NaN, 10)).toEqual([undefined, 1]);
    expect(assemble(Number.POSITIVE_INFINITY, 10, Number.NaN)).toEqual([undefined, 1, undefined]);
  });
});

describe("the finishing order as storage records it", () => {
  beforeEach(() => {
    delete process.env.ANTHROPIC_API_KEY; // the rule-based reader: no model, nothing billed
    resetDbForTests();
  });
  const later = () => new Promise((resolve) => setTimeout(resolve, 5));

  it("keeps a place through a message that changes nothing, and gives it up on one that changes an answer", async () => {
    const alice = await createUser({ email: "alice@adversarial.dev", displayName: "Alice", password: "password123" });
    const bob = await createUser({ email: "bob@adversarial.dev", displayName: "Bob", password: "password123" });
    const event = await createEvent(alice.id, "Saturday dinner", null, "meal", "2026-11-21");
    await joinEvent(event.inviteCode, bob.id);
    const state = async () => {
      const { input, ready } = await loadOptimizerInput(event.id);
      return { order: input.people.map((p) => p.finished), ready };
    };
    await sendMessage(event.id, alice.id, "dinner works, I'm vegetarian, under $40");
    await sendMessage(event.id, bob.id, "lunch or dinner, no restrictions");
    await setReady(event.id, alice.id, true);
    await later();
    await setReady(event.id, bob.id, true);
    expect(await state()).toEqual({ order: [1, 2], ready: 2 });

    // Saying the same thing again changes no answer: Alice stays ready and stays first.
    await later();
    const same = await sendMessage(event.id, alice.id, "dinner works, I'm vegetarian, under $40");
    const unchanged = JSON.stringify(same.constraints);
    expect(await state()).toEqual({ order: [1, 2], ready: 2 });

    // A new answer un-readies her and gives up her place; Bob is now the only one with a place.
    await later();
    const changed = await sendMessage(event.id, alice.id, "actually make it under $15, and I can't do Chinese food");
    expect(JSON.stringify(changed.constraints)).not.toBe(unchanged);
    expect(await state()).toEqual({ order: [undefined, 1], ready: 1 });

    // Ready again: she is after Bob now.
    await later();
    await setReady(event.id, alice.id, true);
    expect(await state()).toEqual({ order: [2, 1], ready: 2 });
  });
});
