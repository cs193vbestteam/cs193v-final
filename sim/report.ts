import type { Stat, Summary } from "./metrics";
import type { SimReport } from "./pipeline";

/**
 * Renderers for the simulation report: Markdown table, stdout table and a
 * hand-written SVG with two panels. No chart libraries, no dependencies.
 */

const pct = (x: number | null | undefined, digits = 0): string => (x === null || x === undefined ? "-" : `${(x * 100).toFixed(digits)}%`);
const num = (x: number | null | undefined, digits = 3): string => (x === null || x === undefined ? "-" : x.toFixed(digits));
const meanMedian = (s: Stat): string => (s.n === 0 ? "-" : `${num(s.mean)} / ${num(s.median)}`);

export function toMarkdown(report: SimReport): string {
  const { meta, overall, bySize } = report;
  const rows = [overall, ...bySize];
  const lines: string[] = [];
  lines.push(`# Tacit simulation report`);
  lines.push("");
  lines.push(
    `${meta.groups} synthetic groups, seed ${meta.seed}, fresh pool of ${meta.restaurantsPerGroup} restaurants per group, group size ${meta.sizeRange[0]}..${meta.sizeRange[1]}. ` +
      `Protocol: ${meta.negotiate.maxRounds} rounds x ${meta.negotiate.perRound} candidates, concessions from round ${meta.negotiate.concessionFrom}, ${meta.negotiate.finalists} finalists.`,
  );
  lines.push("");
  lines.push("Ratios are relative to the oracle optimum (1.0 = as good as a planner who reads every preference). `mean / median` over groups where the oracle found a feasible plan.");
  lines.push("");
  const hasLlm = overall.llm !== undefined;
  const llmCols = hasLlm ? " Nash ratio LLM (no privacy) | max-min ratio LLM (no privacy) | LLM hits optimum |" : "";
  const llmAlign = hasLlm ? "---:|---:|---:|" : "";
  lines.push(`| group | n | agreed | any plan | oracle feasible | agreed given feasible | plan given feasible | Nash ratio protocol | Nash ratio naive |${llmCols} max-min ratio protocol | max-min ratio naive | hits optimum | leaked dims (mean) | leaked / person / round |`);
  lines.push(`|---|---:|---:|---:|---:|---:|---:|---:|---:|${llmAlign}---:|---:|---:|---:|---:|`);
  for (const s of rows) {
    const llmCells = hasLlm ? ` ${s.llm ? meanMedian(s.llm.nashRatio) : "-"} | ${s.llm ? meanMedian(s.llm.maxMinRatio) : "-"} | ${s.llm ? pct(s.llm.hitsOptimum) : "-"} |` : "";
    lines.push(
      `| ${s.label} | ${s.groups} | ${pct(s.convergenceRate)} | ${pct(s.anyPlanRate)} | ${pct(s.oracleFeasibleRate)} | ${pct(s.convergenceGivenFeasible)} | ${pct(s.anyPlanGivenFeasible)} | ` +
        `${meanMedian(s.protocolNashRatio)} | ${meanMedian(s.naiveNashRatio)} |${llmCells} ${meanMedian(s.protocolMaxMinRatio)} | ${meanMedian(s.naiveMaxMinRatio)} | ${pct(s.protocolHitsOptimum)} | ` +
        `${num(s.leakedDims.mean, 1)} | ${num(s.leakedPerPersonPerRound.mean, 2)} |`,
    );
  }
  if (hasLlm) {
    lines.push("");
    lines.push("The LLM columns cover only the groups listed under \"LLM baseline\" below; the LLM section compares all methods on exactly those groups.");
  }
  lines.push("");
  lines.push("## Outcomes");
  lines.push("");
  lines.push("| group | agreed | compromise | no deal | rounds run (mean / median) |");
  lines.push("|---|---:|---:|---:|---:|");
  for (const s of rows) {
    lines.push(`| ${s.label} | ${s.statusCounts.agreed} | ${s.statusCounts.compromise} | ${s.statusCounts.no_deal} | ${num(s.roundsAll.mean, 2)} / ${num(s.roundsAll.median, 1)} |`);
  }
  lines.push("");
  lines.push("## Rounds to agreement (agreed groups only)");
  lines.push("");
  const maxRounds = meta.negotiate.maxRounds;
  const header = Array.from({ length: maxRounds }, (_, i) => `r${i + 1}`);
  lines.push(`| group | ${header.join(" | ")} |`);
  lines.push(`|---|${header.map(() => "---:").join("|")}|`);
  for (const s of rows) {
    lines.push(`| ${s.label} | ${header.map((_, i) => s.roundsHistogram[String(i + 1)] ?? 0).join(" | ")} |`);
  }
  lines.push("");
  lines.push("## Privacy budget");
  lines.push("");
  lines.push("| group | leakedDims reported (mean) | dims agents actually returned (mean) |");
  lines.push("|---|---:|---:|");
  for (const s of rows) lines.push(`| ${s.label} | ${num(s.leakedDims.mean, 2)} | ${num(s.observedDims.mean, 2)} |`);
  if (meta.llm && overall.llm) {
    lines.push("");
    lines.push("## LLM baseline (no privacy)");
    lines.push("");
    lines.push(
      `Model \`${meta.llm.model}\` was given every member's preference JSON and the full candidate list and asked for one plan, on ${meta.llm.groupsRequested} of ${meta.groups} groups ` +
        `(ids ${describeIds(meta.llm.groupIds)}), ${meta.llm.concurrency} requests in flight, ${meta.llm.timeoutMs} ms timeout per call. ` +
        `A pick that violates someone's hard rule, or is not a real candidate, counts as no plan. Calls that failed: ${overall.llm.errors}.`,
    );
    lines.push("");
    lines.push("All three methods on exactly these groups (ratios over the groups where the oracle found a feasible plan):");
    lines.push("");
    lines.push("| group | n (LLM) | oracle feasible | LLM plan given feasible | Nash ratio LLM | Nash ratio protocol | Nash ratio naive | max-min ratio LLM | max-min ratio protocol | LLM hits optimum | protocol hits optimum |");
    lines.push("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
    for (const s of rows) {
      const l = s.llm;
      if (!l) continue;
      lines.push(
        `| ${s.label} | ${l.groups} | ${l.feasible} | ${pct(l.foundGivenFeasible)} | ${meanMedian(l.nashRatio)} | ${meanMedian(l.protocolNashRatio)} | ${meanMedian(l.naiveNashRatio)} | ` +
          `${meanMedian(l.maxMinRatio)} | ${meanMedian(l.protocolMaxMinRatio)} | ${pct(l.hitsOptimum)} | ${pct(l.protocolHitsOptimum)} |`,
      );
    }
  }
  lines.push("");
  lines.push("See report.svg for the chart and report.json for every group.");
  return lines.join("\n") + "\n";
}

/** "0..39" for a contiguous run, otherwise the list (abbreviated when long). */
function describeIds(ids: readonly number[]): string {
  if (ids.length === 0) return "none";
  const sorted = [...ids].sort((a, b) => a - b);
  const contiguous = sorted.every((v, i) => i === 0 || v === sorted[i - 1] + 1);
  if (contiguous) return sorted.length === 1 ? String(sorted[0]) : `${sorted[0]}..${sorted[sorted.length - 1]}`;
  return sorted.length <= 20 ? sorted.join(", ") : `${sorted.slice(0, 20).join(", ")}, ... (${sorted.length} total)`;
}

/** Compact fixed-width table for the terminal. */
export function toStdout(report: SimReport): string {
  const rows = [report.overall, ...report.bySize];
  const hasLlm = report.overall.llm !== undefined;
  const cols: [string, (s: Summary) => string][] = [
    ["group", (s) => s.label],
    ["n", (s) => String(s.groups)],
    ["agreed", (s) => pct(s.convergenceRate)],
    ["anyPlan", (s) => pct(s.anyPlanRate)],
    ["oracleOK", (s) => pct(s.oracleFeasibleRate)],
    ["agreed|OK", (s) => pct(s.convergenceGivenFeasible)],
    ["nashP", (s) => meanMedian(s.protocolNashRatio)],
    ["nashNaive", (s) => meanMedian(s.naiveNashRatio)],
    ...(hasLlm ? ([["nashLLM", (s) => (s.llm ? meanMedian(s.llm.nashRatio) : "-")]] as [string, (s: Summary) => string][]) : []),
    ["maxminP", (s) => meanMedian(s.protocolMaxMinRatio)],
    ["maxminNaive", (s) => meanMedian(s.naiveMaxMinRatio)],
    ["optimum", (s) => pct(s.protocolHitsOptimum)],
    ["leaked", (s) => num(s.leakedDims.mean, 1)],
    ["leak/p/r", (s) => num(s.leakedPerPersonPerRound.mean, 2)],
  ];
  const cells = rows.map((s) => cols.map(([, f]) => f(s)));
  const widths = cols.map(([h], i) => Math.max(h.length, ...cells.map((c) => c[i].length)));
  const fmt = (c: string[]) => c.map((x, i) => x.padEnd(widths[i])).join("  ");
  const out = [fmt(cols.map(([h]) => h)), fmt(widths.map((w) => "-".repeat(w))), ...cells.map(fmt)];
  const hist = Array.from({ length: report.meta.negotiate.maxRounds }, (_, i) => `r${i + 1}=${report.overall.roundsHistogram[String(i + 1)] ?? 0}`).join("  ");
  out.push("");
  out.push(`rounds to agreement (all groups): ${hist}  | compromise=${report.overall.statusCounts.compromise}  no_deal=${report.overall.statusCounts.no_deal}`);
  if (report.meta.llm && report.overall.llm) {
    const l = report.overall.llm;
    out.push(
      `LLM baseline (no privacy, ${report.meta.llm.model}) on ${l.groups} groups (ids ${describeIds(report.meta.llm.groupIds)}): ` +
        `nash LLM ${meanMedian(l.nashRatio)} vs protocol ${meanMedian(l.protocolNashRatio)} on the same groups; ` +
        `LLM hits optimum ${pct(l.hitsOptimum)} vs protocol ${pct(l.protocolHitsOptimum)}; errors ${l.errors}`,
    );
  }
  return out.join("\n");
}

/* ------------------------------------------------------------------ */
/* SVG                                                                 */
/* ------------------------------------------------------------------ */

const FONT = `font-family="Helvetica Neue, Helvetica, Arial, sans-serif"`;
const INK = "#1f2430";
const MUTED = "#6b7280";
const GRID = "#e5e7eb";
const NAIVE = "#b8c4d6";
const PROTO = "#2f6fed";
const LLM = "#7c3aed";
const ORACLE = "#d9480f";
const COMPROMISE = "#f5b84a";
const NODEAL = "#c0392b";

const f2 = (x: number) => x.toFixed(2);

export function toSvg(report: SimReport): string {
  const W = 960;
  const H = 440;
  const panelTop = 70;
  const panelH = 300;
  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" ${FONT} font-size="12" fill="${INK}">`);
  parts.push(`<rect width="${W}" height="${H}" fill="#fafbfc"/>`);
  parts.push(`<text x="24" y="30" font-size="17" font-weight="600">Tacit: privacy-preserving negotiation vs oracle</text>`);
  parts.push(
    `<text x="24" y="50" fill="${MUTED}">${report.meta.groups} synthetic groups, seed ${report.meta.seed}, ${report.meta.restaurantsPerGroup} restaurants per group. ` +
      `Agreed ${(report.overall.convergenceRate * 100).toFixed(0)}%, oracle feasible ${(report.overall.oracleFeasibleRate * 100).toFixed(0)}%.</text>`,
  );

  // ---- Panel (a): mean Nash ratio by group size -----------------------------
  {
    const x0 = 60;
    const w = 400;
    const y0 = panelTop;
    const h = panelH;
    const plotLeft = x0 + 40;
    const plotRight = x0 + w - 10;
    const plotTop = y0 + 56;
    const plotBottom = y0 + h - 40;
    const sy = (v: number) => plotBottom - v * (plotBottom - plotTop);
    parts.push(`<rect x="${x0}" y="${y0}" width="${w}" height="${h}" fill="#ffffff" stroke="${GRID}"/>`);
    parts.push(`<text x="${x0 + 12}" y="${y0 + 19}" font-weight="600">(a) Mean Nash ratio by group size</text>`);
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      const y = sy(t);
      parts.push(`<line x1="${plotLeft}" y1="${f2(y)}" x2="${plotRight}" y2="${f2(y)}" stroke="${GRID}"/>`);
      parts.push(`<text x="${plotLeft - 6}" y="${f2(y + 4)}" text-anchor="end" fill="${MUTED}" font-size="11">${t.toFixed(2)}</text>`);
    }
    parts.push(`<line x1="${plotLeft}" y1="${f2(sy(1))}" x2="${plotRight}" y2="${f2(sy(1))}" stroke="${ORACLE}" stroke-width="1.5" stroke-dasharray="6 4"/>`);
    parts.push(`<text x="${plotRight - 4}" y="${f2(sy(1) - 6)}" text-anchor="end" fill="${ORACLE}" font-size="11">oracle = 1.0</text>`);
    const sizes = report.bySize;
    const hasLlm = report.overall.llm !== undefined;
    const nBars = hasLlm ? 3 : 2;
    const slot = (plotRight - plotLeft) / Math.max(1, sizes.length);
    const barW = Math.min(36, (slot * 0.64) / nBars);
    const gap = 6;
    sizes.forEach((s, i) => {
      const cx = plotLeft + slot * (i + 0.5);
      const bars: [number | null, string, string][] = [
        [s.naiveNashRatio.mean, NAIVE, "naive"],
        [s.protocolNashRatio.mean, PROTO, "protocol"],
      ];
      if (hasLlm) bars.push([s.llm ? s.llm.nashRatio.mean : null, LLM, "llm"]);
      const groupW = nBars * barW + (nBars - 1) * gap;
      bars.forEach(([v, color], j) => {
        const bx = cx - groupW / 2 + j * (barW + gap);
        const val = v ?? 0;
        const by = sy(val);
        parts.push(`<rect x="${f2(bx)}" y="${f2(by)}" width="${f2(barW)}" height="${f2(plotBottom - by)}" fill="${color}" rx="2"/>`);
        parts.push(`<text x="${f2(bx + barW / 2)}" y="${f2(by - 4)}" text-anchor="middle" font-size="10" fill="${INK}">${v === null ? "n/a" : val.toFixed(2)}</text>`);
      });
      parts.push(`<text x="${f2(cx)}" y="${plotBottom + 16}" text-anchor="middle" fill="${INK}">${s.label.replace("size ", "")} people</text>`);
      parts.push(`<text x="${f2(cx)}" y="${plotBottom + 29}" text-anchor="middle" fill="${MUTED}" font-size="10">n=${s.groups}</text>`);
    });
    parts.push(`<line x1="${plotLeft}" y1="${plotTop}" x2="${plotLeft}" y2="${plotBottom}" stroke="${MUTED}"/>`);
    parts.push(`<line x1="${plotLeft}" y1="${plotBottom}" x2="${plotRight}" y2="${plotBottom}" stroke="${MUTED}"/>`);
    parts.push(`<text transform="translate(${x0 + 12}, ${f2((plotTop + plotBottom) / 2)}) rotate(-90)" text-anchor="middle" fill="${MUTED}" font-size="11">Nash ratio (chosen / oracle best)</text>`);
    // legend, in its own row between the title and the plot
    const lx = plotLeft;
    const ly = y0 + 30;
    parts.push(`<rect x="${lx}" y="${ly}" width="12" height="12" fill="${NAIVE}" rx="2"/><text x="${lx + 17}" y="${ly + 10}" font-size="11">naive (round-1 vote)</text>`);
    parts.push(`<rect x="${lx + 130}" y="${ly}" width="12" height="12" fill="${PROTO}" rx="2"/><text x="${lx + 147}" y="${ly + 10}" font-size="11">protocol</text>`);
    if (hasLlm) parts.push(`<rect x="${lx + 200}" y="${ly}" width="12" height="12" fill="${LLM}" rx="2"/><text x="${lx + 217}" y="${ly + 10}" font-size="11">LLM (no privacy)</text>`);
  }

  // ---- Panel (b): convergence by round --------------------------------------
  {
    const x0 = 500;
    const w = 430;
    const y0 = panelTop;
    const h = panelH;
    const plotLeft = x0 + 46;
    const plotRight = x0 + w - 10;
    const plotTop = y0 + 30;
    const plotBottom = y0 + h - 40;
    const maxRounds = report.meta.negotiate.maxRounds;
    const counts: { label: string; v: number; color: string }[] = [];
    for (let r = 1; r <= maxRounds; r++) counts.push({ label: `r${r}`, v: report.overall.roundsHistogram[String(r)] ?? 0, color: PROTO });
    counts.push({ label: "comp.", v: report.overall.statusCounts.compromise, color: COMPROMISE });
    counts.push({ label: "no deal", v: report.overall.statusCounts.no_deal, color: NODEAL });
    const maxV = Math.max(1, ...counts.map((c) => c.v));
    const step = niceStep(maxV);
    const yMax = Math.ceil(maxV / step) * step;
    const sy = (v: number) => plotBottom - (v / yMax) * (plotBottom - plotTop);
    parts.push(`<rect x="${x0}" y="${y0}" width="${w}" height="${h}" fill="#ffffff" stroke="${GRID}"/>`);
    parts.push(`<text x="${x0 + 12}" y="${y0 + 19}" font-weight="600">(b) Rounds to agreement</text>`);
    for (let t = 0; t <= yMax; t += step) {
      const y = sy(t);
      parts.push(`<line x1="${plotLeft}" y1="${f2(y)}" x2="${plotRight}" y2="${f2(y)}" stroke="${GRID}"/>`);
      parts.push(`<text x="${plotLeft - 6}" y="${f2(y + 4)}" text-anchor="end" fill="${MUTED}" font-size="11">${t}</text>`);
    }
    const slot = (plotRight - plotLeft) / counts.length;
    const barW = Math.min(40, slot * 0.64);
    counts.forEach((c, i) => {
      const cx = plotLeft + slot * (i + 0.5);
      const by = sy(c.v);
      parts.push(`<rect x="${f2(cx - barW / 2)}" y="${f2(by)}" width="${f2(barW)}" height="${f2(plotBottom - by)}" fill="${c.color}" rx="2"/>`);
      parts.push(`<text x="${f2(cx)}" y="${f2(by - 4)}" text-anchor="middle" font-size="10">${c.v}</text>`);
      parts.push(`<text x="${f2(cx)}" y="${plotBottom + 16}" text-anchor="middle">${c.label}</text>`);
    });
    parts.push(`<line x1="${plotLeft}" y1="${plotTop}" x2="${plotLeft}" y2="${plotBottom}" stroke="${MUTED}"/>`);
    parts.push(`<line x1="${plotLeft}" y1="${plotBottom}" x2="${plotRight}" y2="${plotBottom}" stroke="${MUTED}"/>`);
    parts.push(`<text transform="translate(${x0 + 14}, ${f2((plotTop + plotBottom) / 2)}) rotate(-90)" text-anchor="middle" fill="${MUTED}" font-size="11">groups</text>`);
    parts.push(`<text x="${f2((plotLeft + plotRight) / 2)}" y="${plotBottom + 31}" text-anchor="middle" fill="${MUTED}" font-size="11">round of unanimous accept; comp. = compromise, no deal = no feasible plan</text>`);
  }

  parts.push(`<text x="24" y="${H - 30}" fill="${MUTED}" font-size="11">Nash ratio = product of true utilities of the chosen plan / best product over all feasible (restaurant, slot) pairs.</text>`);
  const llmNote = report.meta.llm ? ` LLM (no privacy) = ${report.meta.llm.model} reading every preference, on ${report.meta.llm.groupsRequested} groups only.` : "";
  parts.push(`<text x="24" y="${H - 14}" fill="${MUTED}" font-size="11">Groups with no feasible plan are excluded from the ratios. Naive = the round-1 candidate with the most accepts, taken as-is.${llmNote}</text>`);
  parts.push(`</svg>`);
  return parts.join("\n") + "\n";
}

function niceStep(maxV: number): number {
  const raw = maxV / 5;
  const mag = Math.pow(10, Math.floor(Math.log10(Math.max(1, raw))));
  for (const m of [1, 2, 5, 10]) if (m * mag >= raw) return m * mag;
  return 10 * mag;
}
