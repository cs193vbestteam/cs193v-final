import { db } from "./db";
import { chargeTo, type Usage } from "./spend-context";

/**
 * Monthly spending caps on Anthropic API calls (COST-CONTROLS).
 *
 * Every model call is charged to one person, the "payer":
 *   - a chat turn with your own assistant is charged to you;
 *   - the negotiation (each person's agent, the mediator's picks, the sentence under the plan)
 *     is charged to the person who created the plan.
 *
 * Before a call, `canSpend` checks the payer's total for this calendar month (UTC) and the
 * app's total for the month. After a call, `recordUsage` adds what the API reported it used
 * (input and output tokens) times the price per token. When either cap is reached, callers
 * skip the model and answer with the rule-based code paths they already fall back to.
 *
 * The check and the record are two statements, so calls already in flight when a cap is
 * reached still finish: a cap can be passed by a few calls' worth (fractions of a cent each).
 */

export type { Usage };

/** The row that holds the whole app's total; user ids are UUIDs, so it can't collide. */
export const GLOBAL_PAYER = "*";

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = raw === undefined || raw === "" ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * Dollars per million tokens. Defaults are Claude Haiku 5.5's list price (input / output) for
 * prompts up to 100K tokens; set these if ANTHROPIC_MODEL points at another model.
 */
export function prices() {
  return {
    inputPerMTok: envNumber("LLM_PRICE_INPUT_PER_MTOK", 0.1),
    outputPerMTok: envNumber("LLM_PRICE_OUTPUT_PER_MTOK", 0.5),
  };
}

/** Dollars one person may spend on model calls in a calendar month. */
export function perUserMonthlyCap(): number {
  return envNumber("LLM_MONTHLY_CAP_PER_USER_USD", 10);
}

/** Dollars the whole app may spend on model calls in a calendar month, across everyone. */
export function globalMonthlyCap(): number {
  return envNumber("LLM_MONTHLY_CAP_TOTAL_USD", 10);
}

/** Cost in micro-dollars (millionths of a dollar), so totals stay whole numbers. */
export function costMicros(usage: Usage | undefined): number {
  if (!usage) return 0;
  const { inputPerMTok, outputPerMTok } = prices();
  // tokens × $/MTok ÷ 1e6 tokens × 1e6 micro-dollars = tokens × $/MTok
  return Math.ceil((usage.input_tokens ?? 0) * inputPerMTok + (usage.output_tokens ?? 0) * outputPerMTok);
}

/** "2026-11", in UTC: the window a total belongs to. */
export function monthOf(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 7);
}

async function totalMicros(payer: string, month: string): Promise<number> {
  const client = await db();
  const { rows } = await client.execute({
    sql: "SELECT micros FROM llm_spend WHERE payer = ? AND month = ?",
    args: [payer, month],
  });
  return rows[0] ? Number(rows[0].micros) : 0;
}

/** Whether `payer` (and the app as a whole) still has room under this month's caps. */
export async function canSpend(payer: string, now = Date.now()): Promise<boolean> {
  const month = monthOf(now);
  const [mine, all] = await Promise.all([totalMicros(payer, month), totalMicros(GLOBAL_PAYER, month)]);
  return mine < perUserMonthlyCap() * 1e6 && all < globalMonthlyCap() * 1e6;
}

/** Adds one call's cost to the payer's and the app's totals for this month. */
export async function recordSpend(payer: string, micros: number, now = Date.now()): Promise<void> {
  if (micros <= 0) return;
  const client = await db();
  const month = monthOf(now);
  for (const who of [payer, GLOBAL_PAYER]) {
    await client.execute({
      sql: `INSERT INTO llm_spend (payer, month, micros) VALUES (?, ?, ?)
            ON CONFLICT (payer, month) DO UPDATE SET micros = llm_spend.micros + EXCLUDED.micros`,
      args: [who, month, micros],
    });
  }
}

/** One person's spending this month, in dollars (for tests and for anyone checking by hand). */
export async function spentThisMonth(payer: string, now = Date.now()): Promise<number> {
  return (await totalMicros(payer, monthOf(now))) / 1e6;
}

/**
 * Runs `fn` with every model call inside it charged to `payer`. The API code (anthropic.ts,
 * assistant.ts) reports usage through spend-context.ts, which has no database access, so the
 * negotiation modules stay unable to reach storage (tests/isolation.test.ts).
 */
export function withPayer<T>(payer: string, fn: () => Promise<T>): Promise<T> {
  return chargeTo(async (usage) => {
    try {
      await recordSpend(payer, costMicros(usage));
    } catch (err) {
      // Failing to count must not fail the person's request; the provider-side limit still holds.
      console.error("Could not record LLM spend:", (err as Error).message);
    }
  }, fn);
}
