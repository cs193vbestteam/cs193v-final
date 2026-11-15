import { describe, expect, it } from "vitest";
import { SLOTS, describeConstraints, emptyConstraints, mergeConstraints, missingFields } from "@/lib/constraints";
import { MEALS, mealStartTimes } from "@/lib/optimizer-input";
import {
  PENDING_QUESTIONS,
  extractBudget,
  extractCuisines,
  extractDietary,
  extractDistance,
  extractRules,
  extractTime,
  answerPending,
  ruleReply,
  ruleTurn,
} from "@/lib/extract-rules";

const LUNCH = ["11:00", "12:00", "13:00"];
const DINNER = ["17:00", "18:00", "19:00", "20:00"];
const from = (hour: number) => SLOTS.filter((s) => Number(s.slice(0, 2)) >= hour);
const upTo = (hour: number) => SLOTS.filter((s) => Number(s.slice(0, 2)) <= hour);

describe("extractTime", () => {
  it('reads "work" as fitting, not as being at work', () => {
    expect(extractTime("7pm would work")).toEqual(["19:00"]);
    expect(extractTime("anything after 6 would work")).toEqual(SLOTS.filter((s) => s >= "18:00"));
    // Being at work is still time they are not free.
    expect(extractTime("I work until 5")).toEqual(SLOTS.filter((s) => s >= "17:00"));
    expect(extractTime("at work until 5")).toEqual(SLOTS.filter((s) => s >= "17:00"));
  });

  it("takes a refused meal away instead of choosing it", () => {
    expect(extractTime("not lunch")).toEqual(SLOTS.filter((s) => !LUNCH.includes(s)));
    expect(extractTime("anything but dinner")).toEqual(SLOTS.filter((s) => !DINNER.includes(s)));
    expect(extractTime("not before 6")).toEqual(SLOTS.filter((s) => s >= "18:00"));
  });

  it("reads an event they are free after as the start of their free time", () => {
    expect(extractTime("free after class at 4")).toEqual(SLOTS.filter((s) => s >= "16:00"));
    expect(extractTime("after work ends at 5")).toEqual(SLOTS.filter((s) => s >= "17:00"));
  });

  it.each([
    ["brunch", ["10:00", "11:00"]],
    ["lunch works", LUNCH],
    ["afternoon tea would be nice", ["14:00", "15:00", "16:00"]],
    ["dinner only", DINNER],
    ["free in the evening", DINNER],
    ["late night is best", ["21:00", "22:00", "23:00"]],
    ["lunch or dinner", [...LUNCH, ...DINNER]],
  ])("meal words mean the start times in the table: %s", (text, expected) => {
    expect(extractTime(text)).toEqual(expected);
  });

  it("takes the meal's times from the shared table, not from its own copy", () => {
    for (const meal of MEALS) expect(extractTime(meal.replace("_", " "))).toEqual(mealStartTimes(meal));
  });

  it("ignores the day of the week: the plan's date is already set", () => {
    expect(extractTime("Saturday evening only")).toEqual(DINNER);
    expect(extractTime("only free sunday lunch")).toEqual(LUNCH);
  });

  it.each([
    ["any time after 7", from(19)],
    ["from 7pm", from(19)],
    ["not before 6", from(18)],
    ["7 or later", from(19)],
    ["after 6:30", from(19)],
    ["after 11am", from(11)],
  ])("reads an earliest time: %s", (text, expected) => {
    expect(extractTime(text)).toEqual(expected);
  });

  it.each([
    ["before 2", upTo(13)],
    ["I need to be done by 8", upTo(19)],
    ["until 9pm", upTo(20)],
  ])("reads a latest time, leaving an hour for the meal: %s", (text, expected) => {
    expect(extractTime(text)).toEqual(expected);
  });

  it.each([
    ["6 to 8", ["18:00", "19:00", "20:00"]],
    ["between 6 and 8", ["18:00", "19:00", "20:00"]],
    ["6-8pm", ["18:00", "19:00", "20:00"]],
    ["11am to 1pm", ["11:00", "12:00", "13:00"]],
    ["after 6 and before 9", ["18:00", "19:00", "20:00"]],
  ])("reads a range with both ends included: %s", (text, expected) => {
    expect(extractTime(text)).toEqual(expected);
  });

  it.each([
    ["7pm", ["19:00"]],
    ["at 7", ["19:00"]],
    ["noon", ["12:00"]],
    ["around 12:30", ["12:00"]],
    ["7pm or 8pm", ["19:00", "20:00"]],
  ])("reads a single time: %s", (text, expected) => {
    expect(extractTime(text)).toEqual(expected);
  });

  it("reads a bare hour from 1 to 9 as the afternoon or evening, 10 and 11 as the morning", () => {
    expect(extractTime("at 2")).toEqual(["14:00"]);
    expect(extractTime("at 11")).toEqual(["11:00"]);
    expect(extractTime("at 12")).toEqual(["12:00"]);
  });

  it("narrows a meal by a clock time in the same clause", () => {
    expect(extractTime("dinner after 7")).toEqual(["19:00", "20:00"]);
    expect(extractTime("lunch before 1")).toEqual(["11:00", "12:00"]);
  });

  it.each([["any time"], ["whenever"], ["I'm free all day"], ["free all weekend"]])(
    "%s is every start time",
    (text) => {
      expect(extractTime(text)).toEqual([...SLOTS]);
    },
  );

  it("takes times away when the person says they are busy", () => {
    expect(extractTime("I'm busy at lunch")).toEqual(SLOTS.filter((s) => !LUNCH.includes(s)));
    expect(extractTime("busy until 6")).toEqual(from(18));
    expect(extractTime("I have class until 6:30")).toEqual(from(18).filter((s) => s !== "18:00"));
    expect(extractTime("can't do after 9")).toEqual(upTo(20));
  });

  it("combines free and busy clauses", () => {
    expect(extractTime("free all day, but busy at lunch")).toEqual(SLOTS.filter((s) => !LUNCH.includes(s)));
    expect(extractTime("dinner works, but I can't do 8pm")).toEqual(["17:00", "18:00", "19:00"]);
  });

  it("does not read money or distance as a time", () => {
    expect(extractTime("under $40")).toBeUndefined();
    expect(extractTime("around 20")).toBeUndefined();
    expect(extractTime("budget is 8 to 10 dollars")).toBeUndefined();
    expect(extractTime("at most 9 minutes away")).toBeUndefined();
    expect(extractTime("up to 30 minutes")).toBeUndefined();
    expect(extractTime("a table for 6")).toBeUndefined();
  });

  it("does not read a bare number as a time when the question was about money or distance", () => {
    expect(extractTime("about 10", "distance")).toBeUndefined();
    expect(extractTime("around 9", "budget")).toBeUndefined();
    expect(extractTime("5 to 9", "budget")).toBeUndefined();
    // A time written as a time still counts, whatever was asked.
    expect(extractTime("oh and I can only do 7pm", "budget")).toEqual(["19:00"]);
    expect(extractRules("about 10", "distance")).toEqual({ maxTravelMin: 10 });
  });

  it("takes a bare hour as the time when time was the question", () => {
    expect(extractRules("7", "time")).toEqual({ availableSlots: ["19:00"] });
    expect(extractRules("around 12:30", "time")).toEqual({ availableSlots: ["12:00"] });
    expect(extractRules("7", "budget")).toEqual({ budgetMax: 7 });
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
  ])("%s -> %d", (text, expected) => {
    expect(extractDistance(text)).toBe(expected);
  });
  it("not minding the distance is no limit, not an invented number", () => {
    expect(extractDistance("don't care about distance")).toBeUndefined();
    expect(extractRules("don't care about distance")).toEqual({ travelNoLimit: true });
    expect(extractRules("anywhere is fine")).toEqual({ travelNoLimit: true });
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
    expect(extractCuisines("craving ramen, tired of hot pot")).toEqual({
      likedCuisines: ["japanese"],
      dislikedCuisines: ["chinese"],
    });
  });
});

describe("extractRules (full message)", () => {
  it("pulls several constraints from one casual message", () => {
    const u = extractRules("Dinner works, budget around $40 max 40, not too far, no spicy please");
    expect(u.availableSlots).toEqual(DINNER);
    expect(u.budgetMax).toBe(40);
    expect(u.maxTravelMin).toBe(20);
    expect(u.dietary).toEqual(["no_spicy"]);
  });

  it("handles the example from the proposal", () => {
    const u = extractRules("After 7 only. Budget 40. Can't handle spicy. Max 20 minutes away");
    expect(u.budgetMax).toBe(40);
    expect(u.dietary).toEqual(["no_spicy"]);
    expect(u.availableSlots).toEqual(from(19));
    expect(u.maxTravelMin).toBe(20);
  });
});

describe("ruleReply", () => {
  it("asks about the next missing field", () => {
    expect(ruleReply(emptyConstraints(), { availableSlots: ["18:00"] })).toMatch(/spend/);
  });
  it("says it didn't understand when nothing was extracted", () => {
    expect(ruleReply(emptyConstraints(), {})).toMatch(/didn't catch/);
  });
  it("wraps up when everything is known", () => {
    const c = mergeConstraints(emptyConstraints(), { availableSlots: ["18:00"], budgetMax: 40, maxTravelMin: 20 });
    expect(ruleReply(c, { dietaryConfirmed: true })).toMatch(/everything I need/);
  });
});

describe("bare answers to the pending question", () => {
  it.each([
    ["nothing", { dietaryConfirmed: true }],
    ["none", { dietaryConfirmed: true }],
    ["no", { dietaryConfirmed: true }],
    ["Nope!", { dietaryConfirmed: true }],
    ["spicy", { dietary: ["no_spicy"] }],
    ["seafood", { dietary: ["no_seafood"] }],
    ["spicy, seafood", { dietary: ["no_spicy", "no_seafood"] }],
    ["no spicy and no fish", { dietary: ["no_spicy", "no_seafood"] }],
    ["vegan", { dietary: ["vegetarian"] }],
    ["halal please", { dietary: ["halal"] }],
  ])("diet: %s", (text, expected) => {
    expect(extractRules(text, "diet")).toEqual(expected);
  });

  it("does not read a craving as a restriction", () => {
    expect(extractRules("I love spicy food", "diet")).toEqual({});
    expect(extractRules("spicy", "budget")).toEqual({});
  });

  it("reads a bare number as the pending numeric field only", () => {
    expect(extractRules("40", "budget")).toEqual({ budgetMax: 40 });
    expect(extractRules("$40", "budget")).toEqual({ budgetMax: 40 });
    expect(extractRules("about 40 each", "budget")).toEqual({ budgetMax: 40 });
    expect(extractRules("15", "distance")).toEqual({ maxTravelMin: 15 });
    expect(extractRules("maybe 15 min", "distance")).toEqual({ maxTravelMin: 15 });
    expect(extractRules("40", "time")).toEqual({});
    expect(extractRules("40", undefined)).toEqual({});
  });

  it("prefers explicit phrasing over the pending-question fallback", () => {
    // "20 minutes" is unambiguous even while the budget question is pending.
    expect(extractRules("20 minutes", "budget")).toEqual({ maxTravelMin: 20 });
  });

  it("walks the whole conversation with one-word answers", () => {
    let c = emptyConstraints();
    for (const [text, expectedMissing] of [
      ["saturday dinner", ["budget", "distance", "diet"]],
      ["40", ["distance", "diet"]],
      ["15", ["diet"]],
      ["nothing", []],
    ] as const) {
      const pending = (["time", "budget", "distance", "diet"] as const).find((f) => {
        const missing = new Set(
          ["time", "budget", "distance", "diet"].filter((x) => {
            if (x === "time") return !c.availableSlots?.length;
            if (x === "budget") return c.budgetMax === null;
            if (x === "distance") return c.maxTravelMin === null;
            return !c.dietaryConfirmed;
          }),
        );
        return missing.has(f);
      });
      const update = extractRules(text, pending);
      const reply = ruleReply(c, update);
      expect(reply).toContain("Got it");
      c = mergeConstraints(c, update);
      void expectedMissing;
    }
    expect(c.dietaryConfirmed).toBe(true);
    expect(c.budgetMax).toBe(40);
    expect(c.maxTravelMin).toBe(15);
  });
});

describe("ruleTurn: refusing 'whatever' and asking the follow-ups", () => {
  const essentials = {
    availableSlots: ["18:00" as const],
    budgetMax: 40,
    maxTravelMin: 15,
    dietaryConfirmed: true,
  };
  const start = (o: Parameters<typeof mergeConstraints>[1] = {}) => mergeConstraints(emptyConstraints(), o);

  it('takes "I don\'t mind" as the answer: no limit, and the next question', () => {
    const c0 = start({ availableSlots: ["18:00"] });
    const t1 = ruleTurn("whatever, I don't really care", c0);
    expect(t1.update).toEqual({ budgetNoLimit: true });
    expect(t1.reply).toMatch(/no budget limit/);
    expect(t1.reply).toMatch(/How far/);
    const c1 = mergeConstraints(c0, t1.update);
    expect(missingFields(c1)).toEqual(["distance", "diet"]);
    const t2 = ruleTurn("I'm flexible", c1);
    expect(t2.update).toEqual({ travelNoLimit: true });
    const c2 = mergeConstraints(c1, t2.update);
    expect(missingFields(c2)).toEqual(["diet"]);
    expect(describeConstraints(c2)).toEqual(expect.arrayContaining(["Budget: no limit", "Travel: any distance"]));
    // A number given later replaces "no limit".
    const c3 = mergeConstraints(c2, { budgetMax: 40 });
    expect(c3.budgetNoLimit).toBe(false);
    expect(mergeConstraints(c3, { budgetNoLimit: true }).budgetMax).toBeNull();
  });

  it('reads "at least $50 a person" as a floor that answers the budget question', () => {
    expect(extractBudget("at least $50 per person")).toEqual({ budgetMin: 50 });
    expect(extractBudget("$50 or more")).toEqual({ budgetMin: 50 });
    expect(extractBudget("at least $50, no more than $90")).toEqual({ budgetMin: 50, budgetMax: 90 });
    expect(extractBudget("at least 20 minutes away")).toEqual({});
    const c = mergeConstraints(start({ availableSlots: ["18:00"] }), { budgetMin: 50 });
    expect(missingFields(c)).toEqual(["distance", "diet"]);
    expect(describeConstraints(c)).toEqual(
      expect.arrayContaining(["Budget: no limit", "Would rather spend at least $50/person"]),
    );
    // A floor above an earlier ceiling replaces it; a ceiling below an earlier floor replaces that.
    expect(mergeConstraints(start({ budgetMax: 30 }), { budgetMin: 50 })).toMatchObject({
      budgetMax: null,
      budgetMin: 50,
    });
    expect(mergeConstraints(start({ budgetMin: 50 }), { budgetMax: 30 })).toMatchObject({
      budgetMax: 30,
      budgetMin: null,
    });
  });

  it("turns an unsure budget into an either/or and reads the answer", () => {
    const c0 = start({ availableSlots: ["18:00"] });
    const t1 = ruleTurn("not sure, it depends", c0);
    expect(t1.update).toEqual({ pending: "vague_budget" });
    expect(t1.reply).toMatch(/\$45 a head.*\$25 a head/);
    const c1 = mergeConstraints(c0, t1.update);
    const t2 = ruleTurn("45 would bother me", c1);
    expect(t2.update).toMatchObject({ budgetMax: 30, budgetFlex: 10, pending: null });
    expect(t2.reply).toMatch(/Noted\./);
    expect(t2.reply).toMatch(/How far/);
  });

  it("an unsure distance answer gets the distance either/or", () => {
    const c0 = start({ availableSlots: ["18:00"], budgetMax: 40 });
    const t1 = ruleTurn("not sure honestly", c0);
    expect(t1.update).toEqual({ pending: "vague_distance" });
    const t2 = ruleTurn("the so-so place nearby would be worse", mergeConstraints(c0, t1.update));
    expect(t2.update).toMatchObject({ maxTravelMin: 40, pending: null });
  });

  it("a concrete number also clears a pending either/or", () => {
    const c0 = start({ availableSlots: ["18:00"], pending: "vague_budget" });
    const t = ruleTurn("ok, 35", c0);
    expect(t.update).toMatchObject({ budgetMax: 35, pending: null });
  });

  it("asks cuisine, then the concession question, once the essentials are in: no trade-off questions (#48)", () => {
    let c = start(essentials);
    const t0 = ruleTurn("nothing", start({ ...essentials, dietaryConfirmed: false }));
    expect(t0.update).toMatchObject({ dietaryConfirmed: true, pending: "cuisine", probesAsked: ["cuisine"] });
    expect(t0.reply).toContain(PENDING_QUESTIONS.cuisine);
    c = mergeConstraints(c, t0.update);

    // "I don't mind" is an answer: nothing recorded, never asked again.
    const t1 = ruleTurn("I don't mind", c);
    expect(t1.update).toMatchObject({ pending: "concession", probesAsked: ["concession"] });
    expect(t1.update.likedCuisines).toBeUndefined();
    expect(t1.reply).toMatch(/no cuisine preference/);
    expect(t1.reply).not.toMatch(/Which is worse|paying \$10 over|lukewarm/);
    c = mergeConstraints(c, t1.update);
    expect(describeConstraints(c)).toContain("Cuisine: no preference");

    const t2 = ruleTurn("I'd give up the cuisine first, then distance, budget last", c);
    expect(t2.update).toMatchObject({ concessionOrder: ["cuisine", "travel", "budget"], pending: null });
    expect(t2.reply).toMatch(/That's everything I need/);
    c = mergeConstraints(c, t2.update);
    expect(c.probesAsked).toEqual(["cuisine", "concession"]);
    expect(c.weights).toEqual(emptyConstraints().weights); // defaults, untouched

    const t3 = ruleTurn("also I love thai", c);
    expect(t3.update).toMatchObject({ likedCuisines: ["thai"] });
    expect(t3.reply).not.toMatch(/Which is worse/);
  });

  it("a chat saved while waiting on a retired trade-off question is still answered, then moves on", () => {
    const c = start({ ...essentials, pending: "tradeoff_budget_travel", probesAsked: ["tradeoff_budget_travel"] });
    const t = ruleTurn("paying more is worse", c);
    expect(t.update.weights).toMatchObject({ budget: 0.5, travel: 0.2 });
    expect(t.update.pending).toBe("cuisine"); // not the other trade-off
  });

  it("a cuisine answer is recorded, and one we don't have is said plainly", () => {
    const asked = start({ ...essentials, pending: "cuisine", probesAsked: ["cuisine"] });
    const named = ruleTurn("thai or japanese, not mexican", asked);
    expect(named.update).toMatchObject({ likedCuisines: ["japanese", "thai"], dislikedCuisines: ["mexican"] });
    expect(named.update.pending).toBe("concession");
    const unknown = ruleTurn("Ethiopian", asked);
    expect(unknown.update.likedCuisines).toBeUndefined();
    expect(unknown.reply).toMatch(/I can only look for japanese/);
    expect(unknown.update.pending).toBe("concession");
  });

  it("an off-topic message while a probe is pending is still understood, and the probe is repeated", () => {
    const c = start({
      ...essentials,
      pending: "concession",
      probesAsked: ["tradeoff_budget_travel", "tradeoff_cuisine_travel", "concession"],
    });
    const t = ruleTurn("actually no seafood for me", c);
    expect(t.update).toMatchObject({ dietary: ["no_seafood"] });
    expect(t.reply).toMatch(/what goes first/);
  });

  it("the rule-based reader still asks for its four essentials before it calls itself done", () => {
    const c = mergeConstraints(start(essentials), { pending: "concession" });
    expect(missingFields(c)).toEqual([]);
  });
});

describe("answering an either/or by echoing an option", () => {
  const essentials = {
    availableSlots: ["18:00" as const],
    budgetMax: 40,
    maxTravelMin: 15,
    dietaryConfirmed: true,
  };
  const PROBE_ORDER = ["tradeoff_budget_travel", "tradeoff_cuisine_travel", "concession"] as const;
  const pendingOn = (pending: Parameters<typeof answerPending>[1]) => {
    const upTo = PROBE_ORDER.indexOf(pending as (typeof PROBE_ORDER)[number]);
    return mergeConstraints(emptyConstraints(), {
      ...essentials,
      pending,
      probesAsked: ["cuisine", ...(upTo >= 0 ? PROBE_ORDER.slice(0, upTo + 1) : [])],
    });
  };

  it.each([
    ["extra 10 monutes", "travel"],
    ["the extra 10 minutes", "travel"],
    ["lukewarm cuisine", "cuisine"],
    ["a cusine im lukewarm on", "cuisine"],
  ])("cuisine vs travel: %s → %s loses weight", (answer, loser) => {
    const c = pendingOn("tradeoff_cuisine_travel");
    const t = ruleTurn(answer, c);
    expect(t.update.pending).toBe("concession");
    const w = t.update.weights!;
    if (loser === "travel") expect(w.travel!).toBeGreaterThan(c.weights.travel);
    else expect(w.cuisine!).toBeGreaterThan(c.weights.cuisine);
  });

  it("budget vs travel: an echoed option with a typo is understood, and '10' alone is not", () => {
    const c = pendingOn("tradeoff_budget_travel");
    expect(ruleTurn("travellng further", c).update.weights!.travel!).toBeGreaterThan(c.weights.travel);
    expect(ruleTurn("paying $10 over my budget,", c).update.weights!.budget!).toBeGreaterThan(c.weights.budget);
    expect(ruleTurn("10", c).update.weights).toBeUndefined();
  });

  it("vague either/ors accept an echo too", () => {
    const c = mergeConstraints(emptyConstraints(), { availableSlots: ["18:00"], pending: "vague_budget" });
    expect(ruleTurn("the less exciting one", c).update).toMatchObject({ budgetMax: 60, pending: null });
    const d = mergeConstraints(emptyConstraints(), {
      availableSlots: ["18:00"],
      budgetMax: 40,
      pending: "vague_distance",
    });
    expect(ruleTurn("so-so place nearby", d).update).toMatchObject({ maxTravelMin: 40, pending: null });
  });

  it("an unrelated message is still not mistaken for an answer", () => {
    const c = pendingOn("tradeoff_cuisine_travel");
    const t = ruleTurn("what time is it", c);
    expect(t.update.weights).toBeUndefined();
    expect(t.reply).toMatch(/Sorry/);
  });
});
