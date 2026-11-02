import "server-only";
import { db } from "./db";
import { decryptJson } from "./crypto";
import { ConstraintsSchema } from "./constraints";
import { makeAgent, type Agent } from "./agent";
import { poolForEvent } from "./pool";
import { compile } from "./preferences";

/**
 * The only place that turns stored (encrypted) preferences into something the
 * negotiation can call. It hands out opaque Agents, never the preferences.
 *
 * Isolation is structural, not a prompt: negotiate.ts / mediator.ts /
 * evaluate.ts cannot import this module or the database (enforced by
 * tests/isolation.test.ts), and this module exports nothing that returns a
 * preference value.
 */
export async function agentsForEvent(eventId: string): Promise<{ agents: Agent[]; userIds: string[]; readyCount: number }> {
  const client = await db();
  const { rows } = await client.execute({
    sql: "SELECT user_id, constraints_enc, ready FROM members WHERE event_id = ? ORDER BY joined_at",
    args: [eventId],
  });
  const { restaurants } = await poolForEvent(eventId);
  const lookup = (id: string) => restaurants.find((r) => r.id === id);
  const agents: Agent[] = [];
  const userIds: string[] = [];
  let readyCount = 0;
  for (const row of rows) {
    const constraints = ConstraintsSchema.parse(decryptJson(String(row.constraints_enc)));
    agents.push(makeAgent(compile(constraints), lookup));
    userIds.push(String(row.user_id));
    if (Number(row.ready) === 1) readyCount++;
  }
  return { agents, userIds, readyCount };
}
