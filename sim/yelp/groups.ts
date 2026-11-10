import { centroid, haversineKm, type LatLng } from "../../src/lib/geo";
import { compile } from "../../src/lib/preferences";
import type { SimCase } from "../pipeline";
import type { Rng } from "../rng";
import type { YelpRestaurant } from "./businesses";
import { seenFrom, type Persona } from "./personas";

/**
 * Groups of real friends, and a candidate pool for each.
 *
 * A group is grown along the friends graph: start from one reviewer, then
 * keep adding a friend of anyone already in the group. Only reviewers with a
 * persona can join, so every member has enough history in this city.
 *
 * The pool is drawn from restaurants still in business near the middle of
 * the group, and travel is measured from that middle for everyone: this is
 * how the app treats a plan whose members gave no start point, and it keeps
 * the oracle and the protocol looking at the same numbers.
 */

export type FriendGraph = Map<string, string[]>;

/** Keep only edges between people who have a persona, in both directions, sorted for determinism. */
export function friendGraph(
  personas: readonly Persona[],
  friendsOf: ReadonlyMap<string, readonly string[]>,
): FriendGraph {
  const eligible = new Set(personas.map((p) => p.userId));
  const sets = new Map<string, Set<string>>(personas.map((p) => [p.userId, new Set<string>()]));
  for (const id of eligible)
    for (const friend of friendsOf.get(id) ?? [])
      if (friend !== id && eligible.has(friend)) {
        sets.get(id)!.add(friend);
        sets.get(friend)!.add(id);
      }
  return new Map([...sets.entries()].map(([id, s]) => [id, [...s].sort()]));
}

/** Up to `count` distinct friend-connected groups with sizes in [minSize, maxSize]. May return fewer. */
export function formGroups(graph: FriendGraph, rng: Rng, count: number, minSize = 3, maxSize = 6): string[][] {
  const starters = [...graph.entries()]
    .filter(([, f]) => f.length > 0)
    .map(([id]) => id)
    .sort();
  const groups: string[][] = [];
  const seen = new Set<string>();
  if (starters.length === 0) return groups;
  for (let attempt = 0; groups.length < count && attempt < count * 30; attempt++) {
    const size = rng.int(minSize, maxSize);
    const members = [rng.pick(starters)];
    while (members.length < size) {
      const frontier = [...new Set(members.flatMap((m) => graph.get(m) ?? []))]
        .filter((f) => !members.includes(f))
        .sort();
      if (frontier.length === 0) break;
      members.push(rng.pick(frontier));
    }
    if (members.length < minSize) continue;
    const key = [...members].sort().join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    groups.push(members);
  }
  return groups;
}

export const DEFAULT_RADIUS_KM = 12;

/** `n` open restaurants near `centre`, chosen at random among those within the radius (nearest ones if too few). */
export function poolAround(
  centre: LatLng,
  city: readonly YelpRestaurant[],
  rng: Rng,
  n: number,
  radiusKm = DEFAULT_RADIUS_KM,
): YelpRestaurant[] {
  const open = city.filter((r) => r.isOpen);
  const near = open.filter((r) => haversineKm(centre, r.location) <= radiusKm);
  if (near.length >= n) return rng.sample(near, n);
  return [...open].sort((a, b) => haversineKm(centre, a.location) - haversineKm(centre, b.location)).slice(0, n);
}

export function toCase(
  id: number,
  members: readonly Persona[],
  city: readonly YelpRestaurant[],
  rng: Rng,
  poolSize: number,
): SimCase {
  const centre = centroid(members.map((m) => m.home))!;
  const restaurants = poolAround(centre, city, rng, poolSize).map((r) => seenFrom(r, centre));
  const constraints = members.map((m) => m.constraints);
  return { id, constraints, prefs: constraints.map(compile), restaurants };
}
