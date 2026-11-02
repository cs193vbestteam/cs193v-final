import { makeAgent, type Agent } from "../src/lib/agent";
import type { Constraints } from "../src/lib/constraints";
import { negotiate, type NegotiateOptions, type NegotiationResult } from "../src/lib/negotiate";
import { compile, type Preferences } from "../src/lib/preferences";
import type { Restaurant } from "../src/lib/restaurants";
import { metricsFor, summarize, type GroupMetrics, type Summary } from "./metrics";
import { oracle } from "./oracle";
import { makeRng, type Rng } from "./rng";
import { synthGroup, synthRestaurants } from "./synth";

/**
 * The evaluation pipeline, as a library so tests and the CLI share it.
 *
 *   for each group: synth people + a fresh restaurant pool
 *                   oracle (reads everything)  vs  negotiate (reads nothing)
 *                   score both, plus the naive round-1 baseline
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
};

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
  for (let i = 0; i < opts.groups; i++) {
    const c = synthCase(rng, i, { restaurants, minSize, maxSize });
    const { metrics } = await runCase(c, negotiateOpts);
    groups.push(metrics);
  }
  const sizes = Array.from(new Set(groups.map((g) => g.size))).sort((a, b) => a - b);
  return {
    meta: {
      groups: opts.groups,
      seed: opts.seed,
      restaurantsPerGroup: restaurants,
      sizeRange: [minSize, maxSize],
      negotiate: negotiateOpts,
      generatedAt: "", // filled in by the CLI; kept empty here so the report is a pure function of (seed, options)
    },
    overall: summarize("all", groups),
    bySize: sizes.map((s) => summarize(`size ${s}`, groups.filter((g) => g.size === s))),
    groups,
  };
}
