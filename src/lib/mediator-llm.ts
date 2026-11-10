import type { Candidate, RoundFeedback, Selector } from "./mediator";

/**
 * Optional LLM re-ranker for the mediator. It only ever sees the public
 * shortlist the code produced plus anonymised tallies, and it can only pick
 * from that shortlist (propose() discards anything else). Scoring never
 * involves it. Enabled with ANTHROPIC_API_KEY + SETTLE_LLM_MEDIATOR=1.
 */
export function llmSelector(apiKey: string, model = process.env.ANTHROPIC_MODEL || "claude-haiku-5-5"): Selector {
  return async (shortlist: Candidate[], history: RoundFeedback[], k: number) => {
    const options = shortlist.map((c, i) => ({
      id: i,
      name: c.r.name,
      cuisine: c.r.cuisine,
      pricePerPerson: c.r.pricePerPerson,
      travelMin: c.r.travelMin,
      slot: c.slot,
    }));
    const feedback = history.map((round) => ({
      round: round.round,
      proposals: round.proposals.map((p) => ({
        restaurant: shortlist.find((c) => c.r.id === p.proposal.restaurantId)?.r.name ?? p.proposal.restaurantId,
        slot: p.proposal.slot,
        accept: p.tally.accept,
        reluctant: p.tally.reluctant,
        reject: p.tally.reject,
        reluctantAbout: p.tally.dims,
        rejectedFor: p.tally.rejectDims,
      })),
    }));
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model,
        max_tokens: 200,
        system:
          "You help a group pick a restaurant without knowing anyone's preferences. You see anonymous tallies from earlier rounds " +
          "(how many accepted / were reluctant / rejected, and which dimension they named) and a shortlist of untried options. " +
          `Pick the ${k} options most likely to be accepted by everyone, favouring variety when the tallies are uninformative. ` +
          "Always call the tool.",
        tools: [
          {
            name: "pick",
            description: "Choose option ids from the shortlist.",
            input_schema: { type: "object", properties: { ids: { type: "array", items: { type: "integer" } } }, required: ["ids"] },
          },
        ],
        tool_choice: { type: "tool", name: "pick" },
        messages: [{ role: "user", content: JSON.stringify({ feedback, options }) }],
      }),
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) throw new Error(`Anthropic API ${res.status}`);
    const data = (await res.json()) as { content?: { type: string; input?: { ids?: unknown } }[] };
    const ids = data.content?.find((b) => b.type === "tool_use")?.input?.ids;
    if (!Array.isArray(ids)) return [];
    return ids.filter((i): i is number => Number.isInteger(i) && i >= 0 && i < shortlist.length).map((i) => shortlist[i]);
  };
}

/** The selector to use in production, if any. */
export function configuredSelector(): Selector | undefined {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || process.env.SETTLE_LLM_MEDIATOR !== "1") return undefined;
  const inner = llmSelector(key);
  // Any failure falls back to the code's own shortlist order.
  return async (list, history, k) => {
    try {
      return await inner(list, history, k);
    } catch (err) {
      console.error("LLM mediator failed, using code ranking:", (err as Error).message);
      return [];
    }
  };
}
