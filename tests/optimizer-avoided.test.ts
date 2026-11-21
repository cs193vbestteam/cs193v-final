import { describe, expect, it } from "vitest";
import { matchCuisine } from "@/lib/cuisine-table";
import { AVOIDED_FACTOR, canAttend, optimize, satisfaction } from "@/lib/optimizer";
import { OptimizerInputSchema, type OptimizerInput } from "@/lib/optimizer-handoff";
import {
  PersonPreferencesSchema,
  START_TIMES,
  type CandidateRestaurant,
  type PersonPreferences,
} from "@/lib/optimizer-input";

/**
 * Food someone would rather not have ("not a fan of Indian", "nothing too spicy") is a wish:
 * it costs a place points and keeps nobody out. Food they will not eat stays a hard rule.
 */

const place = (id: string, types: string[]): CandidateRestaurant => ({
  id,
  name: id,
  types: [...types, "restaurant"],
  style: ["casual"],
  price: { low: 20, high: 30 },
  servesVegetarian: true,
  openAt: ["18:00", "19:00"],
  travelMin: {},
});
function group(people: PersonPreferences[], candidates: CandidateRestaurant[]): OptimizerInput {
  const ids = people.map((_, i) => `p${i + 1}`);
  return OptimizerInputSchema.parse({
    plan: { date: "2026-11-21", startTimes: [...START_TIMES], anchor: { label: "Test", lat: 37.43, lng: -122.17 } },
    people: people.map((prefs, i) => ({ id: ids[i], prefs })),
    candidates: candidates.map((c) => ({ ...c, travelMin: Object.fromEntries(ids.map((id) => [id, 10])) })),
  });
}
const NOTHING: PersonPreferences = { version: 1 };
const INDIAN = place("indian", ["indian_restaurant"]);
const ITALIAN = place("italian", ["italian_restaurant"]);
const avoids = (types: string[]): PersonPreferences => ({ version: 1, cuisine: { avoided: types, strength: "mild" } });

describe("the format", () => {
  it("accepts food to avoid beside food wanted and food ruled out", () => {
    const p = {
      version: 1,
      cuisine: {
        scores: { thai_restaurant: 1 },
        excluded: ["seafood_restaurant"],
        avoided: ["indian_restaurant"],
        strength: "mild",
      },
    };
    expect(PersonPreferencesSchema.parse(p)).toEqual(p);
  });

  it("refuses a kind of food that is both avoided and wanted, or both avoided and ruled out", () => {
    const bad = (cuisine: Record<string, unknown>) =>
      PersonPreferencesSchema.safeParse({ version: 1, cuisine: { ...cuisine, strength: "mild" } }).success;
    expect(bad({ scores: { thai_restaurant: 1 }, avoided: ["thai_restaurant"] })).toBe(false);
    expect(bad({ excluded: ["thai_restaurant"], avoided: ["thai_restaurant"] })).toBe(false);
    expect(bad({ avoided: ["thai_restaurant", "thai_restaurant"] })).toBe(false);
  });

  it("matching reports avoided on its own, and covers the dishes of an avoided cuisine", () => {
    expect(matchCuisine(["indian_restaurant"], { avoided: ["indian_restaurant"] })).toEqual({
      excluded: false,
      avoided: true,
      score: 0,
    });
    expect(matchCuisine(["hot_pot_restaurant"], { avoided: ["chinese_restaurant"] }).avoided).toBe(true);
    expect(matchCuisine(["italian_restaurant"], { avoided: ["indian_restaurant"] }).avoided).toBe(false);
  });
});

describe("in the optimizer", () => {
  it("never keeps the person out: only food ruled out does", () => {
    expect(canAttend(avoids(["indian_restaurant"]), INDIAN, "18:00")).toBe(true);
    const ruledOut: PersonPreferences = {
      version: 1,
      cuisine: { excluded: ["indian_restaurant"], strength: "mild" },
    };
    expect(canAttend(ruledOut, INDIAN, "18:00")).toBe(false);
  });

  it("costs the place points for that person, and no other place anything", () => {
    const p = avoids(["indian_restaurant"]);
    expect(satisfaction(p, "p1", INDIAN, "18:00")).toBeLessThan(1);
    expect(satisfaction(p, "p1", ITALIAN, "18:00")).toBe(1);
    // A mild wish: the same size of loss as a mild wish for a cuisine that is not met.
    const wants: PersonPreferences = { version: 1, cuisine: { scores: { thai_restaurant: 1 }, strength: "mild" } };
    expect(satisfaction(p, "p1", INDIAN, "18:00")).toBe(satisfaction(wants, "p1", ITALIAN, "18:00"));
  });

  it("steers the group elsewhere when somewhere else is as good for everyone", () => {
    const input = group([avoids(["indian_restaurant"]), NOTHING], [INDIAN, ITALIAN]);
    const result = optimize(input);
    expect(result.restaurantId).toBe("italian");
    if (result.restaurantId !== null) expect(result.cannotCome).toBe(0);
  });

  it("still goes there when it is the only place, with everyone able to come", () => {
    const result = optimize(group([avoids(["indian_restaurant"]), NOTHING], [INDIAN]));
    expect(result).toMatchObject({ restaurantId: "indian", cannotCome: 0 });
  });

  it("is outweighed by someone else's strong wish for that food: a mild dislike is not a veto", () => {
    const loves: PersonPreferences = {
      version: 1,
      cuisine: { scores: { indian_restaurant: 1 }, strength: "strong" },
    };
    const result = optimize(group([avoids(["indian_restaurant"]), loves], [INDIAN, ITALIAN]));
    expect(result.restaurantId).toBe("indian");
  });

  it("a place that is both food they asked for and food they would rather not have is worth half its match", () => {
    const p: PersonPreferences = {
      version: 1,
      cuisine: { scores: { vietnamese_restaurant: 1 }, avoided: ["thai_restaurant"], strength: "strong" },
    };
    const both = place("both", ["vietnamese_restaurant", "thai_restaurant"]);
    const only = place("only", ["vietnamese_restaurant"]);
    const neither = place("neither", ["italian_restaurant"]);
    const s = (r: CandidateRestaurant) => satisfaction(p, "p1", r, "18:00");
    expect(s(only)).toBe(1);
    expect(s(both)).toBeLessThan(s(only));
    expect(s(both)).toBeGreaterThan(s(neither));
    expect(AVOIDED_FACTOR).toBe(0.5);
  });
});
