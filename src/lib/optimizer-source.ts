import "server-only";
import { decryptJson } from "./crypto";
import { db } from "./db";
import { assembleOptimizerInput, type OptimizerInput } from "./optimizer-handoff";
import { todayPacific } from "./plan-date";
import { poolForEvent } from "./pool";
import { scenarioFor } from "./scenario";

/**
 * Reads one plan out of storage as the optimizer's input (#107).
 *
 * This is the one place that decrypts everyone's preferences together, because the optimizer
 * is the one program that is meant to see them together. What it returns has no names, no
 * user ids, no chat text and no start points (see optimizer-handoff.ts); it must only ever be
 * passed to the optimizer, never to a page or a log.
 *
 * `ready` and `members` are counts, so the caller can refuse to run before everyone is done.
 */
export async function loadOptimizerInput(
  eventId: string,
): Promise<{ input: OptimizerInput; members: number; ready: number }> {
  const client = await db();
  const event = await client.execute({
    sql: "SELECT location, event_date FROM events WHERE id = ?",
    args: [eventId],
  });
  if (event.rows.length === 0) throw new Error("No such plan");
  const { rows } = await client.execute({
    sql: "SELECT constraints_enc, ready FROM members WHERE event_id = ? ORDER BY joined_at",
    args: [eventId],
  });
  if (rows.length === 0) throw new Error("The plan has no members");
  const { restaurants, scenario } = await poolForEvent(eventId);
  const parse = scenarioFor(scenario).parseConstraints;
  const members = rows.map((row) => {
    const state = parse(decryptJson(String(row.constraints_enc)));
    return { prefs: state.prefs, startPoint: state.startPoint };
  });
  const location = event.rows[0].location;
  const date = event.rows[0].event_date;
  const input = assembleOptimizerInput({
    date: date ? String(date) : todayPacific(),
    location: location ? String(location) : null,
    restaurants,
    members,
  });
  return { input, members: rows.length, ready: rows.filter((r) => Number(r.ready) === 1).length };
}
