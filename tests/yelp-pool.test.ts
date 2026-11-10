import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createUser } from "@/lib/auth";
import { resetDbForTests } from "@/lib/db";
import { createEvent, listMyEvents } from "@/lib/events";
import { haversineKm } from "@/lib/geo";
import { poolForEvent } from "@/lib/pool";
import type { YelpBusiness } from "@/lib/yelp-business";
import {
  BUSINESS_FILE,
  cityPool,
  findCity,
  indexByCity,
  parsePlace,
  resolveYelpPool,
  yelpDatasetDir,
} from "@/lib/yelp-pool";

/** Made-up businesses in the dataset's shape. No real Yelp data is used in the tests. */
const CENTRE = { lat: 39.95, lng: -75.16 };
const KINDS = ["Japanese, Sushi Bars", "Mexican, Tacos", "Italian, Pizza", "Thai", "Burgers", "Indian"];

const business = (over: Partial<YelpBusiness> & { business_id: string }): YelpBusiness => ({
  name: `Place ${over.business_id}`,
  city: "Philadelphia",
  state: "PA",
  latitude: CENTRE.lat,
  longitude: CENTRE.lng,
  is_open: 1,
  attributes: { RestaurantsPriceRange2: "2" },
  categories: "Restaurants, Italian",
  hours: null,
  ...over,
});

/** 90 restaurants in a grid around the centre, six cuisines cycling; a few closed, one far away. */
function philadelphia(): YelpBusiness[] {
  const out: YelpBusiness[] = [];
  for (let i = 0; i < 90; i++)
    out.push(
      business({
        business_id: `p${String(i).padStart(2, "0")}`,
        latitude: CENTRE.lat + (Math.floor(i / 10) - 4) * 0.004,
        longitude: CENTRE.lng + ((i % 10) - 5) * 0.005,
        categories: `Restaurants, ${KINDS[i % KINDS.length]}`,
        is_open: i % 15 === 0 ? 0 : 1,
      }),
    );
  out.push(business({ business_id: "far", latitude: CENTRE.lat + 1, categories: "Restaurants, Thai" }));
  return out;
}

const dataset = (): YelpBusiness[] => [
  ...philadelphia(),
  business({ business_id: "s1", city: "Springfield", state: "IL" }),
  business({ business_id: "s2", city: "Springfield", state: "MO" }),
  business({ business_id: "s3", city: "Springfield", state: "MO" }),
  business({ business_id: "salon", categories: "Hair Salons" }),
];

describe("switching the source on", () => {
  it("is off unless a folder is configured, and always off in production and on Vercel", () => {
    expect(yelpDatasetDir({})).toBeNull();
    expect(yelpDatasetDir({ YELP_DATASET_DIR: "  " })).toBeNull();
    expect(yelpDatasetDir({ YELP_DATASET_DIR: " /data/yelp " })).toBe("/data/yelp");
    expect(yelpDatasetDir({ YELP_DATASET_DIR: "/data/yelp", VERCEL: "1" })).toBeNull();
    // Any host: `next build` and `next start` run with NODE_ENV=production.
    expect(yelpDatasetDir({ YELP_DATASET_DIR: "/data/yelp", NODE_ENV: "production" })).toBeNull();
    expect(yelpDatasetDir({ YELP_DATASET_DIR: "/data/yelp", NODE_ENV: "development" })).toBe("/data/yelp");
    expect(yelpDatasetDir({ YELP_DATASET_DIR: "/data/yelp", NODE_ENV: "test" })).toBe("/data/yelp");
  });
});

describe("finding the city", () => {
  const index = indexByCity(dataset());

  it("reads a city and an optional two-letter state", () => {
    expect(parsePlace("Philadelphia, PA")).toEqual({ city: "philadelphia", state: "pa" });
    expect(parsePlace("  Tampa ")).toEqual({ city: "tampa", state: null });
    expect(parsePlace("Reno, Nevada")).toEqual({ city: "reno", state: null });
  });

  it("indexes only what maps onto a restaurant", () => {
    expect(index.get("philadelphia|pa")).toHaveLength(91);
    expect([...index.keys()].sort()).toEqual(["philadelphia|pa", "springfield|il", "springfield|mo"]);
  });

  it("matches by name, by name and state, and prefers the larger city of a shared name", () => {
    expect(findCity(index, "philadelphia")).toHaveLength(91);
    expect(findCity(index, "Philadelphia, PA")).toHaveLength(91);
    expect(findCity(index, "Springfield, IL")).toHaveLength(1);
    expect(findCity(index, "Springfield")).toHaveLength(2);
    expect(findCity(index, "Philadelphia, NJ")).toBeNull();
    expect(findCity(index, "Palo Alto, CA")).toBeNull();
    expect(findCity(index, "")).toBeNull();
  });
});

describe("the pool for a city", () => {
  const city = indexByCity(dataset()).get("philadelphia|pa")!;

  it("is open, near the middle, capped, varied and repeatable", () => {
    const pool = cityPool(city)!;
    expect(pool.restaurants).toHaveLength(60);
    expect(haversineKm(pool.center, CENTRE)).toBeLessThan(1);
    const ids = pool.restaurants.map((r) => r.id);
    expect(new Set(ids).size).toBe(60);
    expect(ids).not.toContain("far");
    expect(ids).not.toContain("p00"); // closed
    for (const r of pool.restaurants) {
      expect(r.location).toBeDefined();
      expect(r.travelMin).toBeGreaterThanOrEqual(3);
      expect(haversineKm(pool.center, r.location!)).toBeLessThanOrEqual(8);
      expect(r).not.toHaveProperty("isOpen");
      expect(r).not.toHaveProperty("priceLevel");
    }
    // Interleaved across cuisines: the first five are five different cuisines.
    expect(new Set(pool.restaurants.slice(0, 5).map((r) => r.cuisine)).size).toBe(5);
    expect(cityPool(city)).toEqual(pool);
  });

  it("honours a smaller cap and returns nothing for a city with no open restaurants", () => {
    expect(cityPool(city, 10)!.restaurants).toHaveLength(10);
    expect(cityPool(city.map((r) => ({ ...r, isOpen: false })))).toBeNull();
  });
});

describe("reading the dataset from disk", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "yelp-pool-"));
    writeFileSync(
      join(dir, BUSINESS_FILE),
      dataset()
        .map((b) => JSON.stringify(b))
        .join("\n") + "\n",
    );
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  afterEach(() => vi.restoreAllMocks());

  it("resolves a pool for a city in the dataset", async () => {
    const pool = await resolveYelpPool("Philadelphia, PA", dir);
    expect(pool).toMatchObject({ source: "yelp", location: "Philadelphia, PA" });
    expect(pool!.restaurants).toHaveLength(60);
  });

  it("returns null when off, for a place outside the dataset, or with too few restaurants", async () => {
    expect(await resolveYelpPool("Philadelphia", null)).toBeNull();
    expect(await resolveYelpPool(null, dir)).toBeNull();
    expect(await resolveYelpPool("Palo Alto, CA", dir)).toBeNull();
    expect(await resolveYelpPool("Springfield, IL", dir)).toBeNull();
  });

  it("falls back quietly when the file is missing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await resolveYelpPool("Philadelphia", join(dir, "nope"))).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
  });

  describe("creating a plan", () => {
    beforeEach(() => {
      delete process.env.GOOGLE_PLACES_API_KEY;
      delete process.env.VERCEL;
      resetDbForTests();
    });
    afterEach(() => {
      delete process.env.YELP_DATASET_DIR;
    });
    let n = 0;
    const user = () => createUser({ email: `yelp-pool${n++}@test.dev`, displayName: "A", password: "password123" });

    it("uses the dataset for a city it has, and stores the pool on the plan", async () => {
      process.env.YELP_DATASET_DIR = dir;
      const a = await user();
      const e = await createEvent(a.id, "Dinner", "Philadelphia");
      expect(e).toMatchObject({ poolSource: "yelp", poolSize: 60, location: "Philadelphia" });
      expect((await listMyEvents(a.id))[0]).toMatchObject({ poolSource: "yelp", poolSize: 60 });
      const stored = await poolForEvent(e.id);
      expect(stored.source).toBe("yelp");
      expect(stored.restaurants).toHaveLength(60);
    });

    it("ignores the dataset in a production process, even with the folder configured", async () => {
      process.env.YELP_DATASET_DIR = dir;
      vi.stubEnv("NODE_ENV", "production");
      try {
        const a = await user();
        expect((await createEvent(a.id, "Dinner", "Philadelphia")).poolSource).toBe("seed");
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it("leaves other places, and plans made with the source off, on the seed", async () => {
      process.env.YELP_DATASET_DIR = dir;
      const a = await user();
      expect((await createEvent(a.id, "Dinner", "Palo Alto, CA")).poolSource).toBe("seed");
      expect((await createEvent(a.id, "Dinner")).poolSource).toBe("seed");
      delete process.env.YELP_DATASET_DIR;
      expect((await createEvent(a.id, "Dinner", "Philadelphia")).poolSource).toBe("seed");
    });
  });
});
