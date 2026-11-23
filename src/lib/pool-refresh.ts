import "server-only";
import { matchRestaurant } from "./assistant";
import { decrypt, decryptJson, decryptOrPlain, encryptJson, scope } from "./crypto";
import { db } from "./db";
import type { MemberState } from "./member-state";
import type { NamedRestaurant } from "./optimizer-input";
import { todayPacific } from "./plan-date";
import { addNamedPlaces, extendPool, parsePoolMeta, wantedTypes } from "./pool-extend";
import type { Place } from "./restaurants";
import { parseScenarioId, scenarioFor } from "./scenario";

/**
 * Once everyone is done chatting: fetch the places for what the group asked for, and match the
 * restaurants people named against the completed pool (#101).
 *
 * This reads everyone's preferences together, like the optimizer's loader does, and for the
 * same kind of reason: which places to fetch depends on the whole group. What leaves this
 * module is only whether the pool grew. What it sends to Google is a list of place types.
 *
 * It never throws: a plan whose pool cannot be widened is decided with the pool it has.
 */
export async function refreshPool(
  eventId: string,
  key = process.env.GOOGLE_PLACES_API_KEY,
  fetcher: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const client = await db();
    const event = await client.execute({
      sql: "SELECT pool_json, pool_meta, pool_source, event_date, scenario FROM events WHERE id = ?",
      args: [eventId],
    });
    const row = event.rows[0];
    if (!key || !row?.pool_json || !row.pool_meta || row.pool_source !== "places") return false;
    // Each value opens only with this plan's key for that field (crypto.ts).
    const meta = parsePoolMeta(decrypt(String(row.pool_meta), scope.plan(eventId, "pool_meta")));
    if (!meta) return false;
    const places = JSON.parse(decryptOrPlain(String(row.pool_json), scope.plan(eventId, "pool"))) as Place[];

    const members = await client.execute({
      sql: "SELECT user_id, constraints_enc FROM members WHERE event_id = ?",
      args: [eventId],
    });
    const parse = scenarioFor(parseScenarioId(row.scenario)).parseConstraints;
    const states = members.rows.map((m) => ({
      userId: String(m.user_id),
      state: parse(decryptJson(String(m.constraints_enc), scope.constraints(eventId, String(m.user_id)))),
    }));

    const date = row.event_date ? decryptOrPlain(String(row.event_date), scope.plan(eventId, "date")) : todayPacific();
    const wanted = wantedTypes(states.map((s) => s.state.prefs));
    const byKind = await extendPool(places, meta, wanted, date, key, fetcher);
    // Then the restaurants people asked for by name that are still not in the pool.
    const named = states.flatMap((s) =>
      (s.state.prefs.wantedRestaurants ?? []).filter((r) => r.id === null).map((r) => r.name),
    );
    const byName = await addNamedPlaces(byKind.places, byKind.meta, named, matchRestaurant, date, key, fetcher);
    const out = {
      places: byName.places,
      meta: byName.meta,
      added: byKind.added + byName.added,
      calls: byKind.calls + byName.calls,
    };
    if (out.calls === 0) return false;

    await client.execute({
      sql: "UPDATE events SET pool_json = ?, pool_meta = ? WHERE id = ?",
      args: [
        encryptJson(out.places, scope.plan(eventId, "pool")),
        encryptJson(out.meta, scope.plan(eventId, "pool_meta")),
        eventId,
      ],
    });
    if (out.added === 0) return false;

    // A place somebody named that was not in the first pool may be in it now.
    await Promise.all(
      states.map(({ userId, state }) => {
        const next = rematched(state, out.places);
        return next
          ? client.execute({
              sql: "UPDATE members SET constraints_enc = ? WHERE event_id = ? AND user_id = ?",
              args: [encryptJson(next, scope.constraints(eventId, userId)), eventId, userId],
            })
          : null;
      }),
    );
    return true;
  } catch (err) {
    console.error("Could not widen the plan's pool:", (err as Error).message);
    return false;
  }
}

/** The state with every still-unmatched named restaurant matched against `places`; null when nothing changed. */
function rematched(state: MemberState, places: readonly Place[]): MemberState | null {
  let changed = false;
  const match = (list: NamedRestaurant[] | undefined) =>
    list?.map((r) => {
      if (r.id) return r;
      const id = matchRestaurant(r.name, places);
      if (id) changed = true;
      return id ? { ...r, id } : r;
    });
  const wantedRestaurants = match(state.prefs.wantedRestaurants);
  const excludedRestaurants = match(state.prefs.excludedRestaurants);
  if (!changed) return null;
  return {
    ...state,
    prefs: {
      ...state.prefs,
      ...(wantedRestaurants ? { wantedRestaurants } : {}),
      ...(excludedRestaurants ? { excludedRestaurants } : {}),
    },
  };
}
