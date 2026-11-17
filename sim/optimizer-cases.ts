import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { centroid, type LatLng } from "../src/lib/geo";
import { openOn } from "../src/lib/opening-hours";
import { optimize, rankOptions } from "../src/lib/optimizer";
import { assembleOptimizerInput, checkResult, type OptimizerResult } from "../src/lib/optimizer-handoff";
import type { PersonPreferences } from "../src/lib/optimizer-input";
import { geocode, nearbyRestaurants, toPlaces, type PlaceResult } from "../src/lib/places";

/**
 * The optimizer's recorded test rounds: real restaurant pools from three areas, and groups of
 * three or four made-up people for each. By hand, two steps:
 *
 *   npm run cases:optimizer -- fetch     needs GOOGLE_PLACES_API_KEY in .env.local; 26 billed requests
 *   npm run cases:optimizer -- record    no key, no network: runs the optimizer and writes what it chose
 *
 * `fetch` writes tests/fixtures/optimizer-cases/<area>.places.json: what Google Places
 * returns, with the places themselves taken out exactly as sim/places-sample.ts does (ids and
 * names replaced, addresses and links dropped, coordinates rounded to about a kilometre).
 *
 * `record` reads the groups in <area>.cases.json, builds each one's optimizer input the way a
 * real plan's is built, and writes the optimizer's answer back as `expected`.
 * tests/optimizer-cases.test.ts then holds the optimizer to those answers. Record again only
 * when a change to the scoring is meant to change them, and read the difference before
 * committing it.
 *
 * To read a round with the real place names, set OPTIMIZER_CASES_NAMES to a folder outside
 * the repository: `fetch` saves each area's names there, and `record` prints them.
 */
export const CASES_DIR = path.resolve(__dirname, "../tests/fixtures/optimizer-cases");
/** A Saturday, so the pools have weekend opening hours. */
export const CASES_DATE = "2026-11-21";

type Search = { where: string; types: string[] };
type Area = { id: string; label: string; radiusM: number; searches: Search[] };

const CUISINES = ["japanese_restaurant", "italian_restaurant", "mexican_restaurant", "indian_restaurant"];
// A diet is only visible as a Google type, so the pools are searched for those types too.
const DIETS = ["halal_restaurant", "vegan_restaurant"];
export const AREAS: Area[] = [
  {
    id: "palo-alto-mountain-view",
    label: "Palo Alto and Mountain View",
    radiusM: 5000,
    searches: [
      { where: "Palo Alto, CA", types: ["restaurant", "japanese_restaurant", "indian_restaurant", "vegan_restaurant"] },
      {
        where: "Mountain View, CA",
        types: ["restaurant", "chinese_restaurant", "mexican_restaurant", "halal_restaurant"],
      },
    ],
  },
  {
    id: "long-island-city",
    label: "Long Island City",
    radiusM: 2000,
    searches: [{ where: "Long Island City, Queens, NY", types: ["restaurant", ...CUISINES, ...DIETS] }],
  },
  {
    id: "wicker-park",
    label: "Wicker Park",
    radiusM: 2000,
    searches: [{ where: "Wicker Park, Chicago, IL", types: ["restaurant", ...CUISINES, ...DIETS] }],
  },
];

export type PlacesFile = { about: string; center: LatLng; places: PlaceResult[] };
/**
 * A made-up person: what their chat would have recorded, where they would start from, and,
 * for a case about who finished first, when they were done (any number that grows with time).
 */
export type CaseMember = { prefs: PersonPreferences; startPoint: LatLng | null; finishedAt?: number };
export type Case = { name: string; about: string; members: CaseMember[]; expected?: OptimizerResult };
export type CasesFile = { about: string; cases: Case[] };

const round = (n: number) => Math.round(n * 100) / 100;
const read = <T>(file: string) => JSON.parse(readFileSync(file, "utf8")) as T;
const write = (file: string, data: unknown) => writeFileSync(file, JSON.stringify(data, null, 2) + "\n");

function withoutIdentity(p: PlaceResult, i: number, area: Area): PlaceResult {
  const n = String(i + 1).padStart(3, "0");
  return {
    id: `${area.id}-${n}`,
    displayName: { text: `${area.label} Place ${n}` },
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

async function fetchArea(area: Area, key: string, namesDir: string | undefined) {
  const seen = new Set<string>();
  const places: PlaceResult[] = [];
  const centers: LatLng[] = [];
  let requests = 0;
  for (const search of area.searches) {
    const center = await geocode(search.where, key);
    requests++;
    if (!center) throw new Error(`Could not find ${search.where}`);
    centers.push(center);
    for (const type of search.types) {
      requests++;
      try {
        for (const p of await nearbyRestaurants(center, key, area.radiusM, fetch, [type])) {
          if (seen.has(p.id)) continue;
          seen.add(p.id);
          places.push(p);
        }
      } catch (err) {
        console.error(`  ${search.where} / ${type}: ${(err as Error).message}`);
      }
    }
  }
  const center = centroid(centers)!;
  const out: PlacesFile = {
    about: `Shape of real Google Places results around ${area.label}; identities removed. See sim/optimizer-cases.ts.`,
    center: { lat: round(center.lat), lng: round(center.lng) },
    places: places.map((p, i) => withoutIdentity(p, i, area)),
  };
  write(path.join(CASES_DIR, `${area.id}.places.json`), out);
  if (namesDir) {
    const names = Object.fromEntries(out.places.map((p, i) => [p.id, places[i].displayName?.text ?? ""]));
    write(path.join(namesDir, `${area.id}.names.json`), names);
  }
  console.log(`${area.label}: ${out.places.length} places from ${requests} requests`);
}

/** A group's optimizer input, built from an area's places the way a real plan's is (optimizer-handoff.ts). */
export function buildInput(area: { label: string }, file: PlacesFile, members: readonly CaseMember[]) {
  const restaurants = toPlaces(file.places, file.center)
    .map((r) => openOn(r, CASES_DATE))
    .filter((r) => r.open.length > 0);
  return assembleOptimizerInput({ date: CASES_DATE, location: area.label, restaurants, members });
}

function record(namesDir: string | undefined) {
  for (const area of AREAS) {
    const casesPath = path.join(CASES_DIR, `${area.id}.cases.json`);
    if (!existsSync(casesPath)) continue;
    const places = read<PlacesFile>(path.join(CASES_DIR, `${area.id}.places.json`));
    const cases = read<CasesFile>(casesPath);
    const namesPath = namesDir && path.join(namesDir, `${area.id}.names.json`);
    const names = namesPath && existsSync(namesPath) ? read<Record<string, string>>(namesPath) : {};
    console.log(`\n=== ${area.label}`);
    for (const c of cases.cases) {
      const input = buildInput(area, places, c.members);
      const result = optimize(input);
      const problems = checkResult(input, result);
      if (problems.length) throw new Error(`${c.name}: ${problems.join("; ")}`);
      c.expected = result;
      // Per-person scores are printed here, on the developer's own screen, for made-up people only.
      const ranked = rankOptions(input);
      const describe = (id: string, time: string) => {
        const r = input.candidates.find((x) => x.id === id)!;
        const o = ranked.find((x) => x.restaurantId === id && x.startTime === time)!;
        const scores = o.scores.map((s) => (s === null ? "out" : s.toFixed(2))).join(" ");
        const price = r.price ? `$${r.price.low}-${r.price.high}` : "$?";
        return `${names[id] ?? r.name} (${id}) at ${time} | ${r.types.slice(0, 2).join(", ")} | ${price} | cannot come ${o.cannotCome} | scores ${scores}`;
      };
      console.log(
        `\n- ${c.name} (${c.members.length} people, ${input.candidates.length} places, ${ranked.length} options)`,
      );
      if (result.restaurantId === null) {
        console.log(`    no plan: ${result.reason}`);
        continue;
      }
      console.log(`    chosen: ${describe(result.restaurantId, result.startTime)}`);
      for (const a of result.alternatives) console.log(`    or:     ${describe(a.restaurantId, a.startTime)}`);
    }
    write(casesPath, cases);
  }
}

async function main() {
  const namesDir = process.env.OPTIMIZER_CASES_NAMES;
  if (namesDir && path.resolve(namesDir).startsWith(path.resolve(__dirname, "..") + path.sep))
    throw new Error("OPTIMIZER_CASES_NAMES must be outside the repository");
  if (namesDir) mkdirSync(namesDir, { recursive: true });
  const command = process.argv[2];
  if (command === "fetch") {
    const key = process.env.GOOGLE_PLACES_API_KEY;
    if (!key) throw new Error("GOOGLE_PLACES_API_KEY is not set");
    mkdirSync(CASES_DIR, { recursive: true });
    for (const area of AREAS) await fetchArea(area, key, namesDir);
  } else if (command === "record") {
    record(namesDir);
  } else {
    throw new Error("Say which: fetch or record");
  }
}

if (require.main === module)
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
