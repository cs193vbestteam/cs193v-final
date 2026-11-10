import { z } from "zod";
import type { LlmBudget } from "./agent-llm";
import { anthropicKey, callTool, llmNegotiationEnabled } from "./anthropic";
import { SLOT_LABELS } from "./constraints";
import type { Candidate, RoundFeedback, Selector } from "./mediator";
import type { FinalPicker } from "./negotiate";
import type { Restaurant } from "./restaurants";

/**
 * The LLM mediator (#53): it proposes each round's options and makes the final pick.
 *
 * It sees exactly what the code mediator sees: the public candidate pool and anonymous
 * tallies (how many accepted / were reluctant / rejected, and which dimension they named).
 * Never a preference, a name or who said what. Code keeps it honest:
 *   - proposals can only come from the shortlist the code built (propose() drops the rest);
 *   - the final pick must be one of the finalists, all of which nobody rejected;
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

const PICKER_SYSTEM =
  "You are the mediator for a group choosing a restaurant and a time, and you make the final pick among the " +
  "finalists. Nobody rejected any of them. For each you see public facts, how many people accepted or were " +
  "reluctant, and its group score relative to the best one (higher is better for the group as a whole). " +
  "Choose the plan that is best for the group, normally the highest score; a slightly lower score is fine only " +
  "with a clear reason (e.g. everyone accepted it rather than some being reluctant). Then write ONE short, warm " +
  "sentence for the group saying why this plan. Never mention votes, reluctance, objections, scores or any " +
  "individual: describe the plan itself (time, cuisine, price, distance). Always call the tool.";

/** Words that would turn the group's explanation into a hint about individual answers. */
export const REVEALING =
  /\b(reluctan\w*|reject\w*|object\w*|vote\w*|scor\w*|someone|somebody|one of you|one person|a person|except|everyone but|not everyone|tally|tallies)\b/i;

const Ids = z.object({ ids: z.array(z.number().int()) });
const Pick = z.object({ id: z.number().int(), explanation: z.string().min(1).max(400) });

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

export function llmFinalPicker(
  apiKey: string,
  lookup: (id: string) => Restaurant | undefined,
  budget?: LlmBudget,
): FinalPicker {
  return async (finalists) => {
    if (finalists.length === 0) return null;
    if (budget && !(await budget())) return null;
    const options = finalists.map((f, i) => {
      const r = lookup(f.proposal.restaurantId);
      return {
        id: i,
        ...(r ? publicFacts(r, f.proposal.slot) : { restaurant: f.proposal.restaurantId }),
        accepted: f.tally.accept,
        reluctant: f.tally.reluctant,
        groupScoreRelativeToBest: f.relative,
      };
    });
    const out = await callTool({
      apiKey,
      system: PICKER_SYSTEM,
      user: JSON.stringify({ finalists: options }),
      tool: {
        name: "choose_plan",
        description: "Choose one finalist and explain the choice to the group.",
        input_schema: {
          type: "object",
          properties: {
            id: { type: "integer" },
            explanation: { type: "string", description: "One short sentence for the group." },
          },
          required: ["id", "explanation"],
        },
      },
      maxTokens: 200,
    });
    const parsed = Pick.safeParse(out);
    if (!parsed.success) return null;
    // The sentence is shown to the group: drop it if it hints at who objected to what.
    const explanation = REVEALING.test(parsed.data.explanation) ? "" : parsed.data.explanation;
    return { index: parsed.data.id, explanation };
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

/** The final picker to use in production, if any. negotiate() keeps the code's pick on any failure. */
export function configuredFinalPicker(
  lookup: (id: string) => Restaurant | undefined,
  budget?: LlmBudget,
): FinalPicker | undefined {
  const key = anthropicKey();
  return key && llmNegotiationEnabled() ? llmFinalPicker(key, lookup, budget) : undefined;
}
