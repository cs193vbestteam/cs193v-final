import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DEFAULT_LLM_CONCURRENCY, DEFAULT_LLM_GROUPS, runSim, type SimOptions } from "./pipeline";
import { toMarkdown, toStdout, toSvg } from "./report";

/**
 * CLI: `tsx sim/run.ts --groups 200 --seed 1 --out sim/out [--llm-baseline [--llm-groups 40]]`
 * Writes report.json, report.md and report.svg into --out and prints the summary table.
 *
 * `--llm-baseline` adds the no-privacy LLM baseline (sim/llm-baseline.ts) on the
 * first --llm-groups groups. It needs ANTHROPIC_API_KEY; without it the flag is
 * noted and ignored, so the report stays the deterministic one.
 */

type Args = { groups: number; seed: number; out: string; restaurants: number; llmBaseline: boolean; llmGroups: number };

function parseArgs(argv: string[]): Args {
  const opts: Args = { groups: 200, seed: 1, out: "sim/out", restaurants: 30, llmBaseline: false, llmGroups: DEFAULT_LLM_GROUPS };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`missing value for ${a}`);
      return v;
    };
    if (a === "--groups") opts.groups = Number(next());
    else if (a === "--seed") opts.seed = Number(next());
    else if (a === "--out") opts.out = next();
    else if (a === "--restaurants") opts.restaurants = Number(next());
    else if (a === "--llm-baseline") opts.llmBaseline = true;
    else if (a === "--llm-groups") opts.llmGroups = Number(next());
    else if (a === "--help" || a === "-h") {
      console.log("usage: tsx sim/run.ts [--groups N] [--seed S] [--out DIR] [--restaurants R] [--llm-baseline] [--llm-groups N]");
      console.log("  --llm-baseline   also run the no-privacy LLM baseline (needs ANTHROPIC_API_KEY; model from ANTHROPIC_MODEL)");
      console.log(`  --llm-groups N   cap how many groups (ids 0..N-1) get the LLM call (default ${DEFAULT_LLM_GROUPS})`);
      process.exit(0);
    } else throw new Error(`unknown argument ${a}`);
  }
  if (!Number.isFinite(opts.groups) || opts.groups <= 0) throw new Error("--groups must be a positive number");
  if (!Number.isFinite(opts.seed)) throw new Error("--seed must be a number");
  if (!Number.isFinite(opts.llmGroups) || opts.llmGroups < 0) throw new Error("--llm-groups must be a non-negative number");
  return opts;
}

/** The LLM part of the options, or undefined with a one-line note when it cannot run. */
function llmOptions(opts: Args): SimOptions["llm"] {
  if (!opts.llmBaseline) return undefined;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.log("note: --llm-baseline ignored, ANTHROPIC_API_KEY is not set; continuing without the LLM baseline");
    return undefined;
  }
  const groups = Math.min(opts.llmGroups, opts.groups);
  console.log(`LLM baseline: ${process.env.ANTHROPIC_MODEL || "claude-haiku-5-5"} on groups 0..${groups - 1} (${groups} calls, ${DEFAULT_LLM_CONCURRENCY} in flight)`);
  return {
    apiKey,
    groups,
    concurrency: DEFAULT_LLM_CONCURRENCY,
    onProgress: (done, total) => {
      if (done === total || done % 10 === 0) console.log(`  llm ${done}/${total}`);
    },
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const started = Date.now();
  const report = await runSim({ groups: opts.groups, seed: opts.seed, restaurants: opts.restaurants, llm: llmOptions(opts) });
  report.meta.generatedAt = new Date().toISOString();
  const outDir = resolve(opts.out);
  mkdirSync(outDir, { recursive: true });
  const files = {
    json: join(outDir, "report.json"),
    md: join(outDir, "report.md"),
    svg: join(outDir, "report.svg"),
  };
  writeFileSync(files.json, JSON.stringify(report, null, 2));
  writeFileSync(files.md, toMarkdown(report));
  writeFileSync(files.svg, toSvg(report));
  console.log(toStdout(report));
  console.log("");
  console.log(`wrote ${files.json}\n      ${files.md}\n      ${files.svg}  (${Date.now() - started} ms)`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
