import type { Slot } from "./constraints";
import type { LatLng } from "./geo";
import { MINUTES_PER_DAY, openStartTimes, type WeeklyHours } from "./opening-hours";
import { inferCuisine } from "./places";
import type { Restaurant } from "./restaurants";

/** One record of the Yelp Open Dataset's business file; only the fields we read. */
export type YelpBusiness = {
  business_id: string;
  name: string;
  city: string;
  state: string;
  latitude: number | null;
  longitude: number | null;
  is_open: number;
  /** e.g. `{ RestaurantsPriceRange2: "2" }`; values are strings, sometimes the string "None". */
  attributes: Record<string, unknown> | null;
  /** Comma-separated, e.g. "Mexican, Burgers, Restaurants". */
  categories: string | null;
  /** e.g. `{ Friday: "11:0-22:0" }`. */
  hours: Record<string, string> | null;
};

/**
 * Yelp businesses → the app's restaurant shape.
 *
 * The mapping mirrors what places.ts does for Google results, so a Yelp pool
 * and a live pool are judged on the same terms: cuisine from categories, a
 * dollar figure from the price band, start times from opening hours, and
 * the same keyword heuristics for the dietary flags. A business is dropped
 * when it is not a restaurant, has no coordinates, has no price band, or
 * falls outside the ten cuisines the app models.
 *
 * Used by the evaluation (sim/yelp/) and by the local-only candidate source
 * (yelp-pool.ts).
 */

/** A mapped restaurant that still knows where it is; `travelMin` is set per group later. */
export type YelpRestaurant = Omit<Restaurant, "travelMin" | "location"> & {
  location: LatLng;
  /** Yelp's 1..4 price band, kept for deriving budgets. */
  priceLevel: 1 | 2 | 3 | 4;
  /** Still in business. Closed places inform personas but are never proposed. */
  isOpen: boolean;
};

/** Typical spend per person for each Yelp price band; the same figures places.ts uses for Google's levels. */
export const PRICE_BY_BAND: Record<1 | 2 | 3 | 4, number> = { 1: 15, 2: 30, 3: 55, 4: 90 };

export function priceBand(b: Pick<YelpBusiness, "attributes">): 1 | 2 | 3 | 4 | null {
  const n = Number(b.attributes?.RestaurantsPriceRange2);
  return n === 1 || n === 2 || n === 3 || n === 4 ? n : null;
}

const YELP_DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/**
 * The plan date the evaluation maps the dataset for: a Saturday. A live plan built from the
 * dataset (yelp-pool.ts) has `open` worked out again for its own date.
 */
export const EVAL_DATE = "2026-11-21";

/** "11:0-22:0" → minutes since midnight; a close at or before the open wraps past midnight. */
function parseRange(range: string): [number, number] | null {
  const m = /^(\d{1,2}):(\d{1,2})-(\d{1,2}):(\d{1,2})$/.exec(range.trim());
  if (!m) return null;
  const start = Number(m[1]) * 60 + Number(m[2]);
  let end = Number(m[3]) * 60 + Number(m[4]);
  if (end <= start) end += MINUTES_PER_DAY; // also covers "0:0-0:0", which the dataset uses for open all day
  return [start, end];
}

/** Yelp's per-day hours as weekly intervals. Null when the dataset gives no hours: unknown, not open. */
export function weeklyHoursFromYelp(hours: YelpBusiness["hours"]): WeeklyHours | null {
  if (!hours || Object.keys(hours).length === 0) return null;
  const out: WeeklyHours = [];
  YELP_DAYS.forEach((day, i) => {
    const parsed = hours[day] ? parseRange(hours[day]) : null;
    if (parsed) out.push([i * MINUTES_PER_DAY + parsed[0], i * MINUTES_PER_DAY + parsed[1]]);
  });
  return out;
}

/** The start times a business can take on `date`. No hours at all means none: we cannot say it is open. */
export function openSlots(hours: YelpBusiness["hours"], date: string = EVAL_DATE): Slot[] {
  return openStartTimes(weeklyHoursFromYelp(hours), date) ?? [];
}

export const categoriesOf = (b: Pick<YelpBusiness, "categories">): string[] =>
  (b.categories ?? "")
    .split(",")
    .map((c) => c.trim().toLowerCase())
    .filter(Boolean);

export function toRestaurant(b: YelpBusiness, date: string = EVAL_DATE): YelpRestaurant | null {
  const cats = categoriesOf(b);
  if (!cats.includes("restaurants")) return null;
  if (typeof b.latitude !== "number" || typeof b.longitude !== "number") return null;
  const band = priceBand(b);
  if (!band) return null;
  // inferCuisine matches Google-style tokens ("sushi_bars"), so give it the categories in that form.
  const cuisine = inferCuisine(cats.map((c) => c.replace(/[^a-z]+/g, "_")));
  if (!cuisine) return null;
  const hours = weeklyHoursFromYelp(b.hours);
  // Dropped when it has no hours we can read; kept when it is merely closed on `date`,
  // because a live plan may fall on another day.
  if (!hours || hours.length === 0) return null;
  const open = openStartTimes(hours, date) ?? [];
  const joined = cats.join(" ");
  return {
    id: b.business_id,
    name: b.name,
    cuisine,
    pricePerPerson: PRICE_BY_BAND[band],
    priceLevel: band,
    location: { lat: b.latitude, lng: b.longitude },
    spicy: /thai|indian|szechuan|sichuan|hot pot|korean/.test(joined),
    vegetarianFriendly: /vegetarian|vegan/.test(joined),
    seafoodHeavy: /seafood|sushi|fish|oyster|crab/.test(joined),
    halal: /halal/.test(joined),
    open,
    hours,
    isOpen: b.is_open === 1,
  };
}

const sameCity = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Every mappable restaurant in one city, keyed by business id. */
export function restaurantsInCity(businesses: Iterable<YelpBusiness>, city: string): Map<string, YelpRestaurant> {
  const out = new Map<string, YelpRestaurant>();
  for (const b of businesses) {
    if (!sameCity(b.city ?? "", city)) continue;
    const r = toRestaurant(b);
    if (r) out.set(r.id, r);
  }
  return out;
}
