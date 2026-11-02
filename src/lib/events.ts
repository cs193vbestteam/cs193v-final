import { z } from "zod";
import { db } from "./db";
import { decrypt, decryptJson, encrypt, encryptJson } from "./crypto";
import {
  type Constraints,
  ConstraintsSchema,
  emptyConstraints,
  mergeConstraints,
  missingFields,
} from "./constraints";
import { evaluate } from "./evaluate";
import { extract, type ChatTurn } from "./extract";
import { OPENING_MESSAGE } from "./extract-rules";
import { negotiate, type Assistant, type NegotiationResult } from "./negotiate";
import { getRestaurant } from "./restaurants";

/**
 * Data access for plans ("events"). Every function takes the acting userId explicitly
 * and checks membership, so authorization is testable without HTTP/cookies.
 */

export class AccessError extends Error {}

export type EventSummary = { id: string; title: string; inviteCode: string; creatorId: string; decided: boolean };
export type Member = { userId: string; displayName: string; ready: boolean };
export type StoredResult = NegotiationResult & { participants: number; decidedAt: number };

export const TitleSchema = z.string().trim().min(1, "Give your plan a name").max(80, "Name is too long");
export const MessageSchema = z.string().trim().min(1).max(1000, "Message is too long");

const INVITE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"; // no look-alikes (l/1, o/0)
function newInviteCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => INVITE_ALPHABET[b % INVITE_ALPHABET.length]).join("");
}

function rowToEvent(row: Record<string, unknown>): EventSummary {
  return {
    id: String(row.id),
    title: String(row.title),
    inviteCode: String(row.invite_code),
    creatorId: String(row.creator_id),
    decided: row.result_json !== null && row.result_json !== undefined,
  };
}

async function addMember(eventId: string, userId: string) {
  const client = await db();
  const now = Date.now();
  await client.execute({
    sql: "INSERT OR IGNORE INTO members (event_id, user_id, constraints_enc, ready, joined_at) VALUES (?, ?, ?, 0, ?)",
    args: [eventId, userId, encryptJson(emptyConstraints()), now],
  });
  const { rows } = await client.execute({
    sql: "SELECT COUNT(*) AS n FROM messages WHERE event_id = ? AND user_id = ?",
    args: [eventId, userId],
  });
  if (Number(rows[0].n) === 0) await addMessage(eventId, userId, "assistant", OPENING_MESSAGE);
}

export async function createEvent(userId: string, title: string): Promise<EventSummary> {
  const client = await db();
  const event: EventSummary = {
    id: crypto.randomUUID(),
    title: TitleSchema.parse(title),
    inviteCode: newInviteCode(),
    creatorId: userId,
    decided: false,
  };
  await client.execute({
    sql: "INSERT INTO events (id, title, invite_code, creator_id, created_at) VALUES (?, ?, ?, ?, ?)",
    args: [event.id, event.title, event.inviteCode, userId, Date.now()],
  });
  await addMember(event.id, userId);
  return event;
}

export async function getEventByCode(code: string): Promise<EventSummary | null> {
  const client = await db();
  const { rows } = await client.execute({ sql: "SELECT * FROM events WHERE invite_code = ?", args: [code] });
  return rows[0] ? rowToEvent(rows[0] as Record<string, unknown>) : null;
}

export async function joinEvent(code: string, userId: string): Promise<EventSummary> {
  const event = await getEventByCode(code);
  if (!event) throw new AccessError("That invite link doesn't exist");
  await addMember(event.id, userId);
  return event;
}

export async function isMember(eventId: string, userId: string): Promise<boolean> {
  const client = await db();
  const { rows } = await client.execute({
    sql: "SELECT 1 FROM members WHERE event_id = ? AND user_id = ?",
    args: [eventId, userId],
  });
  return rows.length > 0;
}

async function requireMember(eventId: string, userId: string) {
  if (!(await isMember(eventId, userId))) throw new AccessError("You're not part of this plan");
}

export async function listMyEvents(userId: string): Promise<EventSummary[]> {
  const client = await db();
  const { rows } = await client.execute({
    sql: `SELECT e.* FROM events e JOIN members m ON m.event_id = e.id
          WHERE m.user_id = ? ORDER BY e.created_at DESC`,
    args: [userId],
  });
  return rows.map((r) => rowToEvent(r as Record<string, unknown>));
}

/** Group-visible member info: names and readiness only. Never constraints. */
export async function listMembers(eventId: string, viewerId: string): Promise<Member[]> {
  await requireMember(eventId, viewerId);
  const client = await db();
  const { rows } = await client.execute({
    sql: `SELECT m.user_id, u.display_name, m.ready FROM members m JOIN users u ON u.id = m.user_id
          WHERE m.event_id = ? ORDER BY m.joined_at`,
    args: [eventId],
  });
  return rows.map((r) => ({ userId: String(r.user_id), displayName: String(r.display_name), ready: Number(r.ready) === 1 }));
}

async function addMessage(eventId: string, userId: string, role: ChatTurn["role"], content: string) {
  const client = await db();
  await client.execute({
    sql: "INSERT INTO messages (event_id, user_id, role, content_enc, created_at) VALUES (?, ?, ?, ?, ?)",
    args: [eventId, userId, role, encrypt(content), Date.now()],
  });
}

/** A user's own private chat. There is deliberately no way to read someone else's. */
export async function getMyMessages(eventId: string, userId: string): Promise<ChatTurn[]> {
  await requireMember(eventId, userId);
  const client = await db();
  const { rows } = await client.execute({
    sql: "SELECT role, content_enc FROM messages WHERE event_id = ? AND user_id = ? ORDER BY id",
    args: [eventId, userId],
  });
  return rows.map((r) => ({ role: r.role as ChatTurn["role"], content: decrypt(String(r.content_enc)) }));
}

export async function getMyConstraints(eventId: string, userId: string): Promise<Constraints> {
  await requireMember(eventId, userId);
  const client = await db();
  const { rows } = await client.execute({
    sql: "SELECT constraints_enc FROM members WHERE event_id = ? AND user_id = ?",
    args: [eventId, userId],
  });
  return ConstraintsSchema.parse(decryptJson(String(rows[0].constraints_enc)));
}

async function saveConstraints(eventId: string, userId: string, c: Constraints, ready: boolean) {
  const client = await db();
  await client.execute({
    sql: "UPDATE members SET constraints_enc = ?, ready = ? WHERE event_id = ? AND user_id = ?",
    args: [encryptJson(c), ready ? 1 : 0, eventId, userId],
  });
}

export async function sendMessage(
  eventId: string,
  userId: string,
  text: string,
): Promise<{ messages: ChatTurn[]; constraints: Constraints }> {
  const content = MessageSchema.parse(text);
  const current = await getMyConstraints(eventId, userId); // also checks membership
  await addMessage(eventId, userId, "user", content);

  const history = await getMyMessages(eventId, userId);
  const { reply, update } = await extract(history, current);

  let next = current;
  try {
    next = mergeConstraints(current, update);
  } catch {
    // Ignore an invalid update rather than breaking the chat.
  }
  // Changing constraints un-readies you, so the group re-checks with fresh info.
  const changed = JSON.stringify(next) !== JSON.stringify(current);
  const client = await db();
  const { rows } = await client.execute({
    sql: "SELECT ready FROM members WHERE event_id = ? AND user_id = ?",
    args: [eventId, userId],
  });
  const wasReady = Number(rows[0].ready) === 1;
  await saveConstraints(eventId, userId, next, wasReady && !changed);
  await addMessage(eventId, userId, "assistant", reply);

  return { messages: await getMyMessages(eventId, userId), constraints: next };
}

export async function setReady(eventId: string, userId: string, ready: boolean): Promise<void> {
  const c = await getMyConstraints(eventId, userId);
  if (ready && missingFields(c).length > 0) {
    throw new AccessError("Tell your assistant a bit more first: it still needs " + missingFields(c).join(", "));
  }
  await saveConstraints(eventId, userId, c, ready);
}

/**
 * Runs the negotiation only when every joined member is ready.
 * Each member's constraints are decrypted here, server-side, and wrapped in an
 * opaque Assistant closure. The negotiation engine never sees the constraints.
 */
export async function runNegotiation(eventId: string, userId: string): Promise<StoredResult> {
  await requireMember(eventId, userId);
  const client = await db();
  const { rows } = await client.execute({
    sql: "SELECT constraints_enc, ready FROM members WHERE event_id = ?",
    args: [eventId],
  });
  const readyCount = rows.filter((row) => Number(row.ready) === 1).length;
  if (readyCount < 2) throw new AccessError("At least 2 people need to be ready first");
  if (readyCount !== rows.length) {
    throw new AccessError("Everyone who joined must be ready before finding a plan");
  }

  const assistants: Assistant[] = rows.map((r) => {
    const c = ConstraintsSchema.parse(decryptJson(String(r.constraints_enc)));
    return (p) => {
      const restaurant = getRestaurant(p.restaurantId);
      return restaurant ? evaluate(c, restaurant, p.slot) : { verdict: "no" };
    };
  });

  const result: StoredResult = { ...negotiate(assistants, { maxRounds: 6 }), participants: rows.length, decidedAt: Date.now() };
  await client.execute({
    sql: "UPDATE events SET result_json = ?, decided_at = ? WHERE id = ?",
    args: [JSON.stringify(result), result.decidedAt, eventId],
  });
  return result;
}

export async function getResult(eventId: string, userId: string): Promise<StoredResult | null> {
  await requireMember(eventId, userId);
  const client = await db();
  const { rows } = await client.execute({ sql: "SELECT result_json FROM events WHERE id = ?", args: [eventId] });
  const raw = rows[0]?.result_json;
  return raw ? (JSON.parse(String(raw)) as StoredResult) : null;
}
