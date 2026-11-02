import type { Agent } from "./agent";
import type { Bucket, Dim, Judgement, Proposal } from "./evaluate";
import { candidateKey, candidatePool, key, propose, tallyOf, type Candidate, type RoundFeedback, type Selector, type Tally } from "./mediator";
import { RESTAURANTS, type Restaurant } from "./restaurants";

/**
 * The protocol.
 *
 *   for round in 1..maxRounds:
 *     mediator proposes K candidates from tallies alone
 *     every agent answers accept / reluctant / reject (+ one dim)
 *     all accept → done; otherwise remember what was feasible
 *     from `concessionFrom` on, ask every agent to concede one more step
 *   pick among the best feasible candidates by Nash product of utility BUCKETS
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
  selector?: Selector;
};

export type Finalist = {
  proposal: Proposal;
  tally: Tally;
  /** One bucket per person, sorted high to low so nothing maps back to a member. */
  buckets: Bucket[];
  nash: number;
  min: number;
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

export const nashProduct = (buckets: number[]) => buckets.reduce((acc, b) => acc * b, 1);

function finalistsFor(cands: Tried[], agents: Agent[], level: number, n: number): Finalist[] {
  const ranked = [...cands].sort(
    (a, b) => b.tally.accept - a.tally.accept || a.tally.reluctant - b.tally.reluctant || key(a.proposal).localeCompare(key(b.proposal)),
  );
  return ranked.slice(0, n).map((t) => {
    const buckets = agents.map((a) => a.bucket(t.proposal, level)).sort((x, y) => y - x);
    return { proposal: t.proposal, tally: t.tally, buckets, nash: nashProduct(buckets), min: Math.min(...buckets) };
  });
}

/** Highest Nash product; ties go to the better-off worst person, then to more accepts. */
function pick(finalists: Finalist[]): Finalist {
  return [...finalists].sort((a, b) => b.nash - a.nash || b.min - a.min || b.tally.accept - a.tally.accept)[0];
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

  const empty: NegotiationResult = {
    status: "no_deal", proposal: null, tally: null, rounds: [], concessionLevel: 0, finalists: [], reservations: [], conflicts: [], leakedDims: 0,
  };
  if (agents.length === 0) return empty;

  const pool = candidatePool(restaurants);
  const tried = new Map<string, Tried>();
  const rounds: RoundFeedback[] = [];
  let level = 0;
  let leakedDims = 0;

  const finish = (status: NegotiationResult["status"], chosen: Finalist | null, finalists: Finalist[], conflicts: Dim[] = []): NegotiationResult => ({
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

  for (let round = 1; round <= maxRounds; round++) {
    level = Math.max(0, round - concessionFrom + 1);
    const untried = pool.filter((c) => !tried.has(candidateKey(c)));
    const picks: Candidate[] = await propose(untried, rounds, perRound, lookup, opts.selector);
    if (picks.length === 0) break;

    const log: RoundFeedback = { round, level, proposals: [] };
    const unanimous: Tried[] = [];
    for (const { r, slot } of picks) {
      const proposal: Proposal = { restaurantId: r.id, slot };
      const judgements = agents.map((a) => a.judge(proposal, level));
      leakedDims += judgements.filter((j) => j.dim).length;
      const tally = tallyOf(judgements);
      const entry: Tried = { proposal, tally, judgements, level };
      tried.set(key(proposal), entry);
      log.proposals.push({ proposal, tally });
      if (tally.accept === agents.length) unanimous.push(entry);
    }
    rounds.push(log);

    if (unanimous.length) {
      const finalists = finalistsFor(unanimous, agents, level, nFinalists);
      return finish("agreed", pick(finalists), finalists);
    }
  }

  // Re-check everything tried at the final concession level: a concession may have made an early option acceptable.
  const feasible: Tried[] = [];
  for (const t of tried.values()) {
    const judgements = t.level === level ? t.judgements : agents.map((a) => a.judge(t.proposal, level));
    const tally = tallyOf(judgements);
    if (tally.reject === 0) feasible.push({ ...t, judgements, tally, level });
  }
  if (feasible.length) {
    for (const f of feasible) tried.set(key(f.proposal), f);
    const finalists = finalistsFor(feasible, agents, level, nFinalists);
    const chosen = pick(finalists);
    return finish(chosen.tally.accept === agents.length ? "agreed" : "compromise", chosen, finalists);
  }

  const counts = new Map<Dim, number>();
  for (const t of tried.values()) {
    for (const [dim, n] of Object.entries(t.tally.rejectDims) as [Dim, number][]) counts.set(dim, (counts.get(dim) ?? 0) + n);
  }
  const conflicts = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([d]) => d);
  return finish("no_deal", null, [], conflicts);
}
