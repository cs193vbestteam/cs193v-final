import { z } from "zod";
import {
  CUISINES,
  DIETARY,
  SLOTS,
  type Constraints,
  type ConstraintsUpdate,
  ConstraintsUpdateSchema,
  type LimitedField,
  UPDATE_LIMITS,
  withinLimits,
  PENDING,
  PROBES,
  type ProbeContext,
  SOFT_DIMS,
  nextProbe,
} from "./constraints";
import { ruleTurn } from "./extract-rules";

/**
 * Private-chat extraction: turn what a user says into structured constraints.
 * Uses Claude (tool use for structured output) if ANTHROPIC_API_KEY is set,
 * otherwise the rule-based extractor. Any LLM failure falls back to rules.
 */

export type ChatTurn = { role: "user" | "assistant"; content: string };
export type ExtractResult = { reply: string; update: ConstraintsUpdate; source: "llm" | "rules" };

const SYSTEM_PROMPT = `You are a private assistant helping ONE person plan a group meal with friends.
Only this person sees this chat. Your job: learn their real constraints quickly and kindly, in 1-2 short sentences per reply.

Hard constraints to collect (ask for whichever is missing, one at a time):
- time: which weekend slots they are free (${SLOTS.join(", ")})
- budget: max dollars per person, and whether they can stretch a bit (budgetFlex = extra dollars that are "a stretch but OK")
- distance: max one-way travel minutes
- diet: restrictions (${DIETARY.join(", ")}), or confirm none (dietaryConfirmed=true)
Soft preferences: liked/disliked cuisines (${CUISINES.join(", ")}).

Once the essentials are known, ask these follow-ups ONE at a time, each exactly once (track them in probesAsked):
- tradeoff_budget_travel: "Which is worse: paying $10 over budget, or travelling 10 minutes further?" → nudge weights (+0.15 to what they protect, -0.1 to the other; keep each within 0.1..0.7).
- tradeoff_cuisine_travel: same shape for cuisine vs travel.
- concession: "If something has to give, what goes first: cuisine, distance or budget?" → concessionOrder, in the order they give (${SOFT_DIMS.join(", ")}; "distance" = travel).
- start_point (ONLY when it is the "Next follow-up" named below): ask roughly where they will be travelling from. A neighbourhood or cross street is enough, it is optional, and it is used only to measure their own trip. Put the place in startText, exactly as they wrote it. If they decline, just set pending to null.
If the person volunteers where they are coming from at any point, record it in startText. Never guess a place they did not state.
Set "pending" to the question you just asked (${PENDING.join(", ")}) and back to null once answered.

Never accept "whatever" / "anything" / "don't care" for budget or distance. Reply with an either/or instead
("Which would bother you more: $45 a head, or $25 a head somewhere less exciting?") and set pending to vague_budget / vague_distance;
infer a number from their answer ($45 bothers them → budgetMax 30, budgetFlex 10; otherwise 60/15. 30 min bothers them → maxTravelMin 15; otherwise 40).

Rules:
- Reassure them numbers stay private when asking about money.
- Never judge their constraints.
- Always reply in English.
- Always call the record_constraints tool. Put ONLY fields the latest message changes into "update".
- availableSlots is the FULL list of slots they are free (replace, not append). If they say they're busy at some time, return all other slots.`;

const TOOL = {
  name: "record_constraints",
  description: "Record constraint changes from the user's latest message and give your reply.",
  input_schema: {
    type: "object",
    properties: {
      reply: { type: "string", description: "Your short reply to the user." },
      update: {
        type: "object",
        properties: {
          budgetMax: { type: "integer" },
          budgetFlex: { type: "integer" },
          availableSlots: { type: "array", items: { type: "string", enum: [...SLOTS] } },
          dietary: { type: "array", items: { type: "string", enum: [...DIETARY] } },
          dietaryConfirmed: { type: "boolean" },
          maxTravelMin: { type: "integer" },
          startText: { type: "string", description: "The place the person says they will travel from, verbatim." },
          likedCuisines: { type: "array", items: { type: "string", enum: [...CUISINES] } },
          dislikedCuisines: { type: "array", items: { type: "string", enum: [...CUISINES] } },
          weights: {
            type: "object",
            properties: { budget: { type: "number" }, travel: { type: "number" }, cuisine: { type: "number" } },
          },
          concessionOrder: { type: "array", items: { type: "string", enum: [...SOFT_DIMS] } },
          probesAsked: { type: "array", items: { type: "string", enum: [...PROBES] } },
          pending: { type: ["string", "null"], enum: [...PENDING, null] },
        },
      },
    },
    required: ["reply", "update"],
  },
} as const;

// The model may name a place (startText) but never supply coordinates: those only come from geocoding.
const ToolOutput = z.object({ reply: z.string().min(1), update: ConstraintsUpdateSchema.omit({ startPoint: true }) });

async function extractWithLLM(
  history: ChatTurn[],
  current: Constraints,
  apiKey: string,
  context: ProbeContext,
): Promise<ExtractResult> {
  // The model already saw the place in the chat; it has no use for the coordinates.
  const known = { ...current, startPoint: current.startPoint ? { label: current.startPoint.label } : null };
  const model = process.env.ANTHROPIC_MODEL || "claude-haiku-5-5";
  const messages = history.slice(-20).map((t) => ({ role: t.role, content: t.content }));
  // The API requires the first message to be from the user.
  while (messages.length && messages[0].role !== "user") messages.shift();

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 512,
      system: `${SYSTEM_PROMPT}\n\nWhat you already know about this person (JSON): ${JSON.stringify(known)}\nNext follow-up to ask once essentials are complete: ${nextProbe(current, context) ?? "none"}`,
      tools: [TOOL],
      tool_choice: { type: "tool", name: TOOL.name },
      messages,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}`);
  const data = (await res.json()) as { content?: { type: string; input?: unknown }[] };
  const block = data.content?.find((b) => b.type === "tool_use");
  const parsed = ToolOutput.parse(block?.input);
  return { reply: parsed.reply, update: parsed.update, source: "llm" };
}

const LIMIT_NOTES: Record<LimitedField, string> = {
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

export async function extract(
  history: ChatTurn[],
  current: Constraints,
  context: ProbeContext = {},
  /** false when the plan has used up its LLM budget (#4): answer with the rule-based extractor. */
  allowLLM = true,
): Promise<ExtractResult> {
  const latest = [...history].reverse().find((t) => t.role === "user")?.content ?? "";
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey && allowLLM) {
    try {
      return enforceLimits(await extractWithLLM(history, current, apiKey, context));
    } catch (err) {
      console.error("LLM extraction failed, falling back to rules:", (err as Error).message);
    }
  }
  const { update, reply } = ruleTurn(latest, current, context);
  return enforceLimits({ reply, update, source: "rules" });
}
