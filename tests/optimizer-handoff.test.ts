import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { createUser } from "@/lib/auth";
import { resetDbForTests } from "@/lib/db";
import { createEvent, joinEvent, sendMessage, setReady } from "@/lib/events";
import { travelMinutes } from "@/lib/geo";
import {
  MAX_ALTERNATIVES,
  OptimizerInputSchema,
  OptimizerResultSchema,
  SEED_ANCHOR,
  assembleOptimizerInput,
  checkResult,
  toCandidate,
  type HandoffMember,
  type OptimizerResult,
} from "@/lib/optimizer-handoff";
import { START_TIMES, isSelectable, type PersonPreferences } from "@/lib/optimizer-input";
import { loadOptimizerInput } from "@/lib/optimizer-source";
import { openOn } from "@/lib/opening-hours";
import { priceOf, toPool, toRestaurant, type PlaceResult } from "@/lib/places";
import { RESTAURANTS, type Restaurant } from "@/lib/restaurants";

const DATE = "2026-11-21";
const FIXTURE = path.resolve(__dirname, "fixtures/optimizer-input.sample.json");

/**
 * The sample's restaurants: what Google Places returns near Palo Alto, with the places' identities
 * removed (sim/places-sample.ts), turned into a pool the way a real plan's pool is: converted,
 * then kept only if the place can take a start time on the plan's date.
 */
const PLACES = JSON.parse(readFileSync(path.resolve(__dirname, "fixtures/places-sample.json"), "utf8")) as {
  center: { lat: number; lng: number };
  places: PlaceResult[];
};
const SAMPLE_POOL: Restaurant[] = toPool(PLACES.places, PLACES.center)
  .map((r) => openOn(r, DATE))
  .filter((r) => r.open.length > 0);

/** Four people who do not all want the same thing: the sample the optimizer is developed against. */
const SAMPLE_PEOPLE: PersonPreferences[] = [
  {
    version: 1,
    time: { preferred: [{ from: "18:00", to: "19:00" }], strength: "mild" },
    budget: { ideal: 30, max: 45, strength: "must" },
    travel: { idealMin: 10, maxMin: 20, strength: "mild" },
    dietary: [],
    cuisine: { scores: { japanese_restaurant: 1, ramen_restaurant: 1, korean_restaurant: 0.5 }, strength: "strong" },
    priority: ["budget", "cuisine"],
  },
  {
    version: 1,
    time: { unavailable: [{ from: "10:00", to: "17:00" }], strength: "must" },
    dietary: ["vegetarian"],
    cuisine: { scores: { indian_restaurant: 1 }, excluded: ["seafood_restaurant"], strength: "mild" },
    notes: [{ type: "allergy", text: "peanuts" }],
  },
  {
    version: 1,
    time: { unavailable: [{ from: "20:00", to: "23:00" }], strength: "must" },
    budget: { ideal: 60, strength: "mild" },
    travel: { maxMin: 15, strength: "must" },
    dietary: ["halal"],
    style: { excluded: ["fast_food"], strength: "mild" },
    wantedRestaurants: [{ name: SAMPLE_POOL[0].name, id: SAMPLE_POOL[0].id }],
  },
  { version: 1, dietary: [] },
];
const sampleMembers = (): HandoffMember[] => SAMPLE_PEOPLE.map((prefs) => ({ prefs, startPoint: null }));
const sample = () =>
  assembleOptimizerInput({ date: DATE, location: "Palo Alto", restaurants: SAMPLE_POOL, members: sampleMembers() });

const located = (id: string, lat: number, lng: number, extra: Partial<Restaurant> = {}): Restaurant => ({
  ...RESTAURANTS[0],
  id,
  name: id,
  location: { lat, lng },
  travelMin: 7,
  ...extra,
});

describe("assembling the optimizer's input", () => {
  it("gives every person an id that is not their name or account, in the order they joined", () => {
    const input = sample();
    expect(input.people.map((p) => p.id)).toEqual(["p1", "p2", "p3", "p4"]);
    expect(input.people.map((p) => p.prefs)).toEqual(SAMPLE_PEOPLE);
  });

  it("offers every start time of the day on the plan's date", () => {
    const input = sample();
    expect(input.plan.date).toBe(DATE);
    expect(input.plan.startTimes).toEqual([...START_TIMES]);
  });

  it("uses the seed's own anchor when the candidates have no coordinates", () => {
    const seeded = assembleOptimizerInput({
      date: DATE,
      location: null,
      restaurants: RESTAURANTS,
      members: sampleMembers(),
    });
    expect(seeded.plan.anchor).toEqual(SEED_ANCHOR);
  });

  it("puts the anchor in the middle of the candidates and names it after the plan's location", () => {
    const input = assembleOptimizerInput({
      date: DATE,
      location: " Palo Alto ",
      restaurants: [located("a", 37.44, -122.16), located("b", 37.46, -122.14)],
      members: sampleMembers(),
    });
    expect(input.plan.anchor.label).toBe("Palo Alto");
    expect(input.plan.anchor.lat).toBeCloseTo(37.45);
    expect(input.plan.anchor.lng).toBeCloseTo(-122.15);
  });

  it("measures a person from their own start point, and everyone else from the plan's location", () => {
    const start = { lat: 37.33, lng: -121.89 };
    const place = located("far", 37.44, -122.16);
    const input = assembleOptimizerInput({
      date: DATE,
      location: "Palo Alto",
      restaurants: [place],
      members: [
        { prefs: { version: 1 }, startPoint: start },
        { prefs: { version: 1 }, startPoint: null },
      ],
    });
    expect(input.candidates[0].travelMin).toEqual({ p1: travelMinutes(start, place.location!), p2: 7 });
  });

  it("never lets a start point into the input", () => {
    const input = assembleOptimizerInput({
      date: DATE,
      location: "Palo Alto",
      restaurants: [located("a", 37.44, -122.16)],
      members: [{ prefs: { version: 1 }, startPoint: { lat: 37.3312, lng: -121.8911 } }],
    });
    const text = JSON.stringify(input);
    expect(text).not.toMatch(/startPoint|37\.3312|121\.8911/);
  });

  it("uses the pool's figure for a place without coordinates, whatever the person's start point", () => {
    const input = assembleOptimizerInput({
      date: DATE,
      location: null,
      restaurants: [RESTAURANTS[0]],
      members: [{ prefs: { version: 1 }, startPoint: { lat: 37.33, lng: -121.89 } }],
    });
    expect(input.candidates[0].travelMin).toEqual({ p1: RESTAURANTS[0].travelMin });
  });

  it("refuses a plan with nobody in it", () => {
    expect(() =>
      assembleOptimizerInput({ date: DATE, location: null, restaurants: RESTAURANTS, members: [] }),
    ).toThrow();
  });
});

describe("one restaurant in the optimizer's format", () => {
  const travel = { p1: 5 };

  it("takes a seed restaurant's made-up values as known", () => {
    const seed = RESTAURANTS.find((r) => r.id === "noodle-lab")!;
    const c = toCandidate(seed, travel);
    expect(c.price).toEqual({ low: seed.pricePerPerson, high: seed.pricePerPerson });
    expect(c.servesVegetarian).toBe(true);
    expect(c.types).toContain("japanese_restaurant");
    expect(c.openAt).toEqual(seed.open);
    expect(isSelectable(c)).toBe(true);
  });

  it("keeps Google's price range and its answer about vegetarian food", () => {
    const c = toCandidate(
      located("g", 37.4, -122.1, { price: { low: 20, high: 30 }, servesVegetarian: false }),
      travel,
    );
    expect(c.price).toEqual({ low: 20, high: 30 });
    expect(c.servesVegetarian).toBe(false);
  });

  it("says null, not a guess, when Google gave no price and no vegetarian answer", () => {
    const c = toCandidate(located("g", 37.4, -122.1, { price: null, servesVegetarian: null }), travel);
    expect(c.price).toBeNull();
    expect(c.servesVegetarian).toBeNull();
  });

  it("does not read a Google place stored before these fields existed as a known price or a known no", () => {
    const old = located("g", 37.4, -122.1, { vegetarianFriendly: false });
    expect(toCandidate(old, travel).price).toBeNull();
    expect(toCandidate(old, travel).servesVegetarian).toBeNull();
    expect(toCandidate({ ...old, vegetarianFriendly: true }, travel).servesVegetarian).toBe(true);
  });

  it("is not selectable when its hours are unknown", () => {
    const c = toCandidate(located("g", 37.4, -122.1, { hours: undefined, open: [] }), travel);
    expect(c.openAt).toBeNull();
    expect(isSelectable(c)).toBe(false);
  });

  it("is known to be closed, not unknown, when it has hours but none on the day", () => {
    const c = toCandidate(located("g", 37.4, -122.1, { open: [] }), travel);
    expect(c.openAt).toEqual([]);
    expect(isSelectable(c)).toBe(false);
  });

  it("drops anything that is not a Google type name", () => {
    const c = toCandidate(
      located("g", 37.4, -122.1, { types: ["ramen_restaurant", "Not A Type", "ramen_restaurant"] }),
      travel,
    );
    expect(c.types).toEqual(["ramen_restaurant"]);
  });
});

describe("price and vegetarian answer from Google Places", () => {
  const place = (extra: Partial<PlaceResult>): PlaceResult => ({
    id: "g1",
    displayName: { text: "Ramen Place" },
    primaryType: "ramen_restaurant",
    types: ["ramen_restaurant", "japanese_restaurant", "restaurant"],
    location: { latitude: 37.44, longitude: -122.16 },
    ...extra,
  });
  const centre = { lat: 37.44, lng: -122.16 };

  it("reads Google's own range", () => {
    expect(priceOf({ priceRange: { startPrice: { units: "20" }, endPrice: { units: "30" } } })).toEqual({
      low: 20,
      high: 30,
    });
  });

  it("uses the start for both ends of an open-ended range", () => {
    expect(priceOf({ priceRange: { startPrice: { units: "100" } } })).toEqual({ low: 100, high: 100 });
  });

  it("falls back to the price level, then to unknown", () => {
    expect(priceOf({ priceLevel: "PRICE_LEVEL_MODERATE" })).toEqual({ low: 20, high: 40 });
    expect(priceOf({})).toBeNull();
    expect(priceOf({ priceRange: { startPrice: { units: "abc" } } })).toBeNull();
  });

  it("keeps both on the restaurant, with unknown as null", () => {
    const known = toRestaurant(place({ priceLevel: "PRICE_LEVEL_EXPENSIVE", servesVegetarianFood: false }), centre)!;
    expect(known.price).toEqual({ low: 40, high: 70 });
    expect(known.servesVegetarian).toBe(false);
    const unknown = toRestaurant(place({}), centre)!;
    expect(unknown.price).toBeNull();
    expect(unknown.servesVegetarian).toBeNull();
  });
});

describe("the optimizer's result", () => {
  const input = sample();
  const first = input.candidates.find(isSelectable)!;
  const second = input.candidates.filter(isSelectable)[1];
  const good: OptimizerResult = {
    restaurantId: first.id,
    startTime: first.openAt![0],
    cannotCome: 1,
    alternatives: [{ restaurantId: second.id, startTime: second.openAt![0], cannotCome: 2 }],
  };

  it("is a place, a start time, a count of people who cannot come, and alternatives", () => {
    expect(OptimizerResultSchema.parse(good)).toEqual(good);
    expect(checkResult(input, good)).toEqual([]);
  });

  it("has no room for who cannot come", () => {
    expect(OptimizerResultSchema.safeParse({ ...good, whoCannotCome: ["p2"] }).success).toBe(false);
  });

  it("allows at most five alternatives", () => {
    const many = Array.from({ length: MAX_ALTERNATIVES + 1 }, () => good.alternatives[0]);
    expect(OptimizerResultSchema.safeParse({ ...good, alternatives: many }).success).toBe(false);
  });

  it("can say there was nothing to pick from, only when that is true", () => {
    const none: OptimizerResult = { restaurantId: null, reason: "no_candidates" };
    expect(OptimizerResultSchema.parse(none)).toEqual(none);
    expect(checkResult(input, none)).toHaveLength(1);
    expect(checkResult({ ...input, candidates: [] }, none)).toEqual([]);
  });

  it("is rejected when the place is unknown, closed at that time, or listed twice", () => {
    expect(checkResult(input, { ...good, restaurantId: "nowhere" })[0]).toMatch(/not a candidate/);
    const closedAt = START_TIMES.find((t) => !first.openAt!.includes(t))!;
    expect(checkResult(input, { ...good, startTime: closedAt })[0]).toMatch(/cannot take/);
    expect(checkResult(input, { ...good, cannotCome: 9 })[0]).toMatch(/more people/);
    const choice = { restaurantId: good.restaurantId, startTime: good.startTime, cannotCome: good.cannotCome };
    expect(checkResult(input, { ...good, alternatives: [choice] })[0]).toMatch(/twice/);
  });
});

describe("the sample input in tests/fixtures", () => {
  it("has the cases real data brings: unknown prices, unknown vegetarian answers, many types", () => {
    const { candidates } = sample();
    expect(candidates.length).toBeGreaterThan(40);
    expect(candidates.some((c) => c.price === null)).toBe(true);
    expect(candidates.some((c) => c.price !== null && c.price.low < c.price.high)).toBe(true);
    expect(candidates.some((c) => c.servesVegetarian === null)).toBe(true);
    expect(candidates.some((c) => c.servesVegetarian === false)).toBe(true);
    expect(new Set(candidates.flatMap((c) => c.types)).size).toBeGreaterThan(20);
    expect(candidates.every(isSelectable)).toBe(true);
  });

  it("is exactly what the code produces for the sample people and the sample places", () => {
    const built = sample();
    // UPDATE_FIXTURES=1 npm test -- optimizer-handoff   rewrites the file after a deliberate change.
    if (process.env.UPDATE_FIXTURES || !existsSync(FIXTURE))
      writeFileSync(FIXTURE, JSON.stringify(built, null, 2) + "\n");
    const stored = JSON.parse(readFileSync(FIXTURE, "utf8"));
    expect(stored).toEqual(built);
    expect(OptimizerInputSchema.parse(stored)).toEqual(stored);
  });
});

describe("reading a plan out of storage", () => {
  beforeEach(() => {
    delete process.env.ANTHROPIC_API_KEY; // the rule-based reader, so the test needs no model
    resetDbForTests();
  });

  let n = 0;
  const makeUser = (name: string) =>
    createUser({ email: `${name}${n++}@handoff.dev`, displayName: name, password: "password123" });

  it("returns schema-valid input for a plan made through the app, with counts and no identities", async () => {
    const alice = await makeUser("Alice");
    const bob = await makeUser("Bob");
    const event = await createEvent(alice.id, "Saturday dinner", null, "meal", DATE);
    await joinEvent(event.inviteCode, bob.id);
    await sendMessage(event.id, alice.id, "dinner works, I'm vegetarian, under $40");
    await sendMessage(event.id, bob.id, "lunch or dinner, no restrictions");
    await setReady(event.id, alice.id, true);

    const { input, members, ready } = await loadOptimizerInput(event.id);
    expect(members).toBe(2);
    expect(ready).toBe(1);
    expect(OptimizerInputSchema.parse(input)).toEqual(input);
    expect(input.plan.date).toBe(DATE);
    expect(input.people.map((p) => p.id)).toEqual(["p1", "p2"]);
    expect(input.people[0].prefs.dietary).toEqual(["vegetarian"]);
    expect(input.people[0].prefs.budget?.max).toBe(40);
    expect(input.candidates).toHaveLength(RESTAURANTS.length);

    const text = JSON.stringify(input);
    for (const secret of [alice.id, bob.id, "Alice", "Bob", "@handoff.dev", "Saturday dinner", "under $40"])
      expect(text).not.toContain(secret);
  });

  it("refuses a plan that does not exist", async () => {
    await expect(loadOptimizerInput("no-such-plan")).rejects.toThrow();
  });
});

describe("who may read everyone's preferences together", () => {
  const SRC = path.resolve(__dirname, "../src");
  const read = (f: string) => readFileSync(path.join(SRC, f), "utf8");

  it("optimizer-source is server-only and exports one function", () => {
    const src = read("lib/optimizer-source.ts");
    expect(src).toMatch(/import "server-only"/);
    expect([...src.matchAll(/^export (?:async )?function (\w+)/gm)].map((m) => m[1])).toEqual(["loadOptimizerInput"]);
  });

  it("the pure half touches no storage, and no start point leaves it", () => {
    const src = read("lib/optimizer-handoff.ts");
    expect(src).not.toMatch(/from "\.\/(db|crypto|vault|events|auth|session)"/);
  });
});
