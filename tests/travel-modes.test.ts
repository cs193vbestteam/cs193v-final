import { describe, expect, it } from "vitest";
import { reachKm, travelMinutes, TRAVEL_MODES } from "@/lib/geo";
import { personTravelMin } from "@/lib/optimizer-handoff";

const quad = { lat: 37.4275, lng: -122.1697 };
// About 1.6 km from the quad in a straight line.
const downtown = { lat: 37.4419, lng: -122.1699 };

describe("travel time depends on how the person travels", () => {
  it("is longest on foot and shortest by car over the same distance", () => {
    const [walk, bike, drive] = (["walk", "bike", "drive"] as const).map((m) => travelMinutes(quad, downtown, m));
    expect(walk).toBeGreaterThan(bike);
    expect(bike).toBeGreaterThan(drive);
    // 1.6 km at walking pace is around 25 minutes: not something "a 10 minute walk" covers.
    expect(walk).toBeGreaterThan(20);
    expect(walk).toBeLessThan(32);
  });

  it("takes a drive when nobody said, as before", () => {
    expect(travelMinutes(quad, downtown)).toBe(travelMinutes(quad, downtown, "drive"));
  });

  it("gives a distance that takes about the minutes asked for", () => {
    for (const mode of TRAVEL_MODES) expect(reachKm(10, mode)).toBeGreaterThan(0);
    expect(reachKm(10, "walk")).toBeLessThan(reachKm(10, "drive"));
  });
});

describe("each person's minutes to a place", () => {
  const place = { location: downtown, travelMin: 99 };
  const walker = { version: 1 as const, travel: { maxMin: 10, mode: "walk" as const, strength: "must" as const } };

  it("is measured from their own start by their own way of travelling", () => {
    const start = { label: "Main Quad", ...quad };
    expect(personTravelMin(walker, start, place, null)).toBe(travelMinutes(quad, downtown, "walk"));
  });

  it("falls back to the plan's location when they gave no start, and to the stored figure when there is neither", () => {
    expect(personTravelMin(walker, null, place, quad)).toBe(travelMinutes(quad, downtown, "walk"));
    expect(personTravelMin(walker, null, place, null)).toBe(99);
    expect(personTravelMin(walker, null, { travelMin: 7 }, quad)).toBe(7);
  });
});
