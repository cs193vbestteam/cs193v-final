import { SLOTS, type Cuisine, type Slot } from "./constraints";
import type { Restaurant } from "./restaurants";

/**
 * Candidate pool from Google Places (API "New"). Public information only:
 * where a plan happens is group knowledge, nobody's preferences are involved.
 *
 *   resolvePool(location)  → geocode the text, fetch nearby restaurants,
 *                             map them onto our Restaurant shape
 *   Without GOOGLE_PLACES_API_KEY (or on any failure) callers fall back to
 *   the seeded RESTAURANTS, so the app keeps working offline.
 */

export type LatLng = { lat: number; lng: number };

/** The subset of a Places "New" result we read. Kept small so fixtures stay honest. */
export type PlaceResult = {
  id: string;
  displayName?: { text?: string };
  primaryType?: string;
  types?: string[];
  priceLevel?: string;
  location?: { latitude: number; longitude: number };
  servesVegetarianFood?: boolean;
  regularOpeningHours?: { periods?: { open: { day: number; hour: number; minute?: number }; close?: { day: number; hour: number; minute?: number } }[] };
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
].join(",");

/** Typical spend per person for each Google price level. */
export const PRICE_BY_LEVEL: Record<string, number> = {
  PRICE_LEVEL_FREE: 10,
  PRICE_LEVEL_INEXPENSIVE: 15,
  PRICE_LEVEL_MODERATE: 30,
  PRICE_LEVEL_EXPENSIVE: 55,
  PRICE_LEVEL_VERY_EXPENSIVE: 90,
};
export const DEFAULT_PRICE = 30;

/** City travel: roughly 25 km/h door to door, never under 3 minutes. */
export const KM_PER_MIN = 25 / 60;

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

export function haversineKm(a: LatLng, b: LatLng): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/** Google days: 0 = Sunday … 6 = Saturday. Our slots probe lunch at 12:30 and dinner at 19:30. */
const SLOT_PROBE: Record<Slot, { day: number; minutes: number }> = {
  fri_dinner: { day: 5, minutes: 19 * 60 + 30 },
  sat_lunch: { day: 6, minutes: 12 * 60 + 30 },
  sat_dinner: { day: 6, minutes: 19 * 60 + 30 },
  sun_lunch: { day: 0, minutes: 12 * 60 + 30 },
  sun_dinner: { day: 0, minutes: 19 * 60 + 30 },
};

/** Which of our weekend slots a place is open for. Unknown hours → assume open. */
export function openSlots(hours: PlaceResult["regularOpeningHours"]): Slot[] {
  const periods = hours?.periods;
  if (!periods || periods.length === 0) return [...SLOTS];
  // A period with no close means open 24/7.
  if (periods.some((p) => !p.close)) return [...SLOTS];
  const minutesOfWeek = (day: number, hour: number, minute = 0) => day * 1440 + hour * 60 + minute;
  const intervals = periods.map((p) => {
    const start = minutesOfWeek(p.open.day, p.open.hour, p.open.minute);
    let end = minutesOfWeek(p.close!.day, p.close!.hour, p.close!.minute);
    if (end <= start) end += 7 * 1440; // wraps past Saturday night into Sunday
    return [start, end] as const;
  });
  return SLOTS.filter((slot) => {
    const probe = SLOT_PROBE[slot];
    const t = probe.day * 1440 + probe.minutes;
    return intervals.some(([s, e]) => (t >= s && t < e) || (t + 7 * 1440 >= s && t + 7 * 1440 < e));
  });
}

/** Map one Places result onto our Restaurant shape. Returns null for things we can't place. */
export function toRestaurant(p: PlaceResult, center: LatLng): Restaurant | null {
  if (!p.id || !p.location) return null;
  const types = [...(p.types ?? []), p.primaryType ?? ""].map((t) => t.toLowerCase());
  const name = p.displayName?.text ?? "Unnamed place";
  const cuisine = inferCuisine(types, name);
  if (!cuisine) return null;
  const km = haversineKm(center, { lat: p.location.latitude, lng: p.location.longitude });
  const travelMin = Math.max(3, Math.round(km / KM_PER_MIN));
  const joined = types.join(" ") + " " + name.toLowerCase();
  return {
    id: p.id,
    name,
    cuisine,
    pricePerPerson: PRICE_BY_LEVEL[p.priceLevel ?? ""] ?? DEFAULT_PRICE,
    travelMin,
    spicy: /thai|indian|sichuan|hot_pot|korean|hot pot/.test(joined),
    vegetarianFriendly: p.servesVegetarianFood === true || /vegetarian|vegan/.test(joined),
    seafoodHeavy: /seafood|sushi|fish|oyster|crab/.test(joined),
    halal: /halal/.test(joined),
    open: openSlots(p.regularOpeningHours),
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

async function postPlaces<T>(path: string, body: unknown, key: string, fieldMask: string, fetcher: Fetcher): Promise<T> {
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
export async function geocode(location: string, key: string, fetcher: Fetcher = fetch): Promise<LatLng | null> {
  const data = await postPlaces<{ places?: { location?: { latitude: number; longitude: number } }[] }>(
    "places:searchText",
    { textQuery: location, maxResultCount: 1 },
    key,
    "places.location",
    fetcher,
  );
  const loc = data.places?.[0]?.location;
  return loc ? { lat: loc.latitude, lng: loc.longitude } : null;
}

/** Restaurants within `radiusM` of a point (Nearby Search caps at 20 results). */
export async function nearbyRestaurants(center: LatLng, key: string, radiusM = 5000, fetcher: Fetcher = fetch): Promise<PlaceResult[]> {
  const data = await postPlaces<{ places?: PlaceResult[] }>(
    "places:searchNearby",
    {
      includedTypes: ["restaurant"],
      maxResultCount: 20,
      rankPreference: "POPULARITY",
      locationRestriction: { circle: { center: { latitude: center.lat, longitude: center.lng }, radius: radiusM } },
    },
    key,
    PLACE_FIELDS,
    fetcher,
  );
  return data.places ?? [];
}

export type ResolvedPool = { source: "places"; location: string; center: LatLng; restaurants: Restaurant[] } | { source: "seed"; location: string | null; reason: string };

/**
 * The pool for a plan near `location`. Falls back to the seed when there is no
 * key, the place can't be found, or fewer than 5 restaurants map cleanly.
 */
export async function resolvePool(location: string | null, key = process.env.GOOGLE_PLACES_API_KEY, fetcher: Fetcher = fetch): Promise<ResolvedPool> {
  const where = location?.trim() || null;
  if (!where) return { source: "seed", location: null, reason: "no location given" };
  if (!key) return { source: "seed", location: where, reason: "no GOOGLE_PLACES_API_KEY" };
  try {
    const center = await geocode(where, key, fetcher);
    if (!center) return { source: "seed", location: where, reason: "location not found" };
    const restaurants = toPool(await nearbyRestaurants(center, key, 5000, fetcher), center);
    if (restaurants.length < 5) return { source: "seed", location: where, reason: `only ${restaurants.length} usable places nearby` };
    return { source: "places", location: where, center, restaurants };
  } catch (err) {
    return { source: "seed", location: where, reason: (err as Error).message };
  }
}
