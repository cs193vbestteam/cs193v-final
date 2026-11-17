import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { maskGroup, type Agent, type PrivateAgent } from "@/lib/agent";
import type { Bucket, Proposal } from "@/lib/evaluate";
import { MODULUS, exponentsOf, logOf, maskValues, pairKeys, sumMasked } from "@/lib/masked-sum";
import { negotiate } from "@/lib/negotiate";
import { RESTAURANTS } from "@/lib/restaurants";
import { agentsFor, synthCase } from "../sim/pipeline";
import { makeRng } from "../sim/rng";

/**
 * #15: the final pick compares finalists on the group's Nash product without
 * the mediator seeing any individual 1..5 bucket.
 */

const P = (restaurantId: string): Proposal => ({ restaurantId, slot: "18:00" });
const [X, Y, Z] = [P("x"), P("y"), P("z")];

/** Assistants with fixed buckets: `table[member][restaurantId]`. They accept everything. */
const fixed = (table: Record<string, Bucket>[]): PrivateAgent[] =>
  table.map((mine) => ({
    judge: () => ({ verdict: "accept" as const }),
    bucket: (p) => mine[p.restaurantId] ?? 1,
  }));

const product = (xs: number[]) => xs.reduce((a, b) => a * b, 1);

describe("buckets as exponents", () => {
  it("writes each bucket as 2s, 3s and 5s, so adding exponents multiplies buckets", () => {
    for (const b of [1, 2, 3, 4, 5]) expect(Math.exp(logOf(exponentsOf(b)))).toBeCloseTo(b, 10);
    for (const buckets of [
      [5, 4, 3],
      [1, 1, 1, 1],
      [4, 4, 2, 5, 3, 3],
    ]) {
      const sum = buckets.map(exponentsOf).reduce<number[]>((acc, e) => acc.map((x, k) => x + e[k]), [0, 0, 0]);
      expect(Math.exp(logOf(sum))).toBeCloseTo(product(buckets), 8);
    }
    expect(exponentsOf(7)).toEqual([0, 0, 0]); // anything else counts as 1
  });
});

describe("pairwise masks", () => {
  it("cancel in the sum and hide every single message", () => {
    const values = [
      [2, 0, 1, -1, 0, 0],
      [0, 1, 0, 0, 0, -1],
      [-2, 0, 0, 1, 1, 0],
      [0, 0, 0, 0, 0, 0],
    ];
    const keys = pairKeys(values.length);
    const messages = values.map((v, i) => maskValues(i, keys, "q1", v));
    expect(sumMasked(messages)).toEqual([0, 1, 1, 0, 1, -1]);
    for (const [i, message] of messages.entries()) {
      for (const x of message) {
        expect(Number.isInteger(x)).toBe(true);
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThan(MODULUS);
      }
      // A masked message is not the value it carries, even for the member whose values are all zero.
      expect(message).not.toEqual(values[i]);
      expect(message.every((x) => x > 1000 && x < MODULUS - 1000)).toBe(true);
    }
    // Leaving one member out leaves masks that do not cancel: a partial sum says nothing.
    expect(sumMasked(messages.slice(0, 3))).not.toEqual([0, 1, 1, 0, 1, -1]);
  });

  it("use different masks for different questions and different groups", () => {
    const keys = pairKeys(3);
    expect(maskValues(0, keys, "q1", [1, 2, 3])).not.toEqual(maskValues(0, keys, "q2", [1, 2, 3]));
    expect(maskValues(0, keys, "q1", [1, 2, 3])).toEqual(maskValues(0, keys, "q1", [1, 2, 3]));
    expect(maskValues(0, pairKeys(3), "q1", [1, 2, 3])).not.toEqual(maskValues(0, keys, "q1", [1, 2, 3]));
  });

  it("the same private values look different to the mediator every time a group is formed", () => {
    const table = [
      { x: 5, y: 3 },
      { x: 4, y: 4 },
      { x: 3, y: 5 },
    ] as Record<string, Bucket>[];
    const first = maskGroup(fixed(table)).map((a) => a.compare([X, Y], 0));
    const second = maskGroup(fixed(table)).map((a) => a.compare([X, Y], 0));
    expect(first).not.toEqual(second);
    expect(sumMasked(first)).toEqual(sumMasked(second));
  });

  it("a lone member has nobody to mask with: the sum is their own answer, which the sum always is", () => {
    const [alone] = maskGroup(fixed([{ x: 4, y: 5 }]));
    // y relative to x: lose two 2s, gain one 5.
    expect(sumMasked([alone.compare([X, Y], 0)])).toEqual([-2, 0, 1]);
  });
});

describe("what the mediator can do with a masked group", () => {
  const table = [
    { x: 5, y: 4, z: 3 },
    { x: 3, y: 4, z: 5 },
    { x: 4, y: 4, z: 3 },
  ] as Record<string, Bucket>[];

  it("gets the exact ratio of Nash products between finalists, and nothing per person", () => {
    const agents = maskGroup(fixed(table));
    const messages = agents.map((a) => a.compare([X, Y, Z], 0));
    const sums = sumMasked(messages);
    const nash = (id: string) => product(table.map((t) => t[id]));
    expect(Math.exp(logOf(sums.slice(0, 3)))).toBeCloseTo(nash("y") / nash("x"), 8); // 64 / 60
    expect(Math.exp(logOf(sums.slice(3, 6)))).toBeCloseTo(nash("z") / nash("x"), 8); // 45 / 60
    // No single message equals the plain differences it carries.
    table.forEach((mine, i) => {
      const plain = [Y, Z].flatMap((p) => exponentsOf(mine[p.restaurantId]).map((e, k) => e - exponentsOf(mine.x)[k]));
      expect(messages[i]).not.toEqual(plain);
      expect(messages[i].some((x) => x > 1000)).toBe(true);
    });
  });

  it("cannot ask for a bucket: the agents it holds have no such method", () => {
    for (const agent of maskGroup(fixed(table))) {
      expect(Object.keys(agent).sort()).toEqual(["compare", "judge"]);
      expect(agent).not.toHaveProperty("bucket");
    }
  });

  it("has nothing to compare with fewer than two finalists", () => {
    const [a] = maskGroup(fixed(table));
    expect(a.compare([X], 0)).toEqual([]);
    expect(a.compare([], 0)).toEqual([]);
  });
});

describe("negotiate with masked agents", () => {
  /** Record everything the mediator receives from the agents during a negotiation. */
  function recording(agents: Agent[]) {
    const seen: unknown[] = [];
    const wrapped: Agent[] = agents.map((a) => ({
      judge(p, level) {
        const j = a.judge(p, level);
        seen.push(j);
        return j;
      },
      compare(finalists, level) {
        const m = a.compare(finalists, level);
        seen.push(m);
        return m;
      },
    }));
    return { wrapped, seen };
  }

  it("picks the true Nash optimum among the finalists without ever receiving a bucket", async () => {
    const rng = makeRng(21);
    let compared = 0;
    for (let i = 0; i < 25; i++) {
      const c = synthCase(rng, i, { restaurants: 30, minSize: 3, maxSize: 6 });
      const { wrapped, seen } = recording(agentsFor(c));
      const result = await negotiate(wrapped, { restaurants: c.restaurants, finalists: 6, exploreRounds: 1 });
      if (result.finalists.length < 2) continue;
      compared++;

      // Everything received is a verdict (with at most a dimension name) or a masked message.
      const messages = seen.filter(Array.isArray) as number[][];
      expect(messages).toHaveLength(c.prefs.length);
      for (const item of seen) {
        if (Array.isArray(item)) continue;
        expect(Object.keys(item as object).every((k) => k === "verdict" || k === "dim")).toBe(true);
      }
      // With 3+ members no message contains a small number, so none can be a bucket or a bucket's exponent.
      for (const m of messages) expect(m.every((x) => x > 1000 && x < MODULUS - 1000)).toBe(true);

      // The result carries ratios only, and they are the true ones.
      const { bucket } = await import("@/lib/evaluate");
      const truth = result.finalists.map((f) =>
        c.prefs.reduce(
          (acc, prefs) =>
            acc *
            bucket(
              prefs,
              c.restaurants.find((r) => r.id === f.proposal.restaurantId)!,
              f.proposal.slot,
              result.concessionLevel,
            ),
          1,
        ),
      );
      const best = Math.max(...truth);
      result.finalists.forEach((f, k) => expect(f.relative).toBeCloseTo(truth[k] / best, 5));
      const chosen = result.finalists.findIndex((f) => f.proposal === result.proposal);
      expect(truth[chosen]).toBe(best);
      expect(JSON.stringify(result)).not.toMatch(/bucket|nash/i);
    }
    expect(compared).toBeGreaterThan(5);
  });

  it("gives the same result whatever the masks are", async () => {
    const c = synthCase(makeRng(5), 0, { restaurants: 30, minSize: 4, maxSize: 4 });
    const opts = { restaurants: c.restaurants, finalists: 6, exploreRounds: 1 };
    expect(await negotiate(agentsFor(c), opts)).toEqual(await negotiate(agentsFor(c), opts));
  });

  it("breaks an exact tie by the ranking the mediator already had, not by anyone's bucket", async () => {
    // Two finalists with the same Nash product (5·3 and 3·5): the earlier one in the ranking wins.
    const ids = RESTAURANTS.slice(0, 2)
      .map((r) => r.id)
      .sort();
    const table = [
      { [ids[0]]: 5, [ids[1]]: 3 },
      { [ids[0]]: 3, [ids[1]]: 5 },
    ] as Record<string, Bucket>[];
    const members: PrivateAgent[] = fixed(table).map((m) => ({
      ...m,
      judge: (p) => (ids.includes(p.restaurantId) ? { verdict: "accept" } : { verdict: "reject", dim: "price" }),
    }));
    const pool = RESTAURANTS.filter((r) => ids.includes(r.id));
    const result = await negotiate(maskGroup(members), { restaurants: pool, perRound: 20, finalists: 20 });
    expect(result.status).toBe("agreed");
    expect(result.finalists.length).toBeGreaterThan(1);
    expect(result.finalists.every((f) => f.relative === 1)).toBe(true);
    expect(result.proposal).toBe(result.finalists[0].proposal);
  });
});

describe("where a bucket may appear", () => {
  const read = (file: string) => readFileSync(path.resolve(__dirname, "../src/lib", `${file}.ts`), "utf8");

  it("negotiate.ts and mediator.ts never call for one and never import the unmasked agent", () => {
    for (const file of ["negotiate", "mediator"]) {
      const src = read(file);
      expect(src, file).not.toMatch(/\.bucket\(/);
      expect(src, file).not.toMatch(/PrivateAgent|makeAgent|pairKeys|maskValues/);
    }
  });

  it("the pair keys are made in one place and never leave agent.ts", () => {
    expect(read("agent")).toMatch(/pairKeys\(members\.length\)/);
    for (const file of ["negotiate", "mediator", "events"]) expect(read(file), file).not.toMatch(/pairKeys/);
  });
});
