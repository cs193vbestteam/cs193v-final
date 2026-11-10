/**
 * Plain geometry for travel estimates. Pure and dependency-free, so both the
 * public candidate pool (places.ts) and a person's private assistant
 * (agent.ts) can use it without either reaching the other's data.
 */

export type LatLng = { lat: number; lng: number };

/** City travel: roughly 25 km/h door to door, never under 3 minutes. */
export const KM_PER_MIN = 25 / 60;
export const MIN_TRAVEL_MIN = 3;

export function haversineKm(a: LatLng, b: LatLng): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/** One-way travel estimate in whole minutes between two points. */
export function travelMinutes(from: LatLng, to: LatLng): number {
  return Math.max(MIN_TRAVEL_MIN, Math.round(haversineKm(from, to) / KM_PER_MIN));
}

/** The mean point of a set of nearby coordinates; null when there are none. */
export function centroid(points: readonly LatLng[]): LatLng | null {
  if (points.length === 0) return null;
  const sum = points.reduce((acc, p) => ({ lat: acc.lat + p.lat, lng: acc.lng + p.lng }), { lat: 0, lng: 0 });
  return { lat: sum.lat / points.length, lng: sum.lng / points.length };
}
