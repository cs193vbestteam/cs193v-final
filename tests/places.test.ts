import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SLOTS } from "@/lib/constraints";
import { CUISINES, type Cuisine } from "@/lib/constraints";
import {
  CUISINE_QUERY_TYPES,
  MAX_NEARBY_CALLS,
  MIN_RATING,
  MIN_REVIEWS,
  PLACE_FIELDS,
  POOL_TARGET,
  cuisineQueryOrder,
  gatherPlaces,
  haversineKm,
  inferCuisine,
  mergePools,
  openSlots,
  resolvePool,
  toPool,
  toRestaurant,
  type PlaceResult,
} from "@/lib/places";
import { candidatePool, shortlist } from "@/lib/mediator";
import { summarize } from "@/lib/pool";
import type { Restaurant } from "@/lib/restaurants";

const fixture = JSON.parse(readFileSync(path.join(__dirname, "fixtures/places-nearby.json"), "utf8")) as {
  places: PlaceResult[];
};
const byCuisine = JSON.parse(readFileSync(path.join(__dirname, "fixtures/places-by-cuisine.json"), "utf8")) as Partial<
  Record<Cuisine, { places: PlaceResult[] }>
>;
const CENTER = { lat: 37.4275, lng: -122.1697 }; // Stanford
const byId = (id: string) => fixture.places.find((p) => p.id === id)!;

describe("inferCuisine", () => {
  it.each([
    [["sushi_restaurant"], "japanese"],
    [["dim_sum_restaurant"], "chinese"],
    [["turkish_restaurant"], "mediterranean"],
    [["hamburger_restaurant"], "american"],
    [["restaurant", "food"], null],
  ])("%j → %s", (types, expected) => {
    expect(inferCuisine(types)).toBe(expected);
  });
  it("falls back to the name", () => {
    expect(inferCuisine(["restaurant"], "Pho Corner")).toBe("vietnamese");
  });
});

describe("openSlots", () => {
  it("assumes open when hours are unknown", () => {
    expect(openSlots(undefined)).toEqual([...SLOTS]);
  });
  it("reads dinner-only hours", () => {
    expect(openSlots(byId("ChIJ_sushi").regularOpeningHours)).toEqual(["fri_dinner", "sat_dinner"]);
  });
  it("reads lunch and dinner on Fri/Sat/Sun", () => {
    expect(openSlots(byId("ChIJ_taqueria").regularOpeningHours)).toEqual([...SLOTS]);
  });
  it("handles a period that wraps past midnight", () => {
    expect(openSlots(byId("ChIJ_latenight").regularOpeningHours)).toEqual(["sat_dinner"]);
  });
  it("treats a period with no close as open all week", () => {
    expect(openSlots(byId("ChIJ_247").regularOpeningHours)).toEqual([...SLOTS]);
  });
});

describe("toRestaurant", () => {
  it("maps price level, travel time, flags and hours", () => {
    const r = toRestaurant(byId("ChIJ_sushi"), CENTER)!;
    expect(r).toMatchObject({
      id: "ChIJ_sushi",
      name: "Sakura Omakase",
      cuisine: "japanese",
      pricePerPerson: 55,
      travelMin: 3,
      seafoodHeavy: true,
      vegetarianFriendly: false,
      spicy: false,
      halal: false,
    });
    expect(r.open).toEqual(["fri_dinner", "sat_dinner"]);
  });
  it("estimates travel from distance at city speed", () => {
    const r = toRestaurant(byId("ChIJ_thai"), CENTER)!;
    const km = haversineKm(CENTER, { lat: 37.42, lng: -122.2 });
    expect(km).toBeGreaterThan(2.5);
    expect(r.travelMin).toBe(Math.round(km / (25 / 60)));
    expect(r).toMatchObject({ cuisine: "thai", spicy: true, pricePerPerson: 30 });
  });
  it("reads halal from the types and vegetarian from the Places flag", () => {
    expect(toRestaurant(byId("ChIJ_latenight"), CENTER)).toMatchObject({ halal: true, cuisine: "mediterranean" });
    expect(toRestaurant(byId("ChIJ_taqueria"), CENTER)).toMatchObject({ vegetarianFriendly: true, pricePerPerson: 15 });
  });
  it("drops places without a cuisine we model or without a location", () => {
    expect(toRestaurant(byId("ChIJ_unknown"), CENTER)).toBeNull();
    expect(toRestaurant(byId("ChIJ_noloc"), CENTER)).toBeNull();
  });
});

describe("toPool", () => {
  it("keeps order, drops duplicates and unmappable places", () => {
    const pool = toPool(fixture.places, CENTER);
    expect(pool.map((r) => r.id)).toEqual(["ChIJ_sushi", "ChIJ_taqueria", "ChIJ_thai", "ChIJ_latenight", "ChIJ_247"]);
  });
});

/** Which query a Nearby Search request is: "general" or the cuisine whose types it asks for. */
function queryOf(init?: RequestInit): "general" | Cuisine {
  const types = (JSON.parse(String(init?.body)) as { includedTypes: string[] }).includedTypes;
  if (types.length === 1 && types[0] === "restaurant") return "general";
  const cuisine = CUISINES.find((c) => CUISINE_QUERY_TYPES[c].join() === types.join());
  if (!cuisine) throw new Error(`unexpected includedTypes ${types.join()}`);
  return cuisine;
}

const GEOCODE_RESPONSE = { places: [{ location: { latitude: CENTER.lat, longitude: CENTER.lng } }] };
const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

/**
 * A fetch that answers geocoding, then each Nearby Search query from `pages`
 * (a missing page is an empty result). Queries named in `failing` get a 500.
 */
function placesFetch(
  pages: Partial<Record<"general" | Cuisine, { places: PlaceResult[] }>>,
  failing: ("general" | Cuisine)[] = [],
) {
  const queries: ("general" | Cuisine)[] = [];
  const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url).includes("searchText")) return json(GEOCODE_RESPONSE);
    const q = queryOf(init);
    queries.push(q);
    if (failing.includes(q)) return new Response("backend error", { status: 500 });
    return json(pages[q] ?? { places: [] });
  });
  return { fetcher: fetcher as unknown as typeof fetch, queries, mock: fetcher };
}

const RECORDED = { general: fixture, ...byCuisine };
const GENERAL_IDS = ["ChIJ_sushi", "ChIJ_taqueria", "ChIJ_thai", "ChIJ_latenight", "ChIJ_247"];

const restaurant = (id: string, cuisine: Cuisine): Restaurant => ({
  id,
  name: id,
  cuisine,
  pricePerPerson: 30,
  travelMin: 10,
  spicy: false,
  vegetarianFriendly: false,
  seafoodHeavy: false,
  halal: false,
  open: [...SLOTS],
});

/** A full Nearby Search page of 20 distinct places of one Places type. */
const fullPage = (type: string, prefix: string) => ({
  places: Array.from({ length: 20 }, (_, i): PlaceResult => ({
    id: `${prefix}_${i}`,
    displayName: { text: `${prefix} ${i}` },
    primaryType: type,
    types: [type, "restaurant"],
    location: { latitude: 37.43, longitude: -122.17 },
  })),
});

describe("cuisineQueryOrder", () => {
  it("asks first for the cuisines the pool covers least, ties in CUISINES order", () => {
    const pool = [
      restaurant("a", "japanese"),
      restaurant("b", "japanese"),
      restaurant("c", "thai"),
      restaurant("d", "chinese"),
    ];
    const order = cuisineQueryOrder(pool);
    expect(order).toHaveLength(CUISINES.length);
    expect(order.slice(0, 7)).toEqual([
      "korean",
      "vietnamese",
      "indian",
      "mexican",
      "italian",
      "american",
      "mediterranean",
    ]);
    expect(order.slice(7)).toEqual(["chinese", "thai", "japanese"]);
  });
  it("is the plain CUISINES order for an empty pool", () => {
    expect(cuisineQueryOrder([])).toEqual([...CUISINES]);
  });
});

describe("mergePools", () => {
  const base = [restaurant("b1", "thai"), restaurant("b2", "thai")];
  it("keeps the base first, then interleaves the extra lists", () => {
    const merged = mergePools(base, [
      [restaurant("x1", "korean"), restaurant("x2", "korean")],
      [restaurant("y1", "indian")],
    ]);
    expect(merged.map((r) => r.id)).toEqual(["b1", "b2", "x1", "y1", "x2"]);
  });
  it("drops a place id it has already seen, in the base or in another list", () => {
    const merged = mergePools(base, [
      [restaurant("b2", "thai"), restaurant("x1", "korean")],
      [restaurant("x1", "korean"), restaurant("y1", "indian")],
    ]);
    expect(merged.map((r) => r.id)).toEqual(["b1", "b2", "x1", "y1"]);
  });
  it("stops at the cap without starving the later lists", () => {
    const merged = mergePools(
      base,
      [
        [restaurant("x1", "korean"), restaurant("x2", "korean"), restaurant("x3", "korean")],
        [restaurant("y1", "indian"), restaurant("y2", "indian")],
      ],
      5,
    );
    expect(merged.map((r) => r.id)).toEqual(["b1", "b2", "x1", "y1", "x2"]);
  });
});

describe("gatherPlaces", () => {
  it("merges the general page with one page per missing cuisine", async () => {
    const { fetcher, queries } = placesFetch(RECORDED);
    const got = await gatherPlaces(CENTER, "k", fetcher, { maxCalls: 6 });
    // The general page has japanese, mexican, thai, mediterranean and american, so the
    // five cuisine queries go to the five cuisines it lacks.
    expect(queries).toEqual(["general", "chinese", "korean", "vietnamese", "indian", "italian"]);
    expect(got.calls).toBe(6);
    expect(got.failedCalls).toBe(0);
    expect(got.restaurants.map((r) => r.id)).toEqual([
      ...GENERAL_IDS,
      "ChIJ_dumpling",
      "ChIJ_tofu",
      "ChIJ_pho",
      "ChIJ_dosa",
      "ChIJ_sichuan",
      "ChIJ_bbq_hotpot",
      "ChIJ_banhmi",
      "ChIJ_tandoor",
      "ChIJ_trattoria",
      "ChIJ_bibimbap",
      "ChIJ_biryani",
      "ChIJ_slice",
    ]);
  });

  it("keeps one copy of a place returned by several queries", async () => {
    const { fetcher } = placesFetch(RECORDED);
    const ids = (await gatherPlaces(CENTER, "k", fetcher)).restaurants.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.filter((id) => id === "ChIJ_bbq_hotpot")).toHaveLength(1); // on the chinese and the korean page
    expect(ids.filter((id) => id === "ChIJ_247")).toHaveLength(1); // on the general and the italian page
  });

  it("never makes more Nearby Search calls than the cap", async () => {
    for (const maxCalls of [1, 3, MAX_NEARBY_CALLS, 50]) {
      const { fetcher, mock } = placesFetch(RECORDED);
      const got = await gatherPlaces(CENTER, "k", fetcher, { maxCalls });
      const expected = Math.min(maxCalls, 1 + CUISINES.length);
      expect(mock).toHaveBeenCalledTimes(expected);
      expect(got.calls).toBe(expected);
    }
    expect(MAX_NEARBY_CALLS).toBe(1 + CUISINES.length); // the general page, then every cuisine once
  });

  it("makes a single call when the general page already fills the pool", async () => {
    const { fetcher, mock } = placesFetch(RECORDED);
    const got = await gatherPlaces(CENTER, "k", fetcher, { target: 5 });
    expect(mock).toHaveBeenCalledTimes(1);
    expect(got.restaurants.map((r) => r.id)).toEqual(GENERAL_IDS);
  });

  it("trims a large result to the pool target, across every query", async () => {
    const pages = {
      general: fullPage("thai_restaurant", "general"),
      ...Object.fromEntries(CUISINES.map((c) => [c, fullPage(CUISINE_QUERY_TYPES[c][0], c)])),
    };
    const { fetcher, queries } = placesFetch(pages);
    const got = await gatherPlaces(CENTER, "k", fetcher, { maxCalls: 6 });
    expect(got.restaurants).toHaveLength(POOL_TARGET);
    const perQuery = queries.slice(1).map((c) => got.restaurants.filter((r) => r.id.startsWith(`${c}_`)).length);
    expect(perQuery).toEqual([8, 8, 8, 8, 8]); // 20 general + 40 shared evenly by 5 cuisine pages
  });

  it("keeps the rest of the pool when some queries fail", async () => {
    const { fetcher } = placesFetch(RECORDED, ["korean", "indian"]);
    const got = await gatherPlaces(CENTER, "k", fetcher, { maxCalls: 6 });
    expect(got).toMatchObject({ calls: 6, failedCalls: 2 });
    const ids = got.restaurants.map((r) => r.id);
    expect(ids).toEqual(
      expect.arrayContaining([...GENERAL_IDS, "ChIJ_dumpling", "ChIJ_bbq_hotpot", "ChIJ_pho", "ChIJ_trattoria"]),
    );
    expect(ids).not.toContain("ChIJ_tofu");
    expect(ids).not.toContain("ChIJ_dosa");
  });

  it("still builds a pool from the cuisine pages when the general query fails", async () => {
    const { fetcher, queries } = placesFetch(RECORDED, ["general"]);
    const got = await gatherPlaces(CENTER, "k", fetcher);
    expect(queries.slice(1)).toEqual(CUISINES.slice(0, MAX_NEARBY_CALLS - 1));
    expect(got.failedCalls).toBe(1);
    expect(got.restaurants.map((r) => r.id)).toEqual(
      expect.arrayContaining(["ChIJ_dumpling", "ChIJ_tofu", "ChIJ_pho"]),
    );
  });

  it("throws the first error when every query fails", async () => {
    const { fetcher } = placesFetch(RECORDED, ["general", ...CUISINES]);
    await expect(gatherPlaces(CENTER, "k", fetcher)).rejects.toThrow("Places places:searchNearby 500");
  });
});

describe("resolvePool", () => {
  it("uses the seed when there is no location or no key", async () => {
    expect(await resolvePool(null, "k")).toMatchObject({ source: "seed", reason: "no location given" });
    expect(await resolvePool("Palo Alto", undefined)).toMatchObject({
      source: "seed",
      reason: "no GOOGLE_PLACES_API_KEY",
    });
  });

  it("geocodes, gathers nearby places over several queries and maps them", async () => {
    const { fetcher, mock } = placesFetch(RECORDED);
    const pool = await resolvePool("Stanford, CA", "k", fetcher);
    expect(pool.source).toBe("places");
    if (pool.source !== "places") throw new Error();
    expect(pool.center).toEqual(CENTER);
    expect(pool.restaurants).toHaveLength(17);
    expect(pool.restaurants.length).toBeGreaterThan(fixture.places.length);
    expect(pool).toMatchObject({ calls: MAX_NEARBY_CALLS, failedCalls: 0 });
    expect(mock).toHaveBeenCalledTimes(1 + MAX_NEARBY_CALLS); // geocode + nearby
    for (const [, init] of mock.mock.calls.slice(1)) {
      const headers = init!.headers as Record<string, string>;
      expect(headers["X-Goog-Api-Key"]).toBe("k");
      expect(headers["X-Goog-FieldMask"]).toContain("places.regularOpeningHours");
      expect((JSON.parse(String(init!.body)) as { maxResultCount: number }).maxResultCount).toBe(20);
    }
  });

  it("still returns a places pool when one cuisine query fails", async () => {
    const { fetcher } = placesFetch(RECORDED, ["vietnamese"]);
    expect(await resolvePool("Stanford, CA", "k", fetcher)).toMatchObject({ source: "places", failedCalls: 1 });
  });

  it("falls back when too few places map, when the place is unknown, or when the API errors", async () => {
    const few = placesFetch({ general: { places: fixture.places.slice(0, 2) } });
    expect(await resolvePool("Stanford", "k", few.fetcher)).toMatchObject({
      source: "seed",
      reason: "only 2 usable places nearby",
    });
    const noGeo = vi.fn(
      async () => new Response(JSON.stringify({ places: [] }), { status: 200 }),
    ) as unknown as typeof fetch;
    expect(await resolvePool("Atlantis", "k", noGeo)).toMatchObject({ source: "seed", reason: "location not found" });
    const boom = vi.fn(async () => new Response("nope", { status: 403 })) as unknown as typeof fetch;
    expect(await resolvePool("Stanford", "k", boom)).toMatchObject({
      source: "seed",
      reason: "Places places:searchText 403",
    });
    const nearbyDown = placesFetch(RECORDED, ["general", ...CUISINES]);
    expect(await resolvePool("Stanford", "k", nearbyDown.fetcher)).toMatchObject({
      source: "seed",
      reason: "Places places:searchNearby 500",
    });
  });
});

describe("ratings, closed places and what the group is shown", () => {
  const sushi = byId("ChIJ_sushi");

  it("carries Google's rating, address and Maps link onto the restaurant", () => {
    const r = toRestaurant(
      {
        ...sushi,
        rating: 4.6,
        userRatingCount: 812,
        businessStatus: "OPERATIONAL",
        formattedAddress: "123 University Ave, Palo Alto, CA",
        googleMapsUri: "https://maps.google.com/?cid=1",
      },
      CENTER,
    )!;
    expect(r).toMatchObject({
      rating: 4.6,
      ratingCount: 812,
      address: "123 University Ave, Palo Alto, CA",
      mapsUrl: "https://maps.google.com/?cid=1",
    });
    // A place Google says nothing more about still maps, without the extra fields.
    const plain = toRestaurant(sushi, CENTER)!;
    expect(plain.rating).toBeUndefined();
    expect(plain.mapsUrl).toBeUndefined();
  });

  it("leaves out places that are closed, and poorly rated ones with enough reviews to trust", () => {
    expect(toRestaurant({ ...sushi, businessStatus: "CLOSED_PERMANENTLY" }, CENTER)).toBeNull();
    expect(toRestaurant({ ...sushi, businessStatus: "CLOSED_TEMPORARILY" }, CENTER)).toBeNull();
    expect(toRestaurant({ ...sushi, rating: MIN_RATING - 0.1, userRatingCount: MIN_REVIEWS }, CENTER)).toBeNull();
    // Three bad reviews are not enough to drop a place; a rating at the bar is kept.
    expect(toRestaurant({ ...sushi, rating: 2.0, userRatingCount: 3 }, CENTER)).not.toBeNull();
    expect(toRestaurant({ ...sushi, rating: MIN_RATING, userRatingCount: 500 }, CENTER)).not.toBeNull();
  });

  it("asks Google for the rating fields, and for every cuisine by default", async () => {
    expect(PLACE_FIELDS).toContain("places.rating");
    expect(PLACE_FIELDS).toContain("places.businessStatus");
    const { fetcher, queries } = placesFetch(RECORDED);
    const got = await gatherPlaces(CENTER, "k", fetcher);
    expect(got.calls).toBe(1 + CUISINES.length);
    expect([...queries.slice(1)].sort()).toEqual([...CUISINES].sort());
  });

  it("the mediator tries the better-reviewed of two otherwise identical places first", () => {
    const twin = (id: string, rating?: number, ratingCount?: number): Restaurant => ({
      ...restaurant(id, "thai"),
      ...(rating !== undefined ? { rating, ratingCount } : {}),
    });
    const pool = candidatePool(
      [twin("plain"), twin("loved", 4.8, 900), twin("meh", 3.6, 900), twin("new", 5, 2)],
      ["sat_dinner"],
    );
    const lookup = (id: string) => pool.find((c) => c.r.id === id)?.r;
    const round2 = [{ round: 1, level: 0, proposals: [] }];
    expect(shortlist(pool, round2, 4, lookup).map((c) => c.r.id)).toEqual(["loved", "plain", "new", "meh"]);
  });

  it("shows the group the chosen place's public facts, and nothing when there are none", () => {
    const rated: Restaurant = {
      ...restaurant("a", "thai"),
      rating: 4.5,
      ratingCount: 120,
      address: "1 Main St",
      mapsUrl: "https://maps.google.com/?cid=2",
    };
    const out = summarize([rated, restaurant("b", "thai")], ["a", "b"]);
    expect(out.a).toMatchObject({ rating: 4.5, ratingCount: 120, address: "1 Main St" });
    expect(out.b).not.toHaveProperty("rating");
    expect(out.b).not.toHaveProperty("mapsUrl");
  });
});
