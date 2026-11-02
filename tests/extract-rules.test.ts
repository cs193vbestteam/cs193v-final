import { describe, expect, it } from "vitest";
import { emptyConstraints, mergeConstraints } from "@/lib/constraints";
import {
  extractBudget,
  extractCuisines,
  extractDietary,
  extractDistance,
  extractRules,
  extractTime,
  ruleReply,
} from "@/lib/extract-rules";

describe("extractTime", () => {
  it.each([
    ["Saturday evening only", ["sat_dinner"]],
    ["only free sunday lunch", ["sun_lunch"]],
    ["sat lunch or sun dinner", ["sat_lunch", "sun_dinner"]],
    ["Saturday lunch and dinner", ["sat_lunch", "sat_dinner"]],
  ])("%s", (text, expected) => {
    expect(extractTime(text)?.sort()).toEqual([...expected].sort());
  });

  it("handles being busy (negation)", () => {
    expect(extractTime("I'm busy Saturday afternoon")).toEqual(["fri_dinner", "sat_dinner", "sun_lunch", "sun_dinner"]);
    expect(extractTime("can't do saturday lunch")).toEqual(["fri_dinner", "sat_dinner", "sun_lunch", "sun_dinner"]);
  });

  it("combines free and busy clauses", () => {
    expect(extractTime("free all weekend, but busy sunday")).toEqual(["fri_dinner", "sat_lunch", "sat_dinner"]);
  });

  it("returns undefined when no time is mentioned", () => {
    expect(extractTime("I like sushi")).toBeUndefined();
  });
});

describe("extractBudget", () => {
  it.each([
    ["my budget is 40", 40],
    ["under $35 please", 35],
    ["$50 max", 50],
    ["no more than 60", 60],
    ["30 bucks", 30],
  ])("%s -> %d", (text, expected) => {
    expect(extractBudget(text).budgetMax).toBe(expected);
  });

  it("does not confuse travel minutes for dollars", () => {
    expect(extractBudget("up to 30 minutes away").budgetMax).toBeUndefined();
    expect(extractBudget("no more than 20 min").budgetMax).toBeUndefined();
  });

  it("detects flexibility", () => {
    expect(extractBudget("around $40 but I can stretch").budgetFlex).toBe(8);
    expect(extractBudget("$40, strict").budgetFlex).toBe(0);
  });
});

describe("extractDistance", () => {
  it.each([
    ["no more than 20 minutes", 20],
    ["15 min drive tops", 15],
    ["not too far", 20],
    ["walking distance", 10],
    ["don't care about distance", 60],
  ])("%s -> %d", (text, expected) => {
    expect(extractDistance(text)).toBe(expected);
  });
  it("undefined when absent", () => expect(extractDistance("sushi")).toBeUndefined());
});

describe("extractDietary", () => {
  it("finds restrictions", () => {
    expect(extractDietary("I can't eat spicy and I'm vegetarian").dietary?.sort()).toEqual(["no_spicy", "vegetarian"]);
    expect(extractDietary("no spicy, allergic to shellfish").dietary?.sort()).toEqual(["no_seafood", "no_spicy"]);
  });
  it("confirms 'no restrictions'", () => {
    expect(extractDietary("no restrictions")).toEqual({ dietaryConfirmed: true });
    expect(extractDietary("I eat anything")).toEqual({ dietaryConfirmed: true });
  });
});

describe("extractCuisines", () => {
  it("separates likes and dislikes", () => {
    expect(extractCuisines("I'd love sushi, but not burgers")).toEqual({
      likedCuisines: ["japanese"],
      dislikedCuisines: ["american"],
    });
    expect(extractCuisines("craving ramen, tired of hot pot")).toEqual({ likedCuisines: ["japanese"], dislikedCuisines: ["chinese"] });
  });
});

describe("extractRules (full message)", () => {
  it("pulls several constraints from one casual message", () => {
    const u = extractRules("Saturday night works, budget around $40 max 40, not too far, no spicy please");
    expect(u.availableSlots).toEqual(["sat_dinner"]);
    expect(u.budgetMax).toBe(40);
    expect(u.maxTravelMin).toBe(20);
    expect(u.dietary).toEqual(["no_spicy"]);
  });

  it("handles the example from the proposal", () => {
    const u = extractRules("Saturday night only. Budget 40. Can't handle spicy. Max 20 minutes away");
    expect(u.budgetMax).toBe(40);
    expect(u.dietary).toEqual(["no_spicy"]);
    expect(u.availableSlots).toEqual(["sat_dinner"]);
    expect(u.maxTravelMin).toBe(20);
  });
});

describe("ruleReply", () => {
  it("asks about the next missing field", () => {
    expect(ruleReply(emptyConstraints(), { availableSlots: ["sat_dinner"] })).toMatch(/spend/);
  });
  it("says it didn't understand when nothing was extracted", () => {
    expect(ruleReply(emptyConstraints(), {})).toMatch(/didn't catch/);
  });
  it("wraps up when everything is known", () => {
    const c = mergeConstraints(emptyConstraints(), { availableSlots: ["sat_dinner"], budgetMax: 40, maxTravelMin: 20 });
    expect(ruleReply(c, { dietaryConfirmed: true })).toMatch(/everything I need/);
  });
});
