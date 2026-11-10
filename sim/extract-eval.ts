import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ConstraintsSchema,
  UPDATE_LIMITS,
  emptyConstraints,
  mergeConstraints,
  type Constraints,
} from "../src/lib/constraints";
import { extract, type ChatTurn, type ExtractResult } from "../src/lib/extract";
import { OPENING_MESSAGE } from "../src/lib/extract-rules";

/**
 * The extractor evaluation: replay short private chats through an extractor
 * and compare what it recorded with what a careful person would have.
 *
 *   for each case: start from empty constraints (or the case's `start`)
 *                  feed the user's messages one at a time, exactly as the app does
 *                  (extract → enforce limits → merge, invalid merges ignored)
 *                  compare the fields the case is about
 *
 * Two kinds of result come out. Accuracy is a measurement: a wrong field is a
 * miss, not a failure. Violations are failures, whatever the extractor: a
 * final value outside the limits, or, in an adversarial case, a field changing
 * that the messages never legitimately talked about, or a reply matching a
 * forbidden pattern.
 */

export const CATEGORIES = ["clear", "vague", "correction", "mixed_language", "multi_turn", "adversarial"] as const;
export type Category = (typeof CATEGORIES)[number];

/** The constraint fields a case can state an expectation about or list in `mayChange`. */
export const CHECKED_FIELDS = [
  "availableSlots",
  "budgetMax",
  "budgetNoLimit",
  "budgetMin",
  "budgetFlex",
  "maxTravelMin",
  "travelNoLimit",
  "dietary",
  "dietaryConfirmed",
  "likedCuisines",
  "dislikedCuisines",
  "weights",
  "concessionOrder",
  "startPoint",
] as const;
export type CheckedField = (typeof CHECKED_FIELDS)[number];

export type Case = {
  id: string;
  category: Category;
  note?: string;
  /** Constraints already recorded before the first message. */
  start?: Partial<Constraints>;
  /** The user's messages, in order. */
  turns: string[];
  expected: Partial<Pick<Constraints, CheckedField>>;
  /** Adversarial cases: the only fields these messages may change. */
  mayChange?: CheckedField[];
  replyMustNotMatch?: string[];
  replyMaxChars?: number;
};

/** The suite lives with the other fixtures; the path is relative to the repository root, where npm runs scripts. */
export function loadCases(file = join(process.cwd(), "tests/fixtures/extract-cases.json")): Case[] {
  return (JSON.parse(readFileSync(file, "utf8")) as { cases: Case[] }).cases;
}

/** One assistant turn: what the app calls for every message. */
export type TurnExtractor = (history: ChatTurn[], current: Constraints) => Promise<ExtractResult>;

/** The rule-based extractor, through the same entry point and limits as production. */
export const rulesExtractor: TurnExtractor = (history, current) => extract(history, current, {}, false);
/** The LLM path (needs ANTHROPIC_API_KEY); a failed call falls back to rules, and `source` says so. */
export const llmExtractor: TurnExtractor = (history, current) => extract(history, current, {}, true);

export type FieldResult = { field: CheckedField; ok: boolean; expected: unknown; got: unknown };

export type CaseResult = {
  id: string;
  category: Category;
  fields: FieldResult[];
  /** Every field the case is about came out right. */
  allCorrect: boolean;
  /** Which extractor actually answered each turn. */
  sources: ExtractResult["source"][];
  /** Updates that failed validation when merged and were ignored, as the app does. */
  invalidMerges: number;
  violations: string[];
  replies: string[];
  final: Constraints;
};

const asSet = (xs: unknown) => (Array.isArray(xs) ? [...xs].map(String).sort().join("|") : null);

function same(expected: unknown, got: unknown): boolean {
  if (Array.isArray(expected)) return asSet(expected) === asSet(got);
  if (expected !== null && typeof expected === "object") return JSON.stringify(expected) === JSON.stringify(got);
  return expected === got;
}

/** Final values that no extractor may ever leave behind. */
export function limitViolations(c: Constraints): string[] {
  const out: string[] = [];
  const check = (name: string, x: number | null, { min, max }: { min: number; max: number }) => {
    if (x !== null && (x < min || x > max)) out.push(`${name} = ${x} is outside ${min}..${max}`);
  };
  check("budgetMax", c.budgetMax, UPDATE_LIMITS.budgetMax);
  check("budgetFlex", c.budgetFlex, UPDATE_LIMITS.budgetFlex);
  check("maxTravelMin", c.maxTravelMin, UPDATE_LIMITS.maxTravelMin);
  for (const [dim, w] of Object.entries(c.weights)) check(`weights.${dim}`, w, UPDATE_LIMITS.weight);
  if (!ConstraintsSchema.safeParse(c).success) out.push("final constraints do not fit the schema");
  return out;
}

export async function runCase(c: Case, extractor: TurnExtractor): Promise<CaseResult> {
  let constraints = ConstraintsSchema.parse({ ...emptyConstraints(), ...(c.start ?? {}) });
  const before = constraints;
  const history: ChatTurn[] = [{ role: "assistant", content: OPENING_MESSAGE }];
  const sources: ExtractResult["source"][] = [];
  const replies: string[] = [];
  let invalidMerges = 0;

  for (const message of c.turns) {
    history.push({ role: "user", content: message });
    const result = await extractor(history, constraints);
    sources.push(result.source);
    replies.push(result.reply);
    try {
      constraints = mergeConstraints(constraints, result.update);
    } catch {
      invalidMerges++; // the app ignores an invalid update rather than breaking the chat
    }
    history.push({ role: "assistant", content: result.reply });
  }

  const fields: FieldResult[] = (Object.keys(c.expected) as CheckedField[]).map((field) => ({
    field,
    ok: same(c.expected[field], constraints[field]),
    expected: c.expected[field],
    got: constraints[field],
  }));

  const violations = limitViolations(constraints);
  if (c.category === "adversarial") {
    const allowed = new Set<CheckedField>(c.mayChange ?? []);
    for (const field of CHECKED_FIELDS)
      if (!allowed.has(field) && !same(before[field], constraints[field]))
        violations.push(
          `${field} changed although the messages never mention it: ${JSON.stringify(constraints[field])}`,
        );
  }
  for (const pattern of c.replyMustNotMatch ?? [])
    for (const reply of replies)
      if (new RegExp(pattern, "i").test(reply)) violations.push(`a reply matches the forbidden pattern /${pattern}/`);
  if (c.replyMaxChars !== undefined)
    for (const reply of replies)
      if (reply.length > c.replyMaxChars)
        violations.push(`a reply is ${reply.length} characters long (limit ${c.replyMaxChars})`);

  return {
    id: c.id,
    category: c.category,
    fields,
    allCorrect: fields.every((f) => f.ok),
    sources,
    invalidMerges,
    violations,
    replies,
    final: constraints,
  };
}

export type Tally = {
  cases: number;
  casesCorrect: number;
  fields: number;
  fieldsCorrect: number;
  /** fieldsCorrect / fields; null when the category states no expectations. */
  accuracy: number | null;
  violations: number;
};

export type ExtractorReport = {
  extractor: string;
  overall: Tally;
  /** Everything except the adversarial set: the accuracy headline. */
  ordinary: Tally;
  byCategory: Record<Category, Tally>;
  /** Field accuracy across every case, per field. */
  byField: Partial<Record<CheckedField, { fields: number; correct: number }>>;
  turns: number;
  /** Turns answered by the rule-based extractor. For the LLM run this is the fallback count. */
  ruleTurns: number;
  invalidMerges: number;
  violations: { id: string; message: string }[];
  results: CaseResult[];
};

function tally(results: readonly CaseResult[]): Tally {
  const fields = results.reduce((n, r) => n + r.fields.length, 0);
  const fieldsCorrect = results.reduce((n, r) => n + r.fields.filter((f) => f.ok).length, 0);
  return {
    cases: results.length,
    casesCorrect: results.filter((r) => r.allCorrect).length,
    fields,
    fieldsCorrect,
    accuracy: fields ? fieldsCorrect / fields : null,
    violations: results.reduce((n, r) => n + r.violations.length, 0),
  };
}

export async function runSuite(
  name: string,
  cases: readonly Case[],
  extractor: TurnExtractor,
): Promise<ExtractorReport> {
  const results: CaseResult[] = [];
  for (const c of cases) results.push(await runCase(c, extractor));
  const byField: ExtractorReport["byField"] = {};
  for (const r of results)
    for (const f of r.fields) {
      const entry = (byField[f.field] ??= { fields: 0, correct: 0 });
      entry.fields++;
      if (f.ok) entry.correct++;
    }
  return {
    extractor: name,
    overall: tally(results),
    ordinary: tally(results.filter((r) => r.category !== "adversarial")),
    byCategory: Object.fromEntries(
      CATEGORIES.map((cat) => [cat, tally(results.filter((r) => r.category === cat))]),
    ) as Record<Category, Tally>,
    byField,
    turns: results.reduce((n, r) => n + r.sources.length, 0),
    ruleTurns: results.reduce((n, r) => n + r.sources.filter((s) => s === "rules").length, 0),
    invalidMerges: results.reduce((n, r) => n + r.invalidMerges, 0),
    violations: results.flatMap((r) => r.violations.map((message) => ({ id: r.id, message }))),
    results,
  };
}

const pct = (x: number | null) => (x === null ? "-" : `${(x * 100).toFixed(0)}%`);
const LABEL: Record<Category, string> = {
  clear: "clear answers",
  vague: "vague answers",
  correction: "corrections",
  mixed_language: "other languages",
  multi_turn: "multi-turn",
  adversarial: "adversarial",
};

/** One table, a column per extractor. */
export function toMarkdown(reports: readonly ExtractorReport[]): string {
  const lines: string[] = ["# Extractor evaluation", ""];
  const head = reports
    .map((r) => `${r.extractor}: fields right`)
    .concat(reports.map((r) => `${r.extractor}: cases fully right`));
  lines.push(`| category | cases | ${head.join(" | ")} |`, `| --- | ---: | ${head.map(() => "---:").join(" | ")} |`);
  const row = (label: string, pick: (r: ExtractorReport) => Tally) => {
    const first = pick(reports[0]);
    const fields = reports.map((r) => {
      const t = pick(r);
      return `${pct(t.accuracy)} (${t.fieldsCorrect} of ${t.fields})`;
    });
    const cases = reports.map((r) => `${pick(r).casesCorrect} of ${pick(r).cases}`);
    lines.push(`| ${label} | ${first.cases} | ${[...fields, ...cases].join(" | ")} |`);
  };
  for (const cat of CATEGORIES) row(LABEL[cat], (r) => r.byCategory[cat]);
  row("**all except adversarial**", (r) => r.ordinary);
  lines.push("");
  for (const r of reports) {
    lines.push(
      `**${r.extractor}:** ${r.turns} turns, ${r.ruleTurns} answered by the rule-based extractor, ` +
        `${r.invalidMerges} invalid update${r.invalidMerges === 1 ? "" : "s"} ignored, ${r.violations.length} violation${r.violations.length === 1 ? "" : "s"}.`,
    );
    for (const v of r.violations) lines.push(`- ${v.id}: ${v.message}`);
    lines.push("");
  }
  lines.push("Misses (field, expected, got):", "");
  for (const r of reports)
    for (const c of r.results)
      for (const f of c.fields.filter((x) => !x.ok))
        lines.push(
          `- ${r.extractor} · ${c.id} · ${f.field}: expected ${JSON.stringify(f.expected)}, got ${JSON.stringify(f.got)}`,
        );
  return lines.join("\n") + "\n";
}
