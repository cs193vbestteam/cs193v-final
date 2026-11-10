import { createReadStream, existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { CUISINES } from "./constraints";
import { haversineKm, travelMinutes, type LatLng } from "./geo";
import { POOL_TARGET, mergePools } from "./places";
import type { Restaurant } from "./restaurants";
import { toRestaurant, type YelpBusiness, type YelpRestaurant } from "./yelp-business";

/**
 * A free, offline source of real restaurants for LOCAL development: the
 * business file of the Yelp Open Dataset, read from disk.
 *
 *   YELP_DATASET_DIR=/path/to/folder   holding yelp_academic_dataset_business.json
 *
 * When that is set and a plan's location names one of the dataset's cities
 * ("Philadelphia", "Tampa, FL"), the plan's candidates come from the dataset
 * instead of Google Places or the seed. No API key, no network, no cost.
 *
 * This is never to be deployed. The dataset is licensed for educational use
 * and may not be redistributed, so it must not be served from a public site:
 * the source switches itself off on Vercel, and the data is never committed.
 * It is also a frozen snapshot of eleven metropolitan areas.
 */

export const BUSINESS_FILE = "yelp_academic_dataset_business.json";
/** How far from the middle of the city a candidate may be. */
export const CITY_RADIUS_KM = 8;

type Env = Record<string, string | undefined>;

/** The dataset folder, or null when the source is off (not configured, or running on Vercel). */
export function yelpDatasetDir(env: Env = process.env): string | null {
  const dir = env.YELP_DATASET_DIR?.trim();
  if (!dir || env.VERCEL) return null;
  return dir;
}

/** "Philadelphia, PA" → city "philadelphia", state "pa". */
export function parsePlace(location: string): { city: string; state: string | null } {
  const [city, state] = location.split(",").map((part) => part.trim().toLowerCase());
  return { city: city ?? "", state: state && /^[a-z]{2}$/.test(state) ? state : null };
}

export type CityIndex = Map<string, YelpRestaurant[]>;
const cityKey = (city: string, state: string) => `${city.trim().toLowerCase()}|${state.trim().toLowerCase()}`;

/** Every mappable restaurant, grouped by "city|state". */
export function indexByCity(businesses: Iterable<YelpBusiness>): CityIndex {
  const index: CityIndex = new Map();
  for (const b of businesses) {
    const r = toRestaurant(b);
    if (!r) continue;
    const key = cityKey(b.city ?? "", b.state ?? "");
    index.set(key, [...(index.get(key) ?? []), r]);
  }
  return index;
}

/** The restaurants of the named city; with no state given, the largest city of that name. */
export function findCity(index: CityIndex, location: string): YelpRestaurant[] | null {
  const { city, state } = parsePlace(location);
  if (!city) return null;
  if (state) return index.get(cityKey(city, state)) ?? null;
  let best: YelpRestaurant[] | null = null;
  for (const [key, list] of index) if (key.startsWith(`${city}|`) && (!best || list.length > best.length)) best = list;
  return best;
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

/**
 * Up to `cap` restaurants still in business near the middle of the city,
 * nearest first within each cuisine and interleaved across cuisines, so the
 * pool is as varied as a live one. Deterministic: the same city gives the
 * same pool.
 */
export function cityPool(
  city: readonly YelpRestaurant[],
  cap = POOL_TARGET,
  radiusKm = CITY_RADIUS_KM,
): { center: LatLng; restaurants: Restaurant[] } | null {
  const open = city.filter((r) => r.isOpen);
  if (open.length === 0) return null;
  const center = { lat: median(open.map((r) => r.location.lat)), lng: median(open.map((r) => r.location.lng)) };
  const near = open
    .map((r) => ({ r, km: haversineKm(center, r.location) }))
    .filter((x) => x.km <= radiusKm)
    .sort((a, b) => a.km - b.km || a.r.id.localeCompare(b.r.id));
  const asRestaurant = ({ r }: { r: YelpRestaurant }): Restaurant => ({
    id: r.id,
    name: r.name,
    cuisine: r.cuisine,
    pricePerPerson: r.pricePerPerson,
    travelMin: travelMinutes(center, r.location),
    location: r.location,
    spicy: r.spicy,
    vegetarianFriendly: r.vegetarianFriendly,
    seafoodHeavy: r.seafoodHeavy,
    halal: r.halal,
    open: r.open,
  });
  const byCuisine = CUISINES.map((c) => near.filter((x) => x.r.cuisine === c).map(asRestaurant));
  return { center, restaurants: mergePools([], byCuisine, cap) };
}

// Parsing the business file takes a second or two, so keep the index for the life of the process.
const cache = new Map<string, Promise<CityIndex>>();

async function loadIndex(dir: string): Promise<CityIndex> {
  const file = join(dir, BUSINESS_FILE);
  if (!existsSync(file)) throw new Error(`${BUSINESS_FILE} not found in ${dir}`);
  const businesses: YelpBusiness[] = [];
  const lines = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of lines) if (line.trim()) businesses.push(JSON.parse(line) as YelpBusiness);
  return indexByCity(businesses);
}

export type YelpPool = { source: "yelp"; location: string; center: LatLng; restaurants: Restaurant[] };

/**
 * The pool for a plan near `location` from the local dataset, or null when
 * the source is off, the location is not one of its cities, or too few
 * restaurants map cleanly. Callers then fall back to Places or the seed.
 */
export async function resolveYelpPool(location: string | null, dir = yelpDatasetDir()): Promise<YelpPool | null> {
  const where = location?.trim();
  if (!where || !dir) return null;
  try {
    if (!cache.has(dir)) cache.set(dir, loadIndex(dir));
    const city = findCity(await cache.get(dir)!, where);
    const pool = city ? cityPool(city) : null;
    if (!pool || pool.restaurants.length < 5) return null;
    return { source: "yelp", location: where, ...pool };
  } catch (err) {
    cache.delete(dir); // don't keep a failed load
    console.warn(`Yelp dataset unavailable, falling back: ${(err as Error).message}`);
    return null;
  }
}
