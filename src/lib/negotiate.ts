import type { Agent } from "./agent";
import type { Dim, Judgement, Proposal } from "./evaluate";
import { logOf, sumMasked } from "./masked-sum";
import {
  candidateKey,
  candidatePool,
  key,
  propose,
  tallyOf,
  type Candidate,
  type RoundFeedback,
  type Selector,
  type Tally,
} from "./mediator";
import { RESTAURANTS, type Restaurant } from "./restaurants";

/**
 * The protocol.
 *
 *   for round in 1..maxRounds:
 *     from `concessionFrom` on, every agent is asked to concede one more step,
 *       and the closest earlier near-misses are put to them again first
 *     mediator fills the round with fresh candidates chosen from tallies alone
 *     every agent answers accept / reluctant / reject (+ one dim)
 *     all accept → done; otherwise remember what was feasible
 *   pick among the best feasible candidates by Nash product of utility BUCKETS,
 *     compared through a masked sum so no bucket reaches this module
 *
 * With `exploreRounds` > 0 the first unanimous round is not the end: the
 * mediator runs that many more rounds of fresh candidates, informed by every
 * tally so far, and the plan is picked among ALL unanimous candidates seen.
 * Nobody is asked to concede further once the group has agreed. This buys a
 * better plan at the price of more answers heard by the mediator.
 *
 * Privacy by construction: this module imports no storage, no crypto, no
 * preferences. tests/isolation.test.ts enforces that.
 */

export type NegotiateOptions = {
  restaurants?: Restaurant[];
  maxRounds?: number;
  perRound?: number;
  /** First round in which agents are asked to concede (level = round - concessionFrom + 1). */
  concessionFrom?: number;
  /** How many feasible candidates get the bucket question. */
  finalists?: number;
  /**
   * Rounds to keep exploring after the first unanimous accept (default 0: stop at once).
   * Exploring rounds count towards `maxRounds` and never raise the concession level.
   */
  exploreRounds?: number;
  selector?: Selector;
};

export type Finalist = {
  proposal: Proposal;
  tally: Tally;
  /**
   * This finalist's Nash product (the product of everyone's 1..5 bucket)
   * divided by the chosen finalist's: 1 for the pick, at most 1 for the rest.
   * It is all the mediator learns from the bucket question: no bucket, no
   * product, only how the finalists compare.
   */
  relative: number;
};

export type Reservation = { member: number; dim: Dim };

export type NegotiationResult = {
  status: "agreed" | "compromise" | "no_deal";
  proposal: Proposal | null;
  tally: Tally | null;
  rounds: RoundFeedback[];
  /** Concession steps in force when the result was chosen. */
  concessionLevel: number;
  finalists: Finalist[];
  /** For the chosen plan: who is merely reluctant, and about what (dimension only). */
  reservations: Reservation[];
  /** no_deal: dimensions most often behind rejects, worst first. */
  conflicts: Dim[];
  /** How many dimension names the mediator saw in total (the privacy budget spent). */
  leakedDims: number;
};

type Tried = { proposal: Proposal; tally: Tally; judgements: Judgement[]; level: number };

/** Two log-products closer than this are the same product: distinct products of 2s, 3s and 5s differ by far more. */
const SAME = 1e-9;

/**
 * The final step: up to `n` candidates nobody rejects are compared on the
 * group's Nash product, without the mediator seeing any bucket.
 *
 * Every assistant sends one masked message (agent.ts, masked-sum.ts). Summed
 * over the group the masks cancel, leaving, for each finalist after the first,
 * the exponents of 2, 3 and 5 in (its Nash product / the first's). That ratio
 * is all the pick needs, and all the mediator gets: not the buckets, not their
 * multiset, not even either product.
 *
 * The pick is the highest Nash product. On an exact tie the earlier candidate
 * in the ranking below wins (more accepts, fewer reluctant, then by name).
 */
function finalistsFor(
  cands: Tried[],
  agents: Agent[],
  level: number,
  n: number,
): { finalists: Finalist[]; chosen: Finalist } {
  const ranked = [...cands]
    .sort(
      (a, b) =>
        b.tally.accept - a.tally.accept ||
        a.tally.reluctant - b.tally.reluctant ||
        key(a.proposal).localeCompare(key(b.proposal)),
    )
    .slice(0, n);
  const proposals = ranked.map((t) => t.proposal);
  const sums = ranked.length > 1 ? sumMasked(agents.map((a) => a.compare(proposals, level))) : [];
  // log(Nash product of finalist k / Nash product of finalist 0); 0 for the first by definition.
  const logs = ranked.map((_, k) => (k === 0 ? 0 : logOf(sums.slice((k - 1) * 3, k * 3))));
  let best = 0;
  for (let k = 1; k < logs.length; k++) if (logs[k] > logs[best] + SAME) best = k;
  const finalists = ranked.map((t, k) => ({
    proposal: t.proposal,
    tally: t.tally,
    relative: Number(Math.exp(logs[k] - logs[best]).toFixed(6)),
  }));
  return { finalists, chosen: finalists[best] };
}

function reservationsFor(t: Tried): Reservation[] {
  return t.judgements.flatMap((j, i) => (j.verdict === "reluctant" && j.dim ? [{ member: i, dim: j.dim }] : []));
}

export async function negotiate(agents: Agent[], opts: NegotiateOptions = {}): Promise<NegotiationResult> {
  const restaurants = opts.restaurants ?? RESTAURANTS;
  const lookup = (id: string) => restaurants.find((r) => r.id === id);
  const maxRounds = opts.maxRounds ?? 6;
  const perRound = opts.perRound ?? 5;
  const concessionFrom = opts.concessionFrom ?? 4;
  const nFinalists = opts.finalists ?? 3;
  const exploreRounds = Math.max(0, Math.floor(opts.exploreRounds ?? 0));

  const empty: NegotiationResult = {
    status: "no_deal",
    proposal: null,
    tally: null,
    rounds: [],
    concessionLevel: 0,
    finalists: [],
    reservations: [],
    conflicts: [],
    leakedDims: 0,
  };
  if (agents.length === 0) return empty;

  const pool = candidatePool(restaurants);
  const tried = new Map<string, Tried>();
  const rounds: RoundFeedback[] = [];
  let level = 0;
  let leakedDims = 0;

  const finish = (
    status: NegotiationResult["status"],
    chosen: Finalist | null,
    finalists: Finalist[],
    conflicts: Dim[] = [],
  ): NegotiationResult => ({
    status,
    proposal: chosen?.proposal ?? null,
    tally: chosen?.tally ?? null,
    rounds,
    concessionLevel: level,
    finalists,
    reservations: chosen ? reservationsFor(tried.get(key(chosen.proposal))!) : [],
    conflicts,
    leakedDims,
  });

  /** Ask every agent about one proposal at the current level, record it, and say whether it was unanimous. */
  const ask = (proposal: Proposal, log: RoundFeedback, retried: boolean): Tried => {
    const judgements = agents.map((a) => a.judge(proposal, level));
    leakedDims += judgements.filter((j) => j.dim).length;
    const tally = tallyOf(judgements);
    const entry: Tried = { proposal, tally, judgements, level };
    tried.set(key(proposal), entry);
    log.proposals.push(retried ? { proposal, tally, retried } : { proposal, tally });
    return entry;
  };

  /** Every unanimously accepted candidate so far. Non-empty means the group has agreed and is exploring. */
  const unanimous: Tried[] = [];
  let explored = 0;
  const agree = (): NegotiationResult => {
    const { finalists, chosen } = finalistsFor(unanimous, agents, level, nFinalists);
    return finish("agreed", chosen, finalists);
  };

  for (let round = 1; round <= maxRounds; round++) {
    const exploring = unanimous.length > 0;
    // Once the group has agreed, nobody is asked to give up anything more: the level stays where it was.
    if (!exploring) level = Math.max(0, round - concessionFrom + 1);
    const log: RoundFeedback = exploring
      ? { round, level, exploring: true, proposals: [] }
      : { round, level, proposals: [] };

    // A concession step is pointless on brand-new long shots alone: first re-ask the nearest misses.
    if (level > 0 && !exploring) {
      const nearMisses = [...tried.values()]
        .filter((t) => t.level < level && t.tally.reject <= Math.ceil(agents.length / 2))
        .sort(
          (a, b) =>
            a.tally.reject - b.tally.reject ||
            a.tally.reluctant - b.tally.reluctant ||
            key(a.proposal).localeCompare(key(b.proposal)),
        )
        .slice(0, Math.ceil(perRound / 2));
      for (const t of nearMisses) {
        const entry = ask(t.proposal, log, true);
        if (entry.tally.accept === agents.length) unanimous.push(entry);
      }
    }

    const untried = pool.filter((c) => !tried.has(candidateKey(c)));
    const room = perRound - log.proposals.length;
    const picks: Candidate[] = room > 0 ? await propose(untried, rounds, room, lookup, opts.selector) : [];
    for (const { r, slot } of picks) {
      const entry = ask({ restaurantId: r.id, slot }, log, false);
      if (entry.tally.accept === agents.length) unanimous.push(entry);
    }
    if (log.proposals.length === 0) break;
    rounds.push(log);

    if (unanimous.length) {
      if (explored >= exploreRounds) return agree();
      explored++;
    }
  }
  // Agreed, then ran out of rounds or of candidates while exploring.
  if (unanimous.length) return agree();

  // Re-check everything tried at the final concession level: a concession may have made an early option acceptable.
  const feasible: Tried[] = [];
  for (const t of tried.values()) {
    let { judgements } = t;
    if (t.level !== level) {
      judgements = agents.map((a) => a.judge(t.proposal, level));
      leakedDims += judgements.filter((j) => j.dim).length; // these dimension names are seen too
    }
    const tally = tallyOf(judgements);
    if (tally.reject === 0) feasible.push({ ...t, judgements, tally, level });
  }
  if (feasible.length) {
    for (const f of feasible) tried.set(key(f.proposal), f);
    const { finalists, chosen } = finalistsFor(feasible, agents, level, nFinalists);
    return finish(chosen.tally.accept === agents.length ? "agreed" : "compromise", chosen, finalists);
  }

  const counts = new Map<Dim, number>();
  for (const t of tried.values()) {
    for (const [dim, n] of Object.entries(t.tally.rejectDims) as [Dim, number][])
      counts.set(dim, (counts.get(dim) ?? 0) + n);
  }
  const conflicts = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([d]) => d);
  return finish("no_deal", null, [], conflicts);
}
