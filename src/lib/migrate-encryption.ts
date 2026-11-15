import { db } from "./db";
import { blindIndex, decrypt, decryptOrPlain, encrypt, isCurrent, scope, type Scope } from "./crypto";

/**
 * Rewrites every value stored before per-scope keys (see crypto.ts) in the current format:
 * values encrypted with the master key are re-encrypted with their own scope's key, and
 * columns that used to be plaintext (names, plan title / location / date / pool / result) are
 * encrypted. Values already current are left alone, so it is safe to run more than once.
 * Re-encryption happens in memory, row by row; nothing decrypted is written anywhere else.
 */
export async function migrateEncryption(): Promise<Record<string, number>> {
  const client = await db();
  const counts: Record<string, number> = { users: 0, members: 0, messages: 0, events: 0 };
  const upgrade = (v: unknown, s: Scope, wasPlain: boolean) => {
    const raw = String(v);
    if (isCurrent(raw)) return raw;
    return encrypt(wasPlain ? raw : decrypt(raw, s), s);
  };
  const stale = (...vals: unknown[]) => vals.some((v) => v !== null && v !== undefined && !isCurrent(String(v)));

  for (const u of (await client.execute("SELECT id, email_enc, display_name FROM users")).rows) {
    if (!stale(u.email_enc, u.display_name)) continue;
    const id = String(u.id);
    const email = decrypt(String(u.email_enc), scope.email(id));
    await client.execute({
      sql: "UPDATE users SET email_index = ?, email_enc = ?, display_name = ? WHERE id = ?",
      args: [
        blindIndex(email, "email"),
        encrypt(email, scope.email(id)),
        upgrade(u.display_name, scope.displayName(id), true),
        id,
      ],
    });
    counts.users++;
  }

  for (const m of (await client.execute("SELECT event_id, user_id, constraints_enc FROM members")).rows) {
    if (!stale(m.constraints_enc)) continue;
    const [e, u] = [String(m.event_id), String(m.user_id)];
    await client.execute({
      sql: "UPDATE members SET constraints_enc = ? WHERE event_id = ? AND user_id = ?",
      args: [upgrade(m.constraints_enc, scope.constraints(e, u), false), e, u],
    });
    counts.members++;
  }

  for (const m of (await client.execute("SELECT id, event_id, user_id, content_enc FROM messages")).rows) {
    if (!stale(m.content_enc)) continue;
    await client.execute({
      sql: "UPDATE messages SET content_enc = ? WHERE id = ?",
      args: [upgrade(m.content_enc, scope.chat(String(m.event_id), String(m.user_id)), false), m.id],
    });
    counts.messages++;
  }

  for (const ev of (await client.execute("SELECT id, title, location, event_date, pool_json, result_json FROM events"))
    .rows) {
    if (!stale(ev.title, ev.location, ev.event_date, ev.pool_json, ev.result_json)) continue;
    const id = String(ev.id);
    const opt = (v: unknown, field: "location" | "date" | "pool" | "result") =>
      v === null || v === undefined ? null : upgrade(v, scope.plan(id, field), true);
    await client.execute({
      sql: "UPDATE events SET title = ?, location = ?, event_date = ?, pool_json = ?, result_json = ? WHERE id = ?",
      args: [
        upgrade(ev.title, scope.plan(id, "title"), true),
        opt(ev.location, "location"),
        opt(ev.event_date, "date"),
        opt(ev.pool_json, "pool"),
        opt(ev.result_json, "result"),
        id,
      ],
    });
    counts.events++;
  }
  // Sanity check: every name now opens with its own key.
  for (const u of (await client.execute("SELECT id, display_name FROM users")).rows)
    decryptOrPlain(String(u.display_name), scope.displayName(String(u.id)));
  return counts;
}
