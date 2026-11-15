import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assistantTurn, type AssistantOutput, type AssistantTurn } from "../src/lib/assistant";
import type { ChatTurn } from "../src/lib/extract";
import { OPENING_MESSAGE } from "../src/lib/extract-rules";
import { toLegacyConstraints } from "../src/lib/legacy-adapter";
import { MemberStateSchema, emptyMemberState, type MemberState } from "../src/lib/member-state";
import { RESTAURANTS, type Restaurant } from "../src/lib/restaurants";
import type { Case as RuleCase } from "./extract-eval";

/**
 * The ASSISTANT's evaluation: the private chat as Claude runs it (src/lib/assistant.ts).
 * Separate from sim/extract-eval.ts, which measures only the rule-based safety net: a green
 * rule-reader suite says nothing about how well the assistant understands people.
 *
 *   for each case: start from an empty member state
 *                  feed the person's messages one at a time, exactly as the app does
 *                  compare what ended up stored with what the case expects
 *
 * Who answers is decided by the environment, as in production: with ANTHROPIC_API_KEY the
 * real model does (`npm run sim:extract -- --llm`); tests stub the network with each turn's
 * `model` answer (see `scriptedFetch`), which exercises everything code does with it.
 */

export type AssistantCase = {
  id: string;
  /** What the case is about; cases are grouped by this in the report. */
  about: string;
  note?: string;
  /** Candidate restaurants for this plan, when the case names one. Defaults to the sample pool. */
  pool?: { id: string; name: string }[];
  turns: { user: string; model: AssistantOutput }[];
  /** Dotted path into the stored state → the value expected there. `{ "$includes": "x" }` matches loosely. */
  expected: Record<string, unknown>;
  /** Paths that must hold nothing. */
  absent?: string[];
  /** Patterns at least one reply must match. */
  replyMustMatch?: string[];
};

export function loadAssistantCases(file = join(process.cwd(), "tests/fixtures/assistant-cases.json")): AssistantCase[] {
  return (JSON.parse(readFileSync(file, "utf8")) as { cases: AssistantCase[] }).cases;
}

/** A fetch that answers each model call with the scripted `model` for the latest user message. */
export function scriptedFetch(cases: readonly AssistantCase[]): typeof fetch {
  const script = new Map(cases.flatMap((c) => c.turns.map((t) => [t.user, t.model] as const)));
  return (async (_url: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String(init?.body)) as { messages: { role: string; content: string }[] };
    const message = [...body.messages].reverse().find((m) => m.role === "user")?.content ?? "";
    const model = script.get(message);
    if (!model) return new Response("no script for this message", { status: 500 });
    return Response.json({ content: [{ type: "tool_use", input: model }] });
  }) as typeof fetch;
}

const at = (root: unknown, path: string): unknown =>
  path.split(".").reduce<unknown>((x, key) => (x === null || x === undefined ? undefined : (x as never)[key]), root);

const normal = (x: unknown): unknown => {
  if (typeof x === "string") return x.toLowerCase();
  if (Array.isArray(x)) {
    const items = x.map(normal);
    // A list of plain values is a set: the order a model lists them in is not a mistake.
    return items.every((i) => typeof i !== "object" || i === null) ? [...items].sort() : items;
  }
  if (x !== null && typeof x === "object")
    return Object.fromEntries(
      Object.entries(x)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, normal(v)]),
    );
  return x;
};

export function matches(expected: unknown, got: unknown): boolean {
  if (expected !== null && typeof expected === "object" && "$includes" in expected)
    return JSON.stringify(got ?? null)
      .toLowerCase()
      .includes(String((expected as { $includes: unknown }).$includes).toLowerCase());
  return JSON.stringify(normal(expected)) === JSON.stringify(normal(got));
}

export type AssistantFieldResult = { path: string; ok: boolean; expected: unknown; got: unknown };
export type AssistantCaseResult = {
  id: string;
  about: string;
  fields: AssistantFieldResult[];
  allCorrect: boolean;
  /** Who answered each turn. "rules" in a model run means the call failed and the safety net answered. */
  sources: AssistantTurn["source"][];
  /** Things that must never happen, whoever answers. */
  violations: string[];
  replies: string[];
  final: MemberState;
};

const asPool = (c: AssistantCase): Restaurant[] =>
  c.pool ? c.pool.map((p) => ({ ...RESTAURANTS[0], id: p.id, name: p.name })) : RESTAURANTS;

export async function runAssistantCase(c: AssistantCase): Promise<AssistantCaseResult> {
  let state = emptyMemberState();
  const history: ChatTurn[] = [{ role: "assistant", content: OPENING_MESSAGE }];
  const sources: AssistantTurn["source"][] = [];
  const replies: string[] = [];
  const violations: string[] = [];
  const pool = asPool(c);

  for (const turn of c.turns) {
    history.push({ role: "user", content: turn.user });
    const before = state;
    const out = await assistantTurn(history, state, pool);
    state = out.state;
    sources.push(out.source);
    replies.push(out.reply);
    history.push({ role: "assistant", content: out.reply });
    if (!out.reply.trim()) violations.push("an empty reply");
    if (state.chat.turns !== before.chat.turns + 1) violations.push("a reply was not counted");
    const again = state.chat.lastAsked;
    if (again && before.chat.asked.includes(again) && again !== "time" && again !== "diet")
      violations.push(`asked about ${again} a second time`);
  }
  if (!MemberStateSchema.safeParse(state).success) violations.push("the stored state does not fit its schema");

  const fields: AssistantFieldResult[] = [
    ...Object.entries(c.expected).map(([path, expected]) => {
      const got = at(state, path);
      return { path, ok: matches(expected, got), expected, got };
    }),
    ...(c.absent ?? []).map((path) => {
      const got = at(state, path);
      return { path, ok: got === undefined, expected: undefined, got };
    }),
  ];
  for (const pattern of c.replyMustMatch ?? [])
    if (!replies.some((r) => new RegExp(pattern, "i").test(r)))
      fields.push({ path: `reply ~ /${pattern}/`, ok: false, expected: pattern, got: replies.join(" | ") });

  return {
    id: c.id,
    about: c.about,
    fields,
    allCorrect: fields.every((f) => f.ok),
    sources,
    violations,
    replies,
    final: state,
  };
}

export type AssistantReport = {
  answeredBy: string;
  cases: number;
  casesCorrect: number;
  fields: number;
  fieldsCorrect: number;
  turns: number;
  /** Turns the safety net answered because the model call failed. */
  ruleTurns: number;
  byAbout: Record<string, { cases: number; casesCorrect: number }>;
  violations: { id: string; message: string }[];
  results: AssistantCaseResult[];
};

export async function runAssistantSuite(answeredBy: string, cases: readonly AssistantCase[]): Promise<AssistantReport> {
  const results: AssistantCaseResult[] = [];
  for (const c of cases) results.push(await runAssistantCase(c));
  const byAbout: AssistantReport["byAbout"] = {};
  for (const r of results) {
    const entry = (byAbout[r.about] ??= { cases: 0, casesCorrect: 0 });
    entry.cases++;
    if (r.allCorrect) entry.casesCorrect++;
  }
  return {
    answeredBy,
    cases: results.length,
    casesCorrect: results.filter((r) => r.allCorrect).length,
    fields: results.reduce((n, r) => n + r.fields.length, 0),
    fieldsCorrect: results.reduce((n, r) => n + r.fields.filter((f) => f.ok).length, 0),
    turns: results.reduce((n, r) => n + r.sources.length, 0),
    ruleTurns: results.reduce((n, r) => n + r.sources.filter((s) => s === "rules").length, 0),
    byAbout,
    violations: results.flatMap((r) => r.violations.map((message) => ({ id: r.id, message }))),
    results,
  };
}

/**
 * The rule reader's cases, asked of the assistant instead. Only the fields that mean the same
 * thing in both formats are compared, after converting what the assistant stored into the
 * older format; a case with none of those fields is skipped.
 */
export const COMPARABLE_FIELDS = [
  "availableSlots",
  "budgetMax",
  "maxTravelMin",
  "likedCuisines",
  "dislikedCuisines",
] as const;

export async function runRuleCasesThroughAssistant(
  cases: readonly RuleCase[],
): Promise<{ cases: number; fields: number; fieldsCorrect: number; ruleTurns: number; misses: string[] }> {
  let counted = 0;
  let fields = 0;
  let fieldsCorrect = 0;
  let ruleTurns = 0;
  const misses: string[] = [];
  for (const c of cases) {
    const comparable = COMPARABLE_FIELDS.filter((f) => c.expected[f] !== undefined);
    if (c.start || comparable.length === 0) continue;
    counted++;
    let state = emptyMemberState();
    const history: ChatTurn[] = [{ role: "assistant", content: OPENING_MESSAGE }];
    for (const user of c.turns) {
      history.push({ role: "user", content: user });
      const out = await assistantTurn(history, state, RESTAURANTS);
      state = out.state;
      if (out.source === "rules") ruleTurns++;
      history.push({ role: "assistant", content: out.reply });
    }
    const legacy = toLegacyConstraints(state);
    for (const field of comparable) {
      fields++;
      if (matches(c.expected[field], legacy[field])) fieldsCorrect++;
      else
        misses.push(
          `${c.id} · ${field}: expected ${JSON.stringify(c.expected[field])}, got ${JSON.stringify(legacy[field])}`,
        );
    }
  }
  return { cases: counted, fields, fieldsCorrect, ruleTurns, misses };
}

const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : "-");

export function assistantMarkdown(report: AssistantReport): string {
  const lines = [
    `# Assistant evaluation (${report.answeredBy})`,
    "",
    "| about | cases | fully right |",
    "| --- | ---: | ---: |",
    ...Object.entries(report.byAbout).map(([about, t]) => `| ${about} | ${t.cases} | ${t.casesCorrect} |`),
    `| **all** | ${report.cases} | ${report.casesCorrect} |`,
    "",
    `Fields right: ${pct(report.fieldsCorrect, report.fields)} (${report.fieldsCorrect} of ${report.fields}). ` +
      `${report.turns} turns, ${report.ruleTurns} answered by the rule-based safety net, ` +
      `${report.violations.length} violation${report.violations.length === 1 ? "" : "s"}.`,
    "",
    ...report.violations.map((v) => `- ${v.id}: ${v.message}`),
    "Misses (case, path, expected, got):",
    "",
  ];
  for (const r of report.results)
    for (const f of r.fields.filter((x) => !x.ok))
      lines.push(`- ${r.id} · ${f.path}: expected ${JSON.stringify(f.expected)}, got ${JSON.stringify(f.got)}`);
  return lines.join("\n") + "\n";
}
