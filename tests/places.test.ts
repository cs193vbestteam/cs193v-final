import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SLOTS } from "@/lib/constraints";
import {
  haversineKm,
  inferCuisine,
  openSlots,
  resolvePool,
  toPool,
  toRestaurant,
  type PlaceResult,
} from "@/lib/places";

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

describe("resolvePool", () => {
  const geocodeResponse = { places: [{ location: { latitude: CENTER.lat, longitude: CENTER.lng } }] };
  const fakeFetch = (nearby: unknown) =>
    vi.fn(async (url: RequestInfo | URL) => {
      const body = String(url).includes("searchText") ? geocodeResponse : nearby;
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

  it("uses the seed when there is no location or no key", async () => {
    expect(await resolvePool(null, "k")).toMatchObject({ source: "seed", reason: "no location given" });
    expect(await resolvePool("Palo Alto", undefined)).toMatchObject({
      source: "seed",
      reason: "no GOOGLE_PLACES_API_KEY",
    });
  });

  it("geocodes, fetches nearby places and maps them", async () => {
    const f = fakeFetch(fixture);
    const pool = await resolvePool("Stanford, CA", "k", f);
    expect(pool.source).toBe("places");
    if (pool.source !== "places") throw new Error();
    expect(pool.center).toEqual(CENTER);
    expect(pool.restaurants).toHaveLength(5);
    expect(f).toHaveBeenCalledTimes(2);
    const [, init] = (f as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[1];
    expect((init.headers as Record<string, string>)["X-Goog-Api-Key"]).toBe("k");
    expect((init.headers as Record<string, string>)["X-Goog-FieldMask"]).toContain("places.regularOpeningHours");
  });

  it("falls back when too few places map, when the place is unknown, or when the API errors", async () => {
    expect(await resolvePool("Stanford", "k", fakeFetch({ places: fixture.places.slice(0, 2) }))).toMatchObject({
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
  });
});
