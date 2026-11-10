import { z } from "zod";
import {
  CUISINES,
  type Cuisine,
  DIETARY,
  SLOTS,
  type Constraints,
  type ConstraintsUpdate,
  ConstraintsUpdateSchema,
  type LimitedField,
  UPDATE_LIMITS,
  withinLimits,
  PENDING,
  ASKED_PROBES,
  type ProbeContext,
  SOFT_DIMS,
} from "./constraints";
import { ruleTurn } from "./extract-rules";
import { RUBRIC, misreadBareNumber, stateBlock } from "./extract-prompt";

/**
 * Private-chat extraction: turn what a user says into structured constraints.
 * Uses Claude (tool use for structured output) if ANTHROPIC_API_KEY is set,
 * otherwise the rule-based extractor. Any LLM failure falls back to rules.
 */

export type ChatTurn = { role: "user" | "assistant"; content: string };
export type ExtractResult = { reply: string; update: ConstraintsUpdate; source: "llm" | "rules" };

/** What the model may set `pending` to: everything but the retired trade-off questions. */
const ASKABLE_PENDING = PENDING.filter((p) => !p.startsWith("tradeoff"));

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
          budgetNoLimit: { type: "boolean", description: "They don't mind what it costs." },
          budgetMin: { type: "integer", description: "A floor: 'at least $50 a person'." },
          budgetFlex: { type: "integer" },
          availableSlots: { type: "array", items: { type: "string", enum: [...SLOTS] } },
          dietary: { type: "array", items: { type: "string", enum: [...DIETARY] } },
          dietaryConfirmed: { type: "boolean" },
          avoidNotes: {
            type: "array",
            items: { type: "string" },
            description: "Foods they avoid, in their own words, when they named something specific.",
          },
          maxTravelMin: { type: "integer" },
          travelNoLimit: { type: "boolean", description: "They don't mind how far it is." },
          startText: { type: "string", description: "The place the person says they will travel from, verbatim." },
          likedCuisines: { type: "array", items: { type: "string", enum: [...CUISINES] } },
          dislikedCuisines: { type: "array", items: { type: "string", enum: [...CUISINES] } },
          weights: {
            type: "object",
            properties: { budget: { type: "number" }, travel: { type: "number" }, cuisine: { type: "number" } },
          },
          concessionOrder: { type: "array", items: { type: "string", enum: [...SOFT_DIMS] } },
          probesAsked: { type: "array", items: { type: "string", enum: [...ASKED_PROBES] } },
          pending: { type: ["string", "null"], enum: [...ASKABLE_PENDING, null] },
        },
      },
    },
    required: ["reply", "update"],
  },
} as const;

// The model may name a place (startText) but never supply coordinates: those only come from geocoding.
// Cuisines are read as plain words, not validated here: if the model ever names one that is not on our
// list, readCuisines() drops that one word instead of the whole reply being thrown away.
const ToolOutput = z.object({
  reply: z.string().min(1),
  update: ConstraintsUpdateSchema.omit({ startPoint: true, likedCuisines: true, dislikedCuisines: true }).extend({
    likedCuisines: z.array(z.string()).optional(),
    dislikedCuisines: z.array(z.string()).optional(),
  }),
});

const isCuisine = (word: string): word is Cuisine => (CUISINES as readonly string[]).includes(word);

/**
 * The model's cuisine words, kept only where they are cuisines we have. The
 * model does the translating ("Asian", "something like ramen"); this is the
 * net under it. A word that is not on the list is dropped and the reply says
 * so, and everything else the model read from the message is kept.
 */
export function readCuisines(parsed: z.infer<typeof ToolOutput>): { reply: string; update: ConstraintsUpdate } {
  const { likedCuisines, dislikedCuisines, ...rest } = parsed.update;
  const update: ConstraintsUpdate = { ...rest };
  const unknown = new Set<string>();
  for (const [field, words] of [
    ["likedCuisines", likedCuisines],
    ["dislikedCuisines", dislikedCuisines],
  ] as const) {
    if (!words) continue;
    const tidy = words.map((w) => w.trim().toLowerCase()).filter(Boolean);
    const known = Array.from(new Set(tidy.filter(isCuisine)));
    tidy.filter((w) => !isCuisine(w)).forEach((w) => unknown.add(w));
    if (known.length) update[field] = known;
  }
  if (unknown.size === 0) return { reply: parsed.reply, update };
  const note = `(I couldn't match ${[...unknown].map((u) => `"${u}"`).join(" or ")} to a cuisine I can look for, so I left that out. I know: ${CUISINES.join(", ")}.)`;
  return { reply: `${parsed.reply} ${note}`, update };
}

async function extractWithLLM(
  history: ChatTurn[],
  current: Constraints,
  apiKey: string,
  context: ProbeContext,
): Promise<ExtractResult> {
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
      system: `${RUBRIC}\n\n${stateBlock(history, current, context)}`,
      tools: [TOOL],
      tool_choice: { type: "tool", name: TOOL.name },
      messages,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}`);
  const data = (await res.json()) as { content?: { type: string; input?: unknown }[] };
  const block = data.content?.find((b) => b.type === "tool_use");
  const { reply, update } = readCuisines(ToolOutput.parse(block?.input));
  // A bare "20" filed under the wrong question: the rule-based reader is exact here, so let it answer.
  if (misreadBareNumber(history, current, Object.keys(update))) throw new Error("bare number misread");
  // Bookkeeping the model can forget: a question it did not say it is waiting on is not pending,
  // and a follow-up it is waiting on has been asked.
  if (update.pending === undefined) update.pending = null;
  const waitingOn = ASKED_PROBES.find((p) => p === update.pending);
  if (waitingOn) update.probesAsked = [...new Set([...(update.probesAsked ?? []), waitingOn])];
  return { reply, update, source: "llm" };
}

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
