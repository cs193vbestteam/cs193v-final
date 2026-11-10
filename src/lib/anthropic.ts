/**
 * One forced tool call to the Anthropic Messages API, for the negotiation's LLM parts
 * (agent-llm.ts, mediator-llm.ts). The caller validates what comes back; this only
 * moves bytes and fails loudly, so every caller can fall back to code.
 */

export type ToolSpec = { name: string; description: string; input_schema: Record<string, unknown> };

export function anthropicKey(): string | undefined {
  return process.env.ANTHROPIC_API_KEY || undefined;
}

export function anthropicModel(): string {
  return process.env.ANTHROPIC_MODEL || "claude-haiku-5-5";
}

/**
 * LLM-driven negotiation (per-person agents + mediator) is on whenever a key is set,
 * unless SETTLE_LLM_NEGOTIATION=0 switches back to the code-only protocol.
 */
export function llmNegotiationEnabled(): boolean {
  return !!anthropicKey() && process.env.SETTLE_LLM_NEGOTIATION !== "0";
}

export async function callTool(opts: {
  apiKey: string;
  system: string;
  user: string;
  tool: ToolSpec;
  maxTokens: number;
  timeoutMs?: number;
}): Promise<unknown> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": opts.apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: anthropicModel(),
      max_tokens: opts.maxTokens,
      system: opts.system,
      tools: [opts.tool],
      tool_choice: { type: "tool", name: opts.tool.name },
      messages: [{ role: "user", content: opts.user }],
    }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 12_000),
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}`);
  const data = (await res.json()) as { content?: { type: string; input?: unknown }[]; stop_reason?: string };
  // A reply cut off at the token limit is partial: treat it as a failure, not as a full answer.
  if (data.stop_reason === "max_tokens") throw new Error("Anthropic API: reply cut off at max_tokens");
  const block = data.content?.find((b) => b.type === "tool_use");
  if (!block) throw new Error("Anthropic API: no tool call in the reply");
  return block.input;
}
