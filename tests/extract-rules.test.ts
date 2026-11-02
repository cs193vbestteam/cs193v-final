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
    ["只有周六晚上有空", ["sat_dinner"]],
    ["sat lunch or sun dinner", ["sat_lunch", "sun_dinner"]],
    ["Saturday lunch and dinner", ["sat_lunch", "sat_dinner"]],
  ])("%s", (text, expected) => {
    expect(extractTime(text)?.sort()).toEqual([...expected].sort());
  });

  it("handles being busy (negation)", () => {
    expect(extractTime("I'm busy Saturday afternoon")).toEqual(["fri_dinner", "sat_dinner", "sun_lunch", "sun_dinner"]);
    expect(extractTime("周六下午有事")).toEqual(["fri_dinner", "sat_dinner", "sun_lunch", "sun_dinner"]);
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
    ["预算40以内", 40],
    ["人均不超过60", 60],
    ["30块", 30],
  ])("%s -> %d", (text, expected) => {
    expect(extractBudget(text).budgetMax).toBe(expected);
  });

  it("does not confuse travel minutes for dollars", () => {
    expect(extractBudget("up to 30 minutes away").budgetMax).toBeUndefined();
    expect(extractBudget("不超过20分钟").budgetMax).toBeUndefined();
  });

  it("detects flexibility", () => {
    expect(extractBudget("around $40 but I can stretch").budgetFlex).toBe(8);
    expect(extractBudget("$40, strict").budgetFlex).toBe(0);
  });
});

describe("extractDistance", () => {
  it.each([
    ["no more than 20 minutes", 20],
    ["开车不超过20分钟", 20],
    ["not too far", 20],
    ["walking distance", 10],
    ["距离无所谓", 60],
  ])("%s -> %d", (text, expected) => {
    expect(extractDistance(text)).toBe(expected);
  });
  it("undefined when absent", () => expect(extractDistance("sushi")).toBeUndefined());
});

describe("extractDietary", () => {
  it("finds restrictions in English and Chinese", () => {
    expect(extractDietary("I can't eat spicy and I'm vegetarian").dietary?.sort()).toEqual(["no_spicy", "vegetarian"]);
    expect(extractDietary("不吃辣，海鲜过敏").dietary?.sort()).toEqual(["no_seafood", "no_spicy"]);
  });
  it("confirms 'no restrictions'", () => {
    expect(extractDietary("no restrictions")).toEqual({ dietaryConfirmed: true });
    expect(extractDietary("没有忌口")).toEqual({ dietaryConfirmed: true });
  });
});

describe("extractCuisines", () => {
  it("separates likes and dislikes", () => {
    expect(extractCuisines("I'd love sushi, but not burgers")).toEqual({
      likedCuisines: ["japanese"],
      dislikedCuisines: ["american"],
    });
    expect(extractCuisines("想吃日料，不想吃火锅")).toEqual({ likedCuisines: ["japanese"], dislikedCuisines: ["chinese"] });
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

  it("handles the Chinese example from the proposal", () => {
    const u = extractRules("预算40以内，不吃辣，周六只有晚上有空，开车不想超过20分钟");
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
