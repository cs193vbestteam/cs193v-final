import "server-only";
import { decryptJson, decryptOrPlain, scope } from "./crypto";
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
 * user ids, no chat text, no start points and no times of day (see optimizer-handoff.ts); it must only ever be
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
    sql: "SELECT user_id, constraints_enc, ready, ready_at FROM members WHERE event_id = ? ORDER BY joined_at",
    args: [eventId],
  });
  if (rows.length === 0) throw new Error("The plan has no members");
  const { places: restaurants, scenario } = await poolForEvent(eventId);
  const parse = scenarioFor(scenario).parseConstraints;
  const members = rows.map((row) => {
    const state = parse(decryptJson(String(row.constraints_enc), scope.constraints(eventId, String(row.user_id))));
    const finishedAt = Number(row.ready) === 1 && row.ready_at != null ? Number(row.ready_at) : null;
    return { prefs: state.prefs, startPoint: state.startPoint, finishedAt };
  });
  // Each value opens only with this plan's key for that field (crypto.ts).
  const { location: loc, event_date: day } = event.rows[0];
  const location = loc ? decryptOrPlain(String(loc), scope.plan(eventId, "location")) : null;
  const date = day ? decryptOrPlain(String(day), scope.plan(eventId, "date")) : null;
  const input = assembleOptimizerInput({
    date: date ?? todayPacific(),
    location,
    restaurants,
    members,
  });
  return { input, members: rows.length, ready: rows.filter((r) => Number(r.ready) === 1).length };
}
