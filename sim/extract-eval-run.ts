import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { llmExtractor, loadCases, rulesExtractor, runSuite, toMarkdown, type ExtractorReport } from "./extract-eval";

/**
 * CLI: `npm run sim:extract [-- --llm] [--out sim/out/extract]`
 *
 * Replays tests/fixtures/extract-cases.json through the rule-based extractor
 * and, with --llm, through the model as well. Writes report.json and report.md
 * into --out and prints the table. Exits 1 if any violation was found.
 *
 * --llm needs ANTHROPIC_API_KEY (read from the environment or .env.local);
 * without it the flag is noted and ignored, so the run stays the deterministic
 * one. The model comes from ANTHROPIC_MODEL, as in the app. One call per user
 * message: about 70 calls for the whole suite.
 */

function parseArgs(argv: string[]): { llm: boolean; out: string } {
  const opts = { llm: false, out: "sim/out/extract" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--llm") opts.llm = true;
    else if (a === "--out") {
      const v = argv[++i];
      if (v === undefined) throw new Error("missing value for --out");
      opts.out = v;
    } else if (a === "--help" || a === "-h") {
      console.log("usage: npm run sim:extract [-- --llm] [--out DIR]");
      console.log("  --llm   also run the LLM extractor (needs ANTHROPIC_API_KEY; model from ANTHROPIC_MODEL)");
      process.exit(0);
    } else throw new Error(`unknown argument ${a}`);
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const cases = loadCases();
  const reports: ExtractorReport[] = [];

  // The rule-based run must not touch the network even when a key is present.
  reports.push(await runSuite("rules", cases, rulesExtractor));

  if (opts.llm) {
    if (!process.env.ANTHROPIC_API_KEY) {
      console.log("note: --llm ignored, ANTHROPIC_API_KEY is not set; reporting the rule-based extractor only");
    } else {
      const model = process.env.ANTHROPIC_MODEL || "claude-haiku-5-5";
      const turns = cases.reduce((n, c) => n + c.turns.length, 0);
      console.log(`LLM extractor: ${model}, ${turns} calls`);
      // A failed call is logged by extract() and answered by the rules; the report counts those turns.
      const report = await runSuite(`llm (${model})`, cases, llmExtractor);
      reports.push(report);
      if (report.ruleTurns > 0)
        console.log(
          `note: ${report.ruleTurns} of ${report.turns} turns fell back to the rule-based extractor, so the llm column is not purely the model's`,
        );
    }
  }

  const outDir = resolve(opts.out);
  mkdirSync(outDir, { recursive: true });
  const markdown = toMarkdown(reports);
  writeFileSync(
    join(outDir, "report.json"),
    JSON.stringify({ generatedAt: new Date().toISOString(), reports }, null, 2),
  );
  writeFileSync(join(outDir, "report.md"), markdown);
  console.log(markdown);
  console.log(`wrote ${join(outDir, "report.json")}\n      ${join(outDir, "report.md")}`);

  const violations = reports.reduce((n, r) => n + r.violations.length, 0);
  if (violations > 0) {
    console.error(`${violations} violation${violations === 1 ? "" : "s"}: see above`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
