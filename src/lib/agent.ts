import type { Slot } from "./constraints";
import { bucket, evaluate, type Bucket, type Judgement, type Proposal } from "./evaluate";
import type { Preferences } from "./preferences";
import { getRestaurant, type Restaurant } from "./restaurants";

/**
 * A person's assistant, as the mediator is allowed to hold it: two functions
 * that close over the private preferences and answer in coarse terms only.
 * Built by vault.ts (server) and sim/ (synthetic people). Nothing here reads
 * storage; the caller hands over plain preferences and keeps the keys.
 */
export type Agent = {
  /** verdict + at most one dimension name. `level` = concession steps requested so far. */
  judge: (p: Proposal, level: number) => Judgement;
  /** 1..5 utility bucket, only asked for the final two or three candidates. */
  bucket: (p: Proposal, level: number) => Bucket;
};

export function makeAgent(prefs: Preferences, lookup: (id: string) => Restaurant | undefined = getRestaurant): Agent {
  const resolve = (p: Proposal): [Restaurant | undefined, Slot] => [lookup(p.restaurantId), p.slot];
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
