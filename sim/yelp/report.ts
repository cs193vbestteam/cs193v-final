import type { Stat, Summary } from "../metrics";
import type { YelpReport } from "./pipeline";

/** Markdown and terminal renderers for the Yelp report. Same conventions as sim/report.ts. */

const pct = (x: number | null | undefined, digits = 0): string =>
  x === null || x === undefined ? "-" : `${(x * 100).toFixed(digits)}%`;
const num = (x: number | null | undefined, digits = 3): string =>
  x === null || x === undefined ? "-" : x.toFixed(digits);
const meanMedian = (s: Stat): string => (s.n === 0 ? "-" : `${num(s.mean)} / ${num(s.median)}`);

const COLUMNS: [string, (s: Summary) => string][] = [
  ["groups", (s) => s.label],
  ["n", (s) => String(s.groups)],
  ["agreed", (s) => pct(s.convergenceRate)],
  ["any plan", (s) => pct(s.anyPlanRate)],
  ["oracle feasible", (s) => pct(s.oracleFeasibleRate)],
  ["agreed given feasible", (s) => pct(s.convergenceGivenFeasible)],
  ["plan given feasible", (s) => pct(s.anyPlanGivenFeasible)],
  ["Nash ratio, protocol (mean / median)", (s) => meanMedian(s.protocolNashRatio)],
  ["Nash ratio, naive", (s) => meanMedian(s.naiveNashRatio)],
  ["max-min ratio, protocol", (s) => meanMedian(s.protocolMaxMinRatio)],
  ["hits optimum", (s) => pct(s.protocolHitsOptimum)],
  ["rounds (mean)", (s) => num(s.roundsAll.mean, 2)],
  ["leaked names (mean)", (s) => num(s.leakedDims.mean, 1)],
  ["leaked per person per round", (s) => num(s.leakedPerPersonPerRound.mean, 2)],
];

function table(rows: readonly Summary[]): string[] {
  return [
    `| ${COLUMNS.map(([h]) => h).join(" | ")} |`,
    `| ${COLUMNS.map(() => "---").join(" | ")} |`,
    ...rows.map((s) => `| ${COLUMNS.map(([, f]) => f(s)).join(" | ")} |`),
  ];
}

export function toMarkdown(report: YelpReport): string {
  const { meta, data, validation: v, yelp, synthetic } = report;
  const lines: string[] = [];
  lines.push(`# Settle on the Yelp Open Dataset: ${meta.city}`, "");
  lines.push(
    `${meta.groupsFormed} groups of real friends (${meta.groupsRequested} requested), seed ${meta.seed}, ` +
      `${meta.restaurantsPerGroup} restaurants near each group, group size ${meta.sizeRange[0]}..${meta.sizeRange[1]}. ` +
      `Protocol: ${meta.negotiate.maxRounds} rounds x ${meta.negotiate.perRound} candidates, concessions from round ${meta.negotiate.concessionFrom}, ${meta.negotiate.finalists} finalists.`,
    "",
  );
  lines.push("## Data", "");
  lines.push(`- Restaurants that map onto the app's shape: ${data.restaurants} (${data.openRestaurants} still open)`);
  lines.push(`- Reviewers with enough reviews of them: ${data.reviewers}; personas built: ${data.personas}`);
  lines.push(`- Personas with at least one friend who also has a persona: ${data.personasWithFriends}`, "");

  lines.push("## Do the personas predict later behaviour?", "");
  lines.push(
    `Each persona is built from a reviewer's earlier reviews and checked on their latest ones (${v.heldOutVisits} held-out reviews, ${v.personas} personas). Availability is left out of this check.`,
    "",
  );
  lines.push("| check | value | what it would be if personas knew nothing |", "| --- | --- | --- |");
  lines.push(
    `| hard rules allow a place they later went to | ${pct(v.hardPassVisited)} | ${pct(v.hardPassRandom)} (a random place in the city) |`,
  );
  lines.push(`| a place they later went to scores above a random place | ${pct(v.aucVisitedVsRandom)} | 50% |`);
  lines.push(
    `| a later 4-5 star place scores above a later 1-2 star place | ${pct(v.aucLikedVsDisliked)} (${v.likedDislikedPairs} pairs) | 50% |`,
    "",
  );

  lines.push("## Yelp groups against synthetic groups", "");
  lines.push(
    "The synthetic row is the existing harness on the same number of groups, seed, pool size and protocol settings.",
    "",
  );
  lines.push(...table([yelp.overall, ...(synthetic ? [synthetic.overall] : [])]), "");
  lines.push("## Yelp groups by size", "");
  lines.push(...table(yelp.bySize), "");
  lines.push("See report.json for every group.");
  return lines.join("\n") + "\n";
}

export function toStdout(report: YelpReport): string {
  const v = report.validation;
  const rows = [report.yelp.overall, ...(report.synthetic ? [report.synthetic.overall] : [])];
  const cols: [string, (s: Summary) => string][] = [
    ["groups", (s) => s.label],
    ["n", (s) => String(s.groups)],
    ["agreed", (s) => pct(s.convergenceRate)],
    ["anyPlan", (s) => pct(s.anyPlanRate)],
    ["oracleOK", (s) => pct(s.oracleFeasibleRate)],
    ["agreed|OK", (s) => pct(s.convergenceGivenFeasible)],
    ["nashP", (s) => meanMedian(s.protocolNashRatio)],
    ["nashNaive", (s) => meanMedian(s.naiveNashRatio)],
    ["optimum", (s) => pct(s.protocolHitsOptimum)],
    ["leaked", (s) => num(s.leakedDims.mean, 1)],
  ];
  const cells = rows.map((s) => cols.map(([, f]) => f(s)));
  const widths = cols.map(([h], i) => Math.max(h.length, ...cells.map((c) => c[i].length)));
  const fmt = (c: string[]) => c.map((x, i) => x.padEnd(widths[i])).join("  ");
  return [
    `${report.meta.city}: ${report.data.restaurants} restaurants, ${report.data.personas} personas, ${report.meta.groupsFormed} of ${report.meta.groupsRequested} groups formed`,
    `personas on held-out reviews: hard rules allow ${pct(v.hardPassVisited)} of later visits (random place: ${pct(v.hardPassRandom)}); ` +
      `later visit beats random place ${pct(v.aucVisitedVsRandom)}; liked beats disliked ${pct(v.aucLikedVsDisliked)}`,
    "",
    fmt(cols.map(([h]) => h)),
    fmt(widths.map((w) => "-".repeat(w))),
    ...cells.map(fmt),
  ].join("\n");
}
