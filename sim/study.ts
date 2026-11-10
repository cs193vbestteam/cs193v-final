import type { Summary } from "./metrics";
import { DEFAULT_NEGOTIATE, runSim, type SimReport } from "./pipeline";

/**
 * The multi-seed study behind docs/evaluation.md.
 *
 *   runSeeds   the same configuration over several seeds; one number per
 *              metric per seed, then mean and 95% interval across seeds
 *   runStudy   that, for every `perRound` in a sweep
 *
 * A seed is one independent draw of all the synthetic groups, so the interval
 * says how much a headline number moves when the population is redrawn. It is
 * a Student-t interval over the per-seed values: few seeds, unknown variance.
 * Everything here is a pure function of (seeds, groups, options): no clock, no
 * network. The LLM baseline is not part of it (see study-run.ts).
 */

/* ------------------------------------------------------------------ */
/* Intervals                                                           */
/* ------------------------------------------------------------------ */

/** Two-sided 95% critical values of Student's t for 1..30 degrees of freedom. */
const T_95 = [
  12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.16, 2.145, 2.131, 2.12, 2.11,
  2.101, 2.093, 2.086, 2.08, 2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048, 2.045, 2.042,
];

export function tCritical95(df: number): number {
  if (!Number.isInteger(df) || df < 1) throw new Error(`degrees of freedom must be a positive integer, got ${df}`);
  return df <= T_95.length ? T_95[df - 1] : 1.96;
}

/**
 * Mean and 95% interval of a sample. `lo`/`hi` are null when there are fewer
 * than two values: one seed has a mean but says nothing about spread.
 */
export type Interval = { n: number; mean: number | null; sd: number | null; lo: number | null; hi: number | null };

export function interval(xs: readonly number[]): Interval {
  const n = xs.length;
  if (n === 0) return { n, mean: null, sd: null, lo: null, hi: null };
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  if (n === 1) return { n, mean, sd: null, lo: null, hi: null };
  const sd = Math.sqrt(xs.reduce((a, x) => a + (x - mean) ** 2, 0) / (n - 1));
  const half = (tCritical95(n - 1) * sd) / Math.sqrt(n);
  return { n, mean, sd, lo: mean - half, hi: mean + half };
}

/* ------------------------------------------------------------------ */
/* Metrics                                                             */
/* ------------------------------------------------------------------ */

export type MetricKey =
  | "agreed"
  | "agreedGivenFeasible"
  | "nashRatio"
  | "maxMinRatio"
  | "hitsOptimum"
  | "naiveNashRatio"
  | "leakedDims"
  | "leakedPerPersonPerRound"
  | "rounds";

type Metric = { key: MetricKey; label: string; format: "pct" | "ratio" | "count"; pick: (s: Summary) => number | null };

/** One number per seed for each of these, read off that seed's overall summary. */
export const METRICS: readonly Metric[] = [
  { key: "agreed", label: "agreement rate", format: "pct", pick: (s) => s.convergenceRate },
  {
    key: "agreedGivenFeasible",
    label: "agreement rate, feasible groups",
    format: "pct",
    pick: (s) => s.convergenceGivenFeasible,
  },
  { key: "nashRatio", label: "Nash ratio, protocol", format: "ratio", pick: (s) => s.protocolNashRatio.mean },
  { key: "maxMinRatio", label: "max-min ratio, protocol", format: "ratio", pick: (s) => s.protocolMaxMinRatio.mean },
  { key: "hitsOptimum", label: "hits the optimum", format: "pct", pick: (s) => s.protocolHitsOptimum },
  { key: "naiveNashRatio", label: "Nash ratio, naive", format: "ratio", pick: (s) => s.naiveNashRatio.mean },
  { key: "leakedDims", label: "leaked dimension names per group", format: "count", pick: (s) => s.leakedDims.mean },
  {
    key: "leakedPerPersonPerRound",
    label: "leaked names per person per round",
    format: "count",
    pick: (s) => s.leakedPerPersonPerRound.mean,
  },
  { key: "rounds", label: "rounds run", format: "count", pick: (s) => s.roundsAll.mean },
];

export type SeedRow = { seed: number; values: Record<MetricKey, number | null> };
export type Aggregate = { perRound: number; seeds: SeedRow[]; stats: Record<MetricKey, Interval> };

export function seedRow(seed: number, overall: Summary): SeedRow {
  const values = Object.fromEntries(METRICS.map((m) => [m.key, m.pick(overall)])) as SeedRow["values"];
  return { seed, values };
}

/** Mean and interval across seeds. A seed where a metric is undefined (null) is left out of that metric only. */
export function aggregateSeeds(perRound: number, seeds: readonly SeedRow[]): Aggregate {
  const stats = Object.fromEntries(
    METRICS.map((m) => [m.key, interval(seeds.map((s) => s.values[m.key]).filter((v): v is number => v !== null))]),
  ) as Aggregate["stats"];
  return { perRound, seeds: [...seeds], stats };
}

/**
 * `a - b` for one metric, paired by seed: both aggregates saw the same
 * populations, so the per-seed differences cancel most of the between-seed
 * noise. An interval that excludes 0 is a difference the seeds agree on.
 */
export function pairedDifference(a: Aggregate, b: Aggregate, key: MetricKey): Interval {
  const other = new Map(b.seeds.map((s) => [s.seed, s.values[key]]));
  const diffs: number[] = [];
  for (const s of a.seeds) {
    const x = s.values[key];
    const y = other.get(s.seed);
    if (x !== null && y !== null && y !== undefined) diffs.push(x - y);
  }
  return interval(diffs);
}

/* ------------------------------------------------------------------ */
/* Running                                                             */
/* ------------------------------------------------------------------ */

export type SeedRunOptions = { seeds: readonly number[]; groups: number; restaurants?: number; perRound?: number };

export async function runSeeds(opts: SeedRunOptions): Promise<Aggregate> {
  if (opts.seeds.length === 0) throw new Error("runSeeds needs at least one seed");
  if (new Set(opts.seeds).size !== opts.seeds.length)
    throw new Error("seeds must be distinct: a repeated seed is the same population twice");
  const perRound = opts.perRound ?? DEFAULT_NEGOTIATE.perRound;
  const rows: SeedRow[] = [];
  for (const seed of opts.seeds) {
    const report: SimReport = await runSim({
      groups: opts.groups,
      seed,
      restaurants: opts.restaurants,
      negotiate: { perRound },
    });
    rows.push(seedRow(seed, report.overall));
  }
  return aggregateSeeds(perRound, rows);
}

export type StudyOptions = {
  seeds: readonly number[];
  groups: number;
  restaurants?: number;
  /** `perRound` values to compare. The protocol's default is always included. */
  perRounds?: readonly number[];
  onProgress?: (done: number, total: number) => void;
};

export type StudyReport = {
  meta: { seeds: number[]; groups: number; restaurantsPerGroup: number; basePerRound: number; perRounds: number[] };
  /** The protocol as shipped (default `perRound`). */
  base: Aggregate;
  /** One aggregate per `perRound`, ascending; includes `base`. */
  sweep: Aggregate[];
};

export const DEFAULT_SEEDS: readonly number[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
export const DEFAULT_PER_ROUNDS: readonly number[] = [3, 5, 8, 10];

export async function runStudy(opts: StudyOptions): Promise<StudyReport> {
  const basePerRound = DEFAULT_NEGOTIATE.perRound;
  const perRounds = Array.from(new Set([...(opts.perRounds ?? DEFAULT_PER_ROUNDS), basePerRound])).sort(
    (a, b) => a - b,
  );
  const sweep: Aggregate[] = [];
  for (const perRound of perRounds) {
    sweep.push(await runSeeds({ seeds: opts.seeds, groups: opts.groups, restaurants: opts.restaurants, perRound }));
    opts.onProgress?.(sweep.length, perRounds.length);
  }
  return {
    meta: {
      seeds: [...opts.seeds],
      groups: opts.groups,
      restaurantsPerGroup: opts.restaurants ?? 30,
      basePerRound,
      perRounds,
    },
    base: sweep.find((a) => a.perRound === basePerRound)!,
    sweep,
  };
}

/* ------------------------------------------------------------------ */
/* Markdown                                                            */
/* ------------------------------------------------------------------ */

const DIGITS: Record<Metric["format"], number> = { pct: 1, ratio: 3, count: 2 };

function fmt(x: number | null, format: Metric["format"]): string {
  if (x === null) return "-";
  return format === "pct" ? `${(x * 100).toFixed(DIGITS.pct)}%` : x.toFixed(DIGITS[format]);
}

/** "0.931 [0.924, 0.938]"; just the mean when there is no interval. */
export function formatInterval(i: Interval, format: Metric["format"]): string {
  if (i.mean === null) return "-";
  if (i.lo === null || i.hi === null) return fmt(i.mean, format);
  return `${fmt(i.mean, format)} [${fmt(i.lo, format)}, ${fmt(i.hi, format)}]`;
}

const range = (xs: readonly (number | null)[], format: Metric["format"]): string => {
  const vs = xs.filter((v): v is number => v !== null);
  return vs.length ? `${fmt(Math.min(...vs), format)} to ${fmt(Math.max(...vs), format)}` : "-";
};

const SWEEP_COLUMNS: readonly MetricKey[] = [
  "agreedGivenFeasible",
  "nashRatio",
  "maxMinRatio",
  "hitsOptimum",
  "leakedDims",
  "leakedPerPersonPerRound",
  "rounds",
];
const DIFF_COLUMNS: readonly MetricKey[] = ["nashRatio", "hitsOptimum", "leakedDims"];

/** Like formatInterval, with an explicit sign and percentage points for rates. */
export function formatDifference(i: Interval, format: Metric["format"]): string {
  const one = (x: number) => {
    const sign = x > 0 ? "+" : x < 0 ? "-" : "";
    const abs = Math.abs(x);
    return format === "pct" ? `${sign}${(abs * 100).toFixed(1)} pts` : `${sign}${abs.toFixed(DIGITS[format])}`;
  };
  if (i.mean === null) return "-";
  if (i.lo === null || i.hi === null) return one(i.mean);
  return `${one(i.mean)} [${one(i.lo)}, ${one(i.hi)}]`;
}

const metric = (key: MetricKey): Metric => METRICS.find((m) => m.key === key)!;

/** The tables of the study. Deterministic: same options, same text. */
export function studyMarkdown(report: StudyReport): string {
  const { meta, base, sweep } = report;
  const seedList =
    meta.seeds.length > 1 && meta.seeds.every((s, i) => i === 0 || s === meta.seeds[i - 1] + 1)
      ? `${meta.seeds[0]} to ${meta.seeds[meta.seeds.length - 1]}`
      : meta.seeds.join(", ");
  const lines: string[] = [];
  lines.push(
    `${meta.seeds.length} seeds (${seedList}), ${meta.groups} synthetic groups per seed, ${meta.restaurantsPerGroup} restaurants per group. ` +
      `Each seed gives one value per metric; the table reports the mean across seeds and a 95% Student-t interval (${Math.max(0, meta.seeds.length - 1)} degrees of freedom).`,
  );
  lines.push("");
  lines.push(`**Across seeds** (protocol as shipped, ${meta.basePerRound} candidates per round)`);
  lines.push("");
  lines.push("| metric | mean [95% interval] | range across seeds |");
  lines.push("|---|---:|---:|");
  for (const m of METRICS) {
    lines.push(
      `| ${m.label} | ${formatInterval(base.stats[m.key], m.format)} | ${range(
        base.seeds.map((s) => s.values[m.key]),
        m.format,
      )} |`,
    );
  }
  lines.push("");
  lines.push("**Candidates per round** (`perRound`), mean [95% interval] across the same seeds");
  lines.push("");
  lines.push(`| perRound | ${SWEEP_COLUMNS.map((k) => metric(k).label).join(" | ")} |`);
  lines.push(`|---:|${SWEEP_COLUMNS.map(() => "---:").join("|")}|`);
  for (const a of sweep) {
    const name = a.perRound === meta.basePerRound ? `${a.perRound} (shipped)` : String(a.perRound);
    lines.push(`| ${name} | ${SWEEP_COLUMNS.map((k) => formatInterval(a.stats[k], metric(k).format)).join(" | ")} |`);
  }
  const others = sweep.filter((x) => x.perRound !== meta.basePerRound);
  if (others.length && meta.seeds.length > 1) {
    lines.push("");
    lines.push(
      `**Difference from the shipped ${meta.basePerRound}**, paired by seed (each seed's value minus the same seed at ${meta.basePerRound}); an interval that excludes 0 is a difference every draw of the population supports`,
    );
    lines.push("");
    lines.push(`| perRound | ${DIFF_COLUMNS.map((k) => metric(k).label).join(" | ")} |`);
    lines.push(`|---:|${DIFF_COLUMNS.map(() => "---:").join("|")}|`);
    for (const a of others) {
      lines.push(
        `| ${a.perRound} | ${DIFF_COLUMNS.map((k) => formatDifference(pairedDifference(a, base, k), metric(k).format)).join(" | ")} |`,
      );
    }
  }
  return lines.join("\n");
}

/**
 * The LLM no-privacy baseline next to the other methods, on exactly the groups
 * that had the call. Not deterministic: it reports what one run of a model did.
 */
export function llmMarkdown(report: SimReport): string | null {
  const llm = report.overall.llm;
  const meta = report.meta.llm;
  if (!llm || !meta) return null;
  const pct = (x: number | null) => fmt(x, "pct");
  const mm = (s: { mean: number | null; median: number | null }) =>
    `${fmt(s.mean, "ratio")} / ${fmt(s.median, "ratio")}`;
  const lines: string[] = [];
  lines.push(
    `Model \`${meta.model}\`, groups ${meta.groupIds[0]} to ${meta.groupIds[meta.groupIds.length - 1]} of seed ${report.meta.seed} ` +
      `(${llm.groups} calls, ${llm.feasible} on groups the oracle could solve, ${llm.errors} failed calls counted as no plan). ` +
      `All three methods are scored on these same groups; ratios are mean / median over the feasible ones.`,
  );
  lines.push("");
  // Recount the other two methods on the same groups, so every cell of the table is like for like.
  const feasible = report.groups.filter((g) => g.llm !== undefined && g.oracle.feasibleCount > 0);
  const share = (k: number) => (feasible.length ? k / feasible.length : null);
  const optimal = (r: number | undefined) => r !== undefined && r >= 1 - 1e-12;
  const naiveMaxMin = feasible.map((g) => g.naive.maxMinRatio).filter((r): r is number => r !== undefined);
  const sorted = [...naiveMaxMin].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const naiveMaxMinStat = {
    mean: sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : null,
    median: sorted.length ? (sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2) : null,
  };
  lines.push("| method | reads preferences | feasible plan found | Nash ratio | max-min ratio | hits the optimum |");
  lines.push("|---|---|---:|---:|---:|---:|");
  lines.push(
    `| LLM, no privacy | all of them, verbatim | ${pct(llm.foundGivenFeasible)} | ${mm(llm.nashRatio)} | ${mm(llm.maxMinRatio)} | ${pct(llm.hitsOptimum)} |`,
  );
  lines.push(
    `| protocol | none | ${pct(share(feasible.filter((g) => g.protocol.found).length))} | ${mm(llm.protocolNashRatio)} | ${mm(llm.protocolMaxMinRatio)} | ${pct(llm.protocolHitsOptimum)} |`,
  );
  lines.push(
    `| naive | none | ${pct(share(feasible.filter((g) => g.naive.found).length))} | ${mm(llm.naiveNashRatio)} | ${mm(naiveMaxMinStat)} | ${pct(share(feasible.filter((g) => optimal(g.naive.nashRatio)).length))} |`,
  );
  const invalid = feasible.filter((g) => g.llm && !g.llm.found && g.llm.error === undefined).length;
  lines.push("");
  lines.push(
    `Of the ${feasible.length} solvable groups, the model's pick broke someone's hard rule or was not a real candidate in ${invalid}; those count as no plan, like a failed call.`,
  );
  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/* Document blocks                                                     */
/* ------------------------------------------------------------------ */

const startMark = (name: string) => `<!-- generated:${name}:start -->`;
const endMark = (name: string) => `<!-- generated:${name}:end -->`;

/** Replace what sits between a block's markers. Throws when the markers are missing or out of order. */
export function injectBlock(doc: string, name: string, content: string): string {
  const start = doc.indexOf(startMark(name));
  const end = doc.indexOf(endMark(name));
  if (start === -1 || end === -1 || end < start) throw new Error(`document has no "${name}" generated block`);
  return `${doc.slice(0, start + startMark(name).length)}\n\n${content.trim()}\n\n${doc.slice(end)}`;
}

export function readBlock(doc: string, name: string): string | null {
  const start = doc.indexOf(startMark(name));
  const end = doc.indexOf(endMark(name));
  if (start === -1 || end === -1 || end < start) return null;
  return doc.slice(start + startMark(name).length, end).trim();
}

/* ------------------------------------------------------------------ */
/* Chart                                                               */
/* ------------------------------------------------------------------ */

const FONT = `font-family="Helvetica Neue, Helvetica, Arial, sans-serif"`;
const INK = "#1f2430";
const MUTED = "#6b7280";
const GRID = "#e5e7eb";
const PROTO = "#2f6fed";
const f2 = (x: number) => x.toFixed(2);

function niceTicks(lo: number, hi: number, count = 4): number[] {
  const span = hi - lo || 1;
  const raw = span / count;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((k) => k * pow).find((s) => s >= raw)!;
  const ticks: number[] = [];
  for (let t = Math.ceil(lo / step) * step; t <= hi + step * 1e-9; t += step) ticks.push(Number(t.toFixed(10)));
  return ticks;
}

/**
 * Welfare against privacy cost, one point per `perRound`, with 95% intervals
 * on both axes. Two panels share the x axis (leaked names per group) because
 * the two welfare measures are on different scales: one axis per panel.
 */
export function studySvg(report: StudyReport): string {
  const W = 960;
  const H = 430;
  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" ${FONT} font-size="12" fill="${INK}">`,
  );
  parts.push(`<rect width="${W}" height="${H}" fill="#fafbfc"/>`);
  parts.push(
    `<text x="24" y="30" font-size="17" font-weight="600">Settle: what more candidates per round buy, and cost</text>`,
  );
  parts.push(
    `<text x="24" y="50" fill="${MUTED}">Mean over ${report.meta.seeds.length} seeds of ${report.meta.groups} groups; bars are 95% intervals. Each point is one perRound; ${report.meta.basePerRound} is what ships.</text>`,
  );

  const xs = report.sweep.map((a) => a.stats.leakedDims);
  const xLo = Math.min(...xs.map((i) => i.lo ?? i.mean ?? 0));
  const xHi = Math.max(...xs.map((i) => i.hi ?? i.mean ?? 0));
  const xPad = (xHi - xLo || 1) * 0.12;
  const xMin = Math.max(0, xLo - xPad);
  const xMax = xHi + xPad;

  const panel = (x0: number, title: string, key: MetricKey, yLabel: (v: number) => string) => {
    const w = 430;
    const y0 = 70;
    const h = 330;
    const left = x0 + 58;
    const right = x0 + w - 22;
    const top = y0 + 44;
    const bottom = y0 + h - 46;
    const ys = report.sweep.map((a) => a.stats[key]);
    const yLo = Math.min(...ys.map((i) => i.lo ?? i.mean ?? 0));
    const yHi = Math.max(...ys.map((i) => i.hi ?? i.mean ?? 0));
    const yPad = (yHi - yLo || 0.01) * 0.25;
    const yMin = Math.max(0, yLo - yPad);
    const yMax = Math.min(1, yHi + yPad);
    const sx = (v: number) => left + ((v - xMin) / (xMax - xMin)) * (right - left);
    const sy = (v: number) => bottom - ((v - yMin) / (yMax - yMin)) * (bottom - top);
    parts.push(`<rect x="${x0}" y="${y0}" width="${w}" height="${h}" fill="#ffffff" stroke="${GRID}"/>`);
    parts.push(`<text x="${x0 + 12}" y="${y0 + 19}" font-weight="600">${title}</text>`);
    parts.push(
      `<text x="${x0 + 12}" y="${y0 + 35}" fill="${MUTED}" font-size="11">The vertical axis is zoomed in and does not start at 0.</text>`,
    );
    for (const t of niceTicks(yMin, yMax)) {
      parts.push(`<line x1="${left}" y1="${f2(sy(t))}" x2="${right}" y2="${f2(sy(t))}" stroke="${GRID}"/>`);
      parts.push(
        `<text x="${left - 6}" y="${f2(sy(t) + 4)}" text-anchor="end" fill="${MUTED}" font-size="11">${yLabel(t)}</text>`,
      );
    }
    for (const t of niceTicks(xMin, xMax, 5)) {
      parts.push(
        `<text x="${f2(sx(t))}" y="${bottom + 16}" text-anchor="middle" fill="${MUTED}" font-size="11">${t}</text>`,
      );
    }
    parts.push(`<line x1="${left}" y1="${bottom}" x2="${right}" y2="${bottom}" stroke="${MUTED}"/>`);
    parts.push(
      `<text x="${f2((left + right) / 2)}" y="${bottom + 34}" text-anchor="middle" fill="${MUTED}" font-size="11">leaked dimension names per group (privacy cost)</text>`,
    );
    const pts = report.sweep.map((a) => ({ a, x: a.stats.leakedDims, y: a.stats[key] }));
    parts.push(
      `<polyline fill="none" stroke="${PROTO}" stroke-width="2" stroke-opacity="0.45" points="${pts
        .map((p) => `${f2(sx(p.x.mean ?? 0))},${f2(sy(p.y.mean ?? 0))}`)
        .join(" ")}"/>`,
    );
    for (const p of pts) {
      const cx = sx(p.x.mean ?? 0);
      const cy = sy(p.y.mean ?? 0);
      if (p.y.lo !== null && p.y.hi !== null)
        parts.push(
          `<line x1="${f2(cx)}" y1="${f2(sy(p.y.lo))}" x2="${f2(cx)}" y2="${f2(sy(p.y.hi))}" stroke="${PROTO}" stroke-width="1.5"/>`,
        );
      if (p.x.lo !== null && p.x.hi !== null)
        parts.push(
          `<line x1="${f2(sx(p.x.lo))}" y1="${f2(cy)}" x2="${f2(sx(p.x.hi))}" y2="${f2(cy)}" stroke="${PROTO}" stroke-width="1.5"/>`,
        );
      const shipped = p.a.perRound === report.meta.basePerRound;
      parts.push(
        `<circle cx="${f2(cx)}" cy="${f2(cy)}" r="5" fill="${shipped ? PROTO : "#ffffff"}" stroke="${PROTO}" stroke-width="2"><title>perRound ${p.a.perRound}: ${yLabel(p.y.mean ?? 0)}, ${(p.x.mean ?? 0).toFixed(1)} leaked names</title></circle>`,
      );
      parts.push(
        `<text x="${f2(cx + 9)}" y="${f2(cy + 15)}" font-size="11" fill="${INK}">${p.a.perRound}${shipped ? " (shipped)" : ""}</text>`,
      );
    }
  };

  panel(24, "(a) Nash ratio (1.0 = the oracle's plan)", "nashRatio", (v) => v.toFixed(3));
  panel(506, "(b) Share of feasible groups that end on the optimum", "hitsOptimum", (v) => `${(v * 100).toFixed(0)}%`);
  parts.push(`</svg>`);
  return parts.join("\n");
}
