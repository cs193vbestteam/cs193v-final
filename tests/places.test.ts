import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SLOTS } from "@/lib/constraints";
import type { Cuisine } from "@/lib/constraints";
import { openOn, openStartTimes } from "@/lib/opening-hours";
import {
  MIN_RATING,
  MIN_REVIEWS,
  PLACE_FIELDS,
  haversineKm,
  inferCuisine,
  mergePools,
  resolvePool,
  toPlace,
  toPlaces,
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

describe("opening hours from a Places result", () => {
  // 2026-11-20 is a Friday, 2026-11-21 a Saturday, 2026-11-22 a Sunday.
  const openOnDate = (id: string, date: string) => openOn(toRestaurant(byId(id), CENTER)!, date).open;

  it("leaves `open` empty until the plan's date is known", () => {
    expect(toRestaurant(byId("ChIJ_sushi"), CENTER)!.open).toEqual([]);
  });
  it("has no start times when hours are unknown: unknown is not open", () => {
    const noHours = toRestaurant({ ...byId("ChIJ_sushi"), regularOpeningHours: undefined }, CENTER)!;
    expect(openOn(noHours, "2026-11-21").open).toEqual([]);
  });
  it("reads dinner-only hours on the days the place opens, and nothing on the others", () => {
    // Closes at 23:00, so 22:00 is the last start that leaves an hour.
    const dinner = ["17:00", "18:00", "19:00", "20:00", "21:00", "22:00"];
    expect(openOnDate("ChIJ_sushi", "2026-11-20")).toEqual(dinner);
    expect(openOnDate("ChIJ_sushi", "2026-11-21")).toEqual(dinner);
    expect(openOnDate("ChIJ_sushi", "2026-11-22")).toEqual([]);
  });
  it("reads lunch and dinner on Fri/Sat/Sun", () => {
    for (const date of ["2026-11-20", "2026-11-21", "2026-11-22"]) {
      const open = openOnDate("ChIJ_taqueria", date);
      expect(open).toEqual(expect.arrayContaining(["12:00", "13:00", "18:00", "19:00", "20:00"]));
    }
  });
  it("handles a period that wraps past midnight", () => {
    const saturday = openOnDate("ChIJ_latenight", "2026-11-21");
    expect(saturday).toEqual(expect.arrayContaining(["19:00", "22:00", "23:00"]));
    expect(saturday).not.toContain("12:00");
  });
  it("treats a period with no close as open all week", () => {
    expect(openOnDate("ChIJ_247", "2026-11-23")).toEqual([...SLOTS]);
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
  });
  it("keeps Google's opening hours, and leaves them out when Google gives none", () => {
    const withHours = toRestaurant(byId("ChIJ_sushi"), CENTER)!;
    expect(withHours.hours?.length).toBeGreaterThan(0);
    // 2026-11-21 is a Saturday: open for dinner, not lunch.
    const saturday = openStartTimes(withHours.hours, "2026-11-21")!;
    expect(saturday).toContain("19:00");
    expect(saturday).not.toContain("12:00");

    const noHours = toRestaurant({ ...byId("ChIJ_sushi"), regularOpeningHours: undefined }, CENTER)!;
    expect(noHours.hours).toBeUndefined();
    expect(openStartTimes(noHours.hours, "2026-11-21")).toBeNull();
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

/** Which query a Nearby Search request is: "general", or the types it asks for joined by commas. */
function queryOf(init?: RequestInit): string {
  const types = (JSON.parse(String(init?.body)) as { includedTypes: string[] }).includedTypes;
  return types.length === 1 && types[0] === "restaurant" ? "general" : types.join(",");
}

const GEOCODE_RESPONSE = { places: [{ location: { latitude: CENTER.lat, longitude: CENTER.lng } }] };
const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

/**
 * A fetch that answers geocoding, then each Nearby Search query from `pages`
 * (a missing page is an empty result). Queries named in `failing` get a 500.
 */
function placesFetch(pages: Record<string, { places: PlaceResult[] }>, failing: string[] = []) {
  const queries: string[] = [];
  const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url).includes("searchText")) return json(GEOCODE_RESPONSE);
    const q = queryOf(init);
    queries.push(q);
    if (failing.includes(q)) return new Response("backend error", { status: 500 });
    return json(pages[q] ?? { places: [] });
  });
  return { fetcher: fetcher as unknown as typeof fetch, queries, mock: fetcher };
}

const RECORDED = { general: fixture };

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

describe("resolvePool", () => {
  it("uses the seed when there is no location or no key", async () => {
    expect(await resolvePool(null, "k")).toMatchObject({ source: "seed", reason: "no location given" });
    expect(await resolvePool("Palo Alto", undefined)).toMatchObject({
      source: "seed",
      reason: "no GOOGLE_PLACES_API_KEY",
    });
  });

  it("geocodes, then makes exactly one general search and maps it", async () => {
    const { fetcher, mock, queries } = placesFetch(RECORDED);
    const pool = await resolvePool("Stanford, CA", "k", fetcher);
    expect(pool.source).toBe("places");
    if (pool.source !== "places") throw new Error();
    expect(pool.center).toEqual(CENTER);
    expect(pool.restaurants.map((r) => r.id)).toEqual(toPlaces(fixture.places, CENTER).map((r) => r.id));
    expect(queries).toEqual(["general"]); // what the group wants is not known yet (#101)
    expect(mock).toHaveBeenCalledTimes(2); // geocode + one nearby search
    const [, init] = mock.mock.calls[1];
    const headers = init!.headers as Record<string, string>;
    expect(headers["X-Goog-Api-Key"]).toBe("k");
    expect(headers["X-Goog-FieldMask"]).toContain("places.regularOpeningHours");
    expect((JSON.parse(String(init!.body)) as { maxResultCount: number }).maxResultCount).toBe(20);
  });

  it("keeps a place the current engine has no cuisine for, without counting it as usable", async () => {
    const french: PlaceResult = {
      id: "fr1",
      displayName: { text: "Chez Nous" },
      primaryType: "french_restaurant",
      types: ["french_restaurant", "restaurant"],
      location: { latitude: 37.43, longitude: -122.17 },
    };
    expect(toRestaurant(french, CENTER)).toBeNull();
    expect(toPlace(french, CENTER)).toMatchObject({
      id: "fr1",
      cuisine: null,
      types: ["french_restaurant", "restaurant"],
    });
    expect(toPool([french], CENTER)).toEqual([]);
    const { fetcher } = placesFetch({ general: { places: [...fixture.places, french] } });
    const pool = await resolvePool("Stanford, CA", "k", fetcher);
    if (pool.source !== "places") throw new Error();
    expect(pool.restaurants.map((r) => r.id)).toContain("fr1");
    const onlyFrench = placesFetch({ general: { places: [french] } });
    expect(await resolvePool("Stanford", "k", onlyFrench.fetcher)).toMatchObject({
      source: "seed",
      reason: "only 0 usable places nearby",
    });
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
    const nearbyDown = placesFetch(RECORDED, ["general"]);
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

  it("asks Google for the rating fields", () => {
    expect(PLACE_FIELDS).toContain("places.rating");
    expect(PLACE_FIELDS).toContain("places.businessStatus");
  });

  it("the mediator tries the better-reviewed of two otherwise identical places first", () => {
    const twin = (id: string, rating?: number, ratingCount?: number): Restaurant => ({
      ...restaurant(id, "thai"),
      ...(rating !== undefined ? { rating, ratingCount } : {}),
    });
    const pool = candidatePool(
      [twin("plain"), twin("loved", 4.8, 900), twin("meh", 3.6, 900), twin("new", 5, 2)],
      ["18:00"],
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
