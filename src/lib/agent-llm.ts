import { z } from "zod";
import { callTool } from "./anthropic";
import { SLOT_LABELS, SOFT_DIM_LABELS } from "./constraints";
import { evaluate, utility, type Dim, type Judgement, type Proposal } from "./evaluate";
import { relax, type Preferences } from "./preferences";
import type { Restaurant } from "./restaurants";

/**
 * A person's assistant, LLM-driven (#53). It judges a whole round of proposals in one call.
 *
 * Privacy: the closure holds ONE person's own words and preferences (built in vault.ts) and
 * the public facts about each proposal. Nothing about anyone else ever enters its prompt,
 * and what leaves is the same as the code agent's: a verdict and at most one dimension name.
 *
 * Guardrails, in code, after the model answers:
 *   - a proposal that breaks a hard rule (not free then, over the most they'd pay, too far,
 *     their diet flags, closed) is a reject whatever the model said;
 *   - anything missing, malformed or late falls back to the code agent's verdict;
 *   - each call is checked against the plan's LLM budget first (#4).
 */

export type LlmBudget = () => Promise<boolean>;

const DIMS = ["time", "price", "diet", "distance", "cuisine"] as const;

const Output = z.object({
  verdicts: z.array(
    z.object({
      id: z.number().int(),
      verdict: z.enum(["accept", "reluctant", "reject"]),
      dim: z.enum(DIMS).nullish(),
    }),
  ),
});

const TOOL = {
  name: "judge_options",
  description: "Give this person's verdict on every option.",
  input_schema: {
    type: "object",
    properties: {
      verdicts: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "integer" },
            verdict: { type: "string", enum: ["accept", "reluctant", "reject"] },
            dim: {
              type: "string",
              enum: [...DIMS],
              description: "The ONE main problem, for reluctant or reject. Omit for accept.",
            },
          },
          required: ["id", "verdict"],
        },
      },
    },
    required: ["verdicts"],
  },
};

export const AGENT_SYSTEM = `You are the private assistant of ONE person in a group that is choosing a restaurant and a time.
You know only this person: what they told you in their private chat, summarised below. Judge each option the way they would.
- accept: they'd be happy to go.
- reluctant: they'd go, but it's a stretch. Name the ONE main problem (time, price, diet, distance or cuisine).
- reject: it doesn't work for them. Name the ONE main problem.
Take their own words seriously: something they avoid or are allergic to rules out places likely to serve it (dim "diet");
a cuisine they dislike makes it a stretch or a no; what they said matters most weighs most.
Never accept an option they are not free for, that costs more than the most they'd pay, or that is far beyond their travel limit.
If they have been asked to be more flexible on something, be more forgiving about exactly that, and nothing else.
Always call the tool, with one verdict per option id.`;

export type LlmJudgeArgs = {
  apiKey: string;
  /** The owner's constraints in their own words (describeConstraints), never anyone else's. */
  about: string[];
  prefs: Preferences;
  /** Resolves a proposal to the restaurant as THIS person travels to it. */
  resolve: (p: Proposal) => Restaurant | undefined;
  budget?: LlmBudget;
};

function codeVerdict(prefs: Preferences, r: Restaurant | undefined, p: Proposal, level: number): Judgement {
  return r ? evaluate(prefs, r, p.slot, level) : { verdict: "reject", dim: "time" };
}

/** The model's verdicts, made safe: hard rules win, bad or missing answers fall back to code. */
export function guard(
  prefs: Preferences,
  proposals: readonly Proposal[],
  restaurants: readonly (Restaurant | undefined)[],
  level: number,
  modelOut: unknown,
): Judgement[] {
  const parsed = Output.safeParse(modelOut);
  const byId = new Map(parsed.success ? parsed.data.verdicts.map((v) => [v.id, v]) : []);
  return proposals.map((p, i) => {
    const r = restaurants[i];
    if (!r) return { verdict: "reject", dim: "time" };
    const broken = utility(relax(prefs, level), r, p.slot).violated;
    if (broken) return { verdict: "reject", dim: broken };
    const v = byId.get(i);
    if (!v) return codeVerdict(prefs, r, p, level);
    if (v.verdict === "accept") return { verdict: "accept" };
    return v.dim ? { verdict: v.verdict, dim: v.dim as Dim } : { verdict: v.verdict };
  });
}

/** The prompt for one round: this person's own summary and the public facts of each option. */
export function agentPrompt(
  about: string[],
  prefs: Preferences,
  proposals: readonly Proposal[],
  restaurants: readonly (Restaurant | undefined)[],
  level: number,
): string {
  const flexible = prefs.concession_order.slice(0, level).map((d) => SOFT_DIM_LABELS[d]);
  const options = proposals.map((p, i) => {
    const r = restaurants[i];
    return r
      ? {
          id: i,
          restaurant: r.name,
          cuisine: r.cuisine,
          when: SLOT_LABELS[p.slot],
          pricePerPerson: r.pricePerPerson,
          travelMinutes: Math.round(r.travelMin),
          spicyMenu: r.spicy,
          mostlySeafood: r.seafoodHeavy,
          vegetarianFriendly: r.vegetarianFriendly,
          halal: r.halal,
        }
      : { id: i, unknown: true };
  });
  return JSON.stringify({
    whatThisPersonToldYou: about,
    askedToBeMoreFlexibleAbout: flexible,
    options,
  });
}

/** judgeAll for one person: one LLM call per round, guarded, with code as the fallback. */
export function llmJudge(args: LlmJudgeArgs) {
  return async (proposals: readonly Proposal[], level: number): Promise<Judgement[]> => {
    const restaurants = proposals.map(args.resolve);
    const fallback = () => proposals.map((p, i) => codeVerdict(args.prefs, restaurants[i], p, level));
    if (proposals.length === 0) return [];
    if (args.budget && !(await args.budget())) return fallback();
    try {
      const out = await callTool({
        apiKey: args.apiKey,
        system: AGENT_SYSTEM,
        user: agentPrompt(args.about, args.prefs, proposals, restaurants, level),
        tool: TOOL,
        maxTokens: 400,
      });
      return guard(args.prefs, proposals, restaurants, level, out);
    } catch (err) {
      console.error("LLM agent failed, using the code verdicts:", (err as Error).message);
      return fallback();
    }
  };
}
