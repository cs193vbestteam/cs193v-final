import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { canAttend, optimize, otherStartTimes, rankOptions, satisfaction } from "@/lib/optimizer";
import {
  MAX_ALTERNATIVES,
  OptimizerInputSchema,
  OptimizerResultSchema,
  checkResult,
  type OptimizerInput,
} from "@/lib/optimizer-handoff";
import { START_TIMES, type CandidateRestaurant, type PersonPreferences } from "@/lib/optimizer-input";

const SAMPLE = OptimizerInputSchema.parse(
  JSON.parse(readFileSync(path.resolve(__dirname, "fixtures/optimizer-input.sample.json"), "utf8")),
);
const copy = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

/** A small made-up input: the people given, and places that differ only in what the test is about. */
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
function group(people: PersonPreferences[], candidates: CandidateRestaurant[]): OptimizerInput {
  const ids = people.map((_, i) => `p${i + 1}`);
  return OptimizerInputSchema.parse({
    plan: { date: "2026-11-21", startTimes: [...START_TIMES], anchor: { label: "Test", lat: 37.43, lng: -122.17 } },
    people: people.map((prefs, i) => ({ id: ids[i], prefs })),
    candidates: candidates.map((c) => ({
      ...c,
      travelMin: Object.fromEntries(ids.map((id) => [id, c.travelMin[id] ?? 10])),
    })),
  });
}
const chosen = (input: OptimizerInput) => {
  const result = optimize(input);
  expect(OptimizerResultSchema.safeParse(result).success).toBe(true);
  expect(checkResult(input, result)).toEqual([]);
  if (result.restaurantId === null) throw new Error("no choice");
  return result;
};
const NOTHING: PersonPreferences = { version: 1 };

describe("the sample input", () => {
  it("gets a plan everyone can come to, at the place one of them named", () => {
    const result = chosen(SAMPLE);
    // Two halal places suit all four at 18:00 and 19:00; p3 asked for sample-01 by name.
    expect(result).toMatchObject({ restaurantId: "sample-01", startTime: "18:00", cannotCome: 0 });
  });

  it("offers other restaurants that the same number of people can come to", () => {
    const result = chosen(SAMPLE);
    expect(result.alternatives.length).toBeGreaterThan(0);
    expect(result.alternatives.length).toBeLessThanOrEqual(MAX_ALTERNATIVES);
    expect(result.alternatives.every((a) => a.cannotCome === result.cannotCome)).toBe(true);
    // Only two places suit all four, so there is one alternative: the other place, once.
    expect(result.alternatives.map((a) => `${a.restaurantId}@${a.startTime}`)).toEqual(["sample-64@18:00"]);
    expect(otherStartTimes(rankOptions(SAMPLE), result)).toEqual(["19:00"]);
  });

  it("does not depend on the order of the restaurants", () => {
    const shuffled = copy(SAMPLE);
    shuffled.candidates.reverse();
    expect(optimize(shuffled)).toEqual(optimize(SAMPLE));
  });

  it("is not changed by a person who said nothing", () => {
    const without = copy(SAMPLE);
    without.people.pop(); // p4 has no preferences
    for (const c of without.candidates) delete c.travelMin.p4;
    const a = chosen(SAMPLE);
    const b = chosen(without);
    expect([b.restaurantId, b.startTime]).toEqual([a.restaurantId, a.startTime]);
  });

  it("counts as coming only people whose hard rules the option keeps", () => {
    for (const option of rankOptions(SAMPLE).slice(0, 200)) {
      const r = SAMPLE.candidates.find((c) => c.id === option.restaurantId)!;
      const out = SAMPLE.people.filter((p) => !canAttend(p.prefs, r, option.startTime)).length;
      expect(option.cannotCome).toBe(out);
    }
  });

  it("returns the closest plan, with a count, when no place suits everyone", () => {
    const noHalal = copy(SAMPLE);
    noHalal.candidates = noHalal.candidates.filter((c) => !c.types.includes("halal_restaurant"));
    expect(chosen(noHalal).cannotCome).toBe(1);
  });
});

describe("hard rules", () => {
  it("never sends someone to a time they are unavailable when another time works", () => {
    const busy: PersonPreferences = {
      version: 1,
      time: { unavailable: [{ from: "18:00", to: "18:00" }], strength: "mild" },
    };
    expect(chosen(group([busy, NOTHING], [place("a")]))).toMatchObject({ startTime: "19:00", cannotCome: 0 });
  });

  it("keeps a vegetarian out of a place with no vegetarian food, but not out of one Google is silent about", () => {
    const veg: PersonPreferences = { version: 1, dietary: ["vegetarian"] };
    expect(canAttend(veg, place("a", { servesVegetarian: false }), "18:00")).toBe(false);
    expect(canAttend(veg, place("a", { servesVegetarian: null }), "18:00")).toBe(true);
    const input = group([veg], [place("unknown", { servesVegetarian: null }), place("known")]);
    expect(chosen(input).restaurantId).toBe("known");
  });

  it("reads halal and vegan from the Google type", () => {
    const halal: PersonPreferences = { version: 1, dietary: ["halal"] };
    const vegan: PersonPreferences = { version: 1, dietary: ["vegan"] };
    expect(canAttend(halal, place("a"), "18:00")).toBe(false);
    expect(canAttend(halal, place("a", { types: ["halal_restaurant"] }), "18:00")).toBe(true);
    expect(canAttend(vegan, place("a"), "18:00")).toBe(false);
    expect(canAttend(vegan, place("a", { types: ["vegetarian_restaurant"] }), "18:00")).toBe(true);
  });

  it("keeps a person out of a cuisine, kind of place or restaurant they ruled out", () => {
    const prefs: PersonPreferences = {
      version: 1,
      cuisine: { excluded: ["chinese_restaurant"], strength: "mild" },
      style: { excluded: ["bar"], strength: "mild" },
      excludedRestaurants: [{ name: "Nope", id: "nope" }],
    };
    // A dish inherits its cuisine's ban (cuisine-table.ts).
    expect(canAttend(prefs, place("a", { types: ["hot_pot_restaurant"] }), "18:00")).toBe(false);
    expect(canAttend(prefs, place("a", { style: ["casual", "bar"] }), "18:00")).toBe(false);
    expect(canAttend(prefs, place("nope"), "18:00")).toBe(false);
    expect(canAttend(prefs, place("fine"), "18:00")).toBe(true);
  });

  it("leaves out the fewest people, before it looks at how happy anyone is", () => {
    const veg: PersonPreferences = { version: 1, dietary: ["vegetarian"] };
    const steak: PersonPreferences = {
      version: 1,
      cuisine: { scores: { steak_house: 1 }, strength: "strong" },
    };
    const input = group(
      [veg, steak, steak],
      [place("steak", { types: ["steak_house"], servesVegetarian: false }), place("other")],
    );
    expect(chosen(input)).toMatchObject({ restaurantId: "other", cannotCome: 0 });
  });
});

describe("strength", () => {
  const japanese = (strength: "must" | "strong" | "mild"): PersonPreferences => ({
    version: 1,
    cuisine: { scores: { japanese_restaurant: 1 }, strength },
  });
  const indian = (strength: "must" | "strong" | "mild"): PersonPreferences => ({
    version: 1,
    cuisine: { scores: { indian_restaurant: 1 }, strength },
  });
  const places = [place("j", { types: ["japanese_restaurant"] }), place("i", { types: ["indian_restaurant"] })];

  it("lets a strong wish win over a mild one", () => {
    expect(chosen(group([japanese("strong"), indian("mild")], places)).restaurantId).toBe("j");
    expect(chosen(group([japanese("mild"), indian("strong")], places)).restaurantId).toBe("i");
  });

  it("treats must as the heaviest weight: it wins over two strong wishes", () => {
    const input = group([japanese("must"), indian("strong"), indian("strong")], places);
    expect(chosen(input)).toMatchObject({ restaurantId: "j", cannotCome: 0 });
  });

  it("settles two musts that contradict each other without leaving anyone out", () => {
    const result = chosen(group([japanese("must"), indian("must")], places));
    expect(result.cannotCome).toBe(0);
    // Equal and opposite: the tie goes by id, and the other place is the alternative.
    expect(result.restaurantId).toBe("i");
    expect(result.alternatives[0].restaurantId).toBe("j");
  });

  it("does not leave someone out for a must budget, but goes a long way to keep it", () => {
    const tight: PersonPreferences = { version: 1, budget: { max: 25, strength: "must" } };
    const fancy: PersonPreferences = { version: 1, style: { wanted: ["fine_dining"], strength: "strong" } };
    const dear = place("dear", { style: ["fine_dining"], price: { low: 80, high: 120 } });
    expect(canAttend(tight, dear, "18:00")).toBe(true);
    expect(chosen(group([tight, fancy], [dear, place("cheap", { price: { low: 10, high: 20 } })])).restaurantId).toBe(
      "cheap",
    );
  });

  it("moves a person only a little for one mild wish", () => {
    const prefs = indian("mild");
    expect(satisfaction(prefs, "p1", places[1], "18:00")).toBe(1);
    expect(satisfaction(prefs, "p1", places[0], "18:00")).toBeCloseTo(0.9);
  });
});

describe("what Google does not say", () => {
  it("can still choose a place with no price", () => {
    const prefs: PersonPreferences = { version: 1, budget: { ideal: 20, max: 40, strength: "strong" } };
    expect(chosen(group([prefs], [place("a", { price: null })])).restaurantId).toBe("a");
  });

  it("prefers a place whose price is known to fit", () => {
    const prefs: PersonPreferences = { version: 1, budget: { ideal: 30, max: 40, strength: "strong" } };
    expect(chosen(group([prefs], [place("a", { price: null }), place("b")])).restaurantId).toBe("b");
  });

  it("never chooses a place with unknown hours, and says so when there is nothing else", () => {
    const input = group([NOTHING], [place("a", { openAt: null })]);
    const result = optimize(input);
    expect(result).toEqual({ restaurantId: null, reason: "no_candidates" });
    expect(checkResult(input, result)).toEqual([]);
  });
});

describe("ties", () => {
  const mexican: PersonPreferences = { version: 1, cuisine: { scores: { mexican_restaurant: 1 }, strength: "strong" } };
  // Google tags the burger chain Mexican too, so both score the same for someone who asked for Mexican.
  const chain = place("a-chain", {
    types: ["hamburger_restaurant", "mexican_restaurant"],
    primaryType: "hamburger_restaurant",
    travelMin: { p1: 3 },
  });
  const taqueria = place("z-taqueria", { types: ["mexican_restaurant"], primaryType: "mexican_restaurant" });

  it("go first to the place whose main type is what somebody asked for, ahead of the shorter trip", () => {
    const input = group([mexican], [chain, taqueria]);
    const [first, second] = rankOptions(input);
    expect(first.welfare).toBe(second.welfare);
    expect(chosen(input).restaurantId).toBe("z-taqueria");
  });

  it("count a dish as its cuisine: a taco place for someone who asked for Mexican", () => {
    const tacos = place("z-tacos", { types: ["taco_restaurant"], primaryType: "taco_restaurant" });
    expect(chosen(group([mexican], [chain, tacos])).restaurantId).toBe("z-tacos");
  });

  it("never let the main type outweigh a better score or a person who cannot come", () => {
    const veg: PersonPreferences = { version: 1, dietary: ["vegetarian"] };
    const noVeg = { ...taqueria, servesVegetarian: false };
    expect(chosen(group([mexican, veg], [chain, noVeg]))).toMatchObject({ restaurantId: "a-chain", cannotCome: 0 });
    const dear: PersonPreferences = { version: 1, budget: { max: 25, strength: "strong" } };
    const pricey = { ...taqueria, price: { low: 60, high: 80 } };
    expect(chosen(group([mexican, dear], [chain, pricey])).restaurantId).toBe("a-chain");
  });

  it("skip that step for a pool that does not say which type is the main one", () => {
    const oldChain = { ...chain, primaryType: undefined };
    const oldTaqueria = { ...taqueria, primaryType: undefined };
    expect(chosen(group([mexican], [oldChain, oldTaqueria])).restaurantId).toBe("a-chain"); // the shorter trip
  });

  it("list the alternatives best first, each at its own best time", () => {
    const prefs: PersonPreferences = {
      version: 1,
      time: { preferred: [{ from: "19:00", to: "19:00" }], strength: "strong" },
      cuisine: { scores: { mexican_restaurant: 1 }, strength: "strong" },
    };
    const result = chosen(group([prefs], [place("b-other"), taqueria, place("a-other")]));
    expect([result, ...result.alternatives].map((a) => `${a.restaurantId}@${a.startTime}`)).toEqual([
      "z-taqueria@19:00",
      "a-other@19:00",
      "b-other@19:00",
    ]);
  });

  it("go to the shorter trip, then to 18:00", () => {
    const near = place("z-near", { travelMin: { p1: 5, p2: 5 } });
    expect(chosen(group([NOTHING, NOTHING], [place("a-far"), near]))).toMatchObject({
      restaurantId: "z-near",
      startTime: "18:00",
    });
  });

  it("never lists a restaurant twice, even when that leaves the list short", () => {
    const input = group([NOTHING], [place("a"), place("b")]);
    const result = chosen(input);
    expect(result).toMatchObject({ restaurantId: "a", startTime: "18:00" });
    expect(result.alternatives.map((a) => `${a.restaurantId}@${a.startTime}`)).toEqual(["b@18:00"]);
    // The other time each place can take is said beside it, not as another recommendation.
    expect(otherStartTimes(rankOptions(input), result)).toEqual(["19:00"]);
    expect(otherStartTimes(rankOptions(input), result.alternatives[0])).toEqual(["19:00"]);
  });

  it("leaves out of a place's other times any that fewer people can come to", () => {
    const busy: PersonPreferences = {
      version: 1,
      time: { unavailable: [{ from: "19:00", to: "19:00" }], strength: "mild" },
    };
    const input = group([busy], [place("a", { openAt: ["18:00", "19:00", "20:00"] })]);
    expect(otherStartTimes(rankOptions(input), chosen(input))).toEqual(["20:00"]);
  });
});
