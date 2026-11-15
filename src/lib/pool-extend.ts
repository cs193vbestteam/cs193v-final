import type { LatLng } from "./geo";
import { openOn } from "./opening-hours";
import type { PersonPreferences, Style } from "./optimizer-input";
import { NEARBY_PAGE_SIZE, mergePools, nearbyRestaurants, toPlaces } from "./places";
import type { Place } from "./restaurants";

/**
 * Widening a plan's pool once the group has said what it wants (#101).
 *
 * A plan starts with one general search (places.ts). When everyone is done chatting, this adds
 * one search for each cuisine or kind of place somebody asked for, so the number of billed
 * calls depends on what the group said and never on how many cuisines exist. This file is
 * pure apart from the searches themselves; reading and writing the plan is pool-refresh.ts.
 *
 * What goes to Google is a list of place types and the plan's location. Nothing says who
 * asked for what, or how many people did.
 */

/** Searches a plan may make after the first one, over its whole life. */
export const MAX_EXTRA_CALLS = 7;
/** The most places one plan's pool keeps. */
export const POOL_CAP = (1 + MAX_EXTRA_CALLS) * NEARBY_PAGE_SIZE;

/** Where the pool was searched from, which types have been searched for, and how many extra calls were spent. */
export type PoolMeta = { center: LatLng; searched: string[]; calls: number };
export const newPoolMeta = (center: LatLng): PoolMeta => ({ center, searched: [], calls: 0 });

export function parsePoolMeta(raw: unknown): PoolMeta | null {
  if (!raw) return null;
  try {
    const m = JSON.parse(String(raw)) as Partial<PoolMeta>;
    if (typeof m.center?.lat !== "number" || typeof m.center?.lng !== "number") return null;
    return {
      center: { lat: m.center.lat, lng: m.center.lng },
      searched: Array.isArray(m.searched) ? m.searched.filter((t) => typeof t === "string") : [],
      calls: typeof m.calls === "number" && m.calls >= 0 ? Math.floor(m.calls) : 0,
    };
  } catch {
    return null;
  }
}

/** The Google type to search for a kind of place. An ordinary restaurant needs no search of its own. */
const STYLE_TYPE: Partial<Record<Style, string>> = {
  fast_food: "fast_food_restaurant",
  fine_dining: "fine_dining_restaurant",
  cafe: "cafe",
  bar: "bar",
};

/**
 * The place types the group asked for, most wanted first: every cuisine type somebody scored
 * as exactly what they want, and every kind of place somebody wants. Food and places people
 * ruled out are not searched for. Ties are broken by name so the order is always the same.
 */
export function wantedTypes(people: readonly PersonPreferences[]): string[] {
  const count = new Map<string, number>();
  for (const prefs of people) {
    const mine = new Set<string>();
    for (const [type, score] of Object.entries(prefs.cuisine?.scores ?? {})) if (score === 1) mine.add(type);
    for (const style of prefs.style?.wanted ?? []) {
      const type = STYLE_TYPE[style];
      if (type) mine.add(type);
    }
    for (const type of mine) count.set(type, (count.get(type) ?? 0) + 1);
  }
  return [...count.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([type]) => type);
}

/**
 * Which searches to make now: one per type not searched before, in order. When there are more
 * types than calls left, the last call asks for all the remaining types together, so nothing
 * anybody asked for is left out entirely.
 */
export function searchPlan(wanted: readonly string[], meta: PoolMeta): string[][] {
  const left = Math.max(0, MAX_EXTRA_CALLS - meta.calls);
  const todo = wanted.filter((t) => !meta.searched.includes(t));
  if (left === 0 || todo.length === 0) return [];
  if (todo.length <= left) return todo.map((t) => [t]);
  return [...todo.slice(0, left - 1).map((t) => [t]), todo.slice(left - 1)];
}

export type Extended = { places: Place[]; meta: PoolMeta; added: number; calls: number; failedCalls: number };

/**
 * Run the searches and merge what they find into the pool. Places already in the pool keep
 * their position, so ids chosen earlier stay valid. A new place must be able to take a start
 * time on the plan's date, like every other candidate. A failed search costs its results and
 * its call, and its types stay unsearched so a later run can try again.
 */
export async function extendPool(
  places: readonly Place[],
  meta: PoolMeta,
  wanted: readonly string[],
  date: string,
  key: string,
  fetcher: typeof fetch = fetch,
): Promise<Extended> {
  const plan = searchPlan(wanted, meta);
  if (plan.length === 0) return { places: [...places], meta, added: 0, calls: 0, failedCalls: 0 };
  const settled = await Promise.allSettled(
    plan.map((types) => nearbyRestaurants(meta.center, key, 5000, fetcher, types)),
  );
  const found: Place[][] = [];
  const searched = [...meta.searched];
  let failedCalls = 0;
  settled.forEach((s, i) => {
    if (s.status === "rejected") return void failedCalls++;
    searched.push(...plan[i]);
    found.push(
      toPlaces(s.value, meta.center)
        .map((p) => openOn(p, date))
        .filter((p) => p.open.length > 0),
    );
  });
  const merged = mergePools(places, found, Math.max(POOL_CAP, places.length));
  return {
    places: merged,
    meta: { center: meta.center, searched, calls: meta.calls + plan.length },
    added: merged.length - places.length,
    calls: plan.length,
    failedCalls,
  };
}
