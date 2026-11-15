import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SLOTS } from "@/lib/constraints";
import { haversineKm } from "@/lib/geo";
import { makeRng } from "../sim/rng";
import { openSlots, priceBand, restaurantsInCity, toRestaurant, type YelpRestaurant } from "../sim/yelp/businesses";
import {
  FILES,
  parseFriends,
  stringField,
  type YelpBusiness,
  type YelpReview,
  type YelpUser,
} from "../sim/yelp/dataset";
import { formGroups, friendGraph, poolAround, toCase } from "../sim/yelp/groups";
import { loadCity, missingFiles } from "../sim/yelp/load";
import { MIN_REVIEWS, derivePersona, splitVisits, validate, type Visit } from "../sim/yelp/personas";
import { runYelp, type YelpInput } from "../sim/yelp/pipeline";
import { toMarkdown, toStdout } from "../sim/yelp/report";

/**
 * A miniature dataset in the Yelp Open Dataset's shape: one town, a few dozen
 * restaurants and a dozen reviewers with clear tastes. No real Yelp data is
 * used in the tests.
 */
const CENTRE = { lat: 40.0, lng: -75.0 };

const business = (over: Partial<YelpBusiness> & { business_id: string }): YelpBusiness => ({
  name: `Place ${over.business_id}`,
  city: "Testville",
  state: "PA",
  latitude: CENTRE.lat,
  longitude: CENTRE.lng,
  is_open: 1,
  attributes: { RestaurantsPriceRange2: "2" },
  categories: "Restaurants, Italian",
  hours: { Friday: "11:0-22:0", Saturday: "11:0-22:0", Sunday: "11:0-22:0" },
  ...over,
});

const KINDS: [string, 1 | 2 | 3 | 4][] = [
  ["Japanese, Sushi Bars", 3],
  ["Mexican, Tacos", 1],
  ["Italian, Pizza", 2],
  ["Thai", 2],
  ["American (New), Burgers", 1],
  ["Indian", 2],
];

/** 60 restaurants on a grid about 0.5 km apart; six kinds, cycling. */
function town(): YelpBusiness[] {
  const out: YelpBusiness[] = [];
  for (let i = 0; i < 60; i++) {
    const [categories, price] = KINDS[i % KINDS.length];
    out.push(
      business({
        business_id: `b${String(i).padStart(2, "0")}`,
        latitude: CENTRE.lat + (Math.floor(i / 10) - 3) * 0.005,
        longitude: CENTRE.lng + ((i % 10) - 5) * 0.006,
        categories: `Restaurants, ${categories}`,
        attributes: { RestaurantsPriceRange2: String(price) },
      }),
    );
  }
  return out;
}

/** Each reviewer loves one kind, pans another, and writes 30 reviews in date order. */
function reviewsAndUsers(businesses: YelpBusiness[], nUsers = 12): { reviews: YelpReview[]; users: YelpUser[] } {
  const rng = makeRng(99);
  const reviews: YelpReview[] = [];
  const users: YelpUser[] = [];
  for (let u = 0; u < nUsers; u++) {
    const loves = u % KINDS.length;
    const pans = (u + 1) % KINDS.length;
    for (let k = 0; k < 30; k++) {
      // Mostly the kind they love, sometimes the one they pan, sometimes anything.
      const roll = rng.next();
      const kind = roll < 0.6 ? loves : roll < 0.8 ? pans : rng.int(0, KINDS.length - 1);
      const b = businesses[kind + KINDS.length * rng.int(0, 9)];
      const stars = kind === loves ? 5 : kind === pans ? 1 : 3;
      reviews.push({
        user_id: `u${String(u).padStart(2, "0")}`,
        business_id: b.business_id,
        stars,
        date: `2020-${String(1 + Math.floor(k / 3)).padStart(2, "0")}-${String(1 + (k % 3) * 9).padStart(2, "0")} 12:00:00`,
      });
    }
    // A ring of friends plus one chord, so groups of 3..6 can form.
    const id = (n: number) => `u${String((n + nUsers) % nUsers).padStart(2, "0")}`;
    users.push({ user_id: id(u), friends: [id(u - 1), id(u + 1), id(u + 3)].join(", ") });
  }
  return { reviews, users };
}

function input(): YelpInput {
  const businesses = town();
  const { reviews, users } = reviewsAndUsers(businesses);
  const restaurants = restaurantsInCity(businesses, "Testville");
  const visitsByUser = new Map<string, Visit[]>();
  for (const r of reviews) {
    const restaurant = restaurants.get(r.business_id)!;
    visitsByUser.set(r.user_id, [...(visitsByUser.get(r.user_id) ?? []), { restaurant, stars: r.stars, date: r.date }]);
  }
  const friendsOf = new Map(users.map((u) => [u.user_id, parseFriends(u.friends)]));
  return { city: "Testville", restaurants, visitsByUser, friendsOf };
}

describe("businesses → restaurants", () => {
  it("maps categories, price band, coordinates and flags", () => {
    const r = toRestaurant(
      business({
        business_id: "x",
        categories: "Sushi Bars, Japanese, Restaurants, Seafood",
        attributes: { RestaurantsPriceRange2: "3" },
      }),
    )!;
    expect(r).toMatchObject({ id: "x", cuisine: "japanese", pricePerPerson: 55, priceLevel: 3, seafoodHeavy: true });
    expect(r.location).toEqual(CENTRE);
    expect(r.isOpen).toBe(true);
    expect(toRestaurant(business({ business_id: "v", categories: "Restaurants, Indian, Vegan, Halal" }))).toMatchObject(
      {
        cuisine: "indian",
        spicy: true,
        vegetarianFriendly: true,
        halal: true,
      },
    );
  });

  it("drops what the app cannot model", () => {
    expect(toRestaurant(business({ business_id: "a", categories: "Hair Salons, Beauty & Spas" }))).toBeNull();
    expect(toRestaurant(business({ business_id: "b", categories: "Restaurants, Ethiopian" }))).toBeNull();
    expect(toRestaurant(business({ business_id: "c", attributes: null }))).toBeNull();
    expect(toRestaurant(business({ business_id: "d", attributes: { RestaurantsPriceRange2: "None" } }))).toBeNull();
    expect(toRestaurant(business({ business_id: "e", latitude: null }))).toBeNull();
    expect(toRestaurant(business({ business_id: "f", categories: null }))).toBeNull();
    // No hours at all: we cannot say when it is open, so it is never a candidate.
    expect(toRestaurant(business({ business_id: "g", hours: null }))).toBeNull();
    expect(toRestaurant(business({ business_id: "h", hours: {} }))).toBeNull();
  });

  it("keeps a place that is closed on the plan's day, with no start times for it", () => {
    const weekdays = business({ business_id: "w", hours: { Monday: "11:0-22:0" } });
    expect(toRestaurant(weekdays, "2026-11-21")!.open).toEqual([]); // a Saturday
    expect(toRestaurant(weekdays, "2026-11-23")!.open).toContain("12:00"); // a Monday
  });

  it("reads the price band only when it is 1..4", () => {
    expect(priceBand({ attributes: { RestaurantsPriceRange2: "4" } })).toBe(4);
    expect(priceBand({ attributes: { RestaurantsPriceRange2: "5" } })).toBeNull();
    expect(priceBand({ attributes: {} })).toBeNull();
  });

  it("turns opening hours into the start times of a day", () => {
    const hours = { Friday: "17:0-23:0", Saturday: "11:0-15:0", Sunday: "0:0-0:0" };
    // A start time needs the place open for the hour after it.
    expect(openSlots(hours, "2026-11-20")).toEqual(["17:00", "18:00", "19:00", "20:00", "21:00", "22:00"]);
    expect(openSlots(hours, "2026-11-21")).toEqual(["11:00", "12:00", "13:00", "14:00"]);
    // "0:0-0:0" is the dataset's way of writing open all day.
    expect(openSlots(hours, "2026-11-22")).toEqual([...SLOTS]);
    // Unknown hours are not open hours.
    expect(openSlots(null)).toEqual([]);
    // Closes after midnight.
    expect(openSlots({ Saturday: "18:0-2:0" }, "2026-11-21")).toEqual([
      "18:00",
      "19:00",
      "20:00",
      "21:00",
      "22:00",
      "23:00",
    ]);
    expect(openSlots({ Saturday: "not hours" }, "2026-11-21")).toEqual([]);
  });

  it("keeps one city and remembers closed places", () => {
    const all = [
      business({ business_id: "in" }),
      business({ business_id: "shut", is_open: 0 }),
      business({ business_id: "out", city: "Elsewhere" }),
    ];
    const got = restaurantsInCity(all, " testville ");
    expect([...got.keys()]).toEqual(["in", "shut"]);
    expect(got.get("shut")!.isOpen).toBe(false);
  });
});

describe("dataset helpers", () => {
  it("reads a string field without parsing, and friend lists", () => {
    const line = JSON.stringify({ review_id: "r", user_id: "u1", business_id: "b1", stars: 4 });
    expect(stringField(line, "business_id")).toBe("b1");
    expect(stringField(line, "missing")).toBeNull();
    expect(parseFriends("a, b,c")).toEqual(["a", "b", "c"]);
    expect(parseFriends("None")).toEqual([]);
    expect(parseFriends(null)).toEqual([]);
  });

  it("loads one city from the three files, skipping everything else", async () => {
    const dir = mkdtempSync(join(tmpdir(), "yelp-test-"));
    try {
      expect(missingFiles(dir)).toHaveLength(3);
      const businesses = [...town(), business({ business_id: "far", city: "Elsewhere" })];
      const { reviews, users } = reviewsAndUsers(businesses);
      const extra: YelpReview[] = [
        { user_id: "u00", business_id: "far", stars: 5, date: "2021-01-01 00:00:00" },
        { user_id: "drive-by", business_id: "b00", stars: 2, date: "2021-01-01 00:00:00" },
      ];
      const jsonl = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
      writeFileSync(join(dir, FILES.business), jsonl(businesses));
      writeFileSync(join(dir, FILES.review), jsonl([...reviews, ...extra]));
      writeFileSync(join(dir, FILES.user), jsonl([...users, { user_id: "drive-by", friends: "u00" }]));
      expect(missingFiles(dir)).toEqual([]);

      const notes: string[] = [];
      const loaded = await loadCity(dir, "Testville", (m) => notes.push(m));
      expect(loaded.restaurants.size).toBe(60);
      expect(loaded.visitsByUser.size).toBe(12); // "drive-by" has too few reviews
      expect(loaded.visitsByUser.get("u00")).toHaveLength(30); // the review of "far" is not counted
      expect([...loaded.friendsOf.keys()].sort()).toEqual([...loaded.visitsByUser.keys()].sort());
      expect(loaded.friendsOf.get("u00")).toEqual(["u11", "u01", "u03"]);
      expect(notes).toHaveLength(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("personas", () => {
  const data = input();
  const visits = data.visitsByUser.get("u00")!; // loves Japanese (band 3), pans Mexican (band 1)

  it("needs enough reviews", () => {
    expect(derivePersona("few", visits.slice(0, MIN_REVIEWS - 1), makeRng(1))).toBeNull();
  });

  it("holds out the latest reviews", () => {
    const { train, test } = splitVisits(visits);
    expect(train).toHaveLength(24);
    expect(test).toHaveLength(6);
    const latestTrain = train
      .map((v) => v.date)
      .sort()
      .at(-1)!;
    for (const v of test) expect(v.date >= latestTrain).toBe(true);
  });

  it("reads tastes, budget and reach off the earlier reviews", () => {
    const p = derivePersona("u00", visits, makeRng(1))!;
    const c = p.constraints;
    expect(c.likedCuisines).toContain("japanese");
    expect(c.dislikedCuisines).toContain("mexican");
    expect(c.likedCuisines).not.toContain("mexican");
    // Content at Japanese places in band 3.
    expect(c.budgetMax).toBe(55);
    expect(c.maxTravelMin).toBeGreaterThanOrEqual(8);
    expect(c.maxTravelMin).toBeLessThanOrEqual(45);
    expect(c.dietaryConfirmed).toBe(true);
    expect(c.availableSlots!.length).toBeGreaterThanOrEqual(2);
    expect(c.weights.budget + c.weights.travel + c.weights.cuisine).toBeCloseTo(1);
    expect([...c.concessionOrder!].sort()).toEqual(["budget", "cuisine", "travel"]);
    expect(p.trainVisits).toBe(24);
    expect(p.heldOut).toHaveLength(6);
    // The home point is in the middle of where they eat.
    expect(haversineKm(p.home, CENTRE)).toBeLessThan(5);
  });

  it("marks someone who eats almost only at vegetarian places as vegetarian", () => {
    const veg = toRestaurant(business({ business_id: "veg", categories: "Restaurants, Indian, Vegetarian" }))!;
    const p = derivePersona(
      "v",
      Array.from({ length: 20 }, (_, i) => ({ restaurant: veg, stars: 4, date: `2020-01-${10 + i} 12:00:00` })),
      makeRng(1),
    )!;
    expect(p.constraints.dietary).toEqual(["vegetarian"]);
  });

  it("is the same persona for the same reviews and seed", () => {
    expect(derivePersona("u00", visits, makeRng(5))).toEqual(derivePersona("u00", visits, makeRng(5)));
  });

  it("says more about later reviews than chance does", () => {
    const rng = makeRng(3);
    const personas = [...data.visitsByUser.entries()].map(([id, v]) => derivePersona(id, v, rng)!);
    const v = validate(personas, [...data.restaurants.values()], makeRng(4));
    expect(v.personas).toBe(12);
    expect(v.heldOutVisits).toBe(72);
    expect(v.aucVisitedVsRandom).toBeGreaterThan(0.5);
    expect(v.aucLikedVsDisliked).toBeGreaterThan(0.5);
    expect(v.likedDislikedPairs).toBeGreaterThan(0);
    // The made-up reviewers keep going to the kind they pan, whatever it costs, so the hard-rule
    // rates are only checked for being rates; the real data is where that comparison means something.
    for (const rate of [v.hardPassVisited, v.hardPassRandom]) {
      expect(rate).toBeGreaterThan(0);
      expect(rate).toBeLessThanOrEqual(1);
    }
  });
});

describe("friend groups and pools", () => {
  const data = input();
  const rng = makeRng(2);
  const personas = [...data.visitsByUser.entries()].map(([id, v]) => derivePersona(id, v, rng)!);
  const city = [...data.restaurants.values()];

  it("keeps only friendships between people with a persona, both ways", () => {
    const some = personas.slice(0, 4); // u00..u03
    const graph = friendGraph(some, data.friendsOf);
    expect(graph.get("u00")).toEqual(["u01", "u03"]); // u11 has no persona here
    expect(graph.get("u03")).toContain("u00");
    for (const [id, friends] of graph) for (const f of friends) expect(graph.get(f)).toContain(id);
  });

  it("grows distinct groups along the graph, within the size range", () => {
    const graph = friendGraph(personas, data.friendsOf);
    const groups = formGroups(graph, makeRng(7), 10, 3, 6);
    expect(groups.length).toBe(10);
    expect(new Set(groups.map((g) => [...g].sort().join("|"))).size).toBe(10);
    for (const g of groups) {
      expect(g.length).toBeGreaterThanOrEqual(3);
      expect(g.length).toBeLessThanOrEqual(6);
      expect(new Set(g).size).toBe(g.length);
      // Every member after the first is a friend of someone added before them.
      for (let i = 1; i < g.length; i++) expect(g.slice(0, i).some((m) => graph.get(m)!.includes(g[i]))).toBe(true);
    }
    expect(formGroups(graph, makeRng(7), 10, 3, 6)).toEqual(groups);
  });

  it("forms nothing when nobody has an eligible friend", () => {
    expect(formGroups(friendGraph(personas, new Map()), makeRng(1), 5)).toEqual([]);
  });

  it("draws a pool of open restaurants near the group", () => {
    const withClosed: YelpRestaurant[] = city.map((r, i) => (i < 5 ? { ...r, isOpen: false } : r));
    const pool = poolAround(CENTRE, withClosed, makeRng(1), 20);
    expect(pool).toHaveLength(20);
    expect(pool.every((r) => r.isOpen)).toBe(true);
    expect(new Set(pool.map((r) => r.id)).size).toBe(20);
    // Too few within the radius: the nearest ones instead.
    const tiny = poolAround(CENTRE, withClosed, makeRng(1), 10, 0.001);
    expect(tiny).toHaveLength(10);
  });

  it("builds a case the harness can run, with travel measured from the middle of the group", () => {
    const members = personas.slice(0, 3);
    const c = toCase(0, members, city, makeRng(1), 15);
    expect(c.constraints).toHaveLength(3);
    expect(c.prefs).toHaveLength(3);
    expect(c.restaurants).toHaveLength(15);
    for (const r of c.restaurants) {
      expect(r.travelMin).toBeGreaterThanOrEqual(3);
      expect(r).not.toHaveProperty("location"); // no per-person travel in the harness
      expect(r).not.toHaveProperty("priceLevel");
    }
  });
});

describe("the Yelp pipeline", () => {
  it("is reproducible and bounded by the oracle", async () => {
    const a = await runYelp(input(), { groups: 8, seed: 11, restaurants: 20 });
    const b = await runYelp(input(), { groups: 8, seed: 11, restaurants: 20 });
    expect(a).toEqual(b);
    expect(a.meta).toMatchObject({ city: "Testville", groupsRequested: 8, groupsFormed: 8, restaurantsPerGroup: 20 });
    expect(a.data).toMatchObject({ restaurants: 60, openRestaurants: 60, reviewers: 12, personas: 12 });
    expect(a.groups).toHaveLength(8);
    for (const g of a.groups) {
      expect(g.restaurantCount).toBe(20);
      expect(g.oracle.bestNash).toBeGreaterThanOrEqual(g.protocol.nash);
      for (const r of [g.protocol.nashRatio, g.protocol.maxMinRatio, g.naive.nashRatio]) {
        if (r !== undefined) {
          expect(r).toBeGreaterThanOrEqual(0);
          expect(r).toBeLessThanOrEqual(1);
        }
      }
    }
    expect(a.yelp.overall.groups).toBe(8);
    expect(a.synthetic!.overall).toMatchObject({ label: "synthetic", groups: 8 });
    expect((await runYelp(input(), { groups: 8, seed: 12, restaurants: 20 })).groups).not.toEqual(a.groups);
  });

  it("reports honestly when no groups can be formed", async () => {
    const lonely = { ...input(), friendsOf: new Map<string, string[]>() };
    const r = await runYelp(lonely, { groups: 5, seed: 1 });
    expect(r.meta.groupsFormed).toBe(0);
    expect(r.synthetic).toBeNull();
    expect(r.yelp.overall.groups).toBe(0);
    expect(toMarkdown(r)).toContain("0 groups of real friends (5 requested)");
  });

  it("renders the comparison", async () => {
    const r = await runYelp(input(), { groups: 6, seed: 3, restaurants: 20 });
    const md = toMarkdown(r);
    expect(md).toContain("# Settle on the Yelp Open Dataset: Testville");
    expect(md).toContain("## Do the personas predict later behaviour?");
    expect(md).toContain("| yelp | 6 |");
    expect(md).toContain("| synthetic | 6 |");
    expect(toStdout(r)).toContain("Testville: 60 restaurants, 12 personas, 6 of 6 groups formed");
  });
});
