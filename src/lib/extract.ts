import {
  type Constraints,
  type ConstraintsUpdate,
  type LimitedField,
  UPDATE_LIMITS,
  withinLimits,
  type ProbeContext,
} from "./constraints";
import { ruleTurn } from "./extract-rules";

/**
 * The rule-based reader's entry point: one message in, a legacy constraints update and a
 * reply out. No model is involved. Since #83 the assistant itself lives in assistant.ts and
 * this is only its safety net (no key, a failed call, or the plan's model budget spent).
 */

export type ChatTurn = { role: "user" | "assistant"; content: string };
export type ExtractResult = { reply: string; update: ConstraintsUpdate; source: "llm" | "rules" };

const LIMIT_NOTES: Record<LimitedField, string> = {
  budgetMin: `a minimum spend has to be between $${UPDATE_LIMITS.budgetMin.min} and $${UPDATE_LIMITS.budgetMin.max} a person`,
  budgetMax: `a budget has to be between $${UPDATE_LIMITS.budgetMax.min} and $${UPDATE_LIMITS.budgetMax.max} a person`,
  budgetFlex: `the stretch on a budget can be at most $${UPDATE_LIMITS.budgetFlex.max}`,
  maxTravelMin: `travel time has to be between ${UPDATE_LIMITS.maxTravelMin.min} and ${UPDATE_LIMITS.maxTravelMin.max} minutes`,
  weights: "the trade-off answer was out of range",
};

/**
 * The last check on any extractor's output, LLM or rules: numbers outside
 * UPDATE_LIMITS are dropped and the reply says so, so the person is never
 * told "noted" about a value that was not recorded.
 */
export function enforceLimits(result: ExtractResult): ExtractResult {
  const { update, dropped } = withinLimits(result.update);
  if (dropped.length === 0) return result;
  const note = `(I couldn't use that: ${dropped.map((f) => LIMIT_NOTES[f]).join("; ")}.)`;
  // The rule-based reply acknowledges before the limits run; don't say "noted" when nothing was.
  const nothingKept = Object.keys(update).every((key) => key === "pending" || key === "probesAsked");
  const reply = nothingKept
    ? result.reply.replace(/^Got it, noted privately\./, "I didn't record that.")
    : result.reply;
  return { ...result, update, reply: `${reply} ${note}` };
}

/** One turn of the rule-based reader, with the limits applied. Never touches the network. */
export async function extract(
  history: ChatTurn[],
  current: Constraints,
  context: ProbeContext = {},
): Promise<ExtractResult> {
  const latest = [...history].reverse().find((t) => t.role === "user")?.content ?? "";
  const { update, reply } = ruleTurn(latest, current, context);
  return enforceLimits({ reply, update, source: "rules" });
}
