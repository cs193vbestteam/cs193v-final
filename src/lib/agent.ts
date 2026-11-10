import type { Slot } from "./constraints";
import { bucket, evaluate, type Bucket, type Judgement, type Proposal } from "./evaluate";
import { travelMinutes, type LatLng } from "./geo";
import { exponentsOf, maskValues, pairKeys } from "./masked-sum";
import type { Preferences } from "./preferences";
import { getRestaurant, type Restaurant } from "./restaurants";

/**
 * A person's assistant, as the mediator is allowed to hold it: two functions
 * that close over the private preferences and answer in coarse terms only.
 * Built by vault.ts (server) and sim/ (synthetic people). Nothing here reads
 * storage; the caller hands over plain preferences and keeps the keys.
 *
 * `start` is where this person travels from. When it is given, every
 * candidate with coordinates is judged on THEIR trip instead of the plan-wide
 * estimate. It lives only in this closure: no method returns it, and the
 * verdicts are as coarse as before.
 */
export type Agent = {
  /** verdict + at most one dimension name. `level` = concession steps requested so far. */
  judge: (p: Proposal, level: number) => Judgement;
  /**
   * The same verdicts for a whole round at once, in order. Present when the assistant is an
   * LLM (agent-llm.ts), which judges a round in one call; negotiate() uses it when it can.
   */
  judgeAll?: (ps: readonly Proposal[], level: number) => Promise<Judgement[]>;
  /**
   * Can this person make this time at all? Asked once, before any restaurant is proposed, so no
   * proposal is spent on a time someone cannot make (#64). It says nothing a "reject: time"
   * verdict would not have said. Optional: without it the mediator learns times from rejects.
   */
  freeAt?: (slot: Slot) => boolean;
  /**
   * This person's part of the final comparison, masked. For each finalist
   * after the first it holds their 1..5 bucket for that finalist relative to
   * their bucket for the first, as exponents of 2, 3 and 5, plus pairwise masks
   * (masked-sum.ts). One person's message is random noise; only the sum over
   * the whole group means anything, and that sum is how the group's Nash
   * product for each finalist compares with the first's.
   */
  compare: (finalists: readonly Proposal[], level: number) => number[];
};

/**
 * An assistant before masking: it can still state its own 1..5 bucket. This
 * is what one person's side holds; it is never handed to the mediator, which
 * only ever gets the `Agent`s that `maskGroup` returns.
 */
export type PrivateAgent = Pick<Agent, "judge" | "judgeAll" | "freeAt"> & {
  /** 1..5 utility bucket for one proposal. */
  bucket: (p: Proposal, level: number) => Bucket;
};

/** A proposal's restaurant as this person travels to it: from their own start when known. */
export function resolverFor(
  lookup: (id: string) => Restaurant | undefined,
  start: LatLng | null,
): (p: Proposal) => Restaurant | undefined {
  return (p) => {
    const r = lookup(p.restaurantId);
    return r && start && r.location ? { ...r, travelMin: travelMinutes(start, r.location) } : r;
  };
}

export function makeAgent(
  prefs: Preferences,
  lookup: (id: string) => Restaurant | undefined = getRestaurant,
  start: LatLng | null = null,
): PrivateAgent {
  const at = resolverFor(lookup, start);
  const resolve = (p: Proposal): [Restaurant | undefined, Slot] => [at(p), p.slot];
  const times = prefs.hard.find((h) => h.dim === "time");
  return {
    // Time is a hard rule that no concession loosens, so the answer holds for the whole negotiation.
    freeAt: (slot) => !times || times.val.includes(slot),
    judge(p, level) {
      const [r, slot] = resolve(p);
      return r ? evaluate(prefs, r, slot, level) : { verdict: "reject", dim: "time" };
    },
    bucket(p, level) {
      const [r, slot] = resolve(p);
      return r ? bucket(prefs, r, slot, level) : 1;
    },
  };
}

const keyOf = (p: Proposal) => `${p.restaurantId}@${p.slot}`;

/**
 * Turn a group's assistants into the form the mediator may hold. The members
 * share fresh pairwise keys, made here and kept in these closures; the
 * mediator gets neither the keys nor any way to ask for a bucket.
 *
 * In a deployment where each assistant ran on its owner's device the keys
 * would come from a key agreement between devices. Here every assistant runs
 * in one server process, so this keeps individual buckets out of the
 * mediator's code and out of everything it stores, not out of the server.
 */
export function maskGroup(members: readonly PrivateAgent[]): Agent[] {
  const keys = pairKeys(members.length);
  return members.map((member, i) => ({
    judge: (p, level) => member.judge(p, level),
    ...(member.judgeAll ? { judgeAll: member.judgeAll } : {}),
    ...(member.freeAt ? { freeAt: member.freeAt } : {}),
    compare(finalists, level) {
      if (finalists.length < 2) return [];
      const [first, ...rest] = finalists;
      const base = exponentsOf(member.bucket(first, level));
      const values = rest.flatMap((p) => exponentsOf(member.bucket(p, level)).map((e, k) => e - base[k]));
      return maskValues(i, keys, `${level}|${finalists.map(keyOf).join(",")}`, values);
    },
  }));
}
