/**
 * Plain geometry for travel estimates. Pure and dependency-free, so both the
 * public candidate pool (places.ts) and a person's private assistant
 * (agent.ts) can use it without either reaching the other's data.
 */

export type LatLng = { lat: number; lng: number };

/** City travel: roughly 25 km/h door to door, never under 3 minutes. */
export const KM_PER_MIN = 25 / 60;
export const MIN_TRAVEL_MIN = 3;

/**
 * How someone gets there. "A ten minute walk" and "a ten minute drive" are a kilometre and
 * several apart, so a travel limit means little without it.
 */
export const TRAVEL_MODES = ["walk", "bike", "drive", "transit"] as const;
export type TravelMode = (typeof TRAVEL_MODES)[number];

/**
 * Each way of travelling as a straight-line speed and a fixed overhead in minutes. These are
 * estimates from distance alone, not routes: streets are about 1.3 times the straight line, so
 * walking 4.8 km/h along them is 3.7 km/h as the crow flies; a bike likewise; a car in town
 * averages 25 km/h door to door (parking included, as before); a bus or train is slower door to
 * door than its top speed and starts with a wait.
 */
export const TRAVEL_SPEED: Record<TravelMode, { kmPerHour: number; overheadMin: number }> = {
  walk: { kmPerHour: 3.7, overheadMin: 0 },
  bike: { kmPerHour: 11, overheadMin: 2 },
  drive: { kmPerHour: 25, overheadMin: 0 },
  transit: { kmPerHour: 14, overheadMin: 6 },
};
/** What is assumed when someone gives minutes and no way of travelling. The estimate every plan used before modes. */
export const DEFAULT_TRAVEL_MODE: TravelMode = "drive";

export function haversineKm(a: LatLng, b: LatLng): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/** One-way travel estimate in whole minutes between two points, for one way of travelling. */
export function travelMinutes(from: LatLng, to: LatLng, mode: TravelMode = DEFAULT_TRAVEL_MODE): number {
  const { kmPerHour, overheadMin } = TRAVEL_SPEED[mode];
  return Math.max(MIN_TRAVEL_MIN, Math.round((haversineKm(from, to) / kmPerHour) * 60 + overheadMin));
}

/** How far, in kilometres as the crow flies, `minutes` of travel reaches: the inverse of travelMinutes. */
export function reachKm(minutes: number, mode: TravelMode = DEFAULT_TRAVEL_MODE): number {
  const { kmPerHour, overheadMin } = TRAVEL_SPEED[mode];
  return Math.max(0, ((minutes - overheadMin) / 60) * kmPerHour);
}

/** The mean point of a set of nearby coordinates; null when there are none. */
export function centroid(points: readonly LatLng[]): LatLng | null {
  if (points.length === 0) return null;
  const sum = points.reduce((acc, p) => ({ lat: acc.lat + p.lat, lng: acc.lng + p.lng }), { lat: 0, lng: 0 });
  return { lat: sum.lat / points.length, lng: sum.lng / points.length };
}
