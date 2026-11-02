import { makeAgent, type Agent } from "../src/lib/agent";
import type { Constraints } from "../src/lib/constraints";
import { negotiate, type NegotiateOptions, type NegotiationResult } from "../src/lib/negotiate";
import { compile, type Preferences } from "../src/lib/preferences";
import type { Restaurant } from "../src/lib/restaurants";
import { llmBaselinePick, mapWithConcurrency, DEFAULT_LLM_MODEL, DEFAULT_LLM_TIMEOUT_MS } from "./llm-baseline";
import { metricsFor, outcomeFor, summarize, type GroupMetrics, type LlmOutcome, type Summary } from "./metrics";
import { oracle } from "./oracle";
import { makeRng, type Rng } from "./rng";
import { synthGroup, synthRestaurants } from "./synth";

/**
 * The evaluation pipeline, as a library so tests and the CLI share it.
 *
 *   for each group: synth people + a fresh restaurant pool
 *                   oracle (reads everything)  vs  negotiate (reads nothing)
 *                   score both, plus the naive round-1 baseline
 *   optionally: the LLM "no privacy" baseline on the first N groups (key-gated)
 *   aggregate overall and by group size
 */

export type SimOptions = {
  groups: number;
  seed: number;
  /** Restaurants in each group's (fresh) pool. */
  restaurants?: number;
  minSize?: number;
  maxSize?: number;
  negotiate?: Pick<NegotiateOptions, "maxRounds" | "perRound" | "concessionFrom" | "finalists">;
  /** When set, the LLM baseline runs on groups 0..groups-1 (default 40). Off = fully deterministic report. */
  llm?: LlmRunOptions;
};

export type LlmRunOptions = {
  apiKey: string;
  model?: string;
  /** How many groups (a prefix, ids 0..N-1) get the LLM call. */
  groups?: number;
  /** Requests in flight at once. */
  concurrency?: number;
  timeoutMs?: number;
  /** Progress hook, called after each call. */
  onProgress?: (done: number, total: number) => void;
};

export const DEFAULT_LLM_GROUPS = 40;
export const DEFAULT_LLM_CONCURRENCY = 2;

export type SimCase = {
  id: number;
  constraints: Constraints[];
  prefs: Preferences[];
  restaurants: Restaurant[];
};

export type SimReport = {
  meta: {
    groups: number;
    seed: number;
    restaurantsPerGroup: number;
    sizeRange: [number, number];
    negotiate: Required<NonNullable<SimOptions["negotiate"]>>;
    generatedAt: string;
    /** Present only when the LLM baseline ran. */
    llm?: { model: string; groupsRequested: number; groupIds: number[]; concurrency: number; timeoutMs: number };
  };
  overall: Summary;
  bySize: Summary[];
  groups: GroupMetrics[];
};

export const DEFAULT_NEGOTIATE: Required<NonNullable<SimOptions["negotiate"]>> = { maxRounds: 6, perRound: 5, concessionFrom: 4, finalists: 3 };

/** Draw one scenario. Consumes the rng in a fixed order so a seed is a scenario. */
export function synthCase(rng: Rng, id: number, opts: { restaurants: number; minSize: number; maxSize: number }): SimCase {
  const size = rng.int(opts.minSize, opts.maxSize);
  const restaurants = synthRestaurants(rng, opts.restaurants);
  const constraints = synthGroup(rng, size);
  return { id, constraints, prefs: constraints.map(compile), restaurants };
}

/** Agents for a case; `wrap` lets a caller observe what each agent answers. */
export function agentsFor(c: SimCase, wrap?: (agent: Agent, member: number) => Agent): Agent[] {
  const lookup = (id: string) => c.restaurants.find((r) => r.id === id);
  return c.prefs.map((p, i) => {
    const a = makeAgent(p, lookup);
    return wrap ? wrap(a, i) : a;
  });
}

/** Wrap an agent so every dimension name it hands the mediator is counted. */
export function countingAgent(agent: Agent, counter: { dims: number; calls: number }): Agent {
  return {
    judge(p, level) {
      const j = agent.judge(p, level);
      counter.calls++;
      if (j.dim) counter.dims++;
      return j;
    },
    bucket: (p, level) => agent.bucket(p, level),
  };
}

export async function runCase(c: SimCase, negotiateOpts: SimOptions["negotiate"] = DEFAULT_NEGOTIATE): Promise<{ result: NegotiationResult; metrics: GroupMetrics }> {
  const counter = { dims: 0, calls: 0 };
  const agents = agentsFor(c, (a) => countingAgent(a, counter));
  const result = await negotiate(agents, { restaurants: c.restaurants, ...negotiateOpts });
  const orc = oracle(c.prefs, c.restaurants);
  return { result, metrics: metricsFor(c.id, c.prefs, c.restaurants, result, orc, counter.dims) };
}

export async function runSim(opts: SimOptions): Promise<SimReport> {
  const restaurants = opts.restaurants ?? 30;
  const minSize = opts.minSize ?? 3;
  const maxSize = opts.maxSize ?? 6;
  const negotiateOpts = { ...DEFAULT_NEGOTIATE, ...(opts.negotiate ?? {}) };
  const rng = makeRng(opts.seed);
  const groups: GroupMetrics[] = [];
  const llmCount = opts.llm ? Math.max(0, Math.min(opts.groups, opts.llm.groups ?? DEFAULT_LLM_GROUPS)) : 0;
  const llmCases: SimCase[] = [];
  for (let i = 0; i < opts.groups; i++) {
    const c = synthCase(rng, i, { restaurants, minSize, maxSize });
    const { metrics } = await runCase(c, negotiateOpts);
    groups.push(metrics);
    if (i < llmCount) llmCases.push(c);
  }
  const llmMeta = opts.llm ? await runLlmBaseline(llmCases, groups, opts.llm) : undefined;
  const sizes = Array.from(new Set(groups.map((g) => g.size))).sort((a, b) => a - b);
  return {
    meta: {
      groups: opts.groups,
      seed: opts.seed,
      restaurantsPerGroup: restaurants,
      sizeRange: [minSize, maxSize],
      negotiate: negotiateOpts,
      generatedAt: "", // filled in by the CLI; kept empty here so the report is a pure function of (seed, options)
      ...(llmMeta ? { llm: llmMeta } : {}),
    },
    overall: summarize("all", groups),
    bySize: sizes.map((s) => summarize(`size ${s}`, groups.filter((g) => g.size === s))),
    groups,
  };
}

/**
 * The LLM baseline pass. Runs after the deterministic part so that nothing
 * about the protocol's numbers depends on the network; attaches an `llm`
 * outcome to each group it was asked about and returns the meta block.
 */
async function runLlmBaseline(cases: SimCase[], groups: GroupMetrics[], opts: LlmRunOptions): Promise<NonNullable<SimReport["meta"]["llm"]>> {
  const model = opts.model || process.env.ANTHROPIC_MODEL || DEFAULT_LLM_MODEL;
  const concurrency = opts.concurrency ?? DEFAULT_LLM_CONCURRENCY;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS;
  let done = 0;
  await mapWithConcurrency(cases, concurrency, async (c) => {
    const m = groups[c.id];
    let proposal = null;
    let error: string | undefined;
    try {
      proposal = await llmBaselinePick({ prefs: c.prefs, restaurants: c.restaurants }, { apiKey: opts.apiKey, model, timeoutMs });
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    const outcome: LlmOutcome = { ...outcomeFor(c.prefs, c.restaurants, proposal, m.oracle), model, ...(error ? { error } : {}) };
    m.llm = outcome;
    done++;
    opts.onProgress?.(done, cases.length);
  });
  return { model, groupsRequested: cases.length, groupIds: cases.map((c) => c.id), concurrency, timeoutMs };
}
