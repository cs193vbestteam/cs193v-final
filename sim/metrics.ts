import type { Proposal } from "../src/lib/evaluate";
import type { NegotiationResult } from "../src/lib/negotiate";
import type { Preferences } from "../src/lib/preferences";
import type { Restaurant } from "../src/lib/restaurants";
import { isFeasible, minOf, nashOf, utilitiesOf, type Oracle } from "./oracle";

/**
 * Per-group scorecard: protocol vs a naive baseline vs the oracle.
 *
 * Ratios are relative to the oracle optimum and are `undefined` when the
 * oracle itself found nothing feasible (there is nothing to compare against)
 * or when the optimum is 0 (division by zero). They are 0 when the oracle
 * found a plan but the method under test did not.
 */

export type Outcome = {
  /** A plan was produced (protocol: agreed or compromise; naive: a feasible round-1 pick). */
  found: boolean;
  proposal: Proposal | null;
  /** True utilities (level 0) of the chosen plan, in member order. */
  utilities: number[];
  nash: number;
  maxMin: number;
  nashRatio: number | undefined;
  maxMinRatio: number | undefined;
};

export type GroupMetrics = {
  id: number;
  size: number;
  restaurantCount: number;
  status: NegotiationResult["status"];
  converged: boolean;
  roundsToConverge: number;
  concessionLevel: number;
  oracle: Oracle;
  protocol: Outcome;
  /** Round-1 candidate with the most accepts (ties: fewest reluctant). */
  naive: Outcome & { accepts: number; reluctant: number; rejects: number };
  /** What negotiate() reports as its privacy budget spent. */
  leakedDims: number;
  leakedPerPersonPerRound: number;
  /** Dimension names the agents actually returned, counted by wrapping them (undefined when not wrapped). */
  observedDims: number | undefined;
  /**
   * The "no privacy" LLM baseline (sim/llm-baseline.ts), only on groups the
   * run sent to the model. `error` is set when the call failed outright (the
   * outcome then counts as no plan); an invalid pick is a plain `found: false`.
   */
  llm?: LlmOutcome;
};

export type LlmOutcome = Outcome & { model: string; error?: string };

function ratio(value: number, best: number, feasible: boolean): number | undefined {
  if (!feasible || best <= 0) return undefined;
  return value / best;
}

export function outcomeFor(
  group: readonly Preferences[],
  restaurants: readonly Restaurant[],
  proposal: Proposal | null,
  oracle: Oracle,
): Outcome {
  const feasibleOracle = oracle.feasibleCount > 0;
  const found = proposal !== null && isFeasible(group, restaurants, proposal);
  const utilities = found && proposal ? utilitiesOf(group, restaurants, proposal) : group.map(() => 0);
  const nash = found ? nashOf(utilities) : 0;
  const maxMin = found ? minOf(utilities) : 0;
  return {
    found,
    proposal: found ? proposal : null,
    utilities,
    nash,
    maxMin,
    nashRatio: ratio(nash, oracle.bestNash, feasibleOracle),
    maxMinRatio: ratio(maxMin, oracle.bestMaxMin, feasibleOracle),
  };
}

/** The baseline: no negotiation, just take the first round's best-received candidate. */
export function naivePick(
  result: NegotiationResult,
): { proposal: Proposal; accepts: number; reluctant: number; rejects: number } | null {
  const first = result.rounds[0];
  if (!first || first.proposals.length === 0) return null;
  const ranked = [...first.proposals].sort(
    (a, b) =>
      b.tally.accept - a.tally.accept ||
      a.tally.reluctant - b.tally.reluctant ||
      `${a.proposal.restaurantId}@${a.proposal.slot}`.localeCompare(`${b.proposal.restaurantId}@${b.proposal.slot}`),
  );
  const top = ranked[0];
  return {
    proposal: top.proposal,
    accepts: top.tally.accept,
    reluctant: top.tally.reluctant,
    rejects: top.tally.reject,
  };
}

export function metricsFor(
  id: number,
  group: readonly Preferences[],
  restaurants: readonly Restaurant[],
  result: NegotiationResult,
  oracle: Oracle,
  observedDims?: number,
): GroupMetrics {
  const protocol = outcomeFor(group, restaurants, result.proposal, oracle);
  const naive = naivePick(result);
  // A naive pick that anyone rejected is not a plan at all: someone cannot go.
  const naiveOutcome = outcomeFor(group, restaurants, naive && naive.rejects === 0 ? naive.proposal : null, oracle);
  const rounds = result.rounds.length;
  const size = group.length;
  return {
    id,
    size,
    restaurantCount: restaurants.length,
    status: result.status,
    converged: result.status === "agreed",
    roundsToConverge: rounds,
    concessionLevel: result.concessionLevel,
    oracle,
    protocol,
    naive: {
      ...naiveOutcome,
      accepts: naive?.accepts ?? 0,
      reluctant: naive?.reluctant ?? 0,
      rejects: naive?.rejects ?? 0,
    },
    leakedDims: result.leakedDims,
    leakedPerPersonPerRound: rounds > 0 && size > 0 ? result.leakedDims / (size * rounds) : 0,
    observedDims,
  };
}

/* ------------------------------------------------------------------ */
/* Aggregation                                                         */
/* ------------------------------------------------------------------ */

export type Stat = { n: number; mean: number | null; median: number | null };

export function stat(xs: readonly number[]): Stat {
  if (xs.length === 0) return { n: 0, mean: null, median: null };
  const sorted = [...xs].sort((a, b) => a - b);
  const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  const mid = sorted.length >> 1;
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return { n: xs.length, mean, median };
}

export type Summary = {
  label: string;
  groups: number;
  statusCounts: Record<NegotiationResult["status"], number>;
  /** share of groups with status agreed */
  convergenceRate: number;
  /** share of groups where the protocol produced any plan (agreed or compromise) */
  anyPlanRate: number;
  /** share of groups where the oracle found at least one feasible candidate */
  oracleFeasibleRate: number;
  /** P(agreed | oracle feasible) */
  convergenceGivenFeasible: number | null;
  /** P(any plan | oracle feasible) */
  anyPlanGivenFeasible: number | null;
  /** rounds run, for agreed groups only, keyed by round number */
  roundsHistogram: Record<string, number>;
  /** rounds run, for all groups */
  roundsAll: Stat;
  protocolNashRatio: Stat;
  naiveNashRatio: Stat;
  protocolMaxMinRatio: Stat;
  naiveMaxMinRatio: Stat;
  leakedDims: Stat;
  leakedPerPersonPerRound: Stat;
  observedDims: Stat;
  /** share of groups whose chosen plan is exactly the oracle's Nash optimum */
  protocolHitsOptimum: number | null;
  /** Present only when at least one group in this summary carries an LLM baseline outcome. */
  llm?: LlmSummary;
};

/**
 * Aggregates for the LLM baseline, over the groups that had the call. The
 * `protocol*` / `naive*` fields here are recomputed on that same subset so the
 * comparison is like for like (the LLM usually runs on a prefix of the groups).
 */
export type LlmSummary = {
  /** groups that had an LLM call */
  groups: number;
  /** of those, groups where the oracle found something feasible (ratios are over these) */
  feasible: number;
  /** calls that failed (timeout, HTTP error); counted as no plan */
  errors: number;
  /** P(LLM produced a feasible plan | oracle feasible) */
  foundGivenFeasible: number | null;
  nashRatio: Stat;
  maxMinRatio: Stat;
  hitsOptimum: number | null;
  protocolNashRatio: Stat;
  protocolMaxMinRatio: Stat;
  protocolHitsOptimum: number | null;
  naiveNashRatio: Stat;
};

const defined = (xs: readonly (number | undefined)[]): number[] => xs.filter((x): x is number => x !== undefined);

export function summarize(label: string, ms: readonly GroupMetrics[]): Summary {
  const n = ms.length;
  const statusCounts: Summary["statusCounts"] = { agreed: 0, compromise: 0, no_deal: 0 };
  const roundsHistogram: Record<string, number> = {};
  let feasible = 0;
  let agreedFeasible = 0;
  let anyFeasible = 0;
  let hits = 0;
  for (const m of ms) {
    statusCounts[m.status]++;
    if (m.converged)
      roundsHistogram[String(m.roundsToConverge)] = (roundsHistogram[String(m.roundsToConverge)] ?? 0) + 1;
    if (m.oracle.feasibleCount > 0) {
      feasible++;
      if (m.converged) agreedFeasible++;
      if (m.protocol.found) anyFeasible++;
      if (m.protocol.nashRatio !== undefined && m.protocol.nashRatio >= 1 - 1e-12) hits++;
    }
  }
  const rate = (k: number) => (n ? k / n : 0);
  const withLlm = ms.filter((m): m is WithLlm => m.llm !== undefined);
  return {
    label,
    groups: n,
    statusCounts,
    convergenceRate: rate(statusCounts.agreed),
    anyPlanRate: rate(statusCounts.agreed + statusCounts.compromise),
    oracleFeasibleRate: rate(feasible),
    convergenceGivenFeasible: feasible ? agreedFeasible / feasible : null,
    anyPlanGivenFeasible: feasible ? anyFeasible / feasible : null,
    roundsHistogram,
    roundsAll: stat(ms.map((m) => m.roundsToConverge)),
    protocolNashRatio: stat(defined(ms.map((m) => m.protocol.nashRatio))),
    naiveNashRatio: stat(defined(ms.map((m) => m.naive.nashRatio))),
    protocolMaxMinRatio: stat(defined(ms.map((m) => m.protocol.maxMinRatio))),
    naiveMaxMinRatio: stat(defined(ms.map((m) => m.naive.maxMinRatio))),
    leakedDims: stat(ms.map((m) => m.leakedDims)),
    leakedPerPersonPerRound: stat(ms.map((m) => m.leakedPerPersonPerRound)),
    observedDims: stat(defined(ms.map((m) => m.observedDims))),
    protocolHitsOptimum: feasible ? hits / feasible : null,
    ...(withLlm.length ? { llm: summarizeLlm(withLlm) } : {}),
  };
}

type WithLlm = GroupMetrics & { llm: LlmOutcome };

const hitsOptimum = (ms: readonly WithLlm[], pick: (m: WithLlm) => Outcome): number =>
  ms.filter((m) => {
    const r = pick(m).nashRatio;
    return r !== undefined && r >= 1 - 1e-12;
  }).length;

function summarizeLlm(ms: readonly WithLlm[]): LlmSummary {
  const feasible = ms.filter((m) => m.oracle.feasibleCount > 0);
  const nf = feasible.length;
  return {
    groups: ms.length,
    feasible: nf,
    errors: ms.filter((m) => m.llm.error !== undefined).length,
    foundGivenFeasible: nf ? feasible.filter((m) => m.llm.found).length / nf : null,
    nashRatio: stat(defined(ms.map((m) => m.llm.nashRatio))),
    maxMinRatio: stat(defined(ms.map((m) => m.llm.maxMinRatio))),
    hitsOptimum: nf ? hitsOptimum(feasible, (m) => m.llm) / nf : null,
    protocolNashRatio: stat(defined(ms.map((m) => m.protocol.nashRatio))),
    protocolMaxMinRatio: stat(defined(ms.map((m) => m.protocol.maxMinRatio))),
    protocolHitsOptimum: nf ? hitsOptimum(feasible, (m) => m.protocol) / nf : null,
    naiveNashRatio: stat(defined(ms.map((m) => m.naive.nashRatio))),
  };
}
