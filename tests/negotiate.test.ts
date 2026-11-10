import { describe, expect, it } from "vitest";
import { makeAgent, type Agent } from "@/lib/agent";
import { type Constraints, type ConstraintsUpdate, emptyConstraints, mergeConstraints } from "@/lib/constraints";
import { evaluate } from "@/lib/evaluate";
import { nashProduct, negotiate, type NegotiateOptions } from "@/lib/negotiate";
import { compile } from "@/lib/preferences";
import { RESTAURANTS, getRestaurant } from "@/lib/restaurants";
import { agentsFor, countingAgent, synthCase, type SimCase } from "../sim/pipeline";
import { makeRng } from "../sim/rng";

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

describe("exploring after the first unanimous accept", () => {
  // 60 synthetic groups (3 to 6 people, 30 restaurants each): enough to hit every outcome.
  const cases = (() => {
    const rng = makeRng(11);
    return Array.from({ length: 60 }, (_, i) => synthCase(rng, i, { restaurants: 30, minSize: 3, maxSize: 6 }));
  })();
  const run = (c: SimCase, opts: NegotiateOptions = {}) =>
    negotiate(agentsFor(c), { restaurants: c.restaurants, ...opts });

  it("is off by default: exploreRounds 0 is the same negotiation", async () => {
    for (const c of cases.slice(0, 15)) expect(await run(c, { exploreRounds: 0 })).toEqual(await run(c));
  });

  it("runs one more round of fresh candidates, flagged as exploring, at the same concession level", async () => {
    let explored = 0;
    for (const c of cases) {
      const base = await run(c);
      const more = await run(c, { exploreRounds: 1 });
      const exploring = more.rounds.filter((r) => r.exploring);
      if (base.status !== "agreed" || base.rounds.length === 6) continue;
      // Everything up to the agreement is untouched; exactly one round follows it.
      expect(more.rounds.slice(0, base.rounds.length)).toEqual(base.rounds);
      expect(exploring).toHaveLength(more.rounds.length - base.rounds.length);
      if (exploring.length === 0) continue; // the pool was already exhausted
      explored++;
      expect(more.rounds).toHaveLength(base.rounds.length + 1);
      const extra = more.rounds[more.rounds.length - 1];
      expect(extra.exploring).toBe(true);
      expect(extra.level).toBe(base.rounds[base.rounds.length - 1].level);
      expect(more.concessionLevel).toBe(base.concessionLevel);
      expect(extra.proposals.every((p) => !p.retried)).toBe(true);
      const before = new Set(
        base.rounds.flatMap((r) => r.proposals.map((p) => `${p.proposal.restaurantId}@${p.proposal.slot}`)),
      );
      for (const p of extra.proposals) expect(before.has(`${p.proposal.restaurantId}@${p.proposal.slot}`)).toBe(false);
      expect(more.status).toBe("agreed");
    }
    expect(explored).toBeGreaterThan(20);
  });

  it("never leaves a group that agreed without a plan, and never changes one that did not agree", async () => {
    let undecided = 0;
    for (const c of cases) {
      const base = await run(c);
      const more = await run(c, { exploreRounds: 1 });
      expect(more.status).toBe(base.status);
      if (base.rounds.every((r) => r.proposals.every((p) => p.tally.accept !== c.prefs.length))) {
        // No unanimous candidate ever appeared, so there was nothing to explore from.
        undecided++;
        expect(more).toEqual(base);
      }
    }
    expect(undecided).toBeGreaterThan(0);
  });

  it("picks among every unanimous candidate seen, so the chosen plan is never worse by the buckets", async () => {
    let improved = 0;
    for (const c of cases) {
      const base = await run(c, { finalists: 99 });
      const more = await run(c, { exploreRounds: 1, finalists: 99 });
      if (base.status !== "agreed" || !more.rounds.some((r) => r.exploring)) continue;
      const chosen = (r: typeof base) => r.finalists.find((f) => f.proposal === r.proposal)!;
      // The first agreement's unanimous candidates are still finalists, so the best can only go up.
      const keys = new Set(more.finalists.map((f) => `${f.proposal.restaurantId}@${f.proposal.slot}`));
      for (const f of base.finalists) expect(keys.has(`${f.proposal.restaurantId}@${f.proposal.slot}`)).toBe(true);
      expect(chosen(more).nash).toBeGreaterThanOrEqual(chosen(base).nash);
      for (const f of more.finalists) expect(f.tally.accept).toBe(c.prefs.length);
      if (chosen(more).nash > chosen(base).nash) improved++;
    }
    expect(improved).toBeGreaterThan(0);
  });

  it("counts towards maxRounds and stops when it runs out", async () => {
    for (const c of cases) {
      const oneRound = await run(c, { maxRounds: 1, exploreRounds: 1 });
      expect(oneRound.rounds).toHaveLength(1);
      expect(oneRound.rounds[0].exploring).toBeUndefined();
      const many = await run(c, { exploreRounds: 50 });
      expect(many.rounds.length).toBeLessThanOrEqual(6);
      if (many.rounds.some((r) => r.exploring)) expect(many.status).toBe("agreed");
    }
  });

  it("explores for as many rounds as asked", async () => {
    let seen = 0;
    for (const c of cases) {
      const base = await run(c);
      if (base.status !== "agreed" || base.rounds.length > 3) continue;
      const two = await run(c, { exploreRounds: 2 });
      expect(two.rounds.filter((r) => r.exploring)).toHaveLength(2);
      expect(two.rounds).toHaveLength(base.rounds.length + 2);
      seen++;
    }
    expect(seen).toBeGreaterThan(10);
  });

  it("counts every dimension name heard while exploring", async () => {
    for (const c of cases.slice(0, 30)) {
      const counter = { dims: 0, calls: 0 };
      const agents = agentsFor(c, (a) => countingAgent(a, counter));
      const result = await negotiate(agents, { restaurants: c.restaurants, exploreRounds: 1 });
      expect(result.leakedDims).toBe(counter.dims);
      const base = await run(c);
      expect(result.leakedDims).toBeGreaterThanOrEqual(base.leakedDims);
    }
  });

  it("round logs of an exploring round are still aggregate counts only", async () => {
    const c = cases.find((x) => x.prefs.length >= 4)!;
    const result = await run(c, { exploreRounds: 1 });
    expect(JSON.stringify(result.rounds)).not.toMatch(/budget|maxTravel|weights|prefer|avoid|member/);
  });
});
