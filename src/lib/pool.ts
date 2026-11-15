import { db } from "./db";
import { decryptOrPlain, scope } from "./crypto";
import type { Restaurant } from "./restaurants";
import { parseScenarioId, scenarioFor, type ScenarioId } from "./scenario";

/**
 * The candidate pool of a plan: public information (where the group might
 * eat), stored per event so proposal ids stay stable for its whole life.
 * Plans created without a location, or before Places was wired in, use their
 * scenario's seed.
 */
export type PoolSource = "places" | "yelp" | "seed";

export async function poolForEvent(
  eventId: string,
): Promise<{ restaurants: Restaurant[]; source: PoolSource; scenario: ScenarioId }> {
  const client = await db();
  const { rows } = await client.execute({
    sql: "SELECT pool_json, pool_source, scenario FROM events WHERE id = ?",
    args: [eventId],
  });
  const scenario = parseScenarioId(rows[0]?.scenario);
  const raw = rows[0]?.pool_json;
  if (raw) {
    const restaurants = JSON.parse(decryptOrPlain(String(raw), scope.plan(eventId, "pool"))) as Restaurant[];
    if (Array.isArray(restaurants) && restaurants.length)
      return { restaurants, source: (rows[0].pool_source as PoolSource) ?? "places", scenario };
  }
  return { restaurants: scenarioFor(scenario).seedPool, source: "seed", scenario };
}

/**
 * What the group UI needs to name a place; never anything about people.
 * `travelMin` is left out for pools with coordinates: there each person's
 * assistant measures their own trip, so one number for the group would be
 * wrong for most of them, and a per-person one must never be shown.
 */
export type PlaceSummary = Pick<Restaurant, "name" | "cuisine" | "pricePerPerson"> &
  Pick<Restaurant, "rating" | "ratingCount" | "address" | "mapsUrl"> & { travelMin?: number };

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
      // Public facts about the place itself, from Google: nothing here depends on who is in the group.
      ...(r.rating !== undefined ? { rating: r.rating, ratingCount: r.ratingCount ?? 0 } : {}),
      ...(r.address ? { address: r.address } : {}),
      ...(r.mapsUrl ? { mapsUrl: r.mapsUrl } : {}),
    };
  }
  return out;
}
