import type { ConstraintsUpdate } from "./constraints";
import { centroid, haversineKm, type LatLng } from "./geo";
import { geocode } from "./places";
import type { Restaurant } from "./restaurants";

/**
 * Turns the place a person says they are coming from into coordinates.
 *
 * The extractor only ever produces text (`startText`); this is the one place
 * that resolves it, so a model can never invent coordinates. The result is
 * stored encrypted with the person's constraints and used only to work out their
 * own travel minutes (optimizer-handoff.ts). The text is sent to Google Places to
 * be geocoded, biased towards the plan's candidate pool.
 */

/** A start point further than this from the candidates is treated as a wrong match. */
export const MAX_START_KM = 150;

type Fetcher = typeof fetch;

const located = (restaurants: readonly Restaurant[]): LatLng[] =>
  restaurants.flatMap((r) => (r.location ? [r.location] : []));

/** Per-person travel needs candidate coordinates and a geocoder; the seed pool has neither. */
export function canLocate(restaurants: readonly Restaurant[], key = process.env.GOOGLE_PLACES_API_KEY): boolean {
  return Boolean(key) && located(restaurants).length > 0;
}

export const START_UNAVAILABLE =
  "(I can't measure from your own starting point on this plan, so I'll use the plan's location for travel.)";
export const startNotFound = (text: string) =>
  `(I couldn't place "${text}" on the map, so I'll keep measuring travel from the plan's location. A neighbourhood or cross street usually works.)`;

export const startNotFoundKeeping = (text: string, kept: string) =>
  `(I couldn't place "${text}" on the map, so I'll keep measuring from ${kept}. A neighbourhood or cross street usually works.)`;

/**
 * Replace `startText` in an extractor update with a resolved `startPoint`.
 * When the place can't be resolved the update simply drops it and the reply
 * says so; the rest of the update is kept either way.
 */
export async function resolveStart(
  update: ConstraintsUpdate,
  reply: string,
  restaurants: readonly Restaurant[],
  key = process.env.GOOGLE_PLACES_API_KEY,
  fetcher: Fetcher = fetch,
): Promise<{ update: ConstraintsUpdate; reply: string }> {
  const { startText, ...rest } = update;
  // undefined = not mentioned; null = "forget where I'm coming from", which mergeConstraints handles.
  if (startText === undefined || startText === null) return { update, reply };

  const centre = centroid(located(restaurants));
  if (!key || !centre) return { update: rest, reply: `${reply} ${START_UNAVAILABLE}` };

  let point: LatLng | null = null;
  try {
    point = await geocode(startText, key, fetcher, centre);
  } catch (err) {
    // Said to the person as "couldn't place it"; the cause is only useful to us.
    console.error("Could not look up a start point:", (err as Error).message);
    point = null;
  }
  if (!point || haversineKm(point, centre) > MAX_START_KM)
    return { update: rest, reply: `${reply} ${startNotFound(startText)}` };
  return { update: { ...rest, startPoint: { label: startText, lat: point.lat, lng: point.lng } }, reply };
}
