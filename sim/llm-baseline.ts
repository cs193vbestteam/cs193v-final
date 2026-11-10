import { SLOTS } from "../src/lib/constraints";
import { ACCEPT_AT, RELUCTANT_AT, type Proposal } from "../src/lib/evaluate";
import { candidateKey, candidatePool } from "../src/lib/mediator";
import { NEUTRAL_CUISINE, type Preferences } from "../src/lib/preferences";
import type { Restaurant } from "../src/lib/restaurants";

/**
 * The "no privacy" LLM baseline.
 *
 * Claude is handed EVERY member's preference file plus the full candidate list
 * ((restaurant, open slot) pairs with price, travel, cuisine and flags) and is
 * asked to pick the single best plan for the group in one shot. It is the
 * opposite end of the privacy spectrum from the protocol: the mediator reads
 * nothing, this reads everything. The oracle (brute force over the same data)
 * is the upper bound for both.
 *
 * Key-gated: nothing here runs unless a caller passes an API key. Uses fetch
 * against the Messages API the same way src/lib/extract.ts does, with a tool
 * call forced so the answer is a {restaurantId, slot} object, never prose.
 * The pick is validated against the candidate pool; anything else is null.
 */

export const DEFAULT_LLM_MODEL = "claude-haiku-5-5";
export const DEFAULT_LLM_TIMEOUT_MS = 30_000;

export type LlmBaselineGroup = { prefs: Preferences[]; restaurants: Restaurant[] };

export type LlmBaselineOptions = {
  apiKey: string;
  /** Defaults to ANTHROPIC_MODEL, then claude-haiku-5-5. */
  model?: string;
  /** Per-call timeout; the request is aborted after this. */
  timeoutMs?: number;
};

export const PICK_TOOL = {
  name: "pick_plan",
  description:
    "Commit to the single best (restaurant, slot) plan for the whole group. Both fields must come from the candidate list.",
  input_schema: {
    type: "object",
    properties: {
      restaurantId: { type: "string", description: "The id of a restaurant from the candidate list." },
      slot: { type: "string", enum: [...SLOTS], description: "A slot the chosen restaurant is open for." },
    },
    required: ["restaurantId", "slot"],
    additionalProperties: false,
  },
} as const;

const SYSTEM_PROMPT = `You are planning one group meal. Unlike the people's own assistants, you are allowed to read everyone's full preferences. Pick the single (restaurant, slot) plan that is best for the group as a whole.

How a preference file is scored (this is exactly how each person's assistant would judge a plan):
- "hard" rules are absolute. A plan that violates any member's hard rule is unacceptable for the group, whatever else is true.
  - time/in: the slot must be in the list.
  - price/<=: the restaurant's pricePerPerson must not exceed the value.
  - distance/<=: the restaurant's travelMin must not exceed the value.
  - diet/requires: no_spicy forbids spicy=true; vegetarian needs vegetarianFriendly=true; no_seafood forbids seafoodHeavy=true; halal needs halal=true.
- "soft" rules each give a satisfaction in 0..1, and the person's utility is the weighted mean (weights as given).
  - price and distance: satisfaction is 1 at or below "ideal", then falls linearly to 0 at ideal + tolerance.
  - cuisine: 1 if the cuisine is in "prefer", avoidScore if it is in "avoid", otherwise ${NEUTRAL_CUISINE}.
- A person accepts at utility >= ${ACCEPT_AT}, is reluctant at >= ${RELUCTANT_AT}, and rejects below that.

Choose the plan that maximises the product of all members' utilities (Nash welfare) among plans that violate nobody's hard rule. If several are equal, prefer the one whose worst-off member is best off. Only consider pairs that appear in the candidate list. Always answer by calling the pick_plan tool, nothing else.`;

type CandidateView = {
  restaurantId: string;
  slot: string;
  name: string;
  cuisine: string;
  pricePerPerson: number;
  travelMin: number;
  spicy: boolean;
  vegetarianFriendly: boolean;
  seafoodHeavy: boolean;
  halal: boolean;
};

/** The user turn: everything, in JSON. Exported so tests can check what the model is shown. */
export function buildPrompt(group: LlmBaselineGroup): { system: string; user: string; candidateKeys: Set<string> } {
  const pool = candidatePool([...group.restaurants]);
  const candidates: CandidateView[] = pool.map(({ r, slot }) => ({
    restaurantId: r.id,
    slot,
    name: r.name,
    cuisine: r.cuisine,
    pricePerPerson: r.pricePerPerson,
    travelMin: r.travelMin,
    spicy: r.spicy,
    vegetarianFriendly: r.vegetarianFriendly,
    seafoodHeavy: r.seafoodHeavy,
    halal: r.halal,
  }));
  const user = JSON.stringify(
    {
      members: group.prefs.map((p, i) => ({ member: i, preferences: p })),
      candidates,
    },
    null,
    0,
  );
  return { system: SYSTEM_PROMPT, user, candidateKeys: new Set(pool.map(candidateKey)) };
}

type MessagesResponse = {
  content?: { type: string; name?: string; input?: unknown }[];
  stop_reason?: string;
};

/** Parse and validate the model's answer. Exported for tests. Null for anything that is not a real candidate. */
export function parsePick(data: MessagesResponse, candidateKeys: ReadonlySet<string>): Proposal | null {
  const block = data.content?.find((b) => b.type === "tool_use");
  const input = block?.input;
  if (!input || typeof input !== "object") return null;
  const { restaurantId, slot } = input as { restaurantId?: unknown; slot?: unknown };
  if (typeof restaurantId !== "string" || typeof slot !== "string") return null;
  if (!(SLOTS as readonly string[]).includes(slot)) return null;
  if (!candidateKeys.has(`${restaurantId}@${slot}`)) return null;
  return { restaurantId, slot: slot as Proposal["slot"] };
}

async function callMessages(body: Record<string, unknown>, apiKey: string, timeoutMs: number): Promise<Response> {
  // Looked up at call time (not import time) so tests can stub globalThis.fetch.
  return fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
}

/**
 * One call, one plan. Throws on transport / HTTP failure (the caller decides
 * how to record that); resolves null when the model's pick is not a candidate.
 */
export async function llmBaselinePick(group: LlmBaselineGroup, opts: LlmBaselineOptions): Promise<Proposal | null> {
  const model = opts.model || process.env.ANTHROPIC_MODEL || DEFAULT_LLM_MODEL;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS;
  const { system, user, candidateKeys } = buildPrompt(group);
  const body = {
    model,
    max_tokens: 1024,
    system,
    tools: [PICK_TOOL],
    tool_choice: { type: "tool", name: PICK_TOOL.name },
    messages: [{ role: "user", content: user }],
  };
  let res = await callMessages(body, opts.apiKey, timeoutMs);
  if (res.status === 400) {
    // Newer models reject forced tool_choice; the prompt already says to call the tool, so retry with auto.
    const text = await res.text();
    if (!/tool_choice/i.test(text)) throw new Error(`Anthropic API 400: ${text.slice(0, 200)}`);
    res = await callMessages({ ...body, tool_choice: { type: "auto" } }, opts.apiKey, timeoutMs);
  }
  if (!res.ok) throw new Error(`Anthropic API ${res.status}`);
  const data = (await res.json()) as MessagesResponse;
  return parsePick(data, candidateKeys);
}

/**
 * Run `fn` over `items` with at most `concurrency` in flight, preserving order.
 * Small and local so the harness needs no extra dependency.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}
