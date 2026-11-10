import type { Slot } from "./constraints";
import { bucket, evaluate, type Bucket, type Judgement, type Proposal } from "./evaluate";
import { travelMinutes, type LatLng } from "./geo";
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
  /** 1..5 utility bucket, only asked for the final two or three candidates. */
  bucket: (p: Proposal, level: number) => Bucket;
};

export function makeAgent(
  prefs: Preferences,
  lookup: (id: string) => Restaurant | undefined = getRestaurant,
  start: LatLng | null = null,
): Agent {
  const fromStart = (r: Restaurant | undefined) =>
    r && start && r.location ? { ...r, travelMin: travelMinutes(start, r.location) } : r;
  const resolve = (p: Proposal): [Restaurant | undefined, Slot] => [fromStart(lookup(p.restaurantId)), p.slot];
  return {
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
