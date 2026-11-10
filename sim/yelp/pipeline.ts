import { DEFAULT_NEGOTIATE, runCase, runSim, type SimOptions } from "../pipeline";
import { summarize, type GroupMetrics, type Summary } from "../metrics";
import { makeRng } from "../rng";
import type { YelpRestaurant } from "./businesses";
import { formGroups, friendGraph, toCase } from "./groups";
import { derivePersona, validate, type Validation, type Visit } from "./personas";

/**
 * The Yelp evaluation as a pure function of already-loaded records, so the
 * tests can run it on a handful of hand-written businesses and reviewers.
 *
 *   reviewers with enough history → personas (checked on held-out reviews)
 *   friends graph → groups;  restaurants near each group → its pool
 *   then exactly what the synthetic harness does: oracle vs protocol vs naive
 *
 * The same number of synthetic groups is run with the same seed, pool size
 * and protocol settings, so the two rows of the comparison differ only in
 * where the people and the restaurants came from.
 */

export type YelpInput = {
  city: string;
  /** Every mappable restaurant in the city, by business id. */
  restaurants: ReadonlyMap<string, YelpRestaurant>;
  /** Each reviewer's reviews of those restaurants. */
  visitsByUser: ReadonlyMap<string, readonly Visit[]>;
  friendsOf: ReadonlyMap<string, readonly string[]>;
};

export type YelpOptions = {
  groups: number;
  seed: number;
  /** Restaurants in each group's pool. */
  restaurants?: number;
  minSize?: number;
  maxSize?: number;
  negotiate?: SimOptions["negotiate"];
};

export type YelpReport = {
  meta: {
    city: string;
    seed: number;
    groupsRequested: number;
    groupsFormed: number;
    restaurantsPerGroup: number;
    sizeRange: [number, number];
    negotiate: typeof DEFAULT_NEGOTIATE;
    generatedAt: string;
  };
  data: {
    restaurants: number;
    openRestaurants: number;
    reviewers: number;
    personas: number;
    /** Personas with at least one friend who also has a persona. */
    personasWithFriends: number;
  };
  validation: Validation;
  yelp: { overall: Summary; bySize: Summary[] };
  /** The synthetic harness on the same number of groups, seed, pool size and settings. */
  synthetic: { overall: Summary; bySize: Summary[] } | null;
  groups: GroupMetrics[];
};

const bySize = (groups: readonly GroupMetrics[]): Summary[] =>
  Array.from(new Set(groups.map((g) => g.size)))
    .sort((a, b) => a - b)
    .map((s) =>
      summarize(
        `size ${s}`,
        groups.filter((g) => g.size === s),
      ),
    );

export async function runYelp(input: YelpInput, opts: YelpOptions): Promise<YelpReport> {
  const poolSize = opts.restaurants ?? 30;
  const minSize = opts.minSize ?? 3;
  const maxSize = opts.maxSize ?? 6;
  const negotiateOpts = { ...DEFAULT_NEGOTIATE, ...(opts.negotiate ?? {}) };
  const rng = makeRng(opts.seed);
  const city = [...input.restaurants.values()].sort((a, b) => a.id.localeCompare(b.id));

  // Sorted ids, so the same data and seed always give the same personas and groups.
  const personas = [...input.visitsByUser.keys()]
    .sort()
    .flatMap((id) => derivePersona(id, input.visitsByUser.get(id)!, rng) ?? []);
  const validation = validate(personas, city, rng);

  const graph = friendGraph(personas, input.friendsOf);
  const byId = new Map(personas.map((p) => [p.userId, p]));
  const memberIds = formGroups(graph, rng, opts.groups, minSize, maxSize);

  const groups: GroupMetrics[] = [];
  for (const [i, ids] of memberIds.entries()) {
    const c = toCase(
      i,
      ids.map((id) => byId.get(id)!),
      city,
      rng,
      poolSize,
    );
    groups.push((await runCase(c, negotiateOpts)).metrics);
  }

  const synthetic = groups.length
    ? await runSim({
        groups: groups.length,
        seed: opts.seed,
        restaurants: poolSize,
        minSize,
        maxSize,
        negotiate: negotiateOpts,
      })
    : null;

  return {
    meta: {
      city: input.city,
      seed: opts.seed,
      groupsRequested: opts.groups,
      groupsFormed: groups.length,
      restaurantsPerGroup: poolSize,
      sizeRange: [minSize, maxSize],
      negotiate: negotiateOpts,
      generatedAt: "", // filled in by the CLI, so the report is a pure function of (data, options)
    },
    data: {
      restaurants: city.length,
      openRestaurants: city.filter((r) => r.isOpen).length,
      reviewers: input.visitsByUser.size,
      personas: personas.length,
      personasWithFriends: [...graph.values()].filter((f) => f.length > 0).length,
    },
    validation,
    yelp: { overall: summarize("yelp", groups), bySize: bySize(groups) },
    synthetic: synthetic ? { overall: { ...synthetic.overall, label: "synthetic" }, bySize: synthetic.bySize } : null,
    groups,
  };
}
