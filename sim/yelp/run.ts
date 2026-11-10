import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { FILES } from "./dataset";
import { loadCity, missingFiles } from "./load";
import { runYelp } from "./pipeline";
import { toMarkdown, toStdout } from "./report";

/**
 * CLI: `tsx sim/yelp/run.ts --data DIR [--city Philadelphia] [--groups 200] [--seed 1] [--restaurants 30] [--out sim/out/yelp]`
 * Reads the Yelp Open Dataset from --data (see sim/yelp/README.md) and writes
 * report.json and report.md into --out.
 */

type Args = { data: string; city: string; groups: number; seed: number; restaurants: number; out: string };

const USAGE =
  "usage: tsx sim/yelp/run.ts --data DIR [--city NAME] [--groups N] [--seed S] [--restaurants R] [--out DIR]\n" +
  `  --data DIR   folder holding ${Object.values(FILES).join(", ")}`;

function parseArgs(argv: string[]): Args {
  const opts: Args = { data: "", city: "Philadelphia", groups: 200, seed: 1, restaurants: 30, out: "sim/out/yelp" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`missing value for ${a}`);
      return v;
    };
    if (a === "--data") opts.data = next();
    else if (a === "--city") opts.city = next();
    else if (a === "--groups") opts.groups = Number(next());
    else if (a === "--seed") opts.seed = Number(next());
    else if (a === "--restaurants") opts.restaurants = Number(next());
    else if (a === "--out") opts.out = next();
    else if (a === "--help" || a === "-h") {
      console.log(USAGE);
      process.exit(0);
    } else throw new Error(`unknown argument ${a}`);
  }
  if (!opts.data) throw new Error(`--data is required\n${USAGE}`);
  if (!Number.isFinite(opts.groups) || opts.groups <= 0) throw new Error("--groups must be a positive number");
  if (!Number.isFinite(opts.seed)) throw new Error("--seed must be a number");
  if (!Number.isFinite(opts.restaurants) || opts.restaurants <= 0)
    throw new Error("--restaurants must be a positive number");
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const dir = resolve(opts.data);
  const missing = missingFiles(dir);
  if (missing.length)
    throw new Error(`not found in ${dir}: ${missing.join(", ")}\nSee sim/yelp/README.md for where to get the dataset.`);

  const started = Date.now();
  const input = await loadCity(dir, opts.city, (m) => console.log(`  ${m}`));
  if (input.restaurants.size === 0)
    throw new Error(`no restaurants found for city "${opts.city}"; the name must match the dataset's "city" field`);
  const report = await runYelp(input, { groups: opts.groups, seed: opts.seed, restaurants: opts.restaurants });
  report.meta.generatedAt = new Date().toISOString();

  const outDir = resolve(opts.out);
  mkdirSync(outDir, { recursive: true });
  const files = { json: join(outDir, "report.json"), md: join(outDir, "report.md") };
  writeFileSync(files.json, JSON.stringify(report, null, 2));
  writeFileSync(files.md, toMarkdown(report));
  console.log("");
  console.log(toStdout(report));
  console.log("");
  console.log(`wrote ${files.json}\n      ${files.md}  (${Date.now() - started} ms)`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
