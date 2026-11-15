import { describe, expect, it } from "vitest";
import { makeAgent, maskGroup, type Agent, type PrivateAgent } from "@/lib/agent";
import { type Constraints, type ConstraintsUpdate, emptyConstraints, mergeConstraints } from "@/lib/constraints";
import { bucket, evaluate } from "@/lib/evaluate";
import { negotiate, type NegotiateOptions } from "@/lib/negotiate";
import { compile } from "@/lib/preferences";
import { RESTAURANTS, getRestaurant } from "@/lib/restaurants";
import { agentsFor, countingAgent, synthCase, type SimCase } from "../sim/pipeline";
import { makeRng } from "../sim/rng";
import { key } from "@/lib/mediator";

const c = (o: ConstraintsUpdate) => mergeConstraints(emptyConstraints(), { dietaryConfirmed: true, ...o });
const agentFor = (cons: Constraints): PrivateAgent => makeAgent(compile(cons));
/** What the mediator is handed: the group's assistants, masked together. */
const group = (people: Constraints[]): Agent[] => maskGroup(people.map(agentFor));
/** The true Nash product of a proposal for a group: something only a test may compute. */
const trueNash = (people: Constraints[], p: { restaurantId: string; slot: Parameters<typeof bucket>[2] }, level = 0) =>
  people.reduce((acc, cons) => acc * bucket(compile(cons), getRestaurant(p.restaurantId)!, p.slot, level), 1);

describe("negotiate", () => {
  it("returns no_deal with nobody", async () => {
    expect((await negotiate([])).status).toBe("no_deal");
  });

  it("finds a plan everyone accepts (the 5-friends example)", async () => {
    const people = [
      c({ availableSlots: ["18:00", "20:00"] }), // A: "whatever", but busy daytime
      c({ budgetMax: 30 }), // B: not too expensive
      c({ availableSlots: ["19:00", "18:00", "13:00", "20:00"] }), // C: busy Sat afternoon
      c({ dietary: ["no_spicy"], maxTravelMin: 15 }), // D
      c({ dislikedCuisines: ["american"] }), // E
    ];
    const result = await negotiate(group(people));
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
    const people = [c({ budgetMax: 16, availableSlots: ["20:00"] }), c({ maxTravelMin: 6 })];
    const result = await negotiate(group(people), { maxRounds: 10 });
    expect(result.status).toBe("agreed");
    const keys = result.rounds.flatMap((r) => r.proposals.map((p) => `${p.proposal.restaurantId}@${p.proposal.slot}`));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("first round is a diverse spread, not five variations of one idea", async () => {
    const result = await negotiate(group([c({ budgetMax: 1 })]), { maxRounds: 1 });
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
    const result = await negotiate(group(people), { concessionFrom: 99 });
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
    const without = await negotiate(group(people), { concessionFrom: 99 });
    expect(without.status).toBe("compromise");
    const result = await negotiate(group(people));
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
    const result = await negotiate(group(people));
    const r4 = result.rounds.find((r) => r.round === 4);
    expect(r4).toBeDefined();
    expect(r4!.proposals.filter((p) => p.retried).length).toBeLessThanOrEqual(3);
    expect(r4!.proposals.length).toBeLessThanOrEqual(5);
  });

  it("reports no_deal with the conflicting dimensions for impossible constraints", async () => {
    const people = [c({ availableSlots: ["12:00"] }), c({ availableSlots: ["20:00"] })];
    const result = await negotiate(group(people), { maxRounds: 3 });
    expect(result.status).toBe("no_deal");
    expect(result.proposal).toBeNull();
    expect(result.conflicts[0]).toBe("time");
  });

  it("round logs contain only aggregate counts, never per-person data", async () => {
    const people = [c({ budgetMax: 20 }), c({ dietary: ["vegetarian"] })];
    const result = await negotiate(group(people));
    for (const round of result.rounds) {
      for (const p of round.proposals) {
        expect(Object.keys(p.tally).sort()).toEqual(["accept", "dims", "reject", "rejectDims", "reluctant"]);
        expect(p.tally.accept + p.tally.reluctant + p.tally.reject).toBe(2);
      }
    }
    expect(JSON.stringify(result)).not.toMatch(/budget|utility|weight/);
  });

  it("finalists carry only how they compare with the pick, never a bucket or a product", async () => {
    const people = [c({ budgetMax: 60 }), c({ budgetMax: 22, budgetFlex: 10 }), c({ budgetMax: 60 })];
    const result = await negotiate(group(people));
    expect(result.finalists.length).toBeGreaterThan(0);
    for (const f of result.finalists) {
      expect(Object.keys(f).sort()).toEqual(["proposal", "relative", "tally"]);
      expect(f.relative).toBeGreaterThan(0);
      expect(f.relative).toBeLessThanOrEqual(1);
    }
    const chosen = result.finalists.filter((f) => f.proposal === result.proposal);
    expect(chosen).toHaveLength(1);
    expect(chosen[0].relative).toBe(1);
    expect(JSON.stringify(result)).not.toMatch(/bucket|nash/i);
  });

  it("chooses the finalist with the highest Nash product, and reports the true ratios", async () => {
    const people = [
      c({ budgetMax: 25, budgetFlex: 15 }),
      c({ budgetMax: 25, budgetFlex: 15, likedCuisines: ["vietnamese"] }),
    ];
    const result = await negotiate(group(people));
    // The test may read everyone's preferences; the mediator could not.
    const truth = result.finalists.map((f) => trueNash(people, f.proposal, result.concessionLevel));
    const best = Math.max(...truth);
    expect(trueNash(people, result.proposal!, result.concessionLevel)).toBe(best);
    result.finalists.forEach((f, k) => expect(f.relative).toBeCloseTo(truth[k] / best, 5));
  });

  it("only ever calls agents with valid proposals, and counts leaked dimension names", async () => {
    const seen: string[] = [];
    const spy: Agent = {
      judge: (p) => {
        seen.push(p.restaurantId);
        return { verdict: "reject", dim: "price" };
      },
      compare: () => [],
    };
    const result = await negotiate([spy], { maxRounds: 2 });
    const ids = new Set(RESTAURANTS.map((r) => r.id));
    expect(seen.every((id) => ids.has(id))).toBe(true);
    expect(result.leakedDims).toBe(seen.length);
  });

  it("is deterministic", async () => {
    const people = group([c({ budgetMax: 25 }), c({ maxTravelMin: 10 })]);
    expect(await negotiate(people)).toEqual(await negotiate(people));
  });

  it("lets a selector re-rank the shortlist but never widen it", async () => {
    const people = group([c({ budgetMax: 40 })]);
    const rogue = { r: RESTAURANTS[0], slot: "18:00" as const };
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
    // More groups than the other tests use: since #64 most groups already land on a good plan in
    // round 1, so an exploring round improves on it in only a few of every hundred.
    const many = (() => {
      const rng = makeRng(11);
      return Array.from({ length: 300 }, (_, i) => synthCase(rng, i, { restaurants: 30, minSize: 3, maxSize: 6 }));
    })();
    for (const c of many) {
      const base = await run(c, { finalists: 99 });
      const more = await run(c, { exploreRounds: 1, finalists: 99 });
      if (base.status !== "agreed" || !more.rounds.some((r) => r.exploring)) continue;
      // The true Nash product of each run's choice, from the preferences only the harness holds.
      const nashOf = (r: typeof base) =>
        c.prefs.reduce(
          (acc, prefs) =>
            acc *
            bucket(
              prefs,
              c.restaurants.find((x) => x.id === r.proposal!.restaurantId)!,
              r.proposal!.slot,
              r.concessionLevel,
            ),
          1,
        );
      // The first agreement's unanimous candidates are still finalists, so the best can only go up.
      const keys = new Set(more.finalists.map((f) => `${f.proposal.restaurantId}@${f.proposal.slot}`));
      for (const f of base.finalists) expect(keys.has(`${f.proposal.restaurantId}@${f.proposal.slot}`)).toBe(true);
      expect(nashOf(more)).toBeGreaterThanOrEqual(nashOf(base));
      for (const f of more.finalists) expect(f.tally.accept).toBe(c.prefs.length);
      if (nashOf(more) > nashOf(base)) improved++;
    }
    expect(improved).toBeGreaterThan(0);
  });

  it("counts towards maxRounds and stops when it runs out", async () => {
    for (const c of cases) {
      const oneRound = await run(c, { maxRounds: 1, exploreRounds: 1 });
      // No round at all when no time suits everyone (#64): nothing is proposed.
      expect(oneRound.rounds.length).toBeLessThanOrEqual(1);
      if (oneRound.rounds.length === 0) expect(oneRound.conflicts).toEqual(["time"]);
      else expect(oneRound.rounds[0].exploring).toBeUndefined();
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

describe("times first, and no pointless re-asks (#64)", () => {
  const cases = (() => {
    const rng = makeRng(64);
    return Array.from({ length: 40 }, (_, i) => synthCase(rng, i, { restaurants: 30, minSize: 3, maxSize: 6 }));
  })();
  const at = (p: { proposal: { restaurantId: string; slot: string } }) =>
    `${p.proposal.restaurantId}@${p.proposal.slot}`;

  it("a group free at one time only is never proposed another", async () => {
    const people = [
      c({ availableSlots: ["19:00"], budgetMax: 40 }),
      c({ availableSlots: ["19:00", "18:00"], budgetMax: 60 }),
      c({ availableSlots: ["19:00", "13:00"], budgetMax: 50 }),
    ];
    const result = await negotiate(group(people));
    expect(result.rounds.length).toBeGreaterThan(0);
    expect(result.rounds[0].proposals).toHaveLength(5);
    for (const round of result.rounds)
      for (const p of round.proposals) {
        expect(p.proposal.slot).toBe("19:00");
        expect(p.tally.rejectDims.time).toBeUndefined();
      }
    expect(result.proposal?.slot).toBe("19:00");
  });

  it("with no time everyone can make, nobody is asked about any restaurant", async () => {
    const people = [c({ availableSlots: ["12:00"] }), c({ availableSlots: ["20:00"] })];
    const counter = { dims: 0, calls: 0 };
    const agents = maskGroup(people.map(agentFor)).map((a) => ({ ...countingAgent(a, counter), freeAt: a.freeAt }));
    const result = await negotiate(agents);
    expect(result).toMatchObject({ status: "no_deal", conflicts: ["time"], rounds: [] });
    expect(counter.calls).toBe(0);
    // Each "can't make it" is counted like the time reject it replaces: each of the two people
    // can make one of the times some seed place is open, and says no to every other one.
    const offered = new Set(RESTAURANTS.flatMap((r) => r.open)).size;
    expect(result.leakedDims).toBe(2 * (offered - 1));
  });

  it("assistants that cannot be asked about times still work, as before", async () => {
    const people = [c({ availableSlots: ["19:00"], budgetMax: 40 }), c({ budgetMax: 60 })];
    const agents = group(people).map(({ judge, compare }) => ({ judge, compare }));
    const result = await negotiate(agents);
    expect(result.status).not.toBe("no_deal");
    expect(result.rounds[0].proposals.some((p) => p.tally.rejectDims.time)).toBe(true);
  });

  it("never asks a proposal twice at one level, nor a third time once a re-ask changed nothing", async () => {
    let reasked = 0;
    for (const sim of cases) {
      const result = await negotiate(agentsFor(sim), { restaurants: sim.restaurants });
      const seen = new Map<string, { level: number; tally: string }[]>();
      for (const round of result.rounds)
        for (const p of round.proposals) {
          const history = seen.get(at(p)) ?? [];
          expect(history.some((h) => h.level === round.level)).toBe(false);
          // If the last two asks gave the same tally, there must not be this further one.
          const [a, b] = history.slice(-2);
          if (a && b) expect(a.tally).not.toBe(b.tally);
          if (history.length) reasked++;
          seen.set(at(p), [...history, { level: round.level, tally: JSON.stringify(p.tally) }]);
        }
    }
    expect(reasked).toBeGreaterThan(0);
  });
});

describe("ending with a shortlist instead of one plan", () => {
  const cases = (() => {
    const rng = makeRng(6);
    return Array.from({ length: 60 }, (_, i) => synthCase(rng, i, { restaurants: 30, minSize: 3, maxSize: 6 }));
  })();
  const run = (sim: SimCase, opts: NegotiateOptions = {}) =>
    negotiate(agentsFor(sim), { restaurants: sim.restaurants, ...opts });

  it("is off by default: one plan, as before", async () => {
    for (const sim of cases.slice(0, 15)) expect(await run(sim, { shortlist: 1 })).toEqual(await run(sim));
  });

  it("lists up to six different places nobody rejects, the plan first", async () => {
    let full = 0;
    for (const sim of cases) {
      const one = await run(sim);
      const six = await run(sim, { shortlist: 6 });
      // Whether a plan exists does not depend on how many options are wanted.
      expect(six.status === "no_deal").toBe(one.status === "no_deal");
      if (six.status === "no_deal") {
        expect(six.finalists).toEqual([]);
        continue;
      }
      expect(six.finalists.length).toBeGreaterThanOrEqual(1);
      expect(six.finalists.length).toBeLessThanOrEqual(6);
      expect(six.finalists[0].proposal).toEqual(six.proposal);
      expect(new Set(six.finalists.map((f) => f.proposal.restaurantId)).size).toBe(six.finalists.length);
      for (const f of six.finalists) expect(f.tally.reject).toBe(0);
      // Everything on the list was really proposed, and it found at least as many as stopping early.
      const proposed = new Set(six.rounds.flatMap((r) => r.proposals.map((p) => key(p.proposal))));
      for (const f of six.finalists) expect(proposed.has(key(f.proposal))).toBe(true);
      if (six.finalists.length === 6) full++;
    }
    expect(full).toBeGreaterThan(10);
  });

  it("puts options everyone accepts above ones that are a stretch for someone", async () => {
    let mixed = 0;
    for (const sim of cases) {
      const six = await run(sim, { shortlist: 6 });
      const everyoneIn = six.finalists.map((f) => f.tally.accept === sim.prefs.length);
      if (everyoneIn.includes(true) && everyoneIn.includes(false)) mixed++;
      // Once a "stretch" option appears, no fully accepted one follows it.
      expect(everyoneIn.slice(everyoneIn.indexOf(false)).includes(true) && everyoneIn.includes(false)).toBe(false);
      if (everyoneIn.includes(true)) expect(six.status).toBe("agreed");
    }
    expect(mixed).toBeGreaterThan(0);
  });

  it("keeps looking after the first agreement, at the same concession level, and stops when it has six", async () => {
    let longer = 0;
    for (const sim of cases) {
      const one = await run(sim);
      const six = await run(sim, { shortlist: 6 });
      if (one.status !== "agreed") continue;
      expect(six.rounds.length).toBeGreaterThanOrEqual(one.rounds.length);
      expect(six.concessionLevel).toBe(one.concessionLevel);
      if (six.rounds.length > one.rounds.length) longer++;
      const found = (upTo: number) =>
        new Set(
          six.rounds
            .slice(0, upTo)
            .flatMap((r) => r.proposals.filter((p) => p.tally.reject === 0).map((p) => p.proposal.restaurantId)),
        ).size;
      // It did not run a round it had no need for.
      if (six.rounds.length > one.rounds.length) expect(found(six.rounds.length - 1)).toBeLessThan(6);
    }
    expect(longer).toBeGreaterThan(5);
  });
});
