import { labelOf } from "./cuisine-table";
import { FEATURE_WORDS } from "./member-state";
import type { Feature } from "./optimizer-input";
import { db } from "./db";
import { decryptOrPlain, scope } from "./crypto";
import type { Place, Restaurant } from "./restaurants";
import { parseScenarioId, scenarioFor, type ScenarioId } from "./scenario";

/**
 * The candidate pool of a plan: public information (where the group might
 * eat), stored per event so proposal ids stay stable for its whole life.
 * Plans created without a location, or before Places was wired in, use their
 * scenario's seed.
 */
export type PoolSource = "places" | "yelp" | "seed";

/**
 * `restaurants` is what the current negotiation engine and the chat use: places with one of
 * the ten older cuisines. `places` is everything stored, for the optimizer.
 */
export async function poolForEvent(
  eventId: string,
): Promise<{ restaurants: Restaurant[]; places: Place[]; source: PoolSource; scenario: ScenarioId }> {
  const client = await db();
  const { rows } = await client.execute({
    sql: "SELECT pool_json, pool_source, scenario FROM events WHERE id = ?",
    args: [eventId],
  });
  const scenario = parseScenarioId(rows[0]?.scenario);
  const raw = rows[0]?.pool_json;
  if (raw) {
    const places = JSON.parse(decryptOrPlain(String(raw), scope.plan(eventId, "pool"))) as Place[];
    if (Array.isArray(places) && places.length)
      return {
        restaurants: places.filter((p): p is Restaurant => p.cuisine !== null),
        places,
        source: (rows[0].pool_source as PoolSource) ?? "places",
        scenario,
      };
  }
  const seed = scenarioFor(scenario).seedPool;
  return { restaurants: seed, places: seed, source: "seed", scenario };
}

/**
 * What the group UI needs to name a place; never anything about people.
 * `travelMin` is left out for pools with coordinates: there each person's
 * assistant measures their own trip, so one number for the group would be
 * wrong for most of them, and a per-person one must never be shown.
 */
export type PlaceSummary = Pick<Place, "name" | "cuisine" | "pricePerPerson"> &
  Pick<Restaurant, "rating" | "ratingCount" | "address" | "mapsUrl"> & {
    travelMin?: number;
    /** What kind of food it is, in words, from the place's main Google type: "ramen", "Indian". Optimizer results only. */
    kind?: string;
    /** A few things Google says the place has ("outdoor seating"). Public facts about the place, the same for everyone. */
    offers?: string[];
  };

/**
 * Which of a place's features are worth a word on the plan, most telling first. The rating has
 * its own place on the card, and nearly every restaurant has room for a group and somewhere to park.
 */
const OFFERS_SHOWN: readonly Feature[] = [
  "outdoor",
  "wheelchair",
  "kids",
  "reservable",
  "alcohol",
  "live_music",
  "dogs",
];
const MAX_OFFERS = 3;

/**
 * The same for a plan the optimizer decided. Its pool includes places that have none of the ten
 * older cuisines, so each summary also says what the place is in Google's own terms.
 */
export function summarizePlaces(places: readonly Place[], ids: Iterable<string>): Record<string, PlaceSummary> {
  const out = summarize(places, ids);
  for (const [id, summary] of Object.entries(out)) {
    const p = places.find((x) => x.id === id);
    const type = p?.primaryType ?? p?.types?.find((t) => t !== "restaurant") ?? p?.types?.[0];
    if (type) summary.kind = labelOf(type);
    const offers = OFFERS_SHOWN.filter((f) => p?.features?.[f] === true)
      .slice(0, MAX_OFFERS)
      .map((f) => FEATURE_WORDS[f]);
    if (offers.length) summary.offers = offers;
  }
  return out;
}

export function summarize(restaurants: readonly Place[], ids: Iterable<string>): Record<string, PlaceSummary> {
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
