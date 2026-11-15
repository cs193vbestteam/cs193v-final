import { writeFileSync } from "node:fs";
import path from "node:path";
import { geocode, nearbyRestaurants, type PlaceResult } from "../src/lib/places";

/**
 * Rebuilds tests/fixtures/places-sample.json from Google Places, by hand:
 *
 *   npm run sample:places            (needs GOOGLE_PLACES_API_KEY in .env.local; about 7 requests)
 *
 * The file is what real results look like, with the places themselves taken out: ids and
 * names are replaced, addresses and Maps links are dropped, and coordinates are rounded to
 * about a kilometre. What is kept is what the optimizer has to cope with: the types Google
 * gives, which places have no price or no vegetarian answer, and real opening hours. We
 * commit the shape of the data, not a copy of Google's listings.
 */
const WHERE = "Palo Alto, CA";
const TYPES = [
  ["restaurant"],
  ["japanese_restaurant"],
  ["chinese_restaurant"],
  ["indian_restaurant"],
  ["mexican_restaurant"],
  ["italian_restaurant"],
] as const;
const OUT = path.resolve(__dirname, "../tests/fixtures/places-sample.json");

const round = (n: number) => Math.round(n * 100) / 100;

function withoutIdentity(p: PlaceResult, i: number): PlaceResult {
  const n = String(i + 1).padStart(2, "0");
  return {
    id: `sample-${n}`,
    displayName: { text: `Sample Place ${n}` },
    ...(p.primaryType ? { primaryType: p.primaryType } : {}),
    ...(p.types ? { types: p.types } : {}),
    ...(p.priceLevel ? { priceLevel: p.priceLevel } : {}),
    ...(p.priceRange ? { priceRange: p.priceRange } : {}),
    ...(p.location
      ? { location: { latitude: round(p.location.latitude), longitude: round(p.location.longitude) } }
      : {}),
    ...(p.servesVegetarianFood !== undefined ? { servesVegetarianFood: p.servesVegetarianFood } : {}),
    ...(p.businessStatus ? { businessStatus: p.businessStatus } : {}),
    ...(p.regularOpeningHours?.periods ? { regularOpeningHours: { periods: p.regularOpeningHours.periods } } : {}),
  };
}

async function main() {
  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (!key) throw new Error("GOOGLE_PLACES_API_KEY is not set");
  const center = await geocode(WHERE, key);
  if (!center) throw new Error(`Could not find ${WHERE}`);
  const seen = new Set<string>();
  const places: PlaceResult[] = [];
  for (const types of TYPES) {
    for (const p of await nearbyRestaurants(center, key, 5000, fetch, types)) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      places.push(p);
    }
  }
  const out = {
    about: "Shape of real Google Places results near Palo Alto; identities removed. See sim/places-sample.ts.",
    center: { lat: round(center.lat), lng: round(center.lng) },
    places: places.map(withoutIdentity),
  };
  writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
  console.log(`Wrote ${out.places.length} places to ${path.relative(process.cwd(), OUT)}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
