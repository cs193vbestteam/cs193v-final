import { afterEach, describe, expect, it, vi } from "vitest";
import { negotiate } from "@/lib/negotiate";
import { candidatePool } from "@/lib/mediator";
import { llmBaselinePick, PICK_TOOL } from "../sim/llm-baseline";
import { agentsFor, countingAgent, DEFAULT_NEGOTIATE, runSim, synthCase, type SimReport } from "../sim/pipeline";
import { makeRng } from "../sim/rng";
import { toMarkdown, toStdout, toSvg } from "../sim/report";

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

/* ------------------------------------------------------------------ */
/* LLM baseline (no network: fetch is stubbed)                         */
/* ------------------------------------------------------------------ */

type FakeBody = {
  model: string;
  system: string;
  tools: { name: string }[];
  tool_choice: { type: string; name?: string };
  messages: { role: string; content: string }[];
};

/** A fetch that answers every call with one tool_use block whose input is produced by `pick`. */
function fakeFetch(pick: (body: FakeBody) => unknown, status = 200) {
  const calls: FakeBody[] = [];
  const fn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as FakeBody;
    calls.push(body);
    const payload = {
      content: [{ type: "tool_use", name: PICK_TOOL.name, input: pick(body) }],
      stop_reason: "tool_use",
    };
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    } as unknown as Response;
  });
  return { fn, calls };
}

describe("LLM no-privacy baseline", () => {
  afterEach(() => vi.unstubAllGlobals());

  const group = () => {
    const c = synthCase(makeRng(SEED), 0, { restaurants: 30, minSize: 3, maxSize: 6 });
    return { prefs: c.prefs, restaurants: c.restaurants };
  };

  it("sends every preference file and the full candidate list, forces the tool, and parses a valid pick", async () => {
    const g = group();
    const pool = candidatePool(g.restaurants);
    const target = pool[pool.length - 1];
    const { fn, calls } = fakeFetch(() => ({ restaurantId: target.r.id, slot: target.slot }));
    vi.stubGlobal("fetch", fn);

    const pick = await llmBaselinePick(g, { apiKey: "test-key", model: "test-model" });
    expect(pick).toEqual({ restaurantId: target.r.id, slot: target.slot });

    expect(fn).toHaveBeenCalledTimes(1);
    const [url, init] = fn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("test-key");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    const body = calls[0];
    expect(body.model).toBe("test-model");
    expect(body.tool_choice).toEqual({ type: "tool", name: PICK_TOOL.name });
    expect(body.tools[0].name).toBe(PICK_TOOL.name);
    const shown = JSON.parse(body.messages[0].content) as {
      members: { preferences: unknown }[];
      candidates: { restaurantId: string; slot: string }[];
    };
    // No privacy: all preference files, verbatim, and every (restaurant, open slot) pair.
    expect(shown.members.map((m) => m.preferences)).toEqual(g.prefs);
    expect(shown.candidates).toHaveLength(pool.length);
    expect(new Set(shown.candidates.map((c) => `${c.restaurantId}@${c.slot}`))).toEqual(
      new Set(pool.map((c) => `${c.r.id}@${c.slot}`)),
    );
  });

  it("returns null for a pick that is not a real candidate", async () => {
    const g = group();
    // 1. a restaurant that does not exist
    vi.stubGlobal("fetch", fakeFetch(() => ({ restaurantId: "nope", slot: "sat_dinner" })).fn);
    expect(await llmBaselinePick(g, { apiKey: "k" })).toBeNull();
    // 2. a real restaurant at a slot it is not open for
    const closed = g.restaurants.find((r) => r.open.length < 5)!;
    const closedSlot = (["fri_dinner", "sat_lunch", "sat_dinner", "sun_lunch", "sun_dinner"] as const).find(
      (s) => !closed.open.includes(s),
    )!;
    vi.stubGlobal("fetch", fakeFetch(() => ({ restaurantId: closed.id, slot: closedSlot })).fn);
    expect(await llmBaselinePick(g, { apiKey: "k" })).toBeNull();
    // 3. malformed input
    vi.stubGlobal("fetch", fakeFetch(() => ({ restaurantId: 7 })).fn);
    expect(await llmBaselinePick(g, { apiKey: "k" })).toBeNull();
    // 4. no tool_use block at all
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          ({
            ok: true,
            status: 200,
            json: async () => ({ content: [{ type: "text", text: "r1" }] }),
          }) as unknown as Response,
      ),
    );
    expect(await llmBaselinePick(g, { apiKey: "k" })).toBeNull();
  });

  it("throws on an HTTP failure so the pipeline can record it", async () => {
    vi.stubGlobal("fetch", fakeFetch(() => ({}), 500).fn);
    await expect(llmBaselinePick(group(), { apiKey: "k" })).rejects.toThrow(/500/);
  });

  it("runSim attaches an llm outcome to exactly the first N groups and the renderers show the column", async () => {
    // The fake model always picks the oracle's Nash optimum when there is one, so the LLM ratio must be 1 on feasible groups.
    const rng = makeRng(SEED);
    const optimum = new Map<string, { restaurantId: string; slot: string } | null>();
    const { oracle } = await import("../sim/oracle");
    for (let i = 0; i < GROUPS; i++) {
      const c = synthCase(rng, i, { restaurants: 30, minSize: 3, maxSize: 6 });
      optimum.set(JSON.stringify(c.prefs), oracle(c.prefs, c.restaurants).bestNashProposal);
    }
    const { fn } = fakeFetch((body) => {
      const shown = JSON.parse(body.messages[0].content) as { members: { preferences: unknown }[] };
      const best = optimum.get(JSON.stringify(shown.members.map((m) => m.preferences)));
      return best ?? { restaurantId: "none", slot: "sat_dinner" };
    });
    vi.stubGlobal("fetch", fn);

    const N = 5;
    const report = await runSim({
      groups: GROUPS,
      seed: SEED,
      llm: { apiKey: "k", model: "fake", groups: N, concurrency: 2 },
    });
    expect(fn).toHaveBeenCalledTimes(N);
    expect(report.meta.llm).toEqual({
      model: "fake",
      groupsRequested: N,
      groupIds: [0, 1, 2, 3, 4],
      concurrency: 2,
      timeoutMs: expect.any(Number),
    });
    for (const g of report.groups) {
      if (g.id < N) {
        expect(g.llm).toBeDefined();
        expect(g.llm!.model).toBe("fake");
        expect(g.llm!.error).toBeUndefined();
        if (g.oracle.feasibleCount > 0) expect(g.llm!.nashRatio).toBeCloseTo(1, 12);
        else expect(g.llm!.found).toBe(false);
      } else {
        expect(g.llm).toBeUndefined();
      }
    }
    expect(report.overall.llm).toBeDefined();
    expect(report.overall.llm!.groups).toBe(N);
    expect(report.overall.llm!.errors).toBe(0);
    if (report.overall.llm!.feasible > 0) expect(report.overall.llm!.hitsOptimum).toBe(1);
    // The protocol numbers are untouched by the baseline.
    const plain = await runSim({ groups: GROUPS, seed: SEED });
    expect(plain.groups.map((g) => g.protocol)).toEqual(report.groups.map((g) => g.protocol));
    expect(plain.overall.llm).toBeUndefined();
    expect(JSON.stringify(plain)).not.toContain('"llm"');

    const md = toMarkdown(report);
    expect(md).toContain("Nash ratio LLM (no privacy)");
    expect(md).toContain("## LLM baseline (no privacy)");
    expect(md).toContain("ids 0..4");
    expect(toMarkdown(plain)).not.toContain("LLM");
    expect(toStdout(report)).toContain("nashLLM");
    expect(toStdout(plain)).not.toContain("nashLLM");
    expect(toSvg(report)).toContain("LLM (no privacy)");
    expect(toSvg(plain)).not.toContain("LLM");
  });

  it("records a failed call as an error and no plan, without stopping the run", async () => {
    vi.stubGlobal("fetch", fakeFetch(() => ({}), 429).fn);
    const report = await runSim({ groups: 3, seed: SEED, llm: { apiKey: "k", model: "fake", groups: 2 } });
    expect(report.groups[0].llm?.error).toMatch(/429/);
    expect(report.groups[0].llm?.found).toBe(false);
    expect(report.groups[2].llm).toBeUndefined();
    expect(report.overall.llm?.errors).toBe(2);
  });
});
