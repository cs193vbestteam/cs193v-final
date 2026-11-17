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
  /**
   * How many options to end with (default 1: one plan). Above 1 the result is a shortlist: after the
   * first agreement the mediator keeps proposing fresh candidates, at the same concession level, until
   * this many different restaurants are options nobody rejects, or rounds or candidates run out.
   * `finalists` then holds them, best for the group first, and the plan is the first of them.
   */
  shortlist?: number;
  selector?: Selector;
  /**
   * Writes one sentence for the group about the plan the code picked. It sees only the chosen
   * plan's public facts and cannot change the pick; a failure or an empty answer just means no
   * sentence.
   */
  explainer?: Explainer;
};

export type Explainer = (chosen: Proposal) => Promise<string | null>;

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
  /** Why this plan, in a sentence for the group, when an LLM made the final pick. */
  explanation?: string;
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
  /** A shortlist for the group to choose from: one entry per restaurant, fully accepted ones first. */
  asShortlist = false,
): { finalists: Finalist[]; chosen: Finalist } {
  const places = new Set<string>();
  const ranked = [...cands]
    .sort(
      (a, b) =>
        b.tally.accept - a.tally.accept ||
        a.tally.reluctant - b.tally.reluctant ||
        key(a.proposal).localeCompare(key(b.proposal)),
    )
    // The same restaurant at two times is one option: its better-received time, which sorts first.
    .filter((t) => !asShortlist || (!places.has(t.proposal.restaurantId) && places.add(t.proposal.restaurantId)))
    .slice(0, n);
  const proposals = ranked.map((t) => t.proposal);
  const sums = ranked.length > 1 ? sumMasked(agents.map((a) => a.compare(proposals, level))) : [];
  // log(Nash product of finalist k / Nash product of finalist 0); 0 for the first by definition.
  const logs = ranked.map((_, k) => (k === 0 ? 0 : logOf(sums.slice((k - 1) * 3, k * 3))));
  // In a shortlist an option everyone accepts always ranks above one somebody is only reluctant about.
  const full = (k: number) => ranked[k].tally.accept === agents.length;
  const eligible = (k: number) => !asShortlist || !ranked.some((_, j) => full(j)) || full(k);
  let best = ranked.findIndex((_, k) => eligible(k));
  for (let k = best + 1; k < logs.length; k++) if (eligible(k) && logs[k] > logs[best] + SAME) best = k;
  const finalists = ranked.map((t, k) => ({
    proposal: t.proposal,
    tally: t.tally,
    relative: Number(Math.exp(logs[k] - logs[best]).toFixed(6)),
  }));
  const chosen = finalists[best];
  if (!asShortlist) return { finalists, chosen };
  // Best for the group first: the pick, then fully accepted options, then by how they compare.
  const order = finalists
    .map((f, k) => ({ f, k }))
    .sort(
      (a, b) =>
        Number(b.k === best) - Number(a.k === best) ||
        Number(full(b.k)) - Number(full(a.k)) ||
        b.f.relative - a.f.relative ||
        a.k - b.k,
    )
    .map((x) => x.f);
  return { finalists: order, chosen };
}

/** The code's pick, plus the explainer's sentence about it when there is one. The sentence never changes the pick. */
async function finalPick(
  computed: ReturnType<typeof finalistsFor>,
  explainer: Explainer | undefined,
): Promise<{ finalists: Finalist[]; chosen: Finalist; explanation?: string }> {
  const { finalists, chosen } = computed;
  if (!explainer) return { finalists, chosen };
  try {
    const explanation = (await explainer(chosen.proposal))?.trim().slice(0, 300) || undefined;
    return { finalists, chosen, explanation };
  } catch (err) {
    console.error("LLM explanation failed, showing the plan without one:", (err as Error).message);
    return { finalists, chosen };
  }
}

const dimsOf = (bag: Tally["dims"]) =>
  Object.entries(bag)
    .sort(([a], [b]) => a.localeCompare(b))
    .join();
function sameTally(a: Tally, b: Tally): boolean {
  return (
    a.accept === b.accept &&
    a.reluctant === b.reluctant &&
    a.reject === b.reject &&
    dimsOf(a.dims) === dimsOf(b.dims) &&
    dimsOf(a.rejectDims) === dimsOf(b.rejectDims)
  );
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
  const want = Math.max(1, Math.floor(opts.shortlist ?? 1));
  const asShortlist = want > 1;
  const nFinalists = asShortlist ? want : (opts.finalists ?? 3);
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

  let pool = candidatePool(restaurants);
  const tried = new Map<string, Tried>();
  const rounds: RoundFeedback[] = [];
  let level = 0;
  let leakedDims = 0;

  // Before any restaurant: which times can everyone make? Only the count per time is used, and each
  // "can't" is the same word a "reject: time" would have been, so it is counted the same way. Without
  // this, a first round spread over every time spends most of its proposals learning the calendar.
  let nobodyFree = false;
  if (agents.every((a) => a.freeAt)) {
    const offered = [...new Set(pool.map((c) => c.slot))];
    const free = new Map(offered.map((slot) => [slot, agents.filter((a) => a.freeAt!(slot)).length]));
    for (const n of free.values()) leakedDims += agents.length - n;
    const common = new Set(offered.filter((slot) => free.get(slot) === agents.length));
    nobodyFree = offered.length > 0 && common.size === 0;
    pool = pool.filter((c) => common.has(c.slot));
  }

  const finish = (
    status: NegotiationResult["status"],
    chosen: Finalist | null,
    finalists: Finalist[],
    conflicts: Dim[] = [],
    explanation?: string,
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
    ...(explanation ? { explanation } : {}),
  });

  /**
   * Every agent's verdicts on a batch of proposals, as [proposal][agent]. An agent that can
   * judge a whole round at once (an LLM) gets one call; a malformed batch falls back to judge().
   */
  const judgeBatch = async (ps: Proposal[]): Promise<Judgement[][]> => {
    const perAgent = await Promise.all(
      agents.map(async (a) => {
        const js = a.judgeAll ? await a.judgeAll(ps, level) : null;
        return js && js.length === ps.length ? js : ps.map((p) => a.judge(p, level));
      }),
    );
    return ps.map((_, k) => perAgent.map((js) => js[k]));
  };

  /** Ask every agent about one proposal at the current level, record it, and say whether it was unanimous. */
  const record = (proposal: Proposal, judgements: Judgement[], log: RoundFeedback, retried: boolean): Tried => {
    leakedDims += judgements.filter((j) => j.dim).length;
    const tally = tallyOf(judgements);
    const entry: Tried = { proposal, tally, judgements, level };
    tried.set(key(proposal), entry);
    log.proposals.push(retried ? { proposal, tally, retried } : { proposal, tally });
    return entry;
  };

  // No time suits everyone: no restaurant can change that, so nobody is asked about any.
  if (nobodyFree) return finish("no_deal", null, [], ["time"]);

  /** Near-misses whose answers did not move when asked again after a concession: not worth a third ask. */
  const stuck = new Set<string>();

  /** Every unanimously accepted candidate so far. Non-empty means the group has agreed and is exploring. */
  const unanimous: Tried[] = [];
  let explored = 0;
  /** Everything tried so far that nobody rejects. */
  const workable = () => [...tried.values()].filter((t) => t.tally.reject === 0);
  const placesFound = () => new Set(workable().map((t) => t.proposal.restaurantId)).size;
  const agree = async (): Promise<NegotiationResult> => {
    const { finalists, chosen, explanation } = await finalPick(
      // A shortlist also offers what nobody rejected; a concession only loosens, so an earlier
      // "nobody rejects" still holds at this level.
      finalistsFor(asShortlist ? workable() : unanimous, agents, level, nFinalists, asShortlist),
      opts.explainer,
    );
    return finish("agreed", chosen, finalists, [], explanation);
  };

  for (let round = 1; round <= maxRounds; round++) {
    const exploring = unanimous.length > 0;
    // Once the group has agreed, nobody is asked to give up anything more: the level stays where it was.
    if (!exploring) level = Math.max(0, round - concessionFrom + 1);
    const log: RoundFeedback = exploring
      ? { round, level, exploring: true, proposals: [] }
      : { round, level, proposals: [] };

    // A concession step is pointless on brand-new long shots alone: first re-ask the nearest misses.
    const retries: Proposal[] = [];
    if (level > 0 && !exploring) {
      const nearMisses = [...tried.values()]
        .filter((t) => t.level < level && t.tally.reject <= Math.ceil(agents.length / 2) && !stuck.has(key(t.proposal)))
        .sort(
          (a, b) =>
            a.tally.reject - b.tally.reject ||
            a.tally.reluctant - b.tally.reluctant ||
            key(a.proposal).localeCompare(key(b.proposal)),
        )
        .slice(0, Math.ceil(perRound / 2));
      retries.push(...nearMisses.map((t) => t.proposal));
    }

    // Everything this round asks is known before anyone answers, so each agent judges it in one go.
    const untried = pool.filter((c) => !tried.has(candidateKey(c)));
    const room = perRound - retries.length;
    const picks: Candidate[] = room > 0 ? await propose(untried, rounds, room, lookup, opts.selector) : [];
    const batch = [...retries, ...picks.map(({ r, slot }) => ({ restaurantId: r.id, slot }))];
    const answers = await judgeBatch(batch);
    batch.forEach((proposal, k) => {
      const before = tried.get(key(proposal))?.tally;
      const entry = record(proposal, answers[k], log, k < retries.length);
      // The concession changed nobody's answer here. Its place next round goes to something new;
      // the re-check at the end still looks at it once more at the final level.
      if (before && sameTally(before, entry.tally)) stuck.add(key(proposal));
      if (entry.tally.accept === agents.length) unanimous.push(entry);
    });
    if (log.proposals.length === 0) break;
    rounds.push(log);

    if (unanimous.length) {
      // A shortlist keeps looking, at the same level, until it has enough different places.
      if (explored >= exploreRounds && placesFound() >= want) return await agree();
      explored++;
    }
  }
  // Agreed, then ran out of rounds or of candidates while exploring.
  if (unanimous.length) return await agree();

  // Re-check everything tried at the final concession level: a concession may have made an early option acceptable.
  const feasible: Tried[] = [];
  const stale = [...tried.values()].filter((t) => t.level !== level);
  const rechecked = await judgeBatch(stale.map((t) => t.proposal));
  const fresh = new Map(stale.map((t, k) => [key(t.proposal), rechecked[k]]));
  for (const t of tried.values()) {
    let { judgements } = t;
    const again = fresh.get(key(t.proposal));
    if (again) {
      judgements = again;
      leakedDims += judgements.filter((j) => j.dim).length; // these dimension names are seen too
    }
    const tally = tallyOf(judgements);
    if (tally.reject === 0) feasible.push({ ...t, judgements, tally, level });
  }
  if (feasible.length) {
    for (const f of feasible) tried.set(key(f.proposal), f);
    const { finalists, chosen, explanation } = await finalPick(
      finalistsFor(feasible, agents, level, nFinalists, asShortlist),
      opts.explainer,
    );
    return finish(chosen.tally.accept === agents.length ? "agreed" : "compromise", chosen, finalists, [], explanation);
  }

  const counts = new Map<Dim, number>();
  for (const t of tried.values()) {
    for (const [dim, n] of Object.entries(t.tally.rejectDims) as [Dim, number][])
      counts.set(dim, (counts.get(dim) ?? 0) + n);
  }
  const conflicts = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([d]) => d);
  return finish("no_deal", null, [], conflicts);
}
