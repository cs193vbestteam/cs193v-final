import type { Agent } from "./agent";
import type { Bucket, Dim, Judgement, Proposal } from "./evaluate";
import { candidateKey, candidatePool, key, propose, tallyOf, type Candidate, type RoundFeedback, type Selector, type Tally } from "./mediator";
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

  for (let round = 1; round <= maxRounds; round++) {
    level = Math.max(0, round - concessionFrom + 1);
    const log: RoundFeedback = { round, level, proposals: [] };
    const unanimous: Tried[] = [];

    // A concession step is pointless on brand-new long shots alone: first re-ask the nearest misses.
    if (level > 0) {
      const nearMisses = [...tried.values()]
        .filter((t) => t.level < level && t.tally.reject <= Math.ceil(agents.length / 2))
        .sort((a, b) => a.tally.reject - b.tally.reject || a.tally.reluctant - b.tally.reluctant || key(a.proposal).localeCompare(key(b.proposal)))
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
      const finalists = finalistsFor(unanimous, agents, level, nFinalists);
      return finish("agreed", pick(finalists), finalists);
    }
  }

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
