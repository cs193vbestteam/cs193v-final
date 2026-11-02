import { describe, expect, it } from "vitest";
import { type Constraints, emptyConstraints, mergeConstraints } from "@/lib/constraints";
import { evaluate } from "@/lib/evaluate";
import { type Assistant, negotiate } from "@/lib/negotiate";
import { RESTAURANTS, getRestaurant } from "@/lib/restaurants";

const c = (o: Partial<Constraints>) => mergeConstraints(emptyConstraints(), { dietaryConfirmed: true, ...o });
const assistantFor = (cons: Constraints): Assistant => (p) => evaluate(cons, getRestaurant(p.restaurantId)!, p.slot);

describe("negotiate", () => {
  it("returns no_option with nobody", () => {
    expect(negotiate([]).status).toBe("no_option");
  });

  it("finds a plan everyone says yes to (the 5-friends example)", () => {
    const people = [
      c({ availableSlots: ["sat_dinner", "sun_dinner"] }), // A: "whatever", but busy daytime
      c({ budgetMax: 30 }), // B: not too expensive
      c({ availableSlots: ["fri_dinner", "sat_dinner", "sun_lunch", "sun_dinner"] }), // C: busy Sat afternoon
      c({ dietary: ["no_spicy"], maxTravelMin: 15 }), // D
      c({ dislikedCuisines: ["american"] }), // E
    ];
    const result = negotiate(people.map(assistantFor));
    expect(result.status).toBe("agreed");
    expect(result.tally?.yes).toBe(5);
    // The agreed plan really does satisfy everyone.
    for (const p of people) {
      expect(evaluate(p, getRestaurant(result.proposal!.restaurantId)!, result.proposal!.slot).verdict).toBe("yes");
    }
  });

  it("adapts across rounds instead of proposing the same things", () => {
    const people = [c({ budgetMax: 16, availableSlots: ["sun_dinner"] }), c({ maxTravelMin: 6 })];
    const result = negotiate(people.map(assistantFor), { maxRounds: 10 });
    expect(result.status).toBe("agreed");
    const keys = result.rounds.flatMap((r) => r.proposals.map((p) => `${p.proposal.restaurantId}@${p.proposal.slot}`));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("falls back to a compromise when nothing gets unanimous yes", () => {
    // Only Taqueria Sol is cheap/close enough, and one person mildly dislikes Mexican.
    const people = [c({ budgetMax: 15, maxTravelMin: 5 }), c({ dislikedCuisines: ["mexican"] })];
    const result = negotiate(people.map(assistantFor), { maxRounds: 30 });
    expect(result.status).toBe("compromise");
    expect(result.tally?.no).toBe(0);
    expect(result.proposal?.restaurantId).toBe("taqueria-sol");
  });

  it("reports no_option for impossible constraints", () => {
    const people = [c({ availableSlots: ["sat_lunch"] }), c({ availableSlots: ["sun_dinner"] })];
    const result = negotiate(people.map(assistantFor), { maxRounds: 3 });
    expect(result.status).toBe("no_option");
  });

  it("round logs contain only aggregate counts, never per-person data", () => {
    const people = [c({ budgetMax: 20 }), c({ dietary: ["vegetarian"] })];
    const result = negotiate(people.map(assistantFor));
    for (const round of result.rounds) {
      for (const p of round.proposals) {
        expect(Object.keys(p.tally).sort()).toEqual(["meh", "no", "reasons", "yes"]);
        expect(p.tally.yes + p.tally.meh + p.tally.no).toBe(2);
      }
    }
  });

  it("only ever calls assistants with valid proposals", () => {
    const seen: string[] = [];
    const spy: Assistant = (p) => {
      seen.push(p.restaurantId);
      return { verdict: "no", reason: "price" };
    };
    negotiate([spy], { maxRounds: 2 });
    const ids = new Set(RESTAURANTS.map((r) => r.id));
    expect(seen.every((id) => ids.has(id))).toBe(true);
  });

  it("is deterministic", () => {
    const people = [c({ budgetMax: 25 }), c({ maxTravelMin: 10 })].map(assistantFor);
    expect(negotiate(people)).toEqual(negotiate(people));
  });
});
