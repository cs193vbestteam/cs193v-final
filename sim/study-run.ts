import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DEFAULT_LLM_CONCURRENCY, DEFAULT_LLM_GROUPS, runSim } from "./pipeline";
import { toMarkdown, toSvg } from "./report";
import {
  DEFAULT_PER_ROUNDS,
  DEFAULT_SEEDS,
  injectBlock,
  llmMarkdown,
  runStudy,
  studyMarkdown,
  studySvg,
} from "./study";

/**
 * `npm run sim:study`: the one command behind every number in docs/evaluation.md.
 *
 *   1. the single-seed report (same as `npm run sim`)      → sim/out/report.{json,md,svg}
 *   2. the multi-seed study and the perRound sweep          → sim/out/study.{json,md}, docs/evaluation-sweep.svg
 *   3. with --llm-baseline and ANTHROPIC_API_KEY, the LLM   → the "llm" block of the document
 *      no-privacy baseline on the first --llm-groups groups
 *
 * Steps 1 and 2 are deterministic and rewrite the "study" block of the
 * document. Step 3 calls a model, so its numbers belong to one run; without
 * the flag (or the key) the "llm" block is left exactly as it is.
 *
 * `--check` writes nothing and exits 1 if the document's "study" block is stale.
 */

type Args = {
  seeds: number[];
  groups: number;
  perRounds: number[];
  out: string;
  doc: string;
  chart: string;
  llmBaseline: boolean;
  llmGroups: number;
  check: boolean;
};

const numbers = (v: string, flag: string): number[] => {
  const xs = v.split(",").map(Number);
  if (xs.length === 0 || xs.some((x) => !Number.isInteger(x) || x <= 0))
    throw new Error(`${flag} takes positive integers separated by commas`);
  return xs;
};

function parseArgs(argv: string[]): Args {
  const opts: Args = {
    seeds: [...DEFAULT_SEEDS],
    groups: 200,
    perRounds: [...DEFAULT_PER_ROUNDS],
    out: "sim/out",
    doc: "docs/evaluation.md",
    chart: "docs/evaluation-sweep.svg",
    llmBaseline: false,
    llmGroups: DEFAULT_LLM_GROUPS,
    check: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`missing value for ${a}`);
      return v;
    };
    if (a === "--seeds") opts.seeds = numbers(next(), a);
    else if (a === "--groups") opts.groups = numbers(next(), a)[0];
    else if (a === "--per-round") opts.perRounds = numbers(next(), a);
    else if (a === "--out") opts.out = next();
    else if (a === "--doc") opts.doc = next();
    else if (a === "--chart") opts.chart = next();
    else if (a === "--llm-baseline") opts.llmBaseline = true;
    else if (a === "--llm-groups") opts.llmGroups = numbers(next(), a)[0];
    else if (a === "--check") opts.check = true;
    else if (a === "--help" || a === "-h") {
      console.log(
        "usage: tsx sim/study-run.ts [--seeds 1,2,...] [--groups N] [--per-round 3,5,8,10] [--llm-baseline] [--llm-groups N] [--check]",
      );
      process.exit(0);
    } else throw new Error(`unknown argument ${a}`);
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const started = Date.now();
  const docPath = resolve(opts.doc);

  console.log(
    `study: ${opts.seeds.length} seeds x ${opts.groups} groups, perRound ${opts.perRounds.join(", ")} (deterministic)`,
  );
  const study = await runStudy({
    seeds: opts.seeds,
    groups: opts.groups,
    perRounds: opts.perRounds,
    onProgress: (done, total) => console.log(`  perRound ${done}/${total}`),
  });
  const studyMd = studyMarkdown(study);

  if (opts.check) {
    const current = existsSync(docPath) ? readFileSync(docPath, "utf8") : "";
    if (injectBlock(current, "study", studyMd) !== current) {
      console.error(`${opts.doc} is stale: run \`npm run sim:study\` and commit the result`);
      process.exit(1);
    }
    console.log(`${opts.doc}: study block is up to date`);
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  const withLlm = opts.llmBaseline && Boolean(apiKey);
  if (opts.llmBaseline && !apiKey)
    console.log(
      "note: --llm-baseline ignored, ANTHROPIC_API_KEY is not set; the document's LLM block is left as it is",
    );
  const llmGroups = Math.min(opts.llmGroups, opts.groups);
  if (withLlm)
    console.log(`LLM baseline: ${llmGroups} calls on seed ${opts.seeds[0]}, ${DEFAULT_LLM_CONCURRENCY} in flight`);
  const single = await runSim({
    groups: opts.groups,
    seed: opts.seeds[0],
    llm: withLlm
      ? {
          apiKey: apiKey!,
          groups: llmGroups,
          concurrency: DEFAULT_LLM_CONCURRENCY,
          onProgress: (done, total) => {
            if (done === total || done % 10 === 0) console.log(`  llm ${done}/${total}`);
          },
        }
      : undefined,
  });
  single.meta.generatedAt = new Date().toISOString();

  const outDir = resolve(opts.out);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "report.json"), JSON.stringify(single, null, 2));
  writeFileSync(join(outDir, "report.md"), toMarkdown(single));
  writeFileSync(join(outDir, "report.svg"), toSvg(single));
  writeFileSync(join(outDir, "study.json"), JSON.stringify(study, null, 2));
  writeFileSync(join(outDir, "study.md"), `${studyMd}\n`);
  writeFileSync(resolve(opts.chart), `${studySvg(study)}\n`);

  let doc = injectBlock(readFileSync(docPath, "utf8"), "study", studyMd);
  const llmMd = llmMarkdown(single);
  if (llmMd) doc = injectBlock(doc, "llm", llmMd);
  writeFileSync(docPath, doc);

  console.log("");
  console.log(studyMd);
  if (llmMd) console.log(`\n${llmMd}`);
  console.log("");
  console.log(
    `wrote ${opts.out}/report.{json,md,svg}, ${opts.out}/study.{json,md}, ${opts.chart} and the generated blocks of ${opts.doc}  (${Date.now() - started} ms)`,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
