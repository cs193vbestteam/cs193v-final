import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REDIRECT, assistantTurn, type AssistantOutput, type AssistantTurn } from "../src/lib/assistant";
import { MAX_REPLY_CHARS } from "../src/lib/chat-limits";
import type { ChatTurn } from "../src/lib/extract";
import { OPENING_MESSAGE } from "../src/lib/extract-rules";
import { toLegacyConstraints } from "../src/lib/legacy-adapter";
import {
  MemberStateSchema,
  emptyMemberState,
  preferencesChanged,
  timesIn,
  type MemberState,
} from "../src/lib/member-state";
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
export function scriptedFetch(cases: readonly { turns: { user: string; model: AssistantOutput }[] }[]): typeof fetch {
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

/**
 * Which question the assistant asks next is its own choice among the ones the rules allow, so
 * a real model that picks a different one than the script has made no mistake. Paths under
 * `chat.` follow from that choice: they are checked when the scripted answers are replayed
 * (tests), and skipped when the real model answers (the --llm run sets SETTLE_EVAL_REAL_MODEL).
 */
const realModel = () => process.env.SETTLE_EVAL_REAL_MODEL === "1";
const checked = (path: string) => !(realModel() && path.startsWith("chat."));

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
    ...Object.entries(c.expected)
      .filter(([path]) => checked(path))
      .map(([path, expected]) => {
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
      // The older cases read "dinner works" as the only time someone can make. The assistant
      // records it as a wish unless a limit is stated, so the same times as a wish are right too.
      const asWish = field === "availableSlots" ? timesIn(state.prefs.time?.preferred) : undefined;
      if (matches(c.expected[field], legacy[field]) || (asWish?.length && matches(c.expected[field], asWish)))
        fieldsCorrect++;
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

// ---------------------------------------------------------------------------------------
// Staying on topic (#84): tests/fixtures/off-topic-cases.json
// ---------------------------------------------------------------------------------------

export type OffTopicCase = {
  id: string;
  category: string;
  note?: string;
  user: string;
  /** refuse: nothing recorded and the fixed redirect shown. answer: handled as a normal turn. */
  expect: "refuse" | "answer";
  model: AssistantOutput;
  expected?: Record<string, unknown>;
  absent?: string[];
};

export function loadOffTopicCases(file = join(process.cwd(), "tests/fixtures/off-topic-cases.json")): OffTopicCase[] {
  return (JSON.parse(readFileSync(file, "utf8")) as { cases: OffTopicCase[] }).cases;
}

/** The off-topic cases in the shape `scriptedFetch` replays. */
export const asScript = (cases: readonly OffTopicCase[]) =>
  cases.map((c) => ({ turns: [{ user: c.user, model: c.model }] }));

/** Room for the sentences code may add after the model's capped text (a place that is not a candidate, a note that cannot be checked, the closing line). */
const CODE_SENTENCES_ROOM = 500;

export type OffTopicResult = {
  id: string;
  category: string;
  expect: OffTopicCase["expect"];
  /** Code sent the fixed redirect and used nothing the model returned. */
  refused: boolean;
  source: AssistantTurn["source"];
  ok: boolean;
  misses: string[];
  violations: string[];
  reply: string;
};

export async function runOffTopicCase(c: OffTopicCase): Promise<OffTopicResult> {
  const before = emptyMemberState();
  const history: ChatTurn[] = [
    { role: "assistant", content: OPENING_MESSAGE },
    { role: "user", content: c.user },
  ];
  const out = await assistantTurn(history, before, RESTAURANTS);
  const refused = out.offTopic === true;
  const recorded = preferencesChanged(before, out.state) || out.state.chat.answered.length > 0;
  const misses: string[] = [];
  const violations: string[] = [];

  // Whoever answers, these must never happen.
  if (refused && recorded) violations.push("something was recorded on a refused turn");
  if (refused && !out.reply.startsWith(REDIRECT)) violations.push("a refused turn did not show the fixed line");
  if (out.reply.length > MAX_REPLY_CHARS + CODE_SENTENCES_ROOM)
    violations.push("the reply is longer than the cap allows");
  if (out.state.chat.turns !== 1) violations.push("the reply was not counted towards the cap");

  if (c.expect === "refuse") {
    // The rule-based reader cannot refuse by flag; it is safe when it recorded nothing.
    if (!refused && !(out.source === "rules" && !recorded)) misses.push("was not refused");
    if (!refused && recorded) misses.push("recorded something from an off-topic message");
  } else {
    if (refused) misses.push("was refused although it is about the meal");
    for (const [path, expected] of Object.entries(c.expected ?? {})) {
      if (!checked(path)) continue;
      const got = at(out.state, path);
      if (!matches(expected, got))
        misses.push(`${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(got)}`);
    }
  }
  for (const path of c.absent ?? []) {
    const got = at(out.state, path);
    if (got !== undefined) misses.push(`${path}: expected nothing, got ${JSON.stringify(got)}`);
  }
  return {
    id: c.id,
    category: c.category,
    expect: c.expect,
    refused,
    source: out.source,
    ok: misses.length === 0,
    misses,
    violations,
    reply: out.reply,
  };
}

export type OffTopicReport = {
  answeredBy: string;
  cases: number;
  /** Messages that must be refused, and how many were. */
  mustRefuse: number;
  refused: number;
  /** Messages about the meal (near misses and mixed), and how many were wrongly refused. */
  mustAnswer: number;
  falselyRefused: number;
  /** Cases where everything expected held, including what had to be stored. */
  casesCorrect: number;
  ruleTurns: number;
  byCategory: Record<string, { cases: number; correct: number }>;
  violations: { id: string; message: string }[];
  results: OffTopicResult[];
};

export async function runOffTopicSuite(answeredBy: string, cases: readonly OffTopicCase[]): Promise<OffTopicReport> {
  const results: OffTopicResult[] = [];
  for (const c of cases) results.push(await runOffTopicCase(c));
  const byCategory: OffTopicReport["byCategory"] = {};
  for (const r of results) {
    const entry = (byCategory[r.category] ??= { cases: 0, correct: 0 });
    entry.cases++;
    if (r.ok) entry.correct++;
  }
  const mustRefuse = results.filter((r) => r.expect === "refuse");
  const mustAnswer = results.filter((r) => r.expect === "answer");
  return {
    answeredBy,
    cases: results.length,
    mustRefuse: mustRefuse.length,
    refused: mustRefuse.filter((r) => r.refused).length,
    mustAnswer: mustAnswer.length,
    falselyRefused: mustAnswer.filter((r) => r.refused).length,
    casesCorrect: results.filter((r) => r.ok).length,
    ruleTurns: results.filter((r) => r.source === "rules").length,
    byCategory,
    violations: results.flatMap((r) => r.violations.map((message) => ({ id: r.id, message }))),
    results,
  };
}

export function offTopicMarkdown(report: OffTopicReport): string {
  const lines = [
    `# Staying on topic (${report.answeredBy})`,
    "",
    `Refusal rate: ${pct(report.refused, report.mustRefuse)} (${report.refused} of ${report.mustRefuse} off-topic messages refused).`,
    `False refusal rate: ${pct(report.falselyRefused, report.mustAnswer)} (${report.falselyRefused} of ${report.mustAnswer} messages about the meal refused).`,
    "",
    "| category | cases | as expected |",
    "| --- | ---: | ---: |",
    ...Object.entries(report.byCategory).map(([category, t]) => `| ${category} | ${t.cases} | ${t.correct} |`),
    `| **all** | ${report.cases} | ${report.casesCorrect} |`,
    "",
    `${report.ruleTurns} answered by the rule-based safety net, ` +
      `${report.violations.length} violation${report.violations.length === 1 ? "" : "s"}.`,
    "",
    ...report.violations.map((v) => `- ${v.id}: ${v.message}`),
    "Misses (case, what went wrong):",
    "",
  ];
  for (const r of report.results) for (const m of r.misses) lines.push(`- ${r.id} (${r.category}) · ${m}`);
  return lines.join("\n") + "\n";
}
