import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  assistantMarkdown,
  loadAssistantCases,
  loadOffTopicCases,
  offTopicMarkdown,
  runAssistantSuite,
  runOffTopicSuite,
  runRuleCasesThroughAssistant,
  type AssistantReport,
  type OffTopicReport,
} from "./assistant-eval";
import { loadCases, rulesExtractor, runSuite, toMarkdown, type ExtractorReport } from "./extract-eval";

/**
 * CLI: `npm run sim:extract [-- --llm] [--out sim/out/extract]`
 *
 * Two different things are measured here, and they are reported separately on purpose:
 *
 *   1. The RULE-BASED READER (the safety net) on tests/fixtures/extract-cases.json.
 *      Always runs, never touches the network, deterministic.
 *   2. The ASSISTANT (Claude) on tests/fixtures/assistant-cases.json, and on the comparable
 *      fields of the rule reader's cases. Only with --llm, which needs ANTHROPIC_API_KEY
 *      (read from the environment or .env.local); the model comes from ANTHROPIC_MODEL, as in
 *      the app. One call per message: about 90 calls in all. Without a key the flag is noted
 *      and ignored.
 *   3. STAYING ON TOPIC (#84), also only with --llm: tests/fixtures/off-topic-cases.json, one
 *      call per case (36 more). Reports how many off-topic messages were refused and how many
 *      messages about the meal were refused by mistake.
 *
 * Writes report.json and report.md into --out and prints the tables. Exits 1 on any violation.
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
      console.log(
        "  --llm   also run the assistant (Claude) on its own cases and the off-topic set (needs ANTHROPIC_API_KEY)",
      );
      process.exit(0);
    } else throw new Error(`unknown argument ${a}`);
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const cases = loadCases();
  const key = process.env.ANTHROPIC_API_KEY;

  // The rule-based run must not touch the network even when a key is present: it never calls a model.
  const rules: ExtractorReport = await runSuite("rules (safety net)", cases, rulesExtractor);
  let markdown = toMarkdown([rules]);
  let assistant: AssistantReport | null = null;
  let onRuleCases: Awaited<ReturnType<typeof runRuleCasesThroughAssistant>> | null = null;
  let offTopic: OffTopicReport | null = null;

  if (opts.llm && !key) {
    console.log("note: --llm ignored, ANTHROPIC_API_KEY is not set; reporting the rule-based reader only");
  } else if (opts.llm) {
    const model = process.env.ANTHROPIC_MODEL || "claude-haiku-5-5";
    const own = loadAssistantCases();
    console.log(`Assistant: ${model}, ${own.length} cases of its own, then the rule reader's cases`);
    process.env.SETTLE_EVAL_REAL_MODEL = "1";
    assistant = await runAssistantSuite(model, own);
    onRuleCases = await runRuleCasesThroughAssistant(cases);
    markdown += "\n" + assistantMarkdown(assistant);
    markdown +=
      `\n## The assistant on the rule reader's cases\n\n` +
      `Comparable fields only (times, budget ceiling, travel limit, cuisines), after converting to the older format: ` +
      `${onRuleCases.fieldsCorrect} of ${onRuleCases.fields} right over ${onRuleCases.cases} cases, ` +
      `${onRuleCases.ruleTurns} turns answered by the safety net.\n\n` +
      onRuleCases.misses.map((m) => `- ${m}`).join("\n") +
      "\n";
    const off = loadOffTopicCases();
    console.log(`Staying on topic: ${off.length} cases`);
    offTopic = await runOffTopicSuite(model, off);
    markdown += "\n" + offTopicMarkdown(offTopic);
    const fellBack = assistant.ruleTurns + onRuleCases.ruleTurns + offTopic.ruleTurns;
    if (fellBack > 0)
      console.log(
        `note: ${fellBack} turns fell back to the rule-based reader, so those numbers are not purely the model's`,
      );
  }

  const outDir = resolve(opts.out);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    join(outDir, "report.json"),
    JSON.stringify(
      { generatedAt: new Date().toISOString(), rules, assistant, assistantOnRuleCases: onRuleCases, offTopic },
      null,
      2,
    ),
  );
  writeFileSync(join(outDir, "report.md"), markdown);
  console.log(markdown);
  console.log(`wrote ${join(outDir, "report.json")}\n      ${join(outDir, "report.md")}`);

  const violations = rules.violations.length + (assistant?.violations.length ?? 0) + (offTopic?.violations.length ?? 0);
  if (violations > 0) {
    console.error(`${violations} violation${violations === 1 ? "" : "s"}: see above`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
