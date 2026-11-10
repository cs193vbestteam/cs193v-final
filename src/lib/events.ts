import { z } from "zod";
import { db } from "./db";
import { decrypt, decryptJson, encrypt, encryptJson } from "./crypto";
import type { Constraints } from "./constraints";
import type { ChatTurn } from "./extract";
import { configuredFinalPicker, configuredSelector } from "./mediator-llm";
import { negotiate, type NegotiationResult } from "./negotiate";
import { poolForEvent, summarize, type PlaceSummary, type PoolSource } from "./pool";
import { DEFAULT_SCENARIO, parseScenarioId, ScenarioIdSchema, scenarioFor, type ScenarioId } from "./scenario";
import { agentsForEvent } from "./vault";
import { clearRateKey, hit, LIMITS, rateKey, waitText } from "./ratelimit";

/**
 * Data access for plans ("events"). Every function takes the acting userId explicitly
 * and checks membership, so authorization is testable without HTTP/cookies.
 */

export class AccessError extends Error {}
/** Too many requests; the message is safe to show. */
export class RateLimitError extends AccessError {}

export type EventSummary = {
  id: string;
  title: string;
  inviteCode: string;
  creatorId: string;
  decided: boolean;
  /** What the group is deciding. Plans stored before scenarios existed are meals. */
  scenario: ScenarioId;
  /** Where the plan happens, as typed by the creator. Public. */
  location: string | null;
  poolSource: PoolSource;
  poolSize: number;
};
export type Member = { userId: string; displayName: string; ready: boolean };
/**
 * What the group sees. `memberNames` lets the UI name a reservation ("Sam: timing") without exposing ids;
 * `places` carries the public details of every restaurant the rounds mention, so results outlive the pool.
 */
export type StoredResult = NegotiationResult & {
  participants: number;
  memberNames: string[];
  places: Record<string, PlaceSummary>;
  decidedAt: number;
  /**
   * "full": the round log with anonymous counts. "outcome": only the plan (or
   * that there is none) and how many rounds it took; see `forGroupSize`.
   */
  detail: "full" | "outcome";
  /** Rounds run. Kept on its own because `rounds` is empty when `detail` is "outcome". */
  roundCount: number;
};

/**
 * The smallest group whose counts are anonymous. In a group of two every count
 * is about one identifiable person: each member knows their own answer, so
 * "1x reject, price" next to a $38 restaurant is the other person's ceiling.
 */
export const MIN_GROUP_FOR_DETAIL = 3;

/**
 * What a group of this size may see of a negotiation. Below
 * `MIN_GROUP_FOR_DETAIL` that is the outcome and the number of rounds only: no
 * per-option tallies, no dimension names, no conflicts, no named reservations,
 * no utility buckets, and no place other than the chosen one. Applied before a
 * result is stored and again when one is read, so results stored before this
 * rule existed are covered too.
 */
export function forGroupSize(result: StoredResult): StoredResult {
  const roundCount = result.roundCount ?? result.rounds.length;
  if (result.participants >= MIN_GROUP_FOR_DETAIL) return { ...result, detail: "full", roundCount };
  const chosen = result.proposal?.restaurantId;
  return {
    status: result.status,
    proposal: result.proposal,
    tally: null,
    rounds: [],
    concessionLevel: 0,
    finalists: [],
    reservations: [],
    conflicts: [],
    leakedDims: 0,
    participants: result.participants,
    memberNames: [],
    places: chosen && result.places[chosen] ? { [chosen]: result.places[chosen] } : {},
    decidedAt: result.decidedAt,
    detail: "outcome",
    roundCount,
  };
}

export const TitleSchema = z.string().trim().min(1, "Give your plan a name").max(80, "Name is too long");
export const LocationSchema = z.string().trim().max(120, "Location is too long");
export const MessageSchema = z.string().trim().min(1).max(1000, "Message is too long");

const INVITE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"; // no look-alikes (l/1, o/0)
function newInviteCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => INVITE_ALPHABET[b % INVITE_ALPHABET.length]).join("");
}

function rowToEvent(row: Record<string, unknown>): EventSummary {
  const pool = row.pool_json ? (JSON.parse(String(row.pool_json)) as unknown[]) : null;
  const scenario = parseScenarioId(row.scenario);
  return {
    id: String(row.id),
    title: String(row.title),
    inviteCode: String(row.invite_code),
    creatorId: String(row.creator_id),
    decided: row.result_json !== null && row.result_json !== undefined,
    scenario,
    location: row.location ? String(row.location) : null,
    poolSource: pool?.length ? ((row.pool_source as PoolSource) ?? "places") : "seed",
    poolSize: pool?.length ?? scenarioFor(scenario).seedPool.length,
  };
}

async function addMember(event: Pick<EventSummary, "id" | "scenario">, userId: string) {
  const eventId = event.id;
  const scenario = scenarioFor(event.scenario);
  const client = await db();
  const now = Date.now();
  await client.execute({
    sql: "INSERT INTO members (event_id, user_id, constraints_enc, ready, joined_at) VALUES (?, ?, ?, 0, ?) ON CONFLICT DO NOTHING",
    args: [eventId, userId, encryptJson(scenario.emptyConstraints()), now],
  });
  const { rows } = await client.execute({
    sql: "SELECT COUNT(*) AS n FROM messages WHERE event_id = ? AND user_id = ?",
    args: [eventId, userId],
  });
  if (Number(rows[0].n) === 0) await addMessage(eventId, userId, "assistant", scenario.openingMessage);
}

export async function createEvent(
  userId: string,
  title: string,
  location: string | null = null,
  scenarioId: ScenarioId = DEFAULT_SCENARIO,
): Promise<EventSummary> {
  const client = await db();
  const scenario = scenarioFor(ScenarioIdSchema.parse(scenarioId));
  const where = LocationSchema.parse(location ?? "") || null;
  const pool = await scenario.resolvePool(where);
  const restaurants = pool.source === "seed" ? null : pool.restaurants;
  const event: EventSummary = {
    id: crypto.randomUUID(),
    title: TitleSchema.parse(title),
    inviteCode: newInviteCode(),
    creatorId: userId,
    decided: false,
    scenario: scenario.id,
    location: where,
    poolSource: pool.source,
    poolSize: restaurants?.length ?? scenario.seedPool.length,
  };
  if (pool.source === "seed" && where) console.info(`Plan "${event.title}": using seed pool (${pool.reason})`);
  await client.execute({
    sql: "INSERT INTO events (id, title, invite_code, creator_id, created_at, location, pool_json, pool_source, scenario) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    args: [
      event.id,
      event.title,
      event.inviteCode,
      userId,
      Date.now(),
      where,
      restaurants ? JSON.stringify(restaurants) : null,
      pool.source,
      scenario.id,
    ],
  });
  await addMember(event, userId);
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
  await addMember(event, userId);
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
  return rows.map((r) => ({
    userId: String(r.user_id),
    displayName: String(r.display_name),
    ready: Number(r.ready) === 1,
  }));
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

/** A member's stored constraints together with the scenario that defines them. */
async function loadConstraints(eventId: string, userId: string) {
  await requireMember(eventId, userId);
  const client = await db();
  const { rows } = await client.execute({
    sql: `SELECT m.constraints_enc, e.scenario FROM members m JOIN events e ON e.id = m.event_id
          WHERE m.event_id = ? AND m.user_id = ?`,
    args: [eventId, userId],
  });
  const scenario = scenarioFor(parseScenarioId(rows[0].scenario));
  return { scenario, constraints: scenario.parseConstraints(decryptJson(String(rows[0].constraints_enc))) };
}

export async function getMyConstraints(eventId: string, userId: string): Promise<Constraints> {
  return (await loadConstraints(eventId, userId)).constraints;
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
): Promise<{ messages: ChatTurn[]; constraints: Constraints; scenario: ScenarioId }> {
  const content = MessageSchema.parse(text);
  const { scenario, constraints: current } = await loadConstraints(eventId, userId); // also checks membership
  const chat = await hit(rateKey.chat(userId), LIMITS.chatPerUser);
  if (!chat.allowed) {
    throw new RateLimitError(`You're sending messages very quickly. Please try again ${waitText(chat.retryAfterMs)}.`);
  }
  await addMessage(eventId, userId, "user", content);

  const history = await getMyMessages(eventId, userId);
  const { restaurants } = await poolForEvent(eventId);
  // Only count LLM calls when there is a key to spend; past the plan's daily budget, use the rules.
  const allowLLM = !process.env.ANTHROPIC_API_KEY || (await hit(rateKey.llm(eventId), LIMITS.llmPerPlan)).allowed;
  const { reply, constraints: next } = await scenario.chatTurn(history, current, restaurants, { allowLLM });

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

  return { messages: await getMyMessages(eventId, userId), constraints: next, scenario: scenario.id };
}

export async function setReady(eventId: string, userId: string, ready: boolean): Promise<void> {
  const { scenario, constraints: c } = await loadConstraints(eventId, userId);
  const missing = scenario.missingFields(c);
  if (ready && missing.length > 0) {
    throw new AccessError("Tell your assistant a bit more first: it still needs " + missing.join(", "));
  }
  await saveConstraints(eventId, userId, c, ready);
}

/**
 * Runs the negotiation only when every joined member is ready.
 * The vault decrypts each member's preferences and wraps them in an opaque
 * Agent. This function, and the negotiation engine below it, never see them.
 */
export async function runNegotiation(eventId: string, userId: string): Promise<StoredResult> {
  await requireMember(eventId, userId);
  // Every LLM call in the negotiation (agents and mediator) counts against the plan's daily budget (#4).
  const budget = async () => (await hit(rateKey.llm(eventId), LIMITS.llmPerPlan)).allowed;
  const { agents, userIds, readyCount } = await agentsForEvent(eventId, budget);
  if (readyCount < 2) throw new AccessError("At least 2 people need to be ready first");
  if (readyCount !== agents.length) {
    throw new AccessError("Everyone who joined must be ready before finding a plan");
  }
  const members = await listMembers(eventId, userId);
  const memberNames = userIds.map((id) => members.find((m) => m.userId === id)?.displayName ?? "Someone");
  const { restaurants } = await poolForEvent(eventId);

  const lookup = (id: string) => restaurants.find((r) => r.id === id);
  const outcome = await negotiate(agents, {
    restaurants,
    maxRounds: 6,
    perRound: 5,
    selector: configuredSelector(lookup, budget),
    finalPicker: configuredFinalPicker(lookup, budget),
  });
  const mentioned = new Set<string>();
  if (outcome.proposal) mentioned.add(outcome.proposal.restaurantId);
  for (const round of outcome.rounds) for (const p of round.proposals) mentioned.add(p.proposal.restaurantId);
  for (const f of outcome.finalists) mentioned.add(f.proposal.restaurantId);
  // Small groups store the outcome only: what the page must not show is never written (forGroupSize).
  const result = forGroupSize({
    ...outcome,
    participants: agents.length,
    memberNames,
    places: summarize(restaurants, mentioned),
    decidedAt: Date.now(),
    detail: "full",
    roundCount: outcome.rounds.length,
  });
  const client = await db();
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
  return raw ? forGroupSize(upgradeResult(JSON.parse(String(raw)))) : null;
}

type LegacyTally = { yes: number; meh: number; no: number; reasons: Record<string, number> };
const isLegacyTally = (t: unknown): t is LegacyTally => !!t && typeof t === "object" && "yes" in (t as object);

type LegacyFinalist = { proposal: unknown; tally: unknown; relative?: number; nash?: number };

/**
 * Results stored before the masked final pick (#15) kept every finalist's
 * sorted buckets and Nash product. Only how the finalists compare is passed
 * on; the buckets are dropped here and never reach the page.
 */
function upgradeFinalists(raw: unknown): StoredResult["finalists"] {
  const list = (Array.isArray(raw) ? raw : []) as LegacyFinalist[];
  const best = Math.max(0, ...list.map((f) => f.nash ?? 0));
  return list.map((f) => ({
    proposal: f.proposal,
    tally: f.tally,
    relative: typeof f.relative === "number" ? f.relative : best > 0 ? Number(((f.nash ?? 0) / best).toFixed(6)) : 1,
  })) as StoredResult["finalists"];
}

/** Results stored before the utility-based protocol used yes/meh/no tallies. Map them so old plans still render. */
export function upgradeResult(raw: Record<string, unknown>): StoredResult {
  const fix = (t: unknown) =>
    isLegacyTally(t) ? { accept: t.yes, reluctant: t.meh, reject: t.no, dims: t.reasons ?? {}, rejectDims: {} } : t;
  const rounds = (
    (raw.rounds as { round: number; level?: number; proposals: { proposal: unknown; tally: unknown }[] }[]) ?? []
  ).map((r) => ({
    round: r.round,
    level: r.level ?? 0,
    proposals: r.proposals.map((p) => ({ ...p, tally: fix(p.tally) })),
  }));
  return {
    ...(raw as object),
    status: raw.status === "no_option" ? "no_deal" : raw.status,
    tally: fix(raw.tally),
    rounds,
    concessionLevel: (raw.concessionLevel as number) ?? 0,
    finalists: upgradeFinalists(raw.finalists),
    reservations: (raw.reservations as StoredResult["reservations"]) ?? [],
    conflicts: (raw.conflicts as StoredResult["conflicts"]) ?? [],
    leakedDims: (raw.leakedDims as number) ?? 0,
    memberNames: (raw.memberNames as string[]) ?? [],
    places: (raw.places as StoredResult["places"]) ?? {},
    detail: raw.detail === "outcome" ? "outcome" : "full",
    roundCount: (raw.roundCount as number) ?? rounds.length,
  } as StoredResult;
}

// ---------------------------------------------------------------------------
// Deletion (#5). Every statement is scoped by id, so nothing outside the plan or
// user being removed is touched. Each function is ordered so that a failure
// halfway leaves at most a cleared result behind, never another person's data.
//
// Decisions:
// - A decided plan is un-decided whenever someone leaves or deletes their account:
//   the stored result names every member, and the people left can simply run it again.
// - A plan whose creator leaves or deletes their account is handed over to the member
//   who joined earliest after them, so nobody else loses their chat. A plan with
//   nobody else in it is deleted.
// ---------------------------------------------------------------------------

async function creatorOf(eventId: string): Promise<string | null> {
  const client = await db();
  const { rows } = await client.execute({ sql: "SELECT creator_id FROM events WHERE id = ?", args: [eventId] });
  return rows[0] ? String(rows[0].creator_id) : null;
}

/**
 * Plans `userId` created (only `eventId`, if given) go to the earliest-joined other member;
 * the ones with no other member are deleted, which cascades to their members and messages.
 */
async function handOverOrDeleteCreated(userId: string, eventId?: string) {
  const client = await db();
  const onlyOne = eventId ? " AND id = ?" : "";
  const scope = eventId ? [eventId] : [];
  const others = "FROM members m WHERE m.event_id = events.id AND m.user_id <> ?";
  await client.execute({
    sql: `UPDATE events SET creator_id = (SELECT m.user_id ${others} ORDER BY m.joined_at, m.user_id LIMIT 1)
          WHERE creator_id = ?${onlyOne} AND EXISTS (SELECT 1 ${others})`,
    args: [userId, userId, ...scope, userId],
  });
  await client.execute({ sql: `DELETE FROM events WHERE creator_id = ?${onlyOne}`, args: [userId, ...scope] });
}

/** Deletes a plan with everyone's constraints, chats and the stored result. Creator only. */
export async function deletePlan(eventId: string, userId: string): Promise<void> {
  const creator = await creatorOf(eventId);
  if (!creator) throw new AccessError("That plan doesn't exist");
  if (creator !== userId) throw new AccessError("Only the person who created this plan can delete it");
  const client = await db();
  // members and messages go with it (ON DELETE CASCADE); deleted explicitly too, so this never depends on it.
  await client.execute({ sql: "DELETE FROM messages WHERE event_id = ?", args: [eventId] });
  await client.execute({ sql: "DELETE FROM members WHERE event_id = ?", args: [eventId] });
  await client.execute({ sql: "DELETE FROM events WHERE id = ? AND creator_id = ?", args: [eventId, userId] });
  await clearRateKey(rateKey.llm(eventId));
}

/** Removes one member's constraints and private chat from a plan and un-decides it. */
export async function leavePlan(eventId: string, userId: string): Promise<void> {
  await requireMember(eventId, userId);
  const client = await db();
  await client.execute({
    sql: "UPDATE events SET result_json = NULL, decided_at = NULL WHERE id = ?",
    args: [eventId],
  });
  if ((await creatorOf(eventId)) === userId) await handOverOrDeleteCreated(userId, eventId);
  await client.execute({ sql: "DELETE FROM messages WHERE event_id = ? AND user_id = ?", args: [eventId, userId] });
  await client.execute({ sql: "DELETE FROM members WHERE event_id = ? AND user_id = ?", args: [eventId, userId] });
}

/**
 * Deletes a user and everything stored about them: account (incl. encrypted email), sessions,
 * memberships, constraints and private chats. Their plans are handed over or deleted (see above).
 */
export async function deleteAccount(userId: string): Promise<void> {
  const client = await db();
  await client.execute({
    sql: "UPDATE events SET result_json = NULL, decided_at = NULL WHERE id IN (SELECT event_id FROM members WHERE user_id = ?)",
    args: [userId],
  });
  await handOverOrDeleteCreated(userId);
  await client.execute({ sql: "DELETE FROM messages WHERE user_id = ?", args: [userId] });
  await client.execute({ sql: "DELETE FROM members WHERE user_id = ?", args: [userId] });
  await client.execute({ sql: "DELETE FROM sessions WHERE user_id = ?", args: [userId] });
  await clearRateKey(rateKey.chat(userId));
  await client.execute({ sql: "DELETE FROM users WHERE id = ?", args: [userId] });
}
