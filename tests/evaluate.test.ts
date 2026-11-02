import { describe, expect, it } from "vitest";
import { type Constraints, emptyConstraints, mergeConstraints } from "@/lib/constraints";
import { evaluate } from "@/lib/evaluate";
import type { Restaurant } from "@/lib/restaurants";

const base: Restaurant = {
  id: "test",
  name: "Test Place",
  cuisine: "japanese",
  pricePerPerson: 40,
  travelMin: 15,
  spicy: false,
  vegetarianFriendly: true,
  seafoodHeavy: false,
  halal: false,
  open: ["fri_dinner", "sat_lunch", "sat_dinner", "sun_lunch", "sun_dinner"],
};
const r = (o: Partial<Restaurant>): Restaurant => ({ ...base, ...o });
const c = (o: Partial<Constraints>) => mergeConstraints(emptyConstraints(), o);

describe("evaluate", () => {
  it("says yes when nothing conflicts", () => {
    expect(evaluate(c({ budgetMax: 50, maxTravelMin: 20, availableSlots: ["sat_dinner"] }), base, "sat_dinner")).toEqual({ verdict: "yes" });
  });

  it("says no for a slot the person is not free", () => {
    expect(evaluate(c({ availableSlots: ["sat_dinner"] }), base, "sat_lunch")).toEqual({ verdict: "no", reason: "time" });
  });

  it("says no when the restaurant is closed", () => {
    expect(evaluate(c({}), r({ open: ["sat_dinner"] }), "sun_lunch")).toEqual({ verdict: "no", reason: "time" });
  });

  describe("price", () => {
    it("meh within flex", () => {
      expect(evaluate(c({ budgetMax: 35, budgetFlex: 10 }), base, "sat_dinner")).toEqual({ verdict: "meh", reason: "price" });
    });
    it("no beyond flex", () => {
      expect(evaluate(c({ budgetMax: 35, budgetFlex: 2 }), base, "sat_dinner")).toEqual({ verdict: "no", reason: "price" });
    });
    it("exactly at budget is fine", () => {
      expect(evaluate(c({ budgetMax: 40 }), base, "sat_dinner").verdict).toBe("yes");
    });
  });

  describe("diet", () => {
    it.each([
      [{ dietary: ["no_spicy" as const] }, { spicy: true }],
      [{ dietary: ["vegetarian" as const] }, { vegetarianFriendly: false }],
      [{ dietary: ["no_seafood" as const] }, { seafoodHeavy: true }],
      [{ dietary: ["halal" as const] }, { halal: false }],
    ])("%o rejects %o", (cons, rest) => {
      expect(evaluate(c(cons), r(rest), "sat_dinner")).toEqual({ verdict: "no", reason: "diet" });
    });
  });

  describe("distance", () => {
    it("meh within grace", () => {
      expect(evaluate(c({ maxTravelMin: 10 }), base, "sat_dinner")).toEqual({ verdict: "meh", reason: "distance" });
    });
    it("no beyond grace", () => {
      expect(evaluate(c({ maxTravelMin: 4 }), base, "sat_dinner")).toEqual({ verdict: "no", reason: "distance" });
    });
  });

  it("disliked cuisine is only meh", () => {
    expect(evaluate(c({ dislikedCuisines: ["japanese"] }), base, "sat_dinner")).toEqual({ verdict: "meh", reason: "cuisine" });
  });

  it("reports only the worst issue", () => {
    const j = evaluate(c({ budgetMax: 35, budgetFlex: 10, dietary: ["no_spicy"] }), r({ spicy: true }), "sat_dinner");
    expect(j).toEqual({ verdict: "no", reason: "diet" });
  });

  it("never leaks numbers in its output", () => {
    const j = evaluate(c({ budgetMax: 17, budgetFlex: 0 }), base, "sat_dinner");
    expect(JSON.stringify(j)).not.toMatch(/\d/);
  });
});
