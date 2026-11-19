import { dayOf, db } from "./db";
import {
  blindIndex,
  decrypt,
  decryptOrPlain,
  encrypt,
  encryptJson,
  isCurrent,
  isEncrypted,
  scope,
  type Scope,
} from "./crypto";
import { encryptStatus, readStatus, STATUS_COLUMNS } from "./member-status";
import { GLOBAL_PAYER, payerKey } from "./spend";

/**
 * Rewrites every value stored in an older format in the current one (see crypto.ts):
 * - values encrypted with the master key, or with their scope's key but without padding (v2),
 *   are re-encrypted with their own scope's key and padded;
 * - columns that used to be plaintext (names, plan title / location / date / pool / result) are
 *   encrypted;
 * - metadata that used to be plaintext is moved into encrypted columns: each member's status
 *   (done, joined / done / changed times) into members.status_enc, a plan's creation time and
 *   size into events.meta_enc, and its invite code into invite_enc with only a keyed hash left
 *   in invite_code; decided_at is cleared (the encrypted result carries it);
 * - housekeeping times (account and message creation) are cut to the day;
 * - spending rows and rate-limit counters stop naming user and plan ids.
 * Values already current are left alone, so it is safe to run more than once. Re-encryption
 * happens in memory, row by row; nothing decrypted is written anywhere else.
 */
export async function migrateEncryption(): Promise<Record<string, number>> {
  const client = await db();
  const counts: Record<string, number> = { users: 0, members: 0, messages: 0, events: 0, spend: 0, rateLimits: 0 };
  const upgrade = (v: unknown, s: Scope, wasPlain: boolean) => {
    const raw = String(v);
    if (isCurrent(raw)) return raw;
    if (isEncrypted(raw)) return encrypt(decrypt(raw, s), s); // v2: own key, no padding
    return encrypt(wasPlain ? raw : decrypt(raw, s), s);
  };
  const stale = (...vals: unknown[]) => vals.some((v) => v !== null && v !== undefined && !isCurrent(String(v)));

  await client.execute({ sql: "UPDATE users SET created_at = created_at - MOD(created_at, ?)", args: [86_400_000] });
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

  for (const m of (await client.execute(`SELECT event_id, user_id, constraints_enc, ${STATUS_COLUMNS} FROM members`))
    .rows) {
    if (!stale(m.constraints_enc, m.status_enc ?? "")) continue;
    const [e, u] = [String(m.event_id), String(m.user_id)];
    // readStatus falls back to the plaintext columns while status_enc is empty.
    const status = readStatus({ ...m, status_enc: m.status_enc ? m.status_enc : null }, e, u);
    await client.execute({
      sql: `UPDATE members SET constraints_enc = ?, status_enc = ?, ready = 0, joined_at = 0, ready_at = NULL,
              changed_at = NULL WHERE event_id = ? AND user_id = ?`,
      args: [upgrade(m.constraints_enc, scope.constraints(e, u), false), encryptStatus(status, e, u), e, u],
    });
    counts.members++;
  }

  await client.execute({ sql: "UPDATE messages SET created_at = created_at - MOD(created_at, ?)", args: [86_400_000] });
  for (const m of (await client.execute("SELECT id, event_id, user_id, content_enc FROM messages")).rows) {
    if (!stale(m.content_enc)) continue;
    await client.execute({
      sql: "UPDATE messages SET content_enc = ? WHERE id = ?",
      args: [upgrade(m.content_enc, scope.chat(String(m.event_id), String(m.user_id)), false), m.id],
    });
    counts.messages++;
  }

  for (const ev of (await client.execute("SELECT * FROM events")).rows) {
    const id = String(ev.id);
    const fresh = !ev.invite_enc || !ev.meta_enc || ev.decided_at !== null;
    if (
      !fresh &&
      !stale(
        ev.title,
        ev.location,
        ev.event_date,
        ev.pool_json,
        ev.pool_meta,
        ev.result_json,
        ev.invite_enc,
        ev.meta_enc,
      )
    )
      continue;
    const opt = (v: unknown, field: "location" | "date" | "pool" | "pool_meta" | "result") =>
      v === null || v === undefined ? null : upgrade(v, scope.plan(id, field), true);
    // A plaintext invite code becomes a keyed hash for lookup and an encrypted copy for display.
    const code = ev.invite_enc ? decrypt(String(ev.invite_enc), scope.plan(id, "invite")) : String(ev.invite_code);
    const meta = ev.meta_enc
      ? decrypt(String(ev.meta_enc), scope.plan(id, "meta"))
      : JSON.stringify({ createdAt: Number(ev.created_at ?? 0), maxMembers: Number(ev.max_members ?? 12) });
    // The result carries when it was decided; add it for results stored before it did.
    let result = ev.result_json === null || ev.result_json === undefined ? null : opt(ev.result_json, "result");
    if (result && ev.decided_at !== null && ev.decided_at !== undefined) {
      const parsed = JSON.parse(decrypt(result, scope.plan(id, "result"))) as { decidedAt?: number };
      if (parsed.decidedAt === undefined) {
        result = encryptJson({ ...parsed, decidedAt: Number(ev.decided_at) }, scope.plan(id, "result"));
      }
    }
    await client.execute({
      sql: `UPDATE events SET title = ?, location = ?, event_date = ?, pool_json = ?, pool_meta = ?, result_json = ?,
              invite_code = ?, invite_enc = ?, meta_enc = ?, created_at = ?, max_members = 0, decided_at = NULL
            WHERE id = ?`,
      args: [
        upgrade(ev.title, scope.plan(id, "title"), true),
        opt(ev.location, "location"),
        opt(ev.event_date, "date"),
        opt(ev.pool_json, "pool"),
        opt(ev.pool_meta, "pool_meta"),
        result,
        blindIndex(code, "invite"),
        encrypt(code, scope.plan(id, "invite")),
        encrypt(meta, scope.plan(id, "meta")),
        dayOf(JSON.parse(meta).createdAt),
        id,
      ],
    });
    counts.events++;
  }

  // Spending rows keyed by a user id move to that id's keyed hash (added to anything already there).
  for (const row of (await client.execute("SELECT payer, month, micros FROM llm_spend")).rows) {
    const payer = String(row.payer);
    if (payer === GLOBAL_PAYER || /^[0-9a-f]{64}$/.test(payer)) continue;
    await client.execute({
      sql: `INSERT INTO llm_spend (payer, month, micros) VALUES (?, ?, ?)
            ON CONFLICT (payer, month) DO UPDATE SET micros = llm_spend.micros + EXCLUDED.micros`,
      args: [payerKey(payer), row.month, row.micros],
    });
    await client.execute({ sql: "DELETE FROM llm_spend WHERE payer = ? AND month = ?", args: [payer, row.month] });
    counts.spend++;
  }
  // Rate-limit counters that name a user or plan id are short-lived; dropping them starts a fresh window.
  const dropped = await client.execute(
    "DELETE FROM rate_limits WHERE key ~ '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'",
  );
  counts.rateLimits = dropped.rowCount;
  // Sanity check: every name now opens with its own key.
  for (const u of (await client.execute("SELECT id, display_name FROM users")).rows)
    decryptOrPlain(String(u.display_name), scope.displayName(String(u.id)));
  return counts;
}
