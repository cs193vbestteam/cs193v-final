import { describe, expect, it } from "vitest";
import { emptyConstraints, mergeConstraints, type ConstraintsUpdate } from "@/lib/constraints";
import { ACCEPT_AT, RELUCTANT_AT, bucket, evaluate, utility } from "@/lib/evaluate";
import { compile, relax } from "@/lib/preferences";
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
  open: ["19:00", "12:00", "18:00", "13:00", "20:00"],
};
const r = (o: Partial<Restaurant>): Restaurant => ({ ...base, ...o });
const p = (o: ConstraintsUpdate) => compile(mergeConstraints(emptyConstraints(), o));

describe("evaluate: hard rules", () => {
  it("accepts when nothing conflicts", () => {
    expect(evaluate(p({ budgetMax: 50, maxTravelMin: 20, availableSlots: ["18:00"] }), base, "18:00")).toEqual({
      verdict: "accept",
    });
  });
  it("rejects a slot the person is not free", () => {
    expect(evaluate(p({ availableSlots: ["18:00"] }), base, "12:00")).toEqual({
      verdict: "reject",
      dim: "time",
    });
  });
  it("rejects when the restaurant is closed", () => {
    expect(evaluate(p({}), r({ open: ["18:00"] }), "13:00")).toEqual({ verdict: "reject", dim: "time" });
  });
  it.each([
    [{ dietary: ["no_spicy" as const] }, { spicy: true }],
    [{ dietary: ["vegetarian" as const] }, { vegetarianFriendly: false }],
    [{ dietary: ["no_seafood" as const] }, { seafoodHeavy: true }],
    [{ dietary: ["halal" as const] }, { halal: false }],
  ])("%o rejects %o on diet", (cons, rest) => {
    expect(evaluate(p(cons), r(rest), "18:00")).toEqual({ verdict: "reject", dim: "diet" });
  });
  it("rejects beyond the price ceiling (budget + flex)", () => {
    expect(evaluate(p({ budgetMax: 35, budgetFlex: 2 }), base, "18:00")).toEqual({
      verdict: "reject",
      dim: "price",
    });
  });
  it("rejects beyond the distance ceiling (max + grace)", () => {
    expect(evaluate(p({ maxTravelMin: 4 }), base, "18:00")).toEqual({ verdict: "reject", dim: "distance" });
  });
  it("reports only one dimension even when several hard rules fail", () => {
    const j = evaluate(p({ availableSlots: ["13:00"], dietary: ["halal"], budgetMax: 10 }), base, "18:00");
    expect(j.verdict).toBe("reject");
    expect(Object.keys(j)).toEqual(["verdict", "dim"]);
  });
});

describe("evaluate: utility thresholds", () => {
  it("is reluctant about the weakest dimension when inside the flex band", () => {
    const j = evaluate(p({ budgetMax: 35, budgetFlex: 10 }), base, "18:00");
    expect(j).toEqual({ verdict: "reluctant", dim: "price" });
    const u = utility(p({ budgetMax: 35, budgetFlex: 10 }), base, "18:00").value;
    expect(u).toBeGreaterThanOrEqual(RELUCTANT_AT);
    expect(u).toBeLessThan(ACCEPT_AT);
  });
  it("exactly at budget is fine", () => {
    expect(evaluate(p({ budgetMax: 40 }), base, "18:00").verdict).toBe("accept");
  });
  it("a slight distance stretch is still accepted; a bigger one is reluctant", () => {
    expect(evaluate(p({ maxTravelMin: 12 }), base, "18:00").verdict).toBe("accept");
    expect(evaluate(p({ maxTravelMin: 7 }), base, "18:00")).toEqual({ verdict: "reluctant", dim: "distance" });
  });
  it("an avoided cuisine alone makes the person reluctant, not a rejecter", () => {
    const prefs = p({ budgetMax: 50, maxTravelMin: 20, dislikedCuisines: ["japanese"] });
    expect(evaluate(prefs, base, "18:00")).toEqual({ verdict: "reluctant", dim: "cuisine" });
  });
  it("a preferred cuisine lifts an otherwise borderline option into accept", () => {
    const borderline = { budgetMax: 35, budgetFlex: 10 };
    expect(evaluate(p(borderline), base, "18:00").verdict).toBe("reluctant");
    expect(evaluate(p({ ...borderline, likedCuisines: ["japanese"] }), base, "18:00").verdict).toBe("accept");
  });
  it("several soft misses add up to a reject with the weakest dimension named", () => {
    const j = evaluate(
      p({ budgetMax: 32, budgetFlex: 10, maxTravelMin: 8, dislikedCuisines: ["japanese"] }),
      base,
      "18:00",
    );
    expect(j.verdict).toBe("reject");
    expect(["price", "distance", "cuisine"]).toContain(j.dim);
  });
  it("weights change which dimension is reported", () => {
    const both = { budgetMax: 35, budgetFlex: 10, maxTravelMin: 10 }; // price 0.5, distance 0.5
    expect(evaluate(p({ ...both, weights: { budget: 0.6, travel: 0.1, cuisine: 0.3 } }), base, "18:00").dim).toBe(
      "price",
    );
    expect(evaluate(p({ ...both, weights: { budget: 0.1, travel: 0.6, cuisine: 0.3 } }), base, "18:00").dim).toBe(
      "distance",
    );
  });
});

describe("evaluate: concessions", () => {
  const prefs = p({ budgetMax: 35, budgetFlex: 10, concessionOrder: ["budget", "cuisine", "travel"] });
  it("a concession can turn reluctant into accept", () => {
    expect(evaluate(prefs, base, "18:00").verdict).toBe("reluctant");
    expect(evaluate(prefs, base, "18:00", 1).verdict).toBe("accept");
  });
  it("a concession never turns a hard reject into anything else", () => {
    const strict = p({ budgetMax: 30, budgetFlex: 5, concessionOrder: ["budget"] });
    for (const level of [0, 1, 2, 3])
      expect(evaluate(strict, base, "18:00", level)).toEqual({ verdict: "reject", dim: "price" });
  });
  it("only the dimensions in concession order so far are loosened", () => {
    const prefs2 = p({ budgetMax: 50, maxTravelMin: 7, concessionOrder: ["cuisine", "budget", "travel"] });
    expect(evaluate(prefs2, base, "18:00", 2).verdict).toBe("reluctant");
    expect(evaluate(prefs2, base, "18:00", 3).verdict).toBe("accept");
  });
});

describe("bucket", () => {
  it("maps utility to 1..5 and never reveals more", () => {
    expect(bucket(p({ budgetMax: 50 }), base, "18:00")).toBe(5);
    expect(bucket(p({ budgetMax: 35, budgetFlex: 10 }), base, "18:00")).toBe(4);
    expect(bucket(p({ budgetMax: 10 }), base, "18:00")).toBe(1);
  });
});

describe("no limit, and a minimum spend (#63)", () => {
  const slot = "18:00" as const;

  it("someone with no budget or travel limit never objects on price or distance", () => {
    const prefs = p({ budgetNoLimit: true, travelNoLimit: true, availableSlots: [slot] });
    expect(prefs.hard.map((h) => h.dim)).toEqual(["time"]);
    expect(prefs.soft.map((s) => s.dim)).toEqual(["cuisine"]);
    expect(evaluate(prefs, r({ pricePerPerson: 400, travelMin: 170 }), slot).verdict).toBe("accept");
  });

  it("a minimum is a preference: cheaper scores worse, but is never ruled out by it", () => {
    const prefs = p({ budgetMin: 50, availableSlots: [slot] });
    expect(prefs.hard.some((h) => h.dim === "price")).toBe(false);
    const price = (pricePerPerson: number) => utility(prefs, r({ pricePerPerson }), slot).perDim.price;
    expect(price(50)).toBe(1);
    expect(price(120)).toBe(1); // no ceiling of their own
    expect(price(40)).toBeCloseTo(0.6);
    expect(price(25)).toBe(0);
    expect(utility(prefs, r({ pricePerPerson: 20 }), slot).violated).toBeNull();
    // Too cheap alone costs them the price share of their satisfaction, not the whole plan.
    expect(evaluate(prefs, r({ pricePerPerson: 20 }), slot).verdict).not.toBe("accept");
    expect(evaluate(prefs, r({ pricePerPerson: 60 }), slot).verdict).toBe("accept");
  });

  it("a minimum and a maximum hold together, and conceding on budget lowers the floor", () => {
    const prefs = p({ budgetMin: 50, budgetMax: 80, availableSlots: [slot] });
    expect(evaluate(prefs, r({ pricePerPerson: 90 }), slot)).toEqual({ verdict: "reject", dim: "price" });
    const at = (level: number) => utility(relax(prefs, level), r({ pricePerPerson: 40 }), slot).perDim.price!;
    // Budget is last in the default concession order.
    expect(at(3)).toBeGreaterThan(at(0));
  });
});
