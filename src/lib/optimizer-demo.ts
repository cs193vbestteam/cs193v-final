import "server-only";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { labelOf } from "./cuisine-table";
import type { LatLng } from "./geo";
import { openOn } from "./opening-hours";
import { optimize, otherStartTimes, rankOptions } from "./optimizer";
import { assembleOptimizerInput, type OptimizerResult } from "./optimizer-handoff";
import { START_TIMES, type PersonPreferences, type StartTime, type TimeRange } from "./optimizer-input";
import { toPlaces, type PlaceResult } from "./places";

/**
 * The optimizer's recorded test rounds, run live for the local demo page (/optimizer-demo).
 *
 * It reads the same files the tests do (tests/fixtures/optimizer-cases, written by
 * sim/optimizer-cases.ts) and runs the optimizer on each group when the page is asked for.
 * The people are made up, which is the only reason their preferences and scores may be shown
 * next to each other here; nothing in this file may be pointed at a real plan.
 *
 * The pools in the repository have no real place names. If OPTIMIZER_CASES_NAMES names a
 * folder outside the repository that holds the names `fetch` saved, they are shown instead.
 */
const DIR = path.resolve(process.cwd(), "tests/fixtures/optimizer-cases");
const DATE = "2026-11-21";
const AREAS = [
  { id: "palo-alto-mountain-view", label: "Palo Alto and Mountain View" },
  { id: "long-island-city", label: "Long Island City" },
  { id: "wicker-park", label: "Wicker Park" },
] as const;

type PlacesFile = { center: LatLng; places: PlaceResult[] };
type CasesFile = {
  cases: {
    name: string;
    about: string;
    members: { prefs: PersonPreferences; startPoint: LatLng | null; finishedAt?: number }[];
    expected?: OptimizerResult;
  }[];
};

export type DemoOption = {
  key: string;
  place: string;
  kind: string;
  price: string;
  startTime: string;
  /** The other start times this place can take with as many people, as ranges: "20:00 to 23:00". */
  alsoAt: string[];
  cannotCome: number;
  /** One per person in order; null for someone who cannot come. */
  scores: (number | null)[];
};
export type DemoCase = {
  name: string;
  about: string;
  /** `finished` is the person's place in the order people finished, when the case gives one. */
  people: { id: string; said: string[]; finished?: number }[];
  options: number;
  /** The chosen plan first, then the alternatives in the order the result lists them. Empty when there is no plan. */
  ranking: DemoOption[];
  /** Whether the optimizer still gives the answer that was recorded for the tests. */
  matchesRecorded: boolean;
};
export type DemoArea = { id: string; label: string; places: number; realNames: boolean; cases: DemoCase[] };

const read = <T>(file: string) => JSON.parse(readFileSync(file, "utf8")) as T;
const range = (r: TimeRange) => (r.from === r.to ? r.from : `${r.from} to ${r.to}`);
const list = (xs: readonly string[]) => xs.join(", ");

/** Start times in clock order as runs of consecutive hours: 20:00, 21:00, 23:00 becomes "20:00 to 21:00", "23:00". */
export function timeRanges(times: readonly StartTime[]): string[] {
  const runs: TimeRange[] = [];
  for (const t of times) {
    const last = runs.at(-1);
    if (last && START_TIMES.indexOf(t) === START_TIMES.indexOf(last.to) + 1) last.to = t;
    else runs.push({ from: t, to: t });
  }
  return runs.map(range);
}

/** What one made-up person told their assistant, in words. */
export function describePrefs(p: PersonPreferences): string[] {
  const out: string[] = [];
  if (p.time?.unavailable?.length) out.push(`Cannot do ${list(p.time.unavailable.map(range))}`);
  if (p.time?.preferred?.length) out.push(`Prefers ${list(p.time.preferred.map(range))} (${p.time.strength})`);
  for (const need of p.dietary ?? []) out.push(`Eats ${need}`);
  if (p.budget) {
    const parts = [p.budget.ideal && `around $${p.budget.ideal}`, p.budget.max && `at most $${p.budget.max}`];
    out.push(`Budget ${parts.filter(Boolean).join(", ")} (${p.budget.strength})`);
  }
  if (p.travel) {
    const parts = [
      p.travel.idealMin && `around ${p.travel.idealMin} min`,
      p.travel.maxMin && `at most ${p.travel.maxMin} min`,
    ];
    out.push(`Trip ${parts.filter(Boolean).join(", ")} (${p.travel.strength})`);
  }
  const scores = Object.entries(p.cuisine?.scores ?? {});
  const wanted = scores.filter(([, s]) => s === 1).map(([t]) => labelOf(t));
  const near = scores.filter(([, s]) => s < 1).map(([t]) => labelOf(t));
  if (wanted.length)
    out.push(`Wants ${list(wanted)} (${p.cuisine!.strength})${near.length ? `; ${list(near)} would do` : ""}`);
  if (p.cuisine?.excluded?.length) out.push(`No ${list(p.cuisine.excluded.map(labelOf))}`);
  if (p.style?.wanted?.length)
    out.push(`Wants ${list(p.style.wanted.map((s) => s.replace("_", " ")))} (${p.style.strength})`);
  if (p.style?.excluded?.length) out.push(`No ${list(p.style.excluded.map((s) => s.replace("_", " ")))}`);
  if (p.wantedRestaurants?.length) out.push(`Named a place: ${list(p.wantedRestaurants.map((r) => r.name))}`);
  if (p.excludedRestaurants?.length) out.push(`Ruled out: ${list(p.excludedRestaurants.map((r) => r.name))}`);
  for (const n of p.notes ?? []) out.push(`Note (${n.type}): ${n.text}`);
  if (p.priority?.length) out.push(`Matters most: ${list(p.priority)}`);
  return out.length ? out : ["Said nothing: anything works"];
}

function realNames(areaId: string): Record<string, string> {
  const dir = process.env.OPTIMIZER_CASES_NAMES;
  if (!dir) return {};
  const file = path.join(dir, `${areaId}.names.json`);
  // Real names must not come from inside the repository, where they could be committed.
  if (path.resolve(file).startsWith(process.cwd() + path.sep) || !existsSync(file)) return {};
  return read<Record<string, string>>(file);
}

export function runOptimizerDemo(): DemoArea[] {
  return AREAS.map((area) => {
    const pool = read<PlacesFile>(path.join(DIR, `${area.id}.places.json`));
    const { cases } = read<CasesFile>(path.join(DIR, `${area.id}.cases.json`));
    const names = realNames(area.id);
    const restaurants = toPlaces(pool.places, pool.center)
      .map((r) => openOn(r, DATE))
      .filter((r) => r.open.length > 0);
    const rename = (text: string) =>
      Object.entries(names).reduce((t, [id, name]) => t.replace(`${area.label} Place ${id.slice(-3)}`, name), text);

    return {
      id: area.id,
      label: area.label,
      places: restaurants.length,
      realNames: Object.keys(names).length > 0,
      cases: cases.map((c) => {
        const input = assembleOptimizerInput({ date: DATE, location: area.label, restaurants, members: c.members });
        const ranked = rankOptions(input);
        const result = optimize(input);
        const picks = result.restaurantId === null ? [] : [result, ...result.alternatives];
        return {
          name: c.name,
          about: c.about,
          people: input.people.map((p) => ({
            id: p.id,
            said: describePrefs(p.prefs).map(rename),
            finished: p.finished,
          })),
          options: ranked.length,
          matchesRecorded: JSON.stringify(result) === JSON.stringify(c.expected),
          ranking: picks.map((pick) => {
            const r = input.candidates.find((x) => x.id === pick.restaurantId)!;
            const o = ranked.find((x) => x.restaurantId === pick.restaurantId && x.startTime === pick.startTime)!;
            return {
              key: `${pick.restaurantId}@${pick.startTime}`,
              place: names[r.id] ?? r.name,
              kind: labelOf(r.primaryType ?? r.types[0] ?? "restaurant"),
              price: r.price
                ? r.price.low === r.price.high
                  ? `$${r.price.low}`
                  : `$${r.price.low}–${r.price.high}`
                : "not given",
              startTime: pick.startTime,
              alsoAt: timeRanges(otherStartTimes(ranked, pick)),
              cannotCome: pick.cannotCome,
              scores: o.scores,
            };
          }),
        };
      }),
    };
  });
}
