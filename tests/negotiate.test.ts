import { describe, expect, it } from "vitest";
import { makeAgent, type Agent } from "@/lib/agent";
import { type Constraints, type ConstraintsUpdate, emptyConstraints, mergeConstraints } from "@/lib/constraints";
import { evaluate } from "@/lib/evaluate";
import { nashProduct, negotiate } from "@/lib/negotiate";
import { compile } from "@/lib/preferences";
import { RESTAURANTS, getRestaurant } from "@/lib/restaurants";

const c = (o: ConstraintsUpdate) => mergeConstraints(emptyConstraints(), { dietaryConfirmed: true, ...o });
const agentFor = (cons: Constraints): Agent => makeAgent(compile(cons));

describe("negotiate", () => {
  it("returns no_deal with nobody", async () => {
    expect((await negotiate([])).status).toBe("no_deal");
  });

  it("finds a plan everyone accepts (the 5-friends example)", async () => {
    const people = [
      c({ availableSlots: ["sat_dinner", "sun_dinner"] }), // A: "whatever", but busy daytime
      c({ budgetMax: 30 }), // B: not too expensive
      c({ availableSlots: ["fri_dinner", "sat_dinner", "sun_lunch", "sun_dinner"] }), // C: busy Sat afternoon
      c({ dietary: ["no_spicy"], maxTravelMin: 15 }), // D
      c({ dislikedCuisines: ["american"] }), // E
    ];
    const result = await negotiate(people.map(agentFor));
    expect(result.status).toBe("agreed");
    expect(result.tally?.accept).toBe(5);
    expect(result.reservations).toEqual([]);
    for (const p of people) {
      expect(evaluate(compile(p), getRestaurant(result.proposal!.restaurantId)!, result.proposal!.slot).verdict).toBe(
        "accept",
      );
    }
  });

  it("adapts across rounds instead of proposing the same things", async () => {
    const people = [c({ budgetMax: 16, availableSlots: ["sun_dinner"] }), c({ maxTravelMin: 6 })];
    const result = await negotiate(people.map(agentFor), { maxRounds: 10 });
    expect(result.status).toBe("agreed");
    const keys = result.rounds.flatMap((r) => r.proposals.map((p) => `${p.proposal.restaurantId}@${p.proposal.slot}`));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("first round is a diverse spread, not five variations of one idea", async () => {
    const result = await negotiate([agentFor(c({ budgetMax: 1 }))], { maxRounds: 1 });
    const first = result.rounds[0].proposals.map((p) => getRestaurant(p.proposal.restaurantId)!);
    expect(first).toHaveLength(5);
    expect(new Set(first.map((r) => r.cuisine)).size).toBeGreaterThanOrEqual(4);
  });

  it("falls back to a compromise when nothing gets unanimous accept", async () => {
    // Only Taqueria Sol is cheap/close enough, and one person mildly dislikes Mexican.
    const people = [
      c({ budgetMax: 15, maxTravelMin: 5 }),
      c({ budgetMax: 60, maxTravelMin: 60, dislikedCuisines: ["mexican"] }),
    ];
    const result = await negotiate(people.map(agentFor), { concessionFrom: 99 });
    expect(result.status).toBe("compromise");
    expect(result.tally?.reject).toBe(0);
    expect(result.proposal?.restaurantId).toBe("taqueria-sol");
    expect(result.reservations).toEqual([{ member: 1, dim: "cuisine" }]);
  });

  it("concessions from round 4 turn a lasting compromise into agreement", async () => {
    const people = [
      c({ budgetMax: 15, maxTravelMin: 5 }),
      c({ budgetMax: 60, maxTravelMin: 60, dislikedCuisines: ["mexican"], concessionOrder: ["cuisine"] }),
    ];
    const without = await negotiate(people.map(agentFor), { concessionFrom: 99 });
    expect(without.status).toBe("compromise");
    const result = await negotiate(people.map(agentFor));
    expect(result.status).toBe("agreed");
    expect(result.concessionLevel).toBeGreaterThanOrEqual(1);
    expect(result.rounds.find((r) => r.round === 4)?.level).toBe(1);
    expect(result.rounds.find((r) => r.round === 3)?.level).toBe(0);
    // The near-miss is put to the agents again in round 4 and wins there, not in a post-loop sweep.
    expect(result.rounds).toHaveLength(4);
    const retried = result.rounds[3].proposals.filter((p) => p.retried);
    expect(retried.length).toBeGreaterThan(0);
    expect(retried.some((p) => p.proposal.restaurantId === "taqueria-sol")).toBe(true);
  });

  it("a concession round re-asks at most half its slots and fills the rest with fresh candidates", async () => {
    const people = [
      c({ budgetMax: 15, maxTravelMin: 5 }),
      c({
        budgetMax: 60,
        maxTravelMin: 60,
        dislikedCuisines: ["mexican"],
        concessionOrder: ["budget", "travel", "cuisine"],
      }),
    ];
    const result = await negotiate(people.map(agentFor));
    const r4 = result.rounds.find((r) => r.round === 4);
    expect(r4).toBeDefined();
    expect(r4!.proposals.filter((p) => p.retried).length).toBeLessThanOrEqual(3);
    expect(r4!.proposals.length).toBeLessThanOrEqual(5);
  });

  it("reports no_deal with the conflicting dimensions for impossible constraints", async () => {
    const people = [c({ availableSlots: ["sat_lunch"] }), c({ availableSlots: ["sun_dinner"] })];
    const result = await negotiate(people.map(agentFor), { maxRounds: 3 });
    expect(result.status).toBe("no_deal");
    expect(result.proposal).toBeNull();
    expect(result.conflicts[0]).toBe("time");
  });

  it("round logs contain only aggregate counts, never per-person data", async () => {
    const people = [c({ budgetMax: 20 }), c({ dietary: ["vegetarian"] })];
    const result = await negotiate(people.map(agentFor));
    for (const round of result.rounds) {
      for (const p of round.proposals) {
        expect(Object.keys(p.tally).sort()).toEqual(["accept", "dims", "reject", "rejectDims", "reluctant"]);
        expect(p.tally.accept + p.tally.reluctant + p.tally.reject).toBe(2);
      }
    }
    expect(JSON.stringify(result)).not.toMatch(/budget|utility|weight/);
  });

  it("finalist buckets are sorted, so they cannot be mapped back to members", async () => {
    const people = [c({ budgetMax: 60 }), c({ budgetMax: 22, budgetFlex: 10 }), c({ budgetMax: 60 })];
    const result = await negotiate(people.map(agentFor));
    expect(result.finalists.length).toBeGreaterThan(0);
    for (const f of result.finalists) {
      expect(f.buckets).toHaveLength(3);
      expect([...f.buckets].sort((a, b) => b - a)).toEqual(f.buckets);
      expect(f.nash).toBe(nashProduct(f.buckets));
    }
  });

  it("chooses the finalist with the highest Nash product", async () => {
    const people = [
      c({ budgetMax: 25, budgetFlex: 15 }),
      c({ budgetMax: 25, budgetFlex: 15, likedCuisines: ["vietnamese"] }),
    ];
    const result = await negotiate(people.map(agentFor));
    const best = Math.max(...result.finalists.map((f) => f.nash));
    expect(result.finalists.find((f) => f.proposal.restaurantId === result.proposal!.restaurantId)!.nash).toBe(best);
  });

  it("only ever calls agents with valid proposals, and counts leaked dimension names", async () => {
    const seen: string[] = [];
    const spy: Agent = {
      judge: (p) => {
        seen.push(p.restaurantId);
        return { verdict: "reject", dim: "price" };
      },
      bucket: () => 1,
    };
    const result = await negotiate([spy], { maxRounds: 2 });
    const ids = new Set(RESTAURANTS.map((r) => r.id));
    expect(seen.every((id) => ids.has(id))).toBe(true);
    expect(result.leakedDims).toBe(seen.length);
  });

  it("is deterministic", async () => {
    const people = [c({ budgetMax: 25 }), c({ maxTravelMin: 10 })].map(agentFor);
    expect(await negotiate(people)).toEqual(await negotiate(people));
  });

  it("lets a selector re-rank the shortlist but never widen it", async () => {
    const people = [c({ budgetMax: 40 })].map(agentFor);
    const rogue = { r: RESTAURANTS[0], slot: "sat_dinner" as const };
    const result = await negotiate(people, {
      maxRounds: 1,
      selector: (list) => [rogue, rogue, ...list.slice().reverse()],
    });
    const proposed = result.rounds[0].proposals.map((p) => p.proposal.restaurantId);
    expect(new Set(proposed).size).toBe(proposed.length);
    expect(proposed).toHaveLength(5);
  });
});
