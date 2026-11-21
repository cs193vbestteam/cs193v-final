import { z } from "zod";
import { MAX_MESSAGE_CHARS } from "./chat-limits";
import { db } from "./db";
import { decrypt, decryptJson, decryptOrPlain, encrypt, encryptJson, scope } from "./crypto";
import type { MemberState } from "./member-state";
import type { ChatTurn } from "./extract";
import type { Proposal } from "./evaluate";
import type { NegotiationResult } from "./negotiate";
import { optimize } from "./optimizer";
import { checkResult, type OptimizerResult } from "./optimizer-handoff";
import { loadOptimizerInput } from "./optimizer-source";
import { planDateSchema, todayPacific } from "./plan-date";
import { poolForEvent, summarizePlaces, type PlaceSummary, type PoolSource } from "./pool";
import { newPoolMeta } from "./pool-extend";
import { refreshPool } from "./pool-refresh";
import { DEFAULT_SCENARIO, parseScenarioId, ScenarioIdSchema, scenarioFor, type ScenarioId } from "./scenario";
import { clearRateKey, hit, LIMITS, rateKey, waitText } from "./ratelimit";
import { canSpend, withPayer } from "./spend";

/**
 * Data access for plans ("events"). Every function takes the acting userId explicitly
 * and checks membership, so authorization is testable without HTTP/cookies.
 */

/** Why the optimizer chose nothing (optimizer-handoff.ts). */
type OptimizerNoPlan = Extract<OptimizerResult, { restaurantId: null }>["reason"];

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
  /** The day of the plan, YYYY-MM-DD, chosen by the creator. Public. Null only for plans stored before dates existed. */
  date: string | null;
  poolSource: PoolSource;
  poolSize: number;
  /** How many people the creator lets into the plan, themselves included. */
  maxMembers: number;
};
export type Member = { userId: string; displayName: string; ready: boolean };
/**
 * What the group sees. `memberNames` lets the UI name a reservation ("Sam: timing") without exposing ids;
 * `places` carries the public details of every restaurant the rounds mention, so results outlive the pool.
 */
export type StoredResult = Omit<NegotiationResult, "status"> & {
  /**
   * `partial` is the optimizer's alone: the closest plan there is, which a hard rule keeps at
   * least one person out of (`cannotCome`). `compromise` is the negotiation engine's alone.
   */
  status: NegotiationResult["status"] | "partial";
  /** What decided the plan. Absent on results the negotiation engine stored. */
  engine?: "optimizer";
  /**
   * Optimizer results: how many people a diet, a time or an exclusion keeps out of the plan. A
   * count and never who. Left out below `MIN_GROUP_FOR_DETAIL`, where it would name someone.
   */
  cannotCome?: number;
  /** Optimizer results: how many place-and-time options were scored. Public: the pool and the clock. */
  optionsScored?: number;
  /** Optimizer results with no plan: nothing is open that day, or every option keeps every person out. */
  noPlan?: OptimizerNoPlan;
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
  /**
   * The shortlist the group chooses from: up to SHORTLIST different places nobody rejects, best for
   * the group first; the first is `proposal`. `everyoneIn` says whether everyone fully accepts it or
   * it is a stretch for someone. In a group of two that would be the other person's answer, so it is
   * left out there. Absent on results stored before shortlists.
   */
  options?: { proposal: Proposal; everyoneIn?: boolean }[];
};

/** How many options a negotiation tries to end with. */
export const SHORTLIST = 6;

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
  // A plan one of two can come to is, to each of them, a statement about the other. A pair is
  // told only that nothing works for both, which is also all they could act on.
  const kept = result.status !== "partial";
  const chosen = kept ? result.proposal?.restaurantId : undefined;
  // A pair still gets the shortlist, as places only: no counts, and not who is merely reluctant.
  const options = kept ? (result.options ?? []).map(({ proposal }) => ({ proposal })) : [];
  const listed = new Set([...(chosen ? [chosen] : []), ...options.map((o) => o.proposal.restaurantId)]);
  return {
    status: kept ? result.status : "no_deal",
    proposal: kept ? result.proposal : null,
    tally: null,
    rounds: [],
    concessionLevel: 0,
    finalists: [],
    reservations: [],
    conflicts: [],
    leakedDims: 0,
    participants: result.participants,
    memberNames: [],
    places: Object.fromEntries(Object.entries(result.places).filter(([id]) => listed.has(id))),
    ...(options.length ? { options } : {}),
    decidedAt: result.decidedAt,
    detail: "outcome",
    roundCount,
    ...(result.engine ? { engine: result.engine } : {}),
    ...(result.optionsScored !== undefined ? { optionsScored: result.optionsScored } : {}),
    // "Nothing is open" is about the places. "Nobody can come" would be about the other person.
    ...(result.noPlan === "no_candidates" ? { noPlan: result.noPlan } : {}),
  };
}

export const TitleSchema = z.string().trim().min(1, "Give your plan a name").max(80, "Name is too long");
export const LocationSchema = z.string().trim().max(120, "Location is too long");
// The cap keeps the chat to what it is for: a paragraph about a meal fits, an essay prompt does not (#84).
export const MessageSchema = z
  .string()
  .trim()
  .min(1)
  .max(
    MAX_MESSAGE_CHARS,
    `That message is too long for me (${MAX_MESSAGE_CHARS} characters at most). Could you say it more briefly?`,
  );

/**
 * How many people a plan takes. The creator picks the number when they start the plan and can
 * change it later; MAX_PLAN_SIZE is the most anyone can pick, so one forwarded link cannot fill a
 * plan with hundreds of accounts (#119).
 */
export const MIN_PLAN_SIZE = 2;
export const MAX_PLAN_SIZE = 20;
export const DEFAULT_PLAN_SIZE = 12;
export const PlanSizeSchema = z.coerce
  .number({ message: "Choose how many people can join" })
  .int("Choose a whole number of people")
  .min(MIN_PLAN_SIZE, `A plan needs room for at least ${MIN_PLAN_SIZE} people`)
  .max(MAX_PLAN_SIZE, `A plan can have ${MAX_PLAN_SIZE} people at most`);

const INVITE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"; // no look-alikes (l/1, o/0)
/**
 * Six characters: short enough to read out or type from a friend's screen. That is 31^6, about
 * 890 million codes, far fewer than the eight characters codes had before, so a code is checked
 * against the plans that exist before it is used. Plans made earlier keep their longer codes.
 */
export const INVITE_LENGTH = 6;
/** The longest code any plan has; older plans have eight characters. */
export const MAX_INVITE_LENGTH = 8;
/**
 * A byte has 256 values and the alphabet 31 letters, so `byte % 31` would pick the first eight
 * letters slightly more often. Bytes past the last whole multiple of 31 are thrown away instead.
 */
export function newInviteCode(random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))) {
  const usable = 256 - (256 % INVITE_ALPHABET.length);
  let code = "";
  while (code.length < INVITE_LENGTH) {
    for (const b of random(INVITE_LENGTH * 2)) {
      if (b < usable && code.length < INVITE_LENGTH) code += INVITE_ALPHABET[b % INVITE_ALPHABET.length];
    }
  }
  return code;
}

/** A code no plan has yet. With short codes two plans can draw the same one; this draws again. */
async function unusedInviteCode(): Promise<string> {
  for (let tries = 0; tries < 8; tries++) {
    const code = newInviteCode();
    if (!(await getEventByCode(code))) return code;
  }
  throw new Error("Could not find an unused plan code");
}

/** A plan's shared fields are encrypted with that plan's own keys. */
function rowToEvent(row: Record<string, unknown>): EventSummary {
  const id = String(row.id);
  // Counted as the current engine sees it: places it has no cuisine for are stored but not offered yet.
  const stored = row.pool_json
    ? (JSON.parse(decryptOrPlain(String(row.pool_json), scope.plan(id, "pool"))) as { cuisine?: unknown }[])
    : null;
  const pool = stored?.filter((p) => p.cuisine !== null) ?? null;
  const scenario = parseScenarioId(row.scenario);
  return {
    id,
    title: decryptOrPlain(String(row.title), scope.plan(id, "title")),
    inviteCode: String(row.invite_code),
    creatorId: String(row.creator_id),
    decided: row.result_json !== null && row.result_json !== undefined,
    scenario,
    location: row.location ? decryptOrPlain(String(row.location), scope.plan(id, "location")) : null,
    date: row.event_date ? decryptOrPlain(String(row.event_date), scope.plan(id, "date")) : null,
    poolSource: pool?.length ? ((row.pool_source as PoolSource) ?? "places") : "seed",
    poolSize: pool?.length ?? scenarioFor(scenario).seedPool.length,
    maxMembers: Number(row.max_members ?? DEFAULT_PLAN_SIZE),
  };
}

/**
 * Adds someone to a plan unless it is full. Someone already in it is left as they are. The
 * count and the insert are one statement, so two people taking the last place cannot both get it.
 */
async function addMember(event: Pick<EventSummary, "id" | "scenario" | "maxMembers">, userId: string) {
  const eventId = event.id;
  const scenario = scenarioFor(event.scenario);
  const client = await db();
  const now = Date.now();
  if (!(await isMember(eventId, userId))) {
    await client.execute({
      sql: `INSERT INTO members (event_id, user_id, constraints_enc, ready, joined_at)
            SELECT ?, ?, ?, 0, ? WHERE (SELECT COUNT(*) FROM members WHERE event_id = ?) < ?
            ON CONFLICT DO NOTHING`,
      args: [
        eventId,
        userId,
        encryptJson(scenario.emptyConstraints(), scope.constraints(eventId, userId)),
        now,
        eventId,
        event.maxMembers,
      ],
    });
    if (!(await isMember(eventId, userId))) {
      throw new AccessError(
        `This plan is full: it has room for ${event.maxMembers} people. Whoever created it can make room.`,
      );
    }
  }
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
  /** The day of the plan. The create form always sends one; code that does not care gets today. */
  date: string = todayPacific(),
  /** How many people can join, the creator included. */
  maxMembers: number = DEFAULT_PLAN_SIZE,
): Promise<EventSummary> {
  const client = await db();
  const scenario = scenarioFor(ScenarioIdSchema.parse(scenarioId));
  const where = LocationSchema.parse(location ?? "") || null;
  const day = planDateSchema().parse(date);
  const name = TitleSchema.parse(title);
  const size = PlanSizeSchema.parse(maxMembers);
  // Counted after the input checks, so a typo in the form doesn't use up one of the day's plans.
  const quota = await hit(rateKey.createPlan(userId), LIMITS.createPlanPerUser);
  if (!quota.allowed) {
    throw new RateLimitError(
      `You've created ${LIMITS.createPlanPerUser.max} plans today. You can create another ${waitText(quota.retryAfterMs)}.`,
    );
  }
  const pool = await scenario.resolvePool(where, day);
  const restaurants = pool.source === "seed" ? null : pool.restaurants;
  const event: EventSummary = {
    id: crypto.randomUUID(),
    title: name,
    inviteCode: await unusedInviteCode(),
    creatorId: userId,
    decided: false,
    scenario: scenario.id,
    location: where,
    date: day,
    poolSource: pool.source,
    poolSize: restaurants?.filter((r) => r.cuisine !== null).length ?? scenario.seedPool.length,
    maxMembers: size,
  };
  if (pool.source === "seed" && where) console.info(`Plan ${event.id}: using seed pool (${pool.reason})`);
  await client.execute({
    sql: "INSERT INTO events (id, title, invite_code, creator_id, created_at, location, pool_json, pool_source, scenario, event_date, pool_meta, max_members) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    args: [
      event.id,
      encrypt(event.title, scope.plan(event.id, "title")),
      event.inviteCode,
      userId,
      Date.now(),
      where ? encrypt(where, scope.plan(event.id, "location")) : null,
      restaurants ? encryptJson(restaurants, scope.plan(event.id, "pool")) : null,
      pool.source,
      scenario.id,
      encrypt(day, scope.plan(event.id, "date")),
      // Only a Places pool can be widened later; it needs to know where it was searched from.
      pool.source === "places" ? encryptJson(newPoolMeta(pool.center), scope.plan(event.id, "pool_meta")) : null,
      size,
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

/** How many people are in a plan. Shown to someone deciding whether to join, so it needs no membership. */
export async function countMembers(eventId: string): Promise<number> {
  const client = await db();
  const { rows } = await client.execute({
    sql: "SELECT COUNT(*) AS n FROM members WHERE event_id = ?",
    args: [eventId],
  });
  return Number(rows[0].n);
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
    // Each member's name opens with that member's own key.
    displayName: decryptOrPlain(String(r.display_name), scope.displayName(String(r.user_id))),
    ready: Number(r.ready) === 1,
  }));
}

async function addMessage(eventId: string, userId: string, role: ChatTurn["role"], content: string) {
  const client = await db();
  await client.execute({
    sql: "INSERT INTO messages (event_id, user_id, role, content_enc, created_at) VALUES (?, ?, ?, ?, ?)",
    args: [eventId, userId, role, encrypt(content, scope.chat(eventId, userId)), Date.now()],
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
  return rows.map((r) => ({
    role: r.role as ChatTurn["role"],
    content: decrypt(String(r.content_enc), scope.chat(eventId, userId)),
  }));
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
  return {
    scenario,
    constraints: scenario.parseConstraints(
      decryptJson(String(rows[0].constraints_enc), scope.constraints(eventId, userId)),
    ),
  };
}

export async function getMyConstraints(eventId: string, userId: string): Promise<MemberState> {
  return (await loadConstraints(eventId, userId)).constraints;
}

async function saveConstraints(
  eventId: string,
  userId: string,
  c: MemberState,
  ready: boolean,
  /** Whether what they want is different from before; only the chat can make it so. */
  changed = false,
) {
  const client = await db();
  // `ready_at` is when they became ready and have stayed so: kept while they stay ready, set when
  // they become ready, cleared when they stop being ready. Changing your answers therefore gives
  // up your place in the order (optimizer.ts settles exact ties for whoever finished first).
  await client.execute({
    sql: `UPDATE members SET constraints_enc = ?,
            ready_at = CASE WHEN ? = 0 THEN NULL WHEN ready = 1 AND ready_at IS NOT NULL THEN ready_at ELSE ? END,
            ready = ?,
            changed_at = CASE WHEN ? = 1 THEN ? ELSE changed_at END
          WHERE event_id = ? AND user_id = ?`,
    args: [
      encryptJson(c, scope.constraints(eventId, userId)),
      ready ? 1 : 0,
      Date.now(),
      ready ? 1 : 0,
      changed ? 1 : 0,
      Date.now(),
      eventId,
      userId,
    ],
  });
}

export async function sendMessage(
  eventId: string,
  userId: string,
  text: string,
): Promise<{ messages: ChatTurn[]; constraints: MemberState; scenario: ScenarioId }> {
  const content = MessageSchema.parse(text);
  const { scenario, constraints: current } = await loadConstraints(eventId, userId); // also checks membership
  const chat = await hit(rateKey.chat(userId), LIMITS.chatPerUser);
  if (!chat.allowed) {
    throw new RateLimitError(`You're sending messages very quickly. Please try again ${waitText(chat.retryAfterMs)}.`);
  }
  await addMessage(eventId, userId, "user", content);

  const history = await getMyMessages(eventId, userId);
  const { restaurants } = await poolForEvent(eventId);
  // Only count LLM calls when there is a key to spend; past the plan's daily budget, or past your
  // own monthly spending cap (or the app's), use the rules. Your chat is charged to you.
  const allowLLM =
    !process.env.ANTHROPIC_API_KEY ||
    ((await canSpend(userId)) && (await hit(rateKey.llm(eventId), LIMITS.llmPerPlan)).allowed);
  // Changing what you want un-readies you, so the group re-checks with fresh info. A reply that
  // only moves the conversation along (a question asked, a turn counted) does not.
  const {
    reply,
    constraints: next,
    changed,
  } = await withPayer(userId, () => scenario.chatTurn(history, current, restaurants, { allowLLM }));
  const client = await db();
  const { rows } = await client.execute({
    sql: "SELECT ready FROM members WHERE event_id = ? AND user_id = ?",
    args: [eventId, userId],
  });
  const wasReady = Number(rows[0].ready) === 1;
  await saveConstraints(eventId, userId, next, wasReady && !changed, changed);
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

export const NOTHING_CHANGED =
  "Nobody has changed their answers since this plan was found, so running it again would give the same plan.";

/**
 * Where a plan stands for running it (#118). `changedSince` is whether anyone changed what they
 * want, or joined, after the stored result was made. Pressing "Change my answers" and "I'm done" again
 * changes nothing and does not count. Without a change, the answers are the ones the result was
 * made from, and the optimizer would return the same plan.
 */
async function runState(eventId: string) {
  const client = await db();
  const { rows } = await client.execute({
    sql: `SELECT e.result_json IS NOT NULL AS decided, e.decided_at,
                 (SELECT COUNT(*) FROM members m WHERE m.event_id = e.id) AS members,
                 (SELECT COUNT(*) FROM members m WHERE m.event_id = e.id AND m.ready = 1) AS ready,
                 (SELECT MAX(GREATEST(COALESCE(m.changed_at, 0), m.joined_at)) FROM members m
                   WHERE m.event_id = e.id) AS last_change
          FROM events e WHERE e.id = ?`,
    args: [eventId],
  });
  const row = rows[0];
  if (!row) throw new AccessError("That plan doesn't exist");
  const decided = row.decided === true || Number(row.decided) === 1;
  return {
    decided,
    members: Number(row.members),
    ready: Number(row.ready),
    changedSince: decided && Number(row.last_change ?? 0) > Number(row.decided_at ?? 0),
  };
}

/** Whether pressing "Re-run" would do anything: only once someone has changed an answer or joined. */
export async function canRerun(eventId: string, userId: string): Promise<boolean> {
  await requireMember(eventId, userId);
  const state = await runState(eventId);
  return state.decided && state.changedSince;
}

export async function runNegotiation(eventId: string, userId: string): Promise<StoredResult> {
  await requireMember(eventId, userId);
  const state = await runState(eventId);
  // The same checks decideAndStore makes, made first so a run that cannot start is not counted.
  if (state.ready < 2) throw new AccessError("At least 2 people need to be ready first");
  if (state.ready !== state.members) {
    throw new AccessError("Everyone who joined must be ready before finding a plan");
  }
  if (state.decided && !state.changedSince) throw new AccessError(NOTHING_CHANGED);
  const quota = await hit(rateKey.runs(eventId), LIMITS.runsPerPlan);
  if (!quota.allowed) {
    throw new RateLimitError(
      `This plan has been worked out ${LIMITS.runsPerPlan.max} times today, which is the most allowed. You can run it again ${waitText(quota.retryAfterMs)}.`,
    );
  }
  return decideAndStore(eventId);
}

/**
 * Decides the plan with the optimizer (optimizer.ts) and stores what the group may see of it.
 *
 * No model is called and nothing is charged to anyone: the optimizer is code. This is the one
 * place besides the pool refresh where everyone's preferences are read together, through
 * `loadOptimizerInput`, and nothing of them is stored with the result: it holds the place, the
 * time, the other places on the list and one count.
 *
 * The function and `runNegotiation` keep the names the page and its actions already use; the
 * negotiation engine they are named after no longer decides plans (#130 removes it).
 */
async function decideAndStore(eventId: string): Promise<StoredResult> {
  const first = await loadOptimizerInput(eventId);
  if (first.ready < 2) throw new AccessError("At least 2 people need to be ready first");
  if (first.ready !== first.members) {
    throw new AccessError("Everyone who joined must be ready before finding a plan");
  }
  // Everyone is done, so what the group wants is known: fetch the places for it before deciding (#101).
  const grew = await refreshPool(eventId);
  const { input } = grew ? await loadOptimizerInput(eventId) : first;

  const picked = optimize(input);
  const problems = checkResult(input, picked);
  if (problems.length > 0) throw new Error(`The optimizer returned a result its input does not allow: ${problems[0]}`);

  const choices = picked.restaurantId === null ? [] : [picked, ...picked.alternatives];
  const proposals = choices.map((c) => ({ proposal: { restaurantId: c.restaurantId, slot: c.startTime } }));
  const cannotCome = choices[0]?.cannotCome;
  const { places } = await poolForEvent(eventId);
  // Small groups store less: what the page must not show is never written (forGroupSize).
  const result = forGroupSize({
    status: cannotCome === undefined ? "no_deal" : cannotCome === 0 ? "agreed" : "partial",
    proposal: proposals[0]?.proposal ?? null,
    tally: null,
    rounds: [],
    concessionLevel: 0,
    finalists: [],
    reservations: [],
    conflicts: [],
    leakedDims: 0,
    ...(proposals.length ? { options: proposals } : {}),
    participants: input.people.length,
    memberNames: [],
    places: summarizePlaces(
      places,
      choices.map((c) => c.restaurantId),
    ),
    decidedAt: Date.now(),
    detail: "full",
    roundCount: 0,
    engine: "optimizer",
    optionsScored: input.candidates.reduce(
      (n, r) => n + (r.openAt ?? []).filter((t) => input.plan.startTimes.includes(t)).length,
      0,
    ),
    ...(cannotCome !== undefined ? { cannotCome } : {}),
    ...(picked.restaurantId === null ? { noPlan: picked.reason } : {}),
  });
  const client = await db();
  await client.execute({
    sql: "UPDATE events SET result_json = ?, decided_at = ? WHERE id = ?",
    args: [encryptJson(result, scope.plan(eventId, "result")), result.decidedAt, eventId],
  });
  return result;
}

/**
 * Finds the first plan as soon as the last member is done, so nobody has to keep watch
 * and press the button. It never re-runs a plan that already has a result: after that,
 * a new run is always somebody's explicit choice. Returns whether this call ran it.
 */
export async function negotiateWhenAllReady(eventId: string, userId: string): Promise<boolean> {
  const [members, existing] = await Promise.all([listMembers(eventId, userId), getResult(eventId, userId)]);
  if (existing || members.length < 2 || !members.every((m) => m.ready)) return false;
  // Two people who finish in the same instant both get this far. Counting is one atomic statement,
  // so exactly one of them takes the claim and runs; the other's page shows the plan when it lands.
  const claim = rateKey.autoNegotiate(eventId);
  if (!(await hit(claim, LIMITS.autoNegotiate)).allowed) return false;
  try {
    await runNegotiation(eventId, userId);
  } catch (err) {
    await clearRateKey(claim); // a failed run must not block the next "I'm done" from trying
    throw err;
  }
  return true;
}

export async function getResult(eventId: string, userId: string): Promise<StoredResult | null> {
  await requireMember(eventId, userId);
  const client = await db();
  const { rows } = await client.execute({ sql: "SELECT result_json FROM events WHERE id = ?", args: [eventId] });
  const raw = rows[0]?.result_json;
  return raw
    ? forGroupSize(upgradeResult(JSON.parse(decryptOrPlain(String(raw), scope.plan(eventId, "result")))))
    : null;
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
    // Keep whatever else the round carries (a shortlist's later rounds are marked `exploring`).
    ...r,
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
  await clearRateKey(rateKey.autoNegotiate(eventId));
  await clearRateKey(rateKey.runs(eventId));
}

/** Takes one member's constraints and private chat out of a plan and un-decides it. */
async function dropMember(eventId: string, userId: string) {
  const client = await db();
  await client.execute({
    sql: "UPDATE events SET result_json = NULL, decided_at = NULL WHERE id = ?",
    args: [eventId],
  });
  await client.execute({ sql: "DELETE FROM messages WHERE event_id = ? AND user_id = ?", args: [eventId, userId] });
  await client.execute({ sql: "DELETE FROM members WHERE event_id = ? AND user_id = ?", args: [eventId, userId] });
  // The plan without them is a different group: let it be found again as soon as everyone left is done.
  await clearRateKey(rateKey.autoNegotiate(eventId));
}

/** Removes one member's constraints and private chat from a plan and un-decides it. */
export async function leavePlan(eventId: string, userId: string): Promise<void> {
  await requireMember(eventId, userId);
  if ((await creatorOf(eventId)) === userId) await handOverOrDeleteCreated(userId, eventId);
  await dropMember(eventId, userId);
}

// ---------------------------------------------------------------------------
// What the creator controls (#119). An invite link gets forwarded, so the person who
// started the plan can take someone out, replace the link, and set how many people fit.
// ---------------------------------------------------------------------------

async function requireCreator(eventId: string, userId: string, what: string) {
  const creator = await creatorOf(eventId);
  if (!creator) throw new AccessError("That plan doesn't exist");
  if (creator !== userId) throw new AccessError(`Only the person who created this plan can ${what}`);
}

/**
 * Removes someone else from the plan, with their constraints and private chat, exactly as if
 * they had left. They can come back with the invite link, so replace the link too to keep them out.
 */
export async function removeMember(eventId: string, creatorId: string, memberId: string): Promise<void> {
  await requireCreator(eventId, creatorId, "remove someone");
  if (memberId === creatorId) throw new AccessError("To take yourself out, leave the plan instead");
  if (!(await isMember(eventId, memberId))) throw new AccessError("That person is not in this plan");
  await dropMember(eventId, memberId);
}

/** Replaces the invite link. The old one stops working; everyone already in the plan stays. */
export async function resetInviteCode(eventId: string, creatorId: string): Promise<string> {
  await requireCreator(eventId, creatorId, "replace the invite link");
  const code = await unusedInviteCode();
  const client = await db();
  await client.execute({ sql: "UPDATE events SET invite_code = ? WHERE id = ?", args: [code, eventId] });
  return code;
}

/** Changes how many people fit. It cannot go below the number already in the plan. */
export async function setMaxMembers(eventId: string, creatorId: string, maxMembers: number): Promise<number> {
  await requireCreator(eventId, creatorId, "change how many people can join");
  const size = PlanSizeSchema.parse(maxMembers);
  const client = await db();
  const joined = await countMembers(eventId);
  if (size < joined) {
    throw new AccessError(
      `${joined} people are already in this plan. Remove someone first, or choose ${joined} or more.`,
    );
  }
  await client.execute({ sql: "UPDATE events SET max_members = ? WHERE id = ?", args: [size, eventId] });
  return size;
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
  await clearRateKey(rateKey.createPlan(userId));
  await client.execute({ sql: "DELETE FROM llm_spend WHERE payer = ?", args: [userId] });
  await client.execute({ sql: "DELETE FROM users WHERE id = ?", args: [userId] });
}
