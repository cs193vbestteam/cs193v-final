import { beforeEach, describe, expect, it, vi } from "vitest";
import { createUser } from "@/lib/auth";
import { encryptJson, scope } from "@/lib/crypto";
import { db, resetDbForTests } from "@/lib/db";
import { createEvent, getMyConstraints, joinEvent, runNegotiation, sendMessage, setReady } from "@/lib/events";
import { emptyMemberState } from "@/lib/member-state";
import type { PersonPreferences } from "@/lib/optimizer-input";
import { loadOptimizerInput } from "@/lib/optimizer-source";
import type { PlaceResult } from "@/lib/places";
import { poolForEvent } from "@/lib/pool";
import {
  MAX_EXTRA_CALLS,
  MAX_NAMED_SEARCHES,
  POOL_CAP,
  addNamedPlaces,
  extendPool,
  namedKey,
  newPoolMeta,
  parsePoolMeta,
  searchPlan,
  wantedTypes,
} from "@/lib/pool-extend";
import { matchRestaurant } from "@/lib/assistant";
import { refreshPool } from "@/lib/pool-refresh";
import type { Place } from "@/lib/restaurants";
import { upcomingSaturday } from "./fixtures/plan-date";

const CENTER = { lat: 37.44, lng: -122.16 };
// A plan made through the app needs a day that has not passed.
const DATE = upcomingSaturday();
const EVERY_DAY = Array.from({ length: 7 }, (_, day) => ({ open: { day, hour: 10 }, close: { day, hour: 23 } }));

/** A page of `n` distinct places of one Google type, open every day unless told otherwise. */
const page = (type: string, n = 3, extra: Partial<PlaceResult> = {}) => ({
  places: Array.from({ length: n }, (_, i): PlaceResult => ({
    id: `${type}_${i}`,
    displayName: { text: `${type} ${i}` },
    primaryType: type,
    types: [type, "restaurant"],
    location: { latitude: 37.44, longitude: -122.16 },
    regularOpeningHours: { periods: EVERY_DAY },
    ...extra,
  })),
});
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

/** A fetch that geocodes to CENTER and answers each Nearby Search by the types it asks for. */
function googleFetch(failing: string[] = [], named: Record<string, { places: PlaceResult[] }> = {}) {
  const queries: string[] = [];
  const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url).includes("searchText")) {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      // Finding the plan's location asks for a location only; a search by name asks for whole places.
      if (headers["X-Goog-FieldMask"] === "places.location")
        return json({ places: [{ location: { latitude: CENTER.lat, longitude: CENTER.lng } }] });
      const name = (JSON.parse(String(init?.body)) as { textQuery: string }).textQuery;
      queries.push(`name:${name}`);
      if (failing.includes(`name:${name}`)) return new Response("backend error", { status: 500 });
      return json(named[name] ?? { places: [] });
    }
    const types = (JSON.parse(String(init?.body)) as { includedTypes: string[] }).includedTypes;
    const q = types.join(",");
    queries.push(q);
    if (failing.includes(q)) return new Response("backend error", { status: 500 });
    if (q === "restaurant") return json(page("thai_restaurant", 8));
    return json(page(types[0]));
  });
  return { fetcher: fetcher as unknown as typeof fetch, queries };
}

const prefs = (extra: Partial<PersonPreferences>): PersonPreferences => ({ version: 1, ...extra });
const likes = (...types: string[]) =>
  prefs({ cuisine: { scores: Object.fromEntries(types.map((t) => [t, 1])), strength: "mild" } });

describe("what the group asked for", () => {
  it("is every type somebody scored as exactly what they want, most wanted first", () => {
    const wanted = wantedTypes([
      likes("korean_restaurant", "french_restaurant"),
      likes("french_restaurant"),
      prefs({ cuisine: { scores: { ramen_restaurant: 1, japanese_restaurant: 0.5 }, strength: "strong" } }),
    ]);
    expect(wanted).toEqual(["french_restaurant", "korean_restaurant", "ramen_restaurant"]);
  });

  it("includes kinds of place, but an ordinary restaurant needs no search of its own", () => {
    expect(wantedTypes([prefs({ style: { wanted: ["fine_dining", "casual"], strength: "mild" } })])).toEqual([
      "fine_dining_restaurant",
    ]);
  });

  it("searches for the places a diet needs, before any cuisine", () => {
    const wanted = wantedTypes([likes("korean_restaurant"), likes("korean_restaurant"), prefs({ dietary: ["halal"] })]);
    expect(wanted).toEqual(["halal_restaurant", "korean_restaurant"]);
  });

  it("a vegan needs vegan or vegetarian places; a vegetarian needs vegetarian ones", () => {
    expect(wantedTypes([prefs({ dietary: ["vegan"] })])).toEqual(["vegan_restaurant", "vegetarian_restaurant"]);
    expect(wantedTypes([prefs({ dietary: ["vegetarian"] })])).toEqual(["vegetarian_restaurant"]);
    // Two people with overlapping diets: the shared type is the most needed and comes first.
    expect(wantedTypes([prefs({ dietary: ["vegan"] }), prefs({ dietary: ["vegetarian"] })])).toEqual([
      "vegetarian_restaurant",
      "vegan_restaurant",
    ]);
  });

  it("does not list a type twice when it is both a diet's and somebody's wish", () => {
    expect(wantedTypes([prefs({ dietary: ["vegan"] }), likes("vegan_restaurant", "thai_restaurant")])).toEqual([
      "vegan_restaurant",
      "vegetarian_restaurant",
      "thai_restaurant",
    ]);
  });

  it("someone with no diet adds no search", () => {
    expect(wantedTypes([prefs({ dietary: [] }), prefs({})])).toEqual([]);
  });

  it("keeps a diet's search single even when there are more cuisines than calls", () => {
    const many = Array.from({ length: 10 }, (_, i) => `c${i}_restaurant`);
    const plan = searchPlan(wantedTypes([likes(...many), prefs({ dietary: ["halal"] })]), newPoolMeta(CENTER));
    expect(plan[0]).toEqual(["halal_restaurant"]);
    expect(plan).toHaveLength(MAX_EXTRA_CALLS);
  });

  it("never searches for what people ruled out, and is empty when nobody asked for anything", () => {
    expect(
      wantedTypes([
        prefs({ cuisine: { excluded: ["indian_restaurant"], strength: "mild" } }),
        prefs({ style: { excluded: ["fast_food"], strength: "mild" } }),
        prefs({}),
      ]),
    ).toEqual([]);
  });

  it("counts a person once per type and gives the same order every time", () => {
    const a = wantedTypes([likes("thai_restaurant"), likes("korean_restaurant")]);
    const b = wantedTypes([likes("korean_restaurant"), likes("thai_restaurant")]);
    expect(a).toEqual(b);
  });
});

describe("which searches to make", () => {
  const meta = newPoolMeta(CENTER);
  const types = (n: number) => Array.from({ length: n }, (_, i) => `t${i}_restaurant`);

  it("is one per type when they fit", () => {
    expect(searchPlan(types(3), meta)).toEqual([["t0_restaurant"], ["t1_restaurant"], ["t2_restaurant"]]);
  });

  it("puts the overflow together in the last call, so nothing asked for is left out", () => {
    const plan = searchPlan(types(10), meta);
    expect(plan).toHaveLength(MAX_EXTRA_CALLS);
    expect(plan.slice(0, -1).every((call) => call.length === 1)).toBe(true);
    expect(plan.at(-1)).toEqual(types(10).slice(MAX_EXTRA_CALLS - 1));
  });

  it("skips types searched before and stops at the plan's cap", () => {
    expect(searchPlan(types(3), { ...meta, searched: ["t0_restaurant"], calls: 1 })).toEqual([
      ["t1_restaurant"],
      ["t2_restaurant"],
    ]);
    expect(searchPlan(types(3), { ...meta, calls: MAX_EXTRA_CALLS })).toEqual([]);
    expect(searchPlan(types(3), { ...meta, calls: MAX_EXTRA_CALLS - 1 })).toEqual([types(3)]);
    expect(searchPlan([], meta)).toEqual([]);
  });
});

describe("widening a pool", () => {
  const base: Place[] = [];

  it("adds what each search finds after the places already there, and records what was searched", async () => {
    const { fetcher, queries } = googleFetch();
    const first = await extendPool(base, newPoolMeta(CENTER), ["french_restaurant"], DATE, "k", fetcher);
    expect(queries).toEqual(["french_restaurant"]);
    expect(first.added).toBe(3);
    expect(first.meta).toEqual({ center: CENTER, searched: ["french_restaurant"], calls: 1 });
    const second = await extendPool(
      first.places,
      first.meta,
      ["french_restaurant", "korean_restaurant"],
      DATE,
      "k",
      fetcher,
    );
    expect(queries).toEqual(["french_restaurant", "korean_restaurant"]);
    expect(second.places.slice(0, 3).map((p) => p.id)).toEqual(first.places.map((p) => p.id));
    expect(second.places).toHaveLength(6);
  });

  it("keeps a place the current engine has no cuisine for, with its Google types", async () => {
    const { fetcher } = googleFetch();
    const out = await extendPool(base, newPoolMeta(CENTER), ["french_restaurant"], DATE, "k", fetcher);
    expect(out.places[0]).toMatchObject({ cuisine: null, types: ["french_restaurant", "restaurant"] });
    expect(out.places[0].open.length).toBeGreaterThan(0);
  });

  it("makes no call when there is nothing new to search for", async () => {
    const { fetcher, queries } = googleFetch();
    const out = await extendPool(base, newPoolMeta(CENTER), [], DATE, "k", fetcher);
    expect(queries).toEqual([]);
    expect(out).toMatchObject({ added: 0, calls: 0 });
  });

  it("a failed search costs its call and its results; its type can be tried again", async () => {
    const { fetcher } = googleFetch(["french_restaurant"]);
    const out = await extendPool(
      base,
      newPoolMeta(CENTER),
      ["french_restaurant", "korean_restaurant"],
      DATE,
      "k",
      fetcher,
    );
    expect(out.failedCalls).toBe(1);
    expect(out.meta.calls).toBe(2);
    expect(out.meta.searched).toEqual(["korean_restaurant"]);
    expect(out.places.every((p) => p.id.startsWith("korean"))).toBe(true);
  });

  it("drops a new place that cannot take any start time on the plan's date", async () => {
    const closed = vi.fn(async () => json(page("french_restaurant", 2, { regularOpeningHours: { periods: [] } })));
    const out = await extendPool(base, newPoolMeta(CENTER), ["french_restaurant"], DATE, "k", closed as never);
    expect(out.added).toBe(0);
    expect(out.meta.searched).toEqual(["french_restaurant"]);
  });

  it("never spends more than the plan's cap, however often it runs", async () => {
    const { fetcher, queries } = googleFetch();
    let places = base;
    let meta = newPoolMeta(CENTER);
    for (let round = 0; round < 4; round++) {
      const wanted = Array.from({ length: 5 }, (_, i) => `r${round}c${i}_restaurant`);
      ({ places, meta } = await extendPool(places, meta, wanted, DATE, "k", fetcher));
    }
    expect(queries).toHaveLength(MAX_EXTRA_CALLS);
    expect(meta.calls).toBe(MAX_EXTRA_CALLS);
    expect(places.length).toBeLessThanOrEqual(POOL_CAP);
  });

  it("reads stored bookkeeping defensively", () => {
    expect(parsePoolMeta(null)).toBeNull();
    expect(parsePoolMeta("not json")).toBeNull();
    expect(parsePoolMeta(JSON.stringify({ searched: [] }))).toBeNull();
    expect(parsePoolMeta(JSON.stringify({ center: CENTER }))).toEqual(newPoolMeta(CENTER));
  });
});

describe("a restaurant somebody asked for by name", () => {
  const venue = (id: string, name: string, extra: Partial<PlaceResult> = {}): PlaceResult => ({
    id,
    displayName: { text: name },
    primaryType: "chinese_restaurant",
    types: ["chinese_restaurant", "restaurant"],
    location: { latitude: 37.44, longitude: -122.16 },
    regularOpeningHours: { periods: EVERY_DAY },
    ...extra,
  });
  const IMPERIAL = venue("imp", "Imperial Treasure");
  const meta = newPoolMeta(CENTER);

  it("is searched for by name and added when it is the place that was named", async () => {
    const { fetcher, queries } = googleFetch([], { "Imperial Treasure": { places: [IMPERIAL] } });
    const out = await addNamedPlaces([], meta, ["Imperial Treasure"], matchRestaurant, DATE, "k", fetcher);
    expect(queries).toEqual(["name:Imperial Treasure"]);
    expect(out.places.map((p) => p.id)).toEqual(["imp"]);
    expect(out.meta).toEqual({ center: CENTER, searched: [namedKey("Imperial Treasure")], calls: 1 });
  });

  it("is not searched for when it is already in the pool, or was searched before", async () => {
    const { fetcher, queries } = googleFetch([], { "Imperial Treasure": { places: [IMPERIAL] } });
    const first = await addNamedPlaces([], meta, ["Imperial Treasure"], matchRestaurant, DATE, "k", fetcher);
    await addNamedPlaces(first.places, first.meta, ["imperial treasure"], matchRestaurant, DATE, "k", fetcher);
    // Not found the first time: still asked about only once.
    const none = await addNamedPlaces([], meta, ["Nowhere Diner"], matchRestaurant, DATE, "k", fetcher);
    await addNamedPlaces(none.places, none.meta, ["Nowhere Diner"], matchRestaurant, DATE, "k", fetcher);
    expect(queries).toEqual(["name:Imperial Treasure", "name:Nowhere Diner"]);
    expect(none.added).toBe(0);
    expect(none.meta.calls).toBe(1);
  });

  it("does not add a different place that Google returned for the name", async () => {
    const { fetcher } = googleFetch([], { "Imperial Treasure": { places: [venue("other", "Golden Dragon Palace")] } });
    const out = await addNamedPlaces([], meta, ["Imperial Treasure"], matchRestaurant, DATE, "k", fetcher);
    expect(out.places).toEqual([]);
  });

  it("does not add a place of that name far from the plan, or one closed that day", async () => {
    const far = venue("far", "Imperial Treasure", { location: { latitude: 34.05, longitude: -118.24 } });
    const closed = venue("closed", "Imperial Treasure", { regularOpeningHours: { periods: [] } });
    for (const place of [far, closed]) {
      const { fetcher } = googleFetch([], { "Imperial Treasure": { places: [place] } });
      const out = await addNamedPlaces([], meta, ["Imperial Treasure"], matchRestaurant, DATE, "k", fetcher);
      expect(out.places, place.id).toEqual([]);
    }
  });

  it("looks up the most asked-for names first, a couple at a time, within the plan's cap", async () => {
    const { fetcher, queries } = googleFetch();
    const names = ["A Place", "B Place", "B Place", "C Place"];
    await addNamedPlaces([], meta, names, matchRestaurant, DATE, "k", fetcher);
    expect(queries).toEqual(["name:B Place", "name:A Place"]);
    expect(queries).toHaveLength(MAX_NAMED_SEARCHES);
    const spent = { ...meta, calls: MAX_EXTRA_CALLS };
    const out = await addNamedPlaces([], spent, ["D Place"], matchRestaurant, DATE, "k", fetcher);
    expect(out.calls).toBe(0);
    expect(queries).toHaveLength(MAX_NAMED_SEARCHES);
  });

  it("a failed search costs its call and can be tried again", async () => {
    const { fetcher } = googleFetch(["name:Imperial Treasure"]);
    const out = await addNamedPlaces([], meta, ["Imperial Treasure"], matchRestaurant, DATE, "k", fetcher);
    expect(out).toMatchObject({ added: 0, calls: 1, failedCalls: 1 });
    expect(out.meta.searched).toEqual([]);
  });
});

describe("a plan from creation to decision", () => {
  beforeEach(() => {
    delete process.env.ANTHROPIC_API_KEY; // the rule-based reader, so the test needs no model
    process.env.GOOGLE_PLACES_API_KEY = "k";
    resetDbForTests();
    return () => {
      delete process.env.GOOGLE_PLACES_API_KEY;
      vi.unstubAllGlobals();
    };
  });

  let n = 0;
  const makeUser = (name: string) =>
    createUser({ email: `${name}${n++}@pool.dev`, displayName: name, password: "password123" });

  async function plan() {
    const google = googleFetch();
    vi.stubGlobal("fetch", google.fetcher);
    const alice = await makeUser("Alice");
    const bob = await makeUser("Bob");
    const event = await createEvent(alice.id, "Saturday dinner", "Palo Alto", "meal", DATE);
    await joinEvent(event.inviteCode, bob.id);
    return { google, alice, bob, event };
  }

  /** Store a member's preferences directly, as the chat would have. */
  async function setPrefs(eventId: string, userId: string, p: PersonPreferences) {
    const client = await db();
    await client.execute({
      sql: "UPDATE members SET constraints_enc = ? WHERE event_id = ? AND user_id = ?",
      args: [encryptJson({ ...emptyMemberState(), prefs: p }, scope.constraints(eventId, userId)), eventId, userId],
    });
  }

  it("makes one search when the plan is created, whatever cuisines exist", async () => {
    const { google, event } = await plan();
    expect(google.queries).toEqual(["restaurant"]);
    expect(event.poolSource).toBe("places");
    expect(event.poolSize).toBe(8);
  });

  it("then searches for what the group asked for, once, and keeps the first places in place", async () => {
    const { google, alice, bob, event } = await plan();
    const before = (await poolForEvent(event.id)).places.map((p) => p.id);
    await setPrefs(event.id, alice.id, likes("french_restaurant"));
    await setPrefs(event.id, bob.id, likes("french_restaurant", "korean_restaurant"));

    expect(await refreshPool(event.id)).toBe(true);
    expect(google.queries).toEqual(["restaurant", "french_restaurant", "korean_restaurant"]);
    const after = await poolForEvent(event.id);
    expect(after.places.slice(0, before.length).map((p) => p.id)).toEqual(before);
    expect(after.places).toHaveLength(before.length + 6);
    // The current engine is offered the Korean places and not the French ones; the optimizer gets both.
    expect(after.restaurants.some((r) => r.id.startsWith("korean"))).toBe(true);
    expect(after.restaurants.some((r) => r.id.startsWith("french"))).toBe(false);
    const { input } = await loadOptimizerInput(event.id);
    expect(input.candidates.some((c) => c.types.includes("french_restaurant"))).toBe(true);

    expect(await refreshPool(event.id)).toBe(false);
    expect(google.queries).toHaveLength(3);
  });

  it("makes no further search when nobody asked for a cuisine", async () => {
    const { google, event } = await plan();
    expect(await refreshPool(event.id)).toBe(false);
    expect(google.queries).toEqual(["restaurant"]);
  });

  it("matches a restaurant somebody named once the place is in the pool", async () => {
    const { alice, bob, event } = await plan();
    await setPrefs(
      event.id,
      alice.id,
      prefs({ ...likes("french_restaurant"), wantedRestaurants: [{ name: "french_restaurant 1", id: null }] }),
    );
    await setPrefs(event.id, bob.id, prefs({ excludedRestaurants: [{ name: "Nowhere Diner", id: null }] }));
    await refreshPool(event.id);
    expect((await getMyConstraints(event.id, alice.id)).prefs.wantedRestaurants).toEqual([
      { name: "french_restaurant 1", id: "french_restaurant_1" },
    ]);
    expect((await getMyConstraints(event.id, bob.id)).prefs.excludedRestaurants).toEqual([
      { name: "Nowhere Diner", id: null },
    ]);
  });

  it("finds places for a halal diner, so the optimizer has somewhere they can go", async () => {
    const { google, alice, bob, event } = await plan();
    await setPrefs(event.id, alice.id, prefs({ dietary: ["halal"] }));
    await setPrefs(event.id, bob.id, likes("korean_restaurant"));
    const before = await loadOptimizerInput(event.id);
    expect(before.input.candidates.some((c) => c.types.includes("halal_restaurant"))).toBe(false);

    expect(await refreshPool(event.id)).toBe(true);
    expect(google.queries).toEqual(["restaurant", "halal_restaurant", "korean_restaurant"]);
    const { input } = await loadOptimizerInput(event.id);
    expect(input.candidates.filter((c) => c.types.includes("halal_restaurant")).length).toBe(3);
  });

  it("brings in a restaurant somebody named, and marks it as theirs", async () => {
    const google = googleFetch([], {
      "Imperial Treasure": {
        places: [
          {
            id: "imp",
            displayName: { text: "Imperial Treasure" },
            primaryType: "chinese_restaurant",
            types: ["chinese_restaurant", "restaurant"],
            location: { latitude: 37.44, longitude: -122.16 },
            regularOpeningHours: { periods: EVERY_DAY },
          },
        ],
      },
    });
    vi.stubGlobal("fetch", google.fetcher);
    const alice = await makeUser("Alice");
    const bob = await makeUser("Bob");
    const event = await createEvent(alice.id, "Saturday dinner", "Palo Alto", "meal", DATE);
    await joinEvent(event.inviteCode, bob.id);
    await setPrefs(event.id, alice.id, prefs({ wantedRestaurants: [{ name: "Imperial Treasure", id: null }] }));

    expect(await refreshPool(event.id)).toBe(true);
    expect(google.queries).toEqual(["restaurant", "name:Imperial Treasure"]);
    expect((await poolForEvent(event.id)).places.map((p) => p.id)).toContain("imp");
    expect((await getMyConstraints(event.id, alice.id)).prefs.wantedRestaurants).toEqual([
      { name: "Imperial Treasure", id: "imp" },
    ]);
    // Asked about once: a second refresh makes no further call.
    await refreshPool(event.id);
    expect(google.queries).toHaveLength(2);
  });

  it("decides with the pool it has when Google fails", async () => {
    const { alice, event } = await plan();
    await setPrefs(event.id, alice.id, likes("french_restaurant"));
    const down = vi.fn(async () => new Response("nope", { status: 500 }));
    expect(await refreshPool(event.id, "k", down as never)).toBe(false);
    expect((await poolForEvent(event.id)).places).toHaveLength(8);
  });

  it("does nothing for a plan on the seed restaurants", async () => {
    const alice = await makeUser("Alice");
    const google = googleFetch();
    const event = await createEvent(alice.id, "No location");
    expect(await refreshPool(event.id, "k", google.fetcher)).toBe(false);
    expect(google.queries).toEqual([]);
  });

  it("runs before the plan is decided, when the last person is done", async () => {
    const { google, alice, bob, event } = await plan();
    await sendMessage(event.id, alice.id, "dinner works, no restrictions, I'd like Korean food");
    await sendMessage(event.id, bob.id, "dinner, no restrictions");
    await setReady(event.id, alice.id, true);
    await setReady(event.id, bob.id, true);
    expect(google.queries).toEqual(["restaurant"]); // nothing is fetched while people are still chatting
    const result = await runNegotiation(event.id, alice.id);
    expect(google.queries).toEqual(["restaurant", "korean_restaurant"]);
    expect(result.proposal).not.toBeNull();
  });
});

describe("what the pool refresh may see and say", () => {
  it("is server-only, exports one function, and returns only whether the pool grew", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../src/lib/pool-refresh.ts", import.meta.url), "utf8");
    expect(src).toMatch(/import "server-only"/);
    expect([...src.matchAll(/^export (?:async )?function (\w+)/gm)].map((m) => m[1])).toEqual(["refreshPool"]);
    expect(src).toMatch(/\): Promise<boolean>/);
  });
});
