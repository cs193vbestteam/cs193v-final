import { z } from "zod";
import {
  CUISINES,
  DIETARY,
  SLOTS,
  type Constraints,
  type ConstraintsUpdate,
  ConstraintsUpdateSchema,
  missingFields,
} from "./constraints";
import { extractRules, ruleReply } from "./extract-rules";

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
          likedCuisines: { type: "array", items: { type: "string", enum: [...CUISINES] } },
          dislikedCuisines: { type: "array", items: { type: "string", enum: [...CUISINES] } },
        },
      },
    },
    required: ["reply", "update"],
  },
} as const;

const ToolOutput = z.object({ reply: z.string().min(1), update: ConstraintsUpdateSchema });

async function extractWithLLM(history: ChatTurn[], current: Constraints, apiKey: string): Promise<ExtractResult> {
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
      system: `${SYSTEM_PROMPT}\n\nWhat you already know about this person (JSON): ${JSON.stringify(current)}`,
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

export async function extract(history: ChatTurn[], current: Constraints): Promise<ExtractResult> {
  const latest = [...history].reverse().find((t) => t.role === "user")?.content ?? "";
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey) {
    try {
      return await extractWithLLM(history, current, apiKey);
    } catch (err) {
      console.error("LLM extraction failed, falling back to rules:", (err as Error).message);
    }
  }
  const update = extractRules(latest, missingFields(current)[0]);
  return { reply: ruleReply(current, update), update, source: "rules" };
}
