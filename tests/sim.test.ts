import { describe, expect, it } from "vitest";
import { negotiate } from "@/lib/negotiate";
import { agentsFor, countingAgent, DEFAULT_NEGOTIATE, runSim, synthCase, type SimReport } from "../sim/pipeline";
import { makeRng } from "../sim/rng";
import { toMarkdown, toSvg } from "../sim/report";

const GROUPS = 12;
const SEED = 7;

function stripTime(r: SimReport): SimReport {
  return { ...r, meta: { ...r.meta, generatedAt: "" } };
}

describe("sim harness", () => {
  it("ratios are in [0, 1] when defined and the oracle bounds the protocol", async () => {
    const report = await runSim({ groups: GROUPS, seed: SEED });
    expect(report.groups).toHaveLength(GROUPS);
    for (const g of report.groups) {
      for (const r of [g.protocol.nashRatio, g.protocol.maxMinRatio, g.naive.nashRatio, g.naive.maxMinRatio]) {
        if (r !== undefined) {
          expect(r).toBeGreaterThanOrEqual(0);
          expect(r).toBeLessThanOrEqual(1);
        }
      }
      // Oracle optimum >= protocol outcome, always.
      expect(g.oracle.bestNash).toBeGreaterThanOrEqual(g.protocol.nash);
      expect(g.oracle.bestMaxMin).toBeGreaterThanOrEqual(g.protocol.maxMin);
      expect(g.oracle.bestNash).toBeGreaterThanOrEqual(g.naive.nash);
      // Nothing feasible for the oracle means nothing feasible for anyone.
      if (g.oracle.feasibleCount === 0) {
        expect(g.status).toBe("no_deal");
        expect(g.protocol.found).toBe(false);
        expect(g.protocol.nashRatio).toBeUndefined();
      }
      if (g.protocol.found) expect(g.protocol.utilities.every((u) => u >= 0 && u <= 1)).toBe(true);
      expect(g.size).toBeGreaterThanOrEqual(3);
      expect(g.size).toBeLessThanOrEqual(6);
    }
  });

  it("is deterministic: same seed, same JSON", async () => {
    const a = await runSim({ groups: GROUPS, seed: SEED });
    const b = await runSim({ groups: GROUPS, seed: SEED });
    expect(JSON.stringify(stripTime(a))).toBe(JSON.stringify(stripTime(b)));
    const c = await runSim({ groups: GROUPS, seed: SEED + 1 });
    expect(JSON.stringify(stripTime(c))).not.toBe(JSON.stringify(stripTime(a)));
  });

  it("leakedDims equals every dimension name the agents returned, rounds and final re-check alike", async () => {
    const rng = makeRng(SEED);
    for (let i = 0; i < GROUPS; i++) {
      const c = synthCase(rng, i, { restaurants: 30, minSize: 3, maxSize: 6 });
      // Record every judge() answer in call order so the in-round calls can be separated from the final re-check.
      const seen: boolean[] = [];
      const agents = agentsFor(c, (a) => {
        const inner = countingAgent(a, { dims: 0, calls: 0 });
        return {
          judge(p, level) {
            const j = inner.judge(p, level);
            seen.push(Boolean(j.dim));
            return j;
          },
          bucket: inner.bucket,
        };
      });
      const result = await negotiate(agents, { restaurants: c.restaurants, ...DEFAULT_NEGOTIATE });
      expect(result.leakedDims).toBe(seen.filter(Boolean).length);
    }
  });

  it("renders a report", async () => {
    const report = await runSim({ groups: GROUPS, seed: SEED });
    const svg = toSvg(report);
    expect(svg).toContain("<svg");
    expect(svg).toContain("</svg>");
    expect(svg).toContain("oracle = 1.0");
    const md = toMarkdown(report);
    expect(md).toContain("| all |");
    expect(report.bySize.length).toBeGreaterThan(0);
  });
});
