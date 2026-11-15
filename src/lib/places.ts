import { CUISINES, type Cuisine } from "./constraints";
import { isMealCandidate, stylesOf } from "./cuisine-table";
import { travelMinutes, type LatLng } from "./geo";
import { weeklyHoursFromGoogle } from "./opening-hours";
import type { Restaurant } from "./restaurants";

export { KM_PER_MIN, haversineKm, type LatLng } from "./geo";

/**
 * Candidate pool from Google Places (API "New"). Public information only:
 * where a plan happens is group knowledge, nobody's preferences are involved.
 *
 *   resolvePool(location)  → geocode the text, gather nearby restaurants
 *                             over several queries, map them onto our
 *                             Restaurant shape
 *   Without GOOGLE_PLACES_API_KEY (or on any failure) callers fall back to
 *   the seeded RESTAURANTS, so the app keeps working offline.
 *
 * Nearby Search returns at most 20 places per call and has no paging, so one
 * call gives a small, popularity-ranked pool. gatherPlaces() widens it: one
 * general query, then one query per cuisine (least-covered first), merged and
 * de-duplicated by place id, so no cuisine is missing just because it is less
 * popular nearby. The number of calls per plan is capped (MAX_NEARBY_CALLS)
 * because every call is billed. Closed places and poorly rated ones are left
 * out; the rating, address and Maps link are kept for the group to see.
 */

/** The subset of a Places "New" result we read. Kept small so fixtures stay honest. */
export type PlaceResult = {
  id: string;
  displayName?: { text?: string };
  primaryType?: string;
  types?: string[];
  priceLevel?: string;
  location?: { latitude: number; longitude: number };
  servesVegetarianFood?: boolean;
  rating?: number;
  userRatingCount?: number;
  /** OPERATIONAL, CLOSED_TEMPORARILY or CLOSED_PERMANENTLY. */
  businessStatus?: string;
  formattedAddress?: string;
  googleMapsUri?: string;
  regularOpeningHours?: {
    periods?: {
      open: { day: number; hour: number; minute?: number };
      close?: { day: number; hour: number; minute?: number };
    }[];
  };
};

export const PLACE_FIELDS = [
  "places.id",
  "places.displayName",
  "places.primaryType",
  "places.types",
  "places.priceLevel",
  "places.location",
  "places.servesVegetarianFood",
  "places.regularOpeningHours",
  // Rating fields are in the same billing tier as price level and hours, which we already ask for;
  // status, address and the Maps link are in a lower one.
  "places.rating",
  "places.userRatingCount",
  "places.businessStatus",
  "places.formattedAddress",
  "places.googleMapsUri",
].join(",");

/** A place rated below this, by at least MIN_REVIEWS people, is left out of the pool. */
export const MIN_RATING = 3.5;
/** Fewer reviews than this say too little to drop a place, or to prefer it. */
export const MIN_REVIEWS = 20;

/** Typical spend per person for each Google price level. */
export const PRICE_BY_LEVEL: Record<string, number> = {
  PRICE_LEVEL_FREE: 10,
  PRICE_LEVEL_INEXPENSIVE: 15,
  PRICE_LEVEL_MODERATE: 30,
  PRICE_LEVEL_EXPENSIVE: 55,
  PRICE_LEVEL_VERY_EXPENSIVE: 90,
};
export const DEFAULT_PRICE = 30;

/** Nearby Search (New) returns at most this many places per call and cannot page. */
export const NEARBY_PAGE_SIZE = 20;
/** The most restaurants one plan's pool keeps. */
export const POOL_TARGET = 60;
/** Hard cap on Nearby Search calls per plan (geocoding is one more call on top). */
export const MAX_NEARBY_CALLS = 1 + CUISINES.length;

/** Places types (Table A, valid in `includedTypes`) to ask for when widening the pool for one cuisine. */
export const CUISINE_QUERY_TYPES: Record<Cuisine, readonly string[]> = {
  japanese: ["japanese_restaurant", "sushi_restaurant", "ramen_restaurant"],
  chinese: ["chinese_restaurant"],
  korean: ["korean_restaurant"],
  thai: ["thai_restaurant"],
  vietnamese: ["vietnamese_restaurant"],
  indian: ["indian_restaurant"],
  mexican: ["mexican_restaurant"],
  italian: ["italian_restaurant", "pizza_restaurant"],
  american: ["american_restaurant", "hamburger_restaurant", "barbecue_restaurant", "steak_house"],
  mediterranean: [
    "mediterranean_restaurant",
    "greek_restaurant",
    "turkish_restaurant",
    "lebanese_restaurant",
    "middle_eastern_restaurant",
  ],
};

const CUISINE_TYPES: [RegExp, Cuisine][] = [
  [/japanese|sushi|ramen/, "japanese"],
  [/chinese|dim_sum|cantonese|sichuan|hot_pot/, "chinese"],
  [/korean/, "korean"],
  [/thai/, "thai"],
  [/vietnamese|pho/, "vietnamese"],
  [/indian|curry/, "indian"],
  [/mexican|taco|burrito/, "mexican"],
  [/italian|pizza|pasta/, "italian"],
  [/american|hamburger|burger|barbecue|steak|diner|fast_food|sandwich/, "american"],
  [/mediterranean|greek|turkish|lebanese|middle_eastern|falafel|kebab/, "mediterranean"],
];

export function inferCuisine(types: readonly string[], name = ""): Cuisine | null {
  const hay = [...types, name.toLowerCase().replace(/\s+/g, "_")];
  for (const t of hay) for (const [re, c] of CUISINE_TYPES) if (re.test(t)) return c;
  return null;
}

/** Map one Places result onto our Restaurant shape. Returns null for things we can't place. */
export function toRestaurant(p: PlaceResult, center: LatLng): Restaurant | null {
  if (!p.id || !p.location) return null;
  // Closed for good or for now: not somewhere to send a group this weekend.
  if (p.businessStatus && p.businessStatus !== "OPERATIONAL") return null;
  const reviews = p.userRatingCount ?? 0;
  if (p.rating !== undefined && reviews >= MIN_REVIEWS && p.rating < MIN_RATING) return null;
  const primaryType = p.primaryType?.toLowerCase();
  const placeTypes = Array.from(new Set((p.types ?? []).map((t) => t.toLowerCase()).filter(Boolean)));
  // A supermarket with a cafe inside comes back from a cafe search; it is not somewhere to eat a meal.
  if (!isMealCandidate({ primaryType, types: placeTypes })) return null;
  const types = [...placeTypes, primaryType ?? ""];
  const name = p.displayName?.text ?? "Unnamed place";
  const cuisine = inferCuisine(types, name);
  if (!cuisine) return null;
  const location = { lat: p.location.latitude, lng: p.location.longitude };
  const joined = types.join(" ") + " " + name.toLowerCase();
  const hours = weeklyHoursFromGoogle(p.regularOpeningHours?.periods);
  return {
    id: p.id,
    name,
    cuisine,
    types: primaryType && !placeTypes.includes(primaryType) ? [primaryType, ...placeTypes] : placeTypes,
    style: stylesOf(placeTypes, primaryType),
    pricePerPerson: PRICE_BY_LEVEL[p.priceLevel ?? ""] ?? DEFAULT_PRICE,
    travelMin: travelMinutes(center, location),
    location,
    spicy: /thai|indian|sichuan|hot_pot|korean|hot pot/.test(joined),
    vegetarianFriendly: p.servesVegetarianFood === true || /vegetarian|vegan/.test(joined),
    seafoodHeavy: /seafood|sushi|fish|oyster|crab/.test(joined),
    halal: /halal/.test(joined),
    // Filled in for the plan's date once the pool is gathered (openOn in opening-hours.ts).
    open: [],
    ...(hours ? { hours } : {}),
    ...(p.rating !== undefined ? { rating: p.rating, ratingCount: reviews } : {}),
    ...(p.formattedAddress ? { address: p.formattedAddress } : {}),
    ...(p.googleMapsUri ? { mapsUrl: p.googleMapsUri } : {}),
  };
}

/** Turn a page of results into a pool: drop unmappable places and duplicates, keep stable order. */
export function toPool(results: PlaceResult[], center: LatLng): Restaurant[] {
  const seen = new Set<string>();
  const out: Restaurant[] = [];
  for (const p of results) {
    const r = toRestaurant(p, center);
    if (!r || seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
  }
  return out;
}

type Fetcher = typeof fetch;

async function postPlaces<T>(
  path: string,
  body: unknown,
  key: string,
  fieldMask: string,
  fetcher: Fetcher,
): Promise<T> {
  const res = await fetcher(`https://places.googleapis.com/v1/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "X-Goog-Api-Key": key, "X-Goog-FieldMask": fieldMask },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Places ${path} ${res.status}`);
  return (await res.json()) as T;
}

/** Text → coordinates, via Text Search (one result). */
export async function geocode(
  location: string,
  key: string,
  fetcher: Fetcher = fetch,
  near?: LatLng,
): Promise<LatLng | null> {
  // `near` only biases the search (a neighbourhood name exists in many cities); it does not restrict it.
  const locationBias = near
    ? { circle: { center: { latitude: near.lat, longitude: near.lng }, radius: 50_000 } }
    : undefined;
  const data = await postPlaces<{ places?: { location?: { latitude: number; longitude: number } }[] }>(
    "places:searchText",
    { textQuery: location, maxResultCount: 1, ...(locationBias ? { locationBias } : {}) },
    key,
    "places.location",
    fetcher,
  );
  const loc = data.places?.[0]?.location;
  return loc ? { lat: loc.latitude, lng: loc.longitude } : null;
}

/** Restaurants of the given Places types within `radiusM` of a point (Nearby Search caps at 20 results). */
export async function nearbyRestaurants(
  center: LatLng,
  key: string,
  radiusM = 5000,
  fetcher: Fetcher = fetch,
  includedTypes: readonly string[] = ["restaurant"],
): Promise<PlaceResult[]> {
  const data = await postPlaces<{ places?: PlaceResult[] }>(
    "places:searchNearby",
    {
      includedTypes,
      maxResultCount: NEARBY_PAGE_SIZE,
      rankPreference: "POPULARITY",
      locationRestriction: { circle: { center: { latitude: center.lat, longitude: center.lng }, radius: radiusM } },
    },
    key,
    PLACE_FIELDS,
    fetcher,
  );
  return data.places ?? [];
}

/** Cuisines in the order to query them: least represented in `pool` first, ties in CUISINES order. */
export function cuisineQueryOrder(pool: readonly Restaurant[]): Cuisine[] {
  const count = new Map<Cuisine, number>(CUISINES.map((c) => [c, 0]));
  for (const r of pool) count.set(r.cuisine, (count.get(r.cuisine) ?? 0) + 1);
  return [...CUISINES].sort((a, b) => count.get(a)! - count.get(b)! || CUISINES.indexOf(a) - CUISINES.indexOf(b));
}

/**
 * Merge several pools into one of at most `cap` restaurants, de-duplicated by
 * place id. `base` keeps its order and goes first; the `extra` lists are then
 * interleaved one restaurant at a time, so a cap cuts every cuisine equally
 * instead of dropping whichever query happened to come last.
 */
export function mergePools(
  base: readonly Restaurant[],
  extra: readonly (readonly Restaurant[])[],
  cap = POOL_TARGET,
): Restaurant[] {
  const seen = new Set<string>();
  const out: Restaurant[] = [];
  const add = (r: Restaurant) => {
    if (out.length >= cap || seen.has(r.id)) return;
    seen.add(r.id);
    out.push(r);
  };
  base.forEach(add);
  const longest = Math.max(0, ...extra.map((list) => list.length));
  for (let i = 0; i < longest && out.length < cap; i++) for (const list of extra) if (i < list.length) add(list[i]);
  return out;
}

export type GatherOptions = { maxCalls?: number; target?: number; radiusM?: number };
export type Gathered = { restaurants: Restaurant[]; calls: number; failedCalls: number };

/**
 * The candidate pool around `center`, from at most `maxCalls` Nearby Search
 * calls: the general "restaurant" query, then (only if that left the pool
 * under `target`) one query per cuisine for the least-covered cuisines, run
 * together. A failed call costs its results, not the pool; if every call
 * fails the first error is thrown so the caller can fall back to the seed.
 */
export async function gatherPlaces(
  center: LatLng,
  key: string,
  fetcher: Fetcher = fetch,
  options: GatherOptions = {},
): Promise<Gathered> {
  const maxCalls = Math.max(1, Math.floor(options.maxCalls ?? MAX_NEARBY_CALLS));
  const target = options.target ?? POOL_TARGET;
  const radiusM = options.radiusM ?? 5000;
  const errors: unknown[] = [];
  let calls = 1;

  let base: Restaurant[] = [];
  try {
    base = toPool(await nearbyRestaurants(center, key, radiusM, fetcher), center);
  } catch (err) {
    errors.push(err);
  }

  const extra: Restaurant[][] = [];
  if (base.length < target && maxCalls > 1) {
    const cuisines = cuisineQueryOrder(base).slice(0, maxCalls - 1);
    calls += cuisines.length;
    const settled = await Promise.allSettled(
      cuisines.map((c) => nearbyRestaurants(center, key, radiusM, fetcher, CUISINE_QUERY_TYPES[c])),
    );
    for (const s of settled) {
      if (s.status === "fulfilled") extra.push(toPool(s.value, center));
      else errors.push(s.reason);
    }
  }

  if (errors.length === calls) throw errors[0];
  return { restaurants: mergePools(base, extra, target), calls, failedCalls: errors.length };
}

export type ResolvedPool =
  | {
      source: "places";
      location: string;
      center: LatLng;
      restaurants: Restaurant[];
      calls: number;
      failedCalls: number;
    }
  /** Local development only: the Yelp Open Dataset on disk (yelp-pool.ts). */
  | { source: "yelp"; location: string; center: LatLng; restaurants: Restaurant[] }
  | { source: "seed"; location: string | null; reason: string };

/**
 * The pool for a plan near `location`. Falls back to the seed when there is no
 * key, the place can't be found, or fewer than 5 restaurants map cleanly.
 */
export async function resolvePool(
  location: string | null,
  key = process.env.GOOGLE_PLACES_API_KEY,
  fetcher: Fetcher = fetch,
): Promise<ResolvedPool> {
  const where = location?.trim() || null;
  if (!where) return { source: "seed", location: null, reason: "no location given" };
  if (!key) return { source: "seed", location: where, reason: "no GOOGLE_PLACES_API_KEY" };
  try {
    const center = await geocode(where, key, fetcher);
    if (!center) return { source: "seed", location: where, reason: "location not found" };
    const { restaurants, calls, failedCalls } = await gatherPlaces(center, key, fetcher);
    if (restaurants.length < 5)
      return { source: "seed", location: where, reason: `only ${restaurants.length} usable places nearby` };
    return { source: "places", location: where, center, restaurants, calls, failedCalls };
  } catch (err) {
    return { source: "seed", location: where, reason: (err as Error).message };
  }
}
