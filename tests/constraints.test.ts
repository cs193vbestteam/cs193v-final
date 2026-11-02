import { describe, expect, it } from "vitest";
import { describeConstraints, emptyConstraints, mergeConstraints, missingFields } from "@/lib/constraints";

describe("mergeConstraints", () => {
  it("overwrites scalars", () => {
    const c = mergeConstraints(mergeConstraints(emptyConstraints(), { budgetMax: 40 }), { budgetMax: 50 });
    expect(c.budgetMax).toBe(50);
  });

  it("replaces availability rather than appending", () => {
    let c = mergeConstraints(emptyConstraints(), { availableSlots: ["sat_lunch", "sat_dinner"] });
    c = mergeConstraints(c, { availableSlots: ["sat_dinner"] });
    expect(c.availableSlots).toEqual(["sat_dinner"]);
  });

  it("accumulates dietary needs and confirms diet", () => {
    let c = mergeConstraints(emptyConstraints(), { dietary: ["no_spicy"] });
    c = mergeConstraints(c, { dietary: ["vegetarian", "no_spicy"] });
    expect(c.dietary.sort()).toEqual(["no_spicy", "vegetarian"]);
    expect(c.dietaryConfirmed).toBe(true);
  });

  it("moves a cuisine from liked to disliked when the user changes their mind", () => {
    let c = mergeConstraints(emptyConstraints(), { likedCuisines: ["japanese"] });
    c = mergeConstraints(c, { dislikedCuisines: ["japanese"] });
    expect(c.likedCuisines).toEqual([]);
    expect(c.dislikedCuisines).toEqual(["japanese"]);
  });

  it("rejects invalid values", () => {
    expect(() => mergeConstraints(emptyConstraints(), { budgetMax: -5 })).toThrow();
  });
});

describe("missingFields", () => {
  it("lists all hard fields when empty", () => {
    expect(missingFields(emptyConstraints())).toEqual(["time", "budget", "distance", "diet"]);
  });
  it("is empty when everything is answered", () => {
    const c = mergeConstraints(emptyConstraints(), {
      availableSlots: ["sat_dinner"],
      budgetMax: 40,
      maxTravelMin: 20,
      dietaryConfirmed: true,
    });
    expect(missingFields(c)).toEqual([]);
  });
  it("treats an empty availability list as missing", () => {
    const c = mergeConstraints(emptyConstraints(), { availableSlots: [] });
    expect(missingFields(c)).toContain("time");
  });
});

describe("describeConstraints", () => {
  it("summarizes for the owner", () => {
    const c = mergeConstraints(emptyConstraints(), { budgetMax: 40, budgetFlex: 10, dietaryConfirmed: true });
    const lines = describeConstraints(c);
    expect(lines).toContain("Budget: up to $40/person (can stretch to $50)");
    expect(lines).toContain("Diet: no restrictions");
  });
});
