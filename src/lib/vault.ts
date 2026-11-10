import "server-only";
import { db } from "./db";
import { decryptJson } from "./crypto";
import { makeAgent, maskGroup, type Agent, type PrivateAgent } from "./agent";
import { poolForEvent } from "./pool";
import { scenarioFor } from "./scenario";

/**
 * The only place that turns stored (encrypted) preferences into something the
 * negotiation can call. It hands out opaque Agents, never the preferences.
 *
 * Isolation is structural, not a prompt: negotiate.ts / mediator.ts /
 * evaluate.ts cannot import this module or the database (enforced by
 * tests/isolation.test.ts), and this module exports nothing that returns a
 * preference value.
 */
export async function agentsForEvent(
  eventId: string,
): Promise<{ agents: Agent[]; userIds: string[]; readyCount: number }> {
  const client = await db();
  const { rows } = await client.execute({
    sql: "SELECT user_id, constraints_enc, ready FROM members WHERE event_id = ? ORDER BY joined_at",
    args: [eventId],
  });
  const { restaurants, scenario: scenarioId } = await poolForEvent(eventId);
  const scenario = scenarioFor(scenarioId);
  const lookup = (id: string) => restaurants.find((r) => r.id === id);
  const members: PrivateAgent[] = [];
  const userIds: string[] = [];
  let readyCount = 0;
  for (const row of rows) {
    const constraints = scenario.parseConstraints(decryptJson(String(row.constraints_enc)));
    members.push(makeAgent(scenario.compile(constraints), lookup, constraints.startPoint));
    userIds.push(String(row.user_id));
    if (Number(row.ready) === 1) readyCount++;
  }
  // Masked as a group before leaving this module: what the mediator holds can answer
  // accept / reluctant / reject and take part in a masked sum, and cannot state a bucket.
  return { agents: maskGroup(members), userIds, readyCount };
}
