import { describe, expect, it } from "vitest";
import { MAX_MATCHES, myMatches } from "@/lib/my-matches";
import type { PersonPreferences } from "@/lib/optimizer-input";
import { summarizePlaces } from "@/lib/pool";
import { RESTAURANTS, type Place } from "@/lib/restaurants";

/**
 * The plan says, to each person and only to them, what they asked for that it gives them.
 * Everyone also sees a few public facts about the place. Nothing here names anyone else's wish.
 */

const place = (extra: Partial<Place> = {}): Place => ({
  ...RESTAURANTS[0],
  id: "p1",
  name: "Rangoon Ruby",
  cuisine: null,
  types: ["burmese_restaurant", "restaurant"],
  primaryType: "burmese_restaurant",
  style: ["casual"],
  price: { low: 20, high: 30 },
  features: { outdoor: true, kids: true, reservable: false, alcohol: null, well_rated: true },
  ...extra,
});
const prefs = (extra: Partial<PersonPreferences>): PersonPreferences => ({ version: 1, ...extra });

describe("what the plan gives one person", () => {
  it("lists what they asked for and got, in plain words", () => {
    const p = prefs({
      wantedRestaurants: [{ name: "Rangoon Ruby", id: "p1" }],
      cuisine: { scores: { burmese_restaurant: 1 }, strength: "strong" },
      features: { needed: ["kids"], wanted: ["outdoor"], strength: "mild" },
    });
    expect(myMatches(p, place(), "19:00")).toEqual([
      "the place you named",
      "Burmese food",
      "good for children",
      "outdoor seating",
    ]);
  });

  it("leaves out what the place does not have, or Google does not say", () => {
    const p = prefs({ features: { wanted: ["reservable", "alcohol", "dogs"], strength: "mild" } });
    expect(myMatches(p, place(), "19:00")).toEqual([]);
  });

  it("says nothing for a near match: only food they asked for by name", () => {
    const near = prefs({ cuisine: { scores: { thai_restaurant: 1, burmese_restaurant: 0.5 }, strength: "mild" } });
    expect(myMatches(near, place(), "19:00")).toEqual([]);
  });

  it("notes a preferred time and a price within their budget", () => {
    const p = prefs({
      time: { preferred: [{ from: "18:00", to: "19:00" }], strength: "mild" },
      budget: { max: 40, strength: "must" },
    });
    expect(myMatches(p, place(), "19:00")).toEqual(["a time you prefer", "within your budget"]);
    expect(myMatches(p, place(), "21:00")).toEqual(["within your budget"]);
    expect(myMatches(p, place({ price: { low: 50, high: 70 } }), "21:00")).toEqual([]);
    // No price from Google: nothing is claimed.
    expect(myMatches(p, place({ price: null }), "21:00")).toEqual([]);
  });

  it("is empty for someone who asked for nothing, and never longer than one line", () => {
    expect(myMatches(prefs({}), place(), "19:00")).toEqual([]);
    const everything = prefs({
      wantedRestaurants: [{ name: "Rangoon Ruby", id: "p1" }],
      cuisine: { scores: { burmese_restaurant: 1 }, strength: "mild" },
      features: { wanted: ["kids", "outdoor", "well_rated"], strength: "mild" },
      budget: { max: 40, strength: "mild" },
    });
    expect(myMatches(everything, place(), "19:00")).toHaveLength(MAX_MATCHES);
  });

  it("reads only this person's preferences: someone else's wishes change nothing", () => {
    const mine = prefs({ features: { wanted: ["outdoor"], strength: "mild" } });
    expect(myMatches(mine, place(), "19:00")).toEqual(["outdoor seating"]);
    // The function takes one person's preferences and a place. There is no group to read from.
    expect(myMatches.length).toBe(3);
  });
});

describe("what everyone sees about the place", () => {
  it("is a few things Google says it has, the same for every viewer", () => {
    const summary = summarizePlaces([place()], ["p1"]).p1;
    expect(summary.offers).toEqual(["outdoor seating", "good for children"]);
    expect(summary.kind).toBe("Burmese");
  });

  it("shows at most three, and nothing for a place Google says nothing about", () => {
    const all = place({
      features: { outdoor: true, wheelchair: true, kids: true, reservable: true, alcohol: true, dogs: true },
    });
    expect(summarizePlaces([all], ["p1"]).p1.offers).toEqual([
      "outdoor seating",
      "a step-free entrance",
      "good for children",
    ]);
    expect(summarizePlaces([place({ features: undefined })], ["p1"]).p1.offers).toBeUndefined();
    expect(summarizePlaces([place({ features: { outdoor: false, kids: null } })], ["p1"]).p1.offers).toBeUndefined();
  });
});
