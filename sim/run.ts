import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runSim } from "./pipeline";
import { toMarkdown, toStdout, toSvg } from "./report";

/**
 * CLI: `tsx sim/run.ts --groups 200 --seed 1 --out sim/out`
 * Writes report.json, report.md and report.svg into --out and prints the summary table.
 */

function parseArgs(argv: string[]): { groups: number; seed: number; out: string; restaurants: number } {
  const opts = { groups: 200, seed: 1, out: "sim/out", restaurants: 30 };
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
    else if (a === "--help" || a === "-h") {
      console.log("usage: tsx sim/run.ts [--groups N] [--seed S] [--out DIR] [--restaurants R]");
      process.exit(0);
    } else throw new Error(`unknown argument ${a}`);
  }
  if (!Number.isFinite(opts.groups) || opts.groups <= 0) throw new Error("--groups must be a positive number");
  if (!Number.isFinite(opts.seed)) throw new Error("--seed must be a number");
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const started = Date.now();
  const report = await runSim({ groups: opts.groups, seed: opts.seed, restaurants: opts.restaurants });
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
