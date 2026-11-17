import { z } from "zod";
import type { MissingField } from "./constraints";
import type { MemberState } from "./member-state";
import type { ChatTurn } from "./extract";
import type { ResolvedPool } from "./places";
import type { Preferences } from "./preferences";
import type { Restaurant } from "./restaurants";
import { meal } from "./scenario-meal";

/**
 * A scenario is what a group is deciding: today only a meal.
 *
 * Everything outside the negotiation engine that depends on the kind of plan
 * goes through a `Scenario`: what the private chat collects, how the
 * assistant talks, where the candidates come from, and how one person's
 * answers become the `Preferences` contract. Data access (events.ts,
 * pool.ts) and the pages look the scenario up from the plan and
 * never import a scenario's modules directly, so a second scenario is added
 * here and nowhere else.
 *
 * The types are still the meal's (`MemberState`, `Restaurant`): with one
 * scenario there is nothing to generalise against yet. They widen when the
 * second scenario lands. The methods keep the word "constraints" for what is
 * stored per member; since #83 that is the member's state (member-state.ts).
 */

export const SCENARIOS = ["meal"] as const;
export type ScenarioId = (typeof SCENARIOS)[number];
export const DEFAULT_SCENARIO: ScenarioId = "meal";
export const ScenarioIdSchema = z.enum(SCENARIOS, "Pick what the group is deciding");

export type Scenario = {
  id: ScenarioId;
  /** What the plan creator sees when choosing what the group is deciding. */
  label: string;

  /** The assistant's first message in every private chat. */
  openingMessage: string;
  /** What a member's constraints look like before they have said anything. */
  emptyConstraints(): MemberState;
  /** Validate constraints read back from storage. */
  parseConstraints(raw: unknown): MemberState;
  /** What still has to be settled; a member cannot be "done" while any remain. */
  missingFields(c: MemberState): MissingField[];
  /** Human-readable summary, shown ONLY to the owner of these constraints. */
  describeConstraints(c: MemberState): string[];
  /** One turn of the private chat: the assistant's reply and the constraints after it. */
  chatTurn(
    history: ChatTurn[],
    current: MemberState,
    pool: readonly Restaurant[],
    /** `allowLLM: false` once the plan has used up its LLM budget: answer with the rule-based extractor. */
    options?: { allowLLM?: boolean },
    /** `changed`: what the member wants is different now, not just the chat's bookkeeping. */
  ): Promise<{ reply: string; constraints: MemberState; changed: boolean }>;

  /** Candidates for a plan with no location, or when live data is unavailable. */
  seedPool: Restaurant[];
  /** Candidates near `location` that can take the group on `date` (YYYY-MM-DD), falling back to the seed pool. */
  resolvePool(location: string | null, date: string): Promise<ResolvedPool>;

  /** One person's constraints as the negotiation contract. */
  compile(c: MemberState): Preferences;
};

const REGISTRY: Record<ScenarioId, Scenario> = { meal };

export function scenarioFor(id: ScenarioId): Scenario {
  return REGISTRY[id];
}

/** The scenario stored on a plan row. Anything unrecognised reads as the default. */
export function parseScenarioId(raw: unknown): ScenarioId {
  const parsed = ScenarioIdSchema.safeParse(raw);
  return parsed.success ? parsed.data : DEFAULT_SCENARIO;
}
