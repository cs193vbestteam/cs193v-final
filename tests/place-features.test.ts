import { describe, expect, it } from "vitest";
import { describeState, emptyMemberState } from "@/lib/member-state";
import { UNKNOWN_SATISFACTION, UNSURE_NEED_PENALTY, canAttend, optimize, satisfaction } from "@/lib/optimizer";
import { OptimizerInputSchema, toCandidate, type OptimizerInput } from "@/lib/optimizer-handoff";
import {
  CandidateRestaurantSchema,
  FEATURES,
  PersonPreferencesSchema,
  START_TIMES,
  type CandidateRestaurant,
  type Feature,
  type PersonPreferences,
} from "@/lib/optimizer-input";
import { PLACE_FIELDS, WELL_RATED, featuresOf, toPlace, type PlaceResult } from "@/lib/places";

/**
 * What a place offers (room for a group, a table outside, step-free access…), from Google's own
 * yes/no answers. "Bringing a toddler" and "my dad can't do stairs" used to be notes that
 * changed nothing; now they are read, stored and scored.
 */

const CENTER = { lat: 37.44, lng: -122.16 };
const google = (extra: Partial<PlaceResult>): PlaceResult => ({
  id: "g1",
  displayName: { text: "Test Place" },
  primaryType: "thai_restaurant",
  types: ["thai_restaurant", "restaurant"],
  location: { latitude: 37.44, longitude: -122.16 },
  ...extra,
});

describe("what Google says about a place", () => {
  it("asks Google for each answer", () => {
    for (const f of ["goodForGroups", "outdoorSeating", "accessibilityOptions", "reservable", "parkingOptions"])
      expect(PLACE_FIELDS).toContain(`places.${f}`);
  });

  it("is yes, no, or null when Google does not say: never a guess", () => {
    const f = featuresOf(google({ outdoorSeating: true, allowsDogs: false }));
    expect(f.outdoor).toBe(true);
    expect(f.dogs).toBe(false);
    expect(f.groups).toBeNull();
    expect(f.wheelchair).toBeNull();
    expect(Object.keys(f).sort()).toEqual([...FEATURES].sort());
  });

  it("combines answers that mean the same thing to a person", () => {
    expect(featuresOf(google({ servesWine: true, servesBeer: false })).alcohol).toBe(true);
    expect(featuresOf(google({ servesWine: false, servesBeer: false, servesCocktails: false })).alcohol).toBe(false);
    expect(featuresOf(google({ servesWine: false })).alcohol).toBeNull();
    expect(featuresOf(google({ menuForChildren: true, goodForChildren: false })).kids).toBe(true);
    expect(featuresOf(google({ accessibilityOptions: { wheelchairAccessibleEntrance: false } })).wheelchair).toBe(
      false,
    );
    expect(featuresOf(google({ parkingOptions: { freeStreetParking: true, valetParking: false } })).parking).toBe(true);
    expect(featuresOf(google({ parkingOptions: { freeStreetParking: false } })).parking).toBe(false);
  });

  it("calls a place well rated only on enough reviews", () => {
    expect(featuresOf(google({ rating: WELL_RATED, userRatingCount: 500 })).well_rated).toBe(true);
    expect(featuresOf(google({ rating: 4.0, userRatingCount: 500 })).well_rated).toBe(false);
    expect(featuresOf(google({ rating: 5, userRatingCount: 3 })).well_rated).toBeNull();
    expect(featuresOf(google({})).well_rated).toBeNull();
  });

  it("travels from the Google result to the optimizer's candidate", () => {
    const place = toPlace(google({ outdoorSeating: true }), CENTER)!;
    const c = toCandidate({ ...place, open: ["18:00"] }, { p1: 5 });
    expect(c.features?.outdoor).toBe(true);
    expect(CandidateRestaurantSchema.parse(c)).toEqual(c);
    // A pool stored before this was kept has no answers at all, and is still valid.
    const old = { ...place, features: undefined };
    expect(toCandidate({ ...old, open: ["18:00"] }, { p1: 5 }).features).toBeUndefined();
  });
});

const place = (id: string, features?: Partial<Record<Feature, boolean | null>>): CandidateRestaurant => ({
  id,
  name: id,
  types: ["restaurant"],
  style: ["casual"],
  price: { low: 20, high: 30 },
  servesVegetarian: true,
  ...(features ? { features } : {}),
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
const needs = (...needed: Feature[]): PersonPreferences => ({ version: 1, features: { needed, strength: "mild" } });
const wants = (strength: "mild" | "strong", ...wanted: Feature[]): PersonPreferences => ({
  version: 1,
  features: { wanted, strength },
});

describe("the format", () => {
  it("needs something in it, and nothing both needed and wanted", () => {
    const ok = (features: unknown) => PersonPreferencesSchema.safeParse({ version: 1, features }).success;
    expect(ok({ needed: ["wheelchair"], wanted: ["outdoor"], strength: "mild" })).toBe(true);
    expect(ok({ strength: "mild" })).toBe(false);
    expect(ok({ needed: ["wheelchair"], wanted: ["wheelchair"], strength: "mild" })).toBe(false);
    expect(ok({ wanted: ["a nice view"], strength: "mild" })).toBe(false);
  });
});

describe("something a person cannot go without", () => {
  const STEPS = place("steps", { wheelchair: false });
  const RAMP = place("ramp", { wheelchair: true });
  const UNKNOWN = place("unknown", { wheelchair: null });
  const OLD = place("old");

  it("keeps them out only where Google says the place lacks it", () => {
    const p = needs("wheelchair");
    expect(canAttend(p, STEPS, "18:00")).toBe(false);
    expect(canAttend(p, RAMP, "18:00")).toBe(true);
    expect(canAttend(p, UNKNOWN, "18:00")).toBe(true);
    expect(canAttend(p, OLD, "18:00")).toBe(true);
  });

  it("prefers a known yes to a maybe", () => {
    const p = needs("wheelchair");
    expect(satisfaction(p, "p1", RAMP, "18:00")).toBe(1);
    expect(satisfaction(p, "p1", UNKNOWN, "18:00")).toBeCloseTo(1 - UNSURE_NEED_PENALTY);
    expect(optimize(group([p, NOTHING], [UNKNOWN, RAMP, STEPS]))).toMatchObject({
      restaurantId: "ramp",
      cannotCome: 0,
    });
  });

  it("is counted, not hidden, when no place has it", () => {
    const result = optimize(group([needs("wheelchair"), NOTHING], [STEPS]));
    expect(result).toMatchObject({ restaurantId: "steps", cannotCome: 1 });
  });
});

describe("something a person would like", () => {
  const PATIO = place("patio", { outdoor: true });
  const INDOORS = place("indoors", { outdoor: false });
  const UNSAID = place("unsaid", { outdoor: null });

  it("is scored and keeps nobody out", () => {
    const p = wants("strong", "outdoor");
    expect(canAttend(p, INDOORS, "18:00")).toBe(true);
    const s = (r: CandidateRestaurant) => satisfaction(p, "p1", r, "18:00");
    expect(s(PATIO)).toBe(1);
    expect(s(UNSAID)).toBeGreaterThan(s(INDOORS));
    expect(s(PATIO)).toBeGreaterThan(s(UNSAID));
    expect(1 - s(UNSAID)).toBeCloseTo((1 - s(INDOORS)) * (1 - UNKNOWN_SATISFACTION));
  });

  it("steers the group to a place that has it", () => {
    expect(optimize(group([wants("mild", "outdoor"), NOTHING], [INDOORS, PATIO])).restaurantId).toBe("patio");
  });

  it("asking for several things does not make the place count for more than asking for one", () => {
    const one = wants("strong", "outdoor");
    const three = wants("strong", "outdoor", "alcohol", "reservable");
    const none = place("none", { outdoor: false, alcohol: false, reservable: false });
    expect(satisfaction(three, "p1", none, "18:00")).toBe(satisfaction(one, "p1", none, "18:00"));
  });

  it("shares one dimension with the kind of place, at the stronger of the two strengths", () => {
    const p: PersonPreferences = {
      version: 1,
      style: { wanted: ["fine_dining"], strength: "mild" },
      features: { wanted: ["outdoor"], strength: "strong" },
    };
    const half = { ...place("half", { outdoor: true }), style: ["casual" as const] };
    const strongOnly = wants("strong", "outdoor");
    // Half of what was asked for about the place is met, at the strong rate.
    expect(1 - satisfaction(p, "p1", half, "18:00")).toBeCloseTo(
      (1 - satisfaction(strongOnly, "p1", place("x", { outdoor: false }), "18:00")) / 2,
    );
  });

  it("'tastes good' prefers a well-reviewed place", () => {
    const good = place("good", { well_rated: true });
    const fine = place("fine", { well_rated: false });
    expect(optimize(group([wants("mild", "well_rated"), NOTHING], [fine, good])).restaurantId).toBe("good");
  });
});

describe("the owner's summary", () => {
  it("says what they need and what they would like in plain words", () => {
    const state = {
      ...emptyMemberState(),
      prefs: PersonPreferencesSchema.parse({
        version: 1,
        features: { needed: ["wheelchair"], wanted: ["outdoor", "well_rated"], strength: "strong" },
      }),
    };
    const lines = describeState(state);
    expect(lines).toContain("Needs: a step-free entrance");
    expect(lines).toContain("Nice to have: outdoor seating, well reviewed (matters a lot)");
  });
});
