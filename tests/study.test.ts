import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { summarize } from "../sim/metrics";
import { DEFAULT_NEGOTIATE, runSim } from "../sim/pipeline";
import {
  DEFAULT_PER_ROUNDS,
  DEFAULT_SEEDS,
  DEFAULT_VARIANTS,
  METRICS,
  aggregateSeeds,
  formatDifference,
  formatInterval,
  injectBlock,
  interval,
  llmMarkdown,
  pairedDifference,
  readBlock,
  runSeeds,
  runStudy,
  seedRow,
  studyMarkdown,
  studySvg,
  tCritical95,
  type MetricKey,
  type SeedRow,
} from "../sim/study";

const GROUPS = 12;
const SEEDS = [3, 4, 5];

const row = (seed: number, overrides: Partial<Record<MetricKey, number | null>>): SeedRow => ({
  seed,
  values: { ...(Object.fromEntries(METRICS.map((m) => [m.key, 0])) as Record<MetricKey, number | null>), ...overrides },
});

describe("interval", () => {
  it("uses Student's t, falling back to the normal value past 30 degrees of freedom", () => {
    expect(tCritical95(1)).toBe(12.706);
    expect(tCritical95(9)).toBe(2.262);
    expect(tCritical95(30)).toBe(2.042);
    expect(tCritical95(31)).toBe(1.96);
    expect(() => tCritical95(0)).toThrow();
    expect(() => tCritical95(2.5)).toThrow();
  });

  it("gives the mean, sample standard deviation and 95% bounds", () => {
    const i = interval([1, 2, 3, 4, 5]);
    expect(i.n).toBe(5);
    expect(i.mean).toBe(3);
    expect(i.sd).toBeCloseTo(Math.sqrt(2.5), 12);
    const half = (2.776 * Math.sqrt(2.5)) / Math.sqrt(5);
    expect(i.lo).toBeCloseTo(3 - half, 12);
    expect(i.hi).toBeCloseTo(3 + half, 12);
  });

  it("collapses to the value when every seed agrees", () => {
    expect(interval([0.5, 0.5, 0.5])).toEqual({ n: 3, mean: 0.5, sd: 0, lo: 0.5, hi: 0.5 });
  });

  it("reports no interval for one value and nothing at all for none", () => {
    expect(interval([0.7])).toEqual({ n: 1, mean: 0.7, sd: null, lo: null, hi: null });
    expect(interval([])).toEqual({ n: 0, mean: null, sd: null, lo: null, hi: null });
  });
});

describe("aggregateSeeds", () => {
  it("aggregates each metric over the seeds, in the order given", () => {
    const agg = aggregateSeeds(5, [
      row(1, { nashRatio: 0.9 }),
      row(2, { nashRatio: 0.94 }),
      row(3, { nashRatio: 0.98 }),
    ]);
    expect(agg.perRound).toBe(5);
    expect(agg.seeds.map((s) => s.seed)).toEqual([1, 2, 3]);
    expect(agg.stats.nashRatio.n).toBe(3);
    expect(agg.stats.nashRatio.mean).toBeCloseTo(0.94, 12);
    expect(agg.stats.nashRatio.lo).toBeCloseTo(0.94 - (4.303 * 0.04) / Math.sqrt(3), 12);
    expect(Object.keys(agg.stats).sort()).toEqual(METRICS.map((m) => m.key).sort());
  });

  it("leaves a seed out of only the metric it has no value for", () => {
    const agg = aggregateSeeds(5, [
      row(1, { hitsOptimum: null, leakedDims: 10 }),
      row(2, { hitsOptimum: 0.4, leakedDims: 20 }),
      row(3, { hitsOptimum: 0.6, leakedDims: 30 }),
    ]);
    expect(agg.stats.hitsOptimum.n).toBe(2);
    expect(agg.stats.hitsOptimum.mean).toBeCloseTo(0.5, 12);
    expect(agg.stats.leakedDims.n).toBe(3);
    expect(agg.stats.leakedDims.mean).toBe(20);
  });
});

describe("pairedDifference", () => {
  it("pairs by seed, not by position, and skips seeds missing on either side", () => {
    const a = aggregateSeeds(8, [row(1, { leakedDims: 30 }), row(2, { leakedDims: 44 }), row(3, { leakedDims: null })]);
    const b = aggregateSeeds(5, [row(2, { leakedDims: 40 }), row(1, { leakedDims: 28 }), row(4, { leakedDims: 99 })]);
    const d = pairedDifference(a, b, "leakedDims");
    expect(d.n).toBe(2); // seeds 1 and 2
    expect(d.mean).toBe(3); // (30-28 + 44-40) / 2
  });

  it("is exactly zero against itself", () => {
    const a = aggregateSeeds(5, [row(1, { nashRatio: 0.9 }), row(2, { nashRatio: 0.95 })]);
    expect(pairedDifference(a, a, "nashRatio")).toMatchObject({ n: 2, mean: 0, lo: 0, hi: 0 });
  });
});

describe("runSeeds", () => {
  it("each seed's row is that seed's own overall summary", async () => {
    const agg = await runSeeds({ seeds: SEEDS, groups: GROUPS });
    expect(agg.perRound).toBe(DEFAULT_NEGOTIATE.perRound);
    for (const s of agg.seeds) {
      const report = await runSim({ groups: GROUPS, seed: s.seed });
      expect(s).toEqual(seedRow(s.seed, report.overall));
      expect(s.values.agreed).toBe(report.overall.convergenceRate);
      expect(s.values.leakedDims).toBe(report.overall.leakedDims.mean);
    }
    const leaked = agg.seeds.map((s) => s.values.leakedDims as number);
    expect(agg.stats.leakedDims.mean).toBeCloseTo(leaked.reduce((x, y) => x + y, 0) / leaked.length, 12);
    expect(agg.stats.leakedDims.lo!).toBeLessThanOrEqual(agg.stats.leakedDims.mean!);
    expect(agg.stats.leakedDims.hi!).toBeGreaterThanOrEqual(agg.stats.leakedDims.mean!);
  });

  it("is deterministic, and different seeds are different populations", async () => {
    const a = await runSeeds({ seeds: SEEDS, groups: GROUPS });
    const b = await runSeeds({ seeds: SEEDS, groups: GROUPS });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(new Set(a.seeds.map((s) => JSON.stringify(s.values))).size).toBe(SEEDS.length);
  });

  it("passes perRound through to the negotiation", async () => {
    const agg = await runSeeds({ seeds: [3], groups: GROUPS, perRound: 2 });
    const report = await runSim({ groups: GROUPS, seed: 3, negotiate: { perRound: 2 } });
    expect(report.meta.negotiate.perRound).toBe(2);
    expect(agg.seeds[0]).toEqual(seedRow(3, report.overall));
    const shipped = await runSeeds({ seeds: [3], groups: GROUPS });
    expect(agg.seeds[0].values).not.toEqual(shipped.seeds[0].values);
  });

  it("refuses no seeds, and a seed given twice", async () => {
    await expect(runSeeds({ seeds: [], groups: GROUPS })).rejects.toThrow(/at least one seed/);
    await expect(runSeeds({ seeds: [1, 2, 1], groups: GROUPS })).rejects.toThrow(/distinct/);
  });
});

describe("runStudy", () => {
  it("sweeps perRound in ascending order and always includes the shipped value", async () => {
    const study = await runStudy({ seeds: SEEDS, groups: GROUPS, perRounds: [8, 2] });
    expect(study.meta.perRounds).toEqual([2, DEFAULT_NEGOTIATE.perRound, 8]);
    expect(study.sweep.map((a) => a.perRound)).toEqual(study.meta.perRounds);
    expect(study.base).toBe(study.sweep[1]);
    expect(study.base).toEqual(await runSeeds({ seeds: SEEDS, groups: GROUPS }));
    expect(study.sweep[2]).toEqual(await runSeeds({ seeds: SEEDS, groups: GROUPS, perRound: 8 }));
  });

  it("renders the same tables and chart every time, one row per metric and per perRound", async () => {
    const study = await runStudy({ seeds: SEEDS, groups: GROUPS, perRounds: [3, 8] });
    const md = studyMarkdown(study);
    expect(md).toBe(studyMarkdown(await runStudy({ seeds: SEEDS, groups: GROUPS, perRounds: [3, 8] })));
    expect(md).toContain("3 seeds (3 to 5), 12 synthetic groups per seed");
    expect(md).toContain("2 degrees of freedom");
    for (const m of METRICS) expect(md).toContain(`| ${m.label} |`);
    for (const p of ["| 3 |", "| 5 (shipped) |", "| 8 |"]) expect(md).toContain(p);
    expect(md).toMatch(/Difference from the shipped 5/);
    expect(md).not.toMatch(/NaN|undefined|Infinity/);
    const svg = studySvg(study);
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).not.toMatch(/NaN|undefined|Infinity/);
    expect(svg.match(/<circle /g)).toHaveLength(2 * 3); // two panels x three perRound values
  });

  it("compares protocol variants against the shipped one over the same seeds", async () => {
    const study = await runStudy({
      seeds: SEEDS,
      groups: GROUPS,
      perRounds: [5],
      variants: [{ name: "one more round", negotiate: { exploreRounds: 1 } }],
    });
    expect(study.variants.map((v) => v.name)).toEqual(["one more round"]);
    const variant = study.variants[0].aggregate;
    expect(variant).toEqual(await runSeeds({ seeds: SEEDS, groups: GROUPS, negotiate: { exploreRounds: 1 } }));
    expect(variant.seeds.map((s) => s.seed)).toEqual(study.base.seeds.map((s) => s.seed));
    // An exploring round can only add answers and rounds, never remove them.
    expect(pairedDifference(variant, study.base, "leakedDims").mean!).toBeGreaterThanOrEqual(0);
    expect(pairedDifference(variant, study.base, "rounds").mean!).toBeGreaterThan(0);
    expect(pairedDifference(variant, study.base, "agreed").mean).toBe(0);
    const md = studyMarkdown(study);
    expect(md).toContain("| stop at the first agreement (shipped) |");
    expect(md).toContain("| one more round |");
    expect(md).toContain("**Difference from the shipped protocol**, paired by seed");
  });

  it("uses the exploring-round variants by default and can run with none", async () => {
    const withDefaults = await runStudy({ seeds: [3], groups: GROUPS, perRounds: [5] });
    expect(withDefaults.variants.map((v) => v.negotiate)).toEqual(DEFAULT_VARIANTS.map((v) => v.negotiate));
    const none = await runStudy({ seeds: SEEDS, groups: GROUPS, perRounds: [5], variants: [] });
    expect(none.variants).toEqual([]);
    expect(studyMarkdown(none)).not.toMatch(/After the first unanimous accept/);
  });

  it("with a single seed shows means and no intervals", async () => {
    const md = studyMarkdown(await runStudy({ seeds: [3], groups: GROUPS, perRounds: [5] }));
    expect(md).toContain("1 seeds (3)");
    expect(md).not.toMatch(/\d%? \[/); // no "value [lo, hi]" cells, only the column header mentions an interval
    expect(md).not.toMatch(/Difference from the shipped/);
  });
});

describe("formatting", () => {
  it("formats rates, ratios and counts with their intervals", () => {
    const i = { n: 3, mean: 0.5, sd: 0.1, lo: 0.25, hi: 0.75 };
    expect(formatInterval(i, "pct")).toBe("50.0% [25.0%, 75.0%]");
    expect(formatInterval(i, "ratio")).toBe("0.500 [0.250, 0.750]");
    expect(formatInterval(i, "count")).toBe("0.50 [0.25, 0.75]");
    expect(formatInterval({ n: 1, mean: 0.5, sd: null, lo: null, hi: null }, "pct")).toBe("50.0%");
    expect(formatInterval(interval([]), "pct")).toBe("-");
  });
  it("signs differences and gives rates in percentage points", () => {
    const d = { n: 3, mean: 0.011, sd: 0.01, lo: -0.01, hi: 0.033 };
    expect(formatDifference(d, "pct")).toBe("+1.1 pts [-1.0 pts, +3.3 pts]");
    expect(formatDifference(d, "ratio")).toBe("+0.011 [-0.010, +0.033]");
    expect(formatDifference({ n: 2, mean: 0, sd: 0, lo: 0, hi: 0 }, "count")).toBe("0.00 [0.00, 0.00]");
  });
});

describe("generated blocks", () => {
  const doc = "intro\n<!-- generated:study:start -->\nold\n<!-- generated:study:end -->\noutro\n";

  it("replaces only what is between the markers", () => {
    const next = injectBlock(doc, "study", "new\ntable\n");
    expect(next).toBe("intro\n<!-- generated:study:start -->\n\nnew\ntable\n\n<!-- generated:study:end -->\noutro\n");
    expect(readBlock(next, "study")).toBe("new\ntable");
    expect(injectBlock(next, "study", "new\ntable")).toBe(next);
  });

  it("refuses a document without the block", () => {
    expect(() => injectBlock(doc, "llm", "x")).toThrow(/no "llm" generated block/);
    expect(readBlock(doc, "llm")).toBeNull();
  });
});

describe("LLM baseline table", () => {
  it("is absent for a run without the baseline", async () => {
    expect(llmMarkdown(await runSim({ groups: GROUPS, seed: 3 }))).toBeNull();
  });

  it("scores all three methods on exactly the groups that had the call", async () => {
    const report = await runSim({ groups: GROUPS, seed: 3 });
    const called = report.groups.slice(0, 6);
    // A stand-in model: it picks the protocol's own plan, except on the first solvable group, where it picks nothing.
    const firstSolvable = called.find((g) => g.oracle.feasibleCount > 0)!;
    for (const g of called) {
      g.llm =
        g === firstSolvable
          ? {
              ...g.protocol,
              found: false,
              proposal: null,
              nash: 0,
              maxMin: 0,
              nashRatio: 0,
              maxMinRatio: 0,
              model: "fake",
            }
          : { ...g.protocol, model: "fake" };
    }
    report.overall = summarize("all", report.groups);
    report.meta.llm = { model: "fake", groupsRequested: 6, groupIds: [0, 1, 2, 3, 4, 5], concurrency: 1, timeoutMs: 1 };

    const md = llmMarkdown(report)!;
    const solvable = called.filter((g) => g.oracle.feasibleCount > 0);
    expect(md).toContain("Model `fake`, groups 0 to 5 of seed 3");
    expect(md).toContain(`(6 calls, ${solvable.length} on groups the oracle could solve, 0 failed calls`);
    const pct = (k: number) => `${((k / solvable.length) * 100).toFixed(1)}%`;
    const cells = (name: string) =>
      md
        .split("\n")
        .find((l) => l.startsWith(`| ${name} |`))!
        .split("|")
        .map((c) => c.trim());
    expect(cells("LLM, no privacy")[3]).toBe(pct(solvable.filter((g) => g.protocol.found).length - 1));
    expect(cells("protocol")[3]).toBe(pct(solvable.filter((g) => g.protocol.found).length));
    expect(cells("naive")[3]).toBe(pct(solvable.filter((g) => g.naive.found).length));
    expect(md).toContain(
      `Of the ${solvable.length} solvable groups, the model's pick broke someone's hard rule or was not a real candidate in 1;`,
    );
    expect(md).not.toMatch(/NaN|undefined/);
  });
});

describe("docs/evaluation.md", () => {
  it("holds exactly what `npm run sim:study` generates: every number in the study tables is reproducible", async () => {
    const doc = readFileSync(path.join(__dirname, "../docs/evaluation.md"), "utf8");
    const study = await runStudy({ seeds: DEFAULT_SEEDS, groups: 200, perRounds: DEFAULT_PER_ROUNDS });
    expect(DEFAULT_SEEDS.length).toBeGreaterThanOrEqual(10);
    expect(readBlock(doc, "study")).toBe(studyMarkdown(study));
  }, 120_000);
});
