import { db } from "./db";
import { RESTAURANTS, type Restaurant } from "./restaurants";

/**
 * The candidate pool of a plan: public information (where the group might
 * eat), stored per event so proposal ids stay stable for its whole life.
 * Plans created without a location, or before Places was wired in, use the seed.
 */
export type PoolSource = "places" | "yelp" | "seed";

export async function poolForEvent(eventId: string): Promise<{ restaurants: Restaurant[]; source: PoolSource }> {
  const client = await db();
  const { rows } = await client.execute({
    sql: "SELECT pool_json, pool_source FROM events WHERE id = ?",
    args: [eventId],
  });
  const raw = rows[0]?.pool_json;
  if (raw) {
    const restaurants = JSON.parse(String(raw)) as Restaurant[];
    if (Array.isArray(restaurants) && restaurants.length)
      return { restaurants, source: (rows[0].pool_source as PoolSource) ?? "places" };
  }
  return { restaurants: RESTAURANTS, source: "seed" };
}

/**
 * What the group UI needs to name a place; never anything about people.
 * `travelMin` is left out for pools with coordinates: there each person's
 * assistant measures their own trip, so one number for the group would be
 * wrong for most of them, and a per-person one must never be shown.
 */
export type PlaceSummary = Pick<Restaurant, "name" | "cuisine" | "pricePerPerson"> & { travelMin?: number };

export function summarize(restaurants: Restaurant[], ids: Iterable<string>): Record<string, PlaceSummary> {
  const out: Record<string, PlaceSummary> = {};
  for (const id of ids) {
    const r = restaurants.find((x) => x.id === id);
    if (!r) continue;
    out[id] = {
      name: r.name,
      cuisine: r.cuisine,
      pricePerPerson: r.pricePerPerson,
      ...(r.location ? {} : { travelMin: r.travelMin }),
    };
  }
  return out;
}
