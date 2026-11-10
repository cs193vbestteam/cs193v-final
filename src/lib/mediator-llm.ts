import { z } from "zod";
import type { LlmBudget } from "./agent-llm";
import { anthropicKey, callTool, llmNegotiationEnabled } from "./anthropic";
import { SLOT_LABELS } from "./constraints";
import type { Candidate, RoundFeedback, Selector } from "./mediator";
import type { Explainer } from "./negotiate";
import type { Restaurant } from "./restaurants";

/**
 * The LLM side of the mediator (#55): it proposes each round's options and explains the
 * final plan to the group. The final pick itself stays in code (Nash product, negotiate.ts).
 *
 * It sees exactly what the code mediator sees: the public candidate pool and anonymous
 * tallies (how many accepted / were reluctant / rejected, and which dimension they named).
 * Never a preference, a name or who said what. Code keeps it honest:
 *   - proposals can only come from the shortlist the code built (propose() drops the rest);
 *   - the explainer only describes the plan the code picked, from its public facts;
 *   - any failure, timeout or exhausted budget falls back to the code's own choice.
 *
 * On by default when ANTHROPIC_API_KEY is set; SETTLE_LLM_NEGOTIATION=0 turns it off.
 * SETTLE_LLM_MEDIATOR=1 still turns on the proposer alone, as before.
 */

const PROPOSER_SYSTEM =
  "You are the mediator for a group choosing a restaurant and a time. You never learn anyone's preferences: " +
  "you see anonymous tallies from earlier rounds (how many accepted / were reluctant / rejected, and which " +
  "dimension they named: time, price, diet, distance or cuisine) and a shortlist of untried options. " +
  "Pick the options most likely to be accepted by everyone, learning from the tallies (e.g. price rejects mean " +
  "go cheaper) and favouring variety when they say little. Always call the tool.";

const EXPLAINER_SYSTEM =
  "A group has just settled on a plan for a meal together. Write ONE short, warm sentence for the group about " +
  "why this plan works (time, cuisine, price, distance). You know only the plan itself: never mention votes, " +
  "objections, scores, or any individual. Always call the tool.";

/** Words that would turn the group's explanation into a hint about individual answers. */
export const REVEALING =
  /\b(reluctan\w*|reject\w*|object\w*|vote\w*|scor\w*|someone|somebody|one of you|one person|a person|except|everyone but|not everyone|tally|tallies)\b/i;

const Ids = z.object({ ids: z.array(z.number().int()) });
const Sentence = z.object({ explanation: z.string().min(1).max(400) });

const publicFacts = (r: Restaurant, slot: Candidate["slot"]) => ({
  name: r.name,
  cuisine: r.cuisine,
  when: SLOT_LABELS[slot],
  pricePerPerson: r.pricePerPerson,
  travelMinFromPlanLocation: Math.round(r.travelMin),
});

/** The anonymous history, keyed by restaurant name. */
function feedbackOf(history: RoundFeedback[], lookup: (id: string) => Restaurant | undefined) {
  return history.map((round) => ({
    round: round.round,
    proposals: round.proposals.map((p) => ({
      restaurant: lookup(p.proposal.restaurantId)?.name ?? p.proposal.restaurantId,
      when: SLOT_LABELS[p.proposal.slot],
      accept: p.tally.accept,
      reluctant: p.tally.reluctant,
      reject: p.tally.reject,
      reluctantAbout: p.tally.dims,
      rejectedFor: p.tally.rejectDims,
    })),
  }));
}

export function llmSelector(
  apiKey: string,
  lookup: (id: string) => Restaurant | undefined = () => undefined,
  budget?: LlmBudget,
): Selector {
  return async (shortlist: Candidate[], history: RoundFeedback[], k: number) => {
    if (budget && !(await budget())) return [];
    const options = shortlist.map((c, i) => ({ id: i, ...publicFacts(c.r, c.slot) }));
    const out = await callTool({
      apiKey,
      system: `${PROPOSER_SYSTEM} Pick exactly ${k}.`,
      user: JSON.stringify({ feedback: feedbackOf(history, lookup), options }),
      tool: {
        name: "pick",
        description: "Choose option ids from the shortlist.",
        input_schema: {
          type: "object",
          properties: { ids: { type: "array", items: { type: "integer" } } },
          required: ["ids"],
        },
      },
      maxTokens: 200,
    });
    const parsed = Ids.safeParse(out);
    if (!parsed.success) return [];
    return parsed.data.ids.filter((i) => i >= 0 && i < shortlist.length).map((i) => shortlist[i]);
  };
}

/**
 * The sentence the group sees under the plan. The code has already picked the plan (highest
 * Nash product among the finalists); this only describes it, from its public facts alone.
 */
export function llmExplainer(
  apiKey: string,
  lookup: (id: string) => Restaurant | undefined,
  budget?: LlmBudget,
): Explainer {
  return async (chosen) => {
    const r = lookup(chosen.restaurantId);
    if (!r) return null;
    if (budget && !(await budget())) return null;
    const out = await callTool({
      apiKey,
      system: EXPLAINER_SYSTEM,
      user: JSON.stringify({ plan: publicFacts(r, chosen.slot) }),
      tool: {
        name: "explain_plan",
        description: "One short sentence for the group about the chosen plan.",
        input_schema: {
          type: "object",
          properties: { explanation: { type: "string" } },
          required: ["explanation"],
        },
      },
      maxTokens: 150,
    });
    const parsed = Sentence.safeParse(out);
    if (!parsed.success) return null;
    // The sentence is shown to the group: drop it if it hints at who objected to what.
    return REVEALING.test(parsed.data.explanation) ? null : parsed.data.explanation;
  };
}

/** The proposer to use in production, if any. Failures fall back to the code's own ranking. */
export function configuredSelector(
  lookup: (id: string) => Restaurant | undefined = () => undefined,
  budget?: LlmBudget,
): Selector | undefined {
  const key = anthropicKey();
  if (!key || !(llmNegotiationEnabled() || process.env.SETTLE_LLM_MEDIATOR === "1")) return undefined;
  const inner = llmSelector(key, lookup, budget);
  return async (list, history, k) => {
    try {
      return await inner(list, history, k);
    } catch (err) {
      console.error("LLM mediator failed, using code ranking:", (err as Error).message);
      return [];
    }
  };
}

/** The explainer to use in production, if any. negotiate() shows no sentence on any failure. */
export function configuredExplainer(
  lookup: (id: string) => Restaurant | undefined,
  budget?: LlmBudget,
): Explainer | undefined {
  const key = anthropicKey();
  return key && llmNegotiationEnabled() ? llmExplainer(key, lookup, budget) : undefined;
}
