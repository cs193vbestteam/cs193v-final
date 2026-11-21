import type { Cuisine } from "./constraints";
import { isMealCandidate, stylesOf } from "./cuisine-table";
import { travelMinutes, type LatLng } from "./geo";
import { weeklyHoursFromGoogle } from "./opening-hours";
import type { Feature } from "./optimizer-input";
import { hasLegacyCuisine, type Place, type Restaurant } from "./restaurants";

export { KM_PER_MIN, haversineKm, type LatLng } from "./geo";

/**
 * Candidate pool from Google Places (API "New"). Public information only:
 * where a plan happens is group knowledge, nobody's preferences are involved.
 *
 *   resolvePool(location)  → geocode the text, one general search for
 *                             restaurants nearby, mapped onto our shape
 *   Without GOOGLE_PLACES_API_KEY (or on any failure) callers fall back to
 *   the seeded RESTAURANTS, so the app keeps working offline.
 *
 * Nearby Search returns at most 20 places per call and has no paging, so that
 * one call gives a small, popularity-ranked pool. It is widened later, once
 * the group has said what it wants, with one search per cuisine or kind of
 * place somebody asked for (pool-extend.ts). Every call is billed, so the
 * number per plan is capped there. Closed places and poorly rated ones are
 * left out; the rating, address and Maps link are kept for the group to see.
 */

/** The subset of a Places "New" result we read. Kept small so fixtures stay honest. */
export type PlaceResult = {
  id: string;
  displayName?: { text?: string };
  primaryType?: string;
  types?: string[];
  priceLevel?: string;
  /** Whole dollars as strings, the way Google sends money. `endPrice` is missing for "$100 and up". */
  priceRange?: { startPrice?: { units?: string }; endPrice?: { units?: string } };
  location?: { latitude: number; longitude: number };
  servesVegetarianFood?: boolean;
  goodForGroups?: boolean;
  goodForChildren?: boolean;
  menuForChildren?: boolean;
  outdoorSeating?: boolean;
  liveMusic?: boolean;
  servesBeer?: boolean;
  servesWine?: boolean;
  servesCocktails?: boolean;
  reservable?: boolean;
  allowsDogs?: boolean;
  accessibilityOptions?: { wheelchairAccessibleEntrance?: boolean };
  parkingOptions?: Record<string, boolean | undefined>;
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
  "places.priceRange",
  "places.location",
  "places.servesVegetarianFood",
  // The same billing tier as the vegetarian answer above: what the place is like to be at.
  "places.goodForGroups",
  "places.goodForChildren",
  "places.menuForChildren",
  "places.outdoorSeating",
  "places.liveMusic",
  "places.servesBeer",
  "places.servesWine",
  "places.servesCocktails",
  "places.reservable",
  "places.allowsDogs",
  "places.accessibilityOptions",
  "places.parkingOptions",
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

/** Dollars per person each Google price level stands for, when Google gives a level but no range. */
export const PRICE_RANGE_BY_LEVEL: Record<string, { low: number; high: number }> = {
  PRICE_LEVEL_FREE: { low: 0, high: 10 },
  PRICE_LEVEL_INEXPENSIVE: { low: 0, high: 20 },
  PRICE_LEVEL_MODERATE: { low: 20, high: 40 },
  PRICE_LEVEL_EXPENSIVE: { low: 40, high: 70 },
  PRICE_LEVEL_VERY_EXPENSIVE: { low: 70, high: 120 },
};

/** What a meal costs per person: Google's own range, else its price level, else null (unknown). */
export function priceOf(p: Pick<PlaceResult, "priceRange" | "priceLevel">): { low: number; high: number } | null {
  const low = Number(p.priceRange?.startPrice?.units);
  if (p.priceRange?.startPrice?.units !== undefined && Number.isFinite(low) && low >= 0) {
    const high = Number(p.priceRange.endPrice?.units);
    return { low, high: Number.isFinite(high) && high >= low ? high : low };
  }
  return PRICE_RANGE_BY_LEVEL[p.priceLevel ?? ""] ?? null;
}

/** Nearby Search (New) returns at most this many places per call and cannot page. */
export const NEARBY_PAGE_SIZE = 20;
/** The most restaurants one plan's pool keeps. */
export const POOL_TARGET = 60;

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

/** The longest restaurant name we keep. Longer ones are cut, not dropped: real names can be long. */
export const MAX_PLACE_NAME_CHARS = 80;

/** Text no restaurant is called, and that reads as an order to a language model. */
const INSTRUCTION_LIKE = [
  /\b(?:ignore|disregard|forget|override)\b.{0,40}\b(?:instructions?|prompts?|rules?)\b/i,
  /\bsystem prompt\b/i,
  /\byou are now\b/i,
  /<\/?\s*(?:system|assistant|user|instructions?)\s*>/i,
];

/**
 * A restaurant's name as we store and show it. The name is whatever its owner typed into
 * Google, so it is cleaned before it goes anywhere: control and invisible characters are
 * removed, whitespace is collapsed to single spaces, and it is cut to MAX_PLACE_NAME_CHARS.
 * Returns null, and the place is left out, when the name reads as an instruction to a model.
 * A missing or empty name becomes "Unnamed place", as before.
 */
export function cleanPlaceName(raw: string | undefined): string | null {
  const text = (raw ?? "")
    .normalize("NFC")
    // Control characters, zero-width and direction-changing marks: nothing a name needs.
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "Unnamed place";
  if (INSTRUCTION_LIKE.some((re) => re.test(text))) return null;
  return text.length > MAX_PLACE_NAME_CHARS ? text.slice(0, MAX_PLACE_NAME_CHARS).trimEnd() : text;
}

/** A place counts as well rated at this Google rating or above, once enough people have rated it. */
export const WELL_RATED = 4.4;

/**
 * What Google says about the place itself, as yes, no or null (it does not say). Nothing is
 * guessed: a place with no answer about dogs is not a place that refuses them.
 */
export function featuresOf(p: PlaceResult): Partial<Record<Feature, boolean | null>> {
  const said = (v: boolean | undefined) => v ?? null;
  // Yes if any is yes, no only if every one is a stated no.
  const any = (vs: (boolean | undefined)[]) =>
    vs.some((v) => v === true) ? true : vs.length > 0 && vs.every((v) => v === false) ? false : null;
  const parking = p.parkingOptions ? Object.values(p.parkingOptions) : [];
  const reviews = p.userRatingCount ?? 0;
  return {
    groups: said(p.goodForGroups),
    kids: any([p.goodForChildren, p.menuForChildren]),
    outdoor: said(p.outdoorSeating),
    wheelchair: said(p.accessibilityOptions?.wheelchairAccessibleEntrance),
    reservable: said(p.reservable),
    alcohol: any([p.servesBeer, p.servesWine, p.servesCocktails]),
    parking: p.parkingOptions ? parking.some((v) => v === true) : null,
    dogs: said(p.allowsDogs),
    live_music: said(p.liveMusic),
    well_rated: p.rating !== undefined && reviews >= MIN_REVIEWS ? p.rating >= WELL_RATED : null,
  };
}

/**
 * Map one Places result onto our shape. Returns null for things we can't place. A place whose
 * food is none of the ten older cuisines is kept, with `cuisine: null` (see `Place`).
 */
export function toPlace(p: PlaceResult, center: LatLng): Place | null {
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
  // The owner writes the name on Google, so it is treated as untrusted text (#121).
  const name = cleanPlaceName(p.displayName?.text);
  if (name === null) return null;
  const cuisine = inferCuisine(types, name);
  const location = { lat: p.location.latitude, lng: p.location.longitude };
  const joined = types.join(" ") + " " + name.toLowerCase();
  const hours = weeklyHoursFromGoogle(p.regularOpeningHours?.periods);
  return {
    id: p.id,
    name,
    cuisine,
    types: primaryType && !placeTypes.includes(primaryType) ? [primaryType, ...placeTypes] : placeTypes,
    ...(primaryType ? { primaryType } : {}),
    features: featuresOf(p),
    style: stylesOf(placeTypes, primaryType),
    pricePerPerson: PRICE_BY_LEVEL[p.priceLevel ?? ""] ?? DEFAULT_PRICE,
    price: priceOf(p),
    travelMin: travelMinutes(center, location),
    location,
    spicy: /thai|indian|sichuan|hot_pot|korean|hot pot/.test(joined),
    vegetarianFriendly: p.servesVegetarianFood === true || /vegetarian|vegan/.test(joined),
    servesVegetarian: p.servesVegetarianFood ?? null,
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

/** The same, for the current negotiation engine only: a place it has no cuisine for is dropped. */
export function toRestaurant(p: PlaceResult, center: LatLng): Restaurant | null {
  const place = toPlace(p, center);
  return place && hasLegacyCuisine(place) ? place : null;
}

/** Turn a page of results into places: drop unmappable ones and duplicates, keep stable order. */
export function toPlaces(results: PlaceResult[], center: LatLng): Place[] {
  const seen = new Set<string>();
  const out: Place[] = [];
  for (const p of results) {
    const r = toPlace(p, center);
    if (!r || seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
  }
  return out;
}

/** The places of a page that the current negotiation engine can use. */
export function toPool(results: PlaceResult[], center: LatLng): Restaurant[] {
  return toPlaces(results, center).filter(hasLegacyCuisine);
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

/**
 * Places called `name` near a point, by Text Search. Used for a restaurant somebody asked for
 * by name that the searches by kind of food did not bring in. The search is biased to the
 * plan's area, not restricted to it, so the caller checks how far away a result is.
 */
export async function placesByName(
  name: string,
  center: LatLng,
  key: string,
  fetcher: Fetcher = fetch,
): Promise<PlaceResult[]> {
  const data = await postPlaces<{ places?: PlaceResult[] }>(
    "places:searchText",
    {
      textQuery: name,
      maxResultCount: 3,
      locationBias: { circle: { center: { latitude: center.lat, longitude: center.lng }, radius: 10_000 } },
    },
    key,
    PLACE_FIELDS,
    fetcher,
  );
  return data.places ?? [];
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

/**
 * Merge several pools into one of at most `cap` restaurants, de-duplicated by
 * place id. `base` keeps its order and goes first; the `extra` lists are then
 * interleaved one restaurant at a time, so a cap cuts every cuisine equally
 * instead of dropping whichever query happened to come last.
 */
export function mergePools<T extends { id: string }>(
  base: readonly T[],
  extra: readonly (readonly T[])[],
  cap = POOL_TARGET,
): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  const add = (r: T) => {
    if (out.length >= cap || seen.has(r.id)) return;
    seen.add(r.id);
    out.push(r);
  };
  base.forEach(add);
  const longest = Math.max(0, ...extra.map((list) => list.length));
  for (let i = 0; i < longest && out.length < cap; i++) for (const list of extra) if (i < list.length) add(list[i]);
  return out;
}

export type ResolvedPool =
  | {
      source: "places";
      location: string;
      center: LatLng;
      /** Every usable place nearby, including those the current engine has no cuisine for. */
      restaurants: Place[];
    }
  /** Local development only: the Yelp Open Dataset on disk (yelp-pool.ts). */
  | { source: "yelp"; location: string; center: LatLng; restaurants: Place[] }
  | { source: "seed"; location: string | null; reason: string };

/** Fewer usable places than this and the plan uses the seed instead. */
export const MIN_POOL = 5;

/**
 * The pool a plan STARTS with: the location geocoded, then one general "restaurants nearby"
 * search. More is fetched once the group has said what it wants (pool-extend.ts, #101). Falls
 * back to the seed when there is no key, the place can't be found, or fewer than MIN_POOL
 * restaurants map cleanly.
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
    const restaurants = toPlaces(await nearbyRestaurants(center, key, 5000, fetcher), center);
    const usable = restaurants.filter(hasLegacyCuisine).length;
    if (usable < MIN_POOL) return { source: "seed", location: where, reason: `only ${usable} usable places nearby` };
    return { source: "places", location: where, center, restaurants };
  } catch (err) {
    return { source: "seed", location: where, reason: (err as Error).message };
  }
}
