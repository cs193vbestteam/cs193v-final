import { beforeEach, describe, expect, it } from "vitest";
import { createSession, createUser, getUserBySession } from "@/lib/auth";
import { db, resetDbForTests } from "@/lib/db";
import {
  AccessError,
  createEvent,
  deleteAccount,
  deletePlan,
  getMyMessages,
  getResult,
  joinEvent,
  leavePlan,
  listMembers,
  listMyEvents,
  sendMessage,
} from "@/lib/events";

beforeEach(async () => {
  delete process.env.ANTHROPIC_API_KEY; // deterministic rule-based extractor
  await resetDbForTests();
});

let n = 0;
const makeUser = (name: string) =>
  createUser({ email: `${name}${n++}@test.dev`, displayName: name, password: "password123" });

const count = async (sql: string, ...args: unknown[]) => Number((await (await db()).execute({ sql, args })).rows[0].n);

/** Rows that mention the user anywhere in the database. */
async function rowsForUser(userId: string) {
  return {
    users: await count("SELECT COUNT(*) AS n FROM users WHERE id = ?", userId),
    sessions: await count("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?", userId),
    members: await count("SELECT COUNT(*) AS n FROM members WHERE user_id = ?", userId),
    messages: await count("SELECT COUNT(*) AS n FROM messages WHERE user_id = ?", userId),
    createdEvents: await count("SELECT COUNT(*) AS n FROM events WHERE creator_id = ?", userId),
  };
}

/** Rows that belong to the plan anywhere in the database. */
async function rowsForPlan(eventId: string) {
  return {
    events: await count("SELECT COUNT(*) AS n FROM events WHERE id = ?", eventId),
    members: await count("SELECT COUNT(*) AS n FROM members WHERE event_id = ?", eventId),
    messages: await count("SELECT COUNT(*) AS n FROM messages WHERE event_id = ?", eventId),
  };
}

const NONE_FOR_PLAN = { events: 0, members: 0, messages: 0 };
const NONE_FOR_USER = { users: 0, sessions: 0, members: 0, messages: 0, createdEvents: 0 };

/** Marks a plan as decided without running a whole negotiation. */
const decide = async (eventId: string) =>
  (await db()).execute({
    sql: "UPDATE events SET result_json = ?, decided_at = ? WHERE id = ?",
    args: [JSON.stringify({ status: "agreed", memberNames: ["Alice", "Bob"] }), Date.now(), eventId],
  });
const isDecided = async (eventId: string) =>
  (await count("SELECT COUNT(*) AS n FROM events WHERE id = ? AND result_json IS NOT NULL", eventId)) === 1;

async function setup() {
  const a = await makeUser("Alice");
  const b = await makeUser("Bob");
  const event = await createEvent(a.id, "Saturday dinner");
  await joinEvent(event.inviteCode, b.id);
  await sendMessage(event.id, a.id, "Saturday dinner works, under $40");
  await sendMessage(event.id, b.id, "Sunday lunch only, no spicy food");
  return { a, b, event };
}

describe("deletePlan", () => {
  it("removes the plan, every member, every chat and the result", async () => {
    const { a, event } = await setup();
    await decide(event.id);
    await deletePlan(event.id, a.id);
    expect(await rowsForPlan(event.id)).toEqual(NONE_FOR_PLAN);
  });

  it("refuses anyone but the creator and leaves the plan untouched", async () => {
    const { b, event } = await setup();
    const outsider = await makeUser("Eve");
    const before = await rowsForPlan(event.id);
    await expect(deletePlan(event.id, b.id)).rejects.toBeInstanceOf(AccessError);
    await expect(deletePlan(event.id, outsider.id)).rejects.toBeInstanceOf(AccessError);
    expect(await rowsForPlan(event.id)).toEqual(before);
  });

  it("reports a plan that doesn't exist", async () => {
    const a = await makeUser("Alice");
    await expect(deletePlan("no-such-plan", a.id)).rejects.toThrow("doesn't exist");
  });

  it("does not touch other plans", async () => {
    const { a, b, event } = await setup();
    const other = await createEvent(b.id, "Other plan");
    await joinEvent(other.inviteCode, a.id);
    const before = await rowsForPlan(other.id);
    await deletePlan(event.id, a.id);
    expect(await rowsForPlan(other.id)).toEqual(before);
  });
});

describe("leavePlan", () => {
  it("removes only the leaver's constraints and chat, and un-decides the plan", async () => {
    const { a, b, event } = await setup();
    await decide(event.id);
    const aliceChat = await getMyMessages(event.id, a.id);
    await leavePlan(event.id, b.id);

    expect(await count("SELECT COUNT(*) AS n FROM members WHERE event_id = ? AND user_id = ?", event.id, b.id)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM messages WHERE event_id = ? AND user_id = ?", event.id, b.id)).toBe(
      0,
    );
    expect(await isDecided(event.id)).toBe(false);
    expect(await getResult(event.id, a.id)).toBeNull();
    // Alice keeps her own chat and still sees only names, now without Bob.
    expect(await getMyMessages(event.id, a.id)).toEqual(aliceChat);
    expect((await listMembers(event.id, a.id)).map((m) => m.displayName)).toEqual(["Alice"]);
    // Bob no longer has access.
    await expect(getMyMessages(event.id, b.id)).rejects.toBeInstanceOf(AccessError);
  });

  it("refuses someone who isn't a member", async () => {
    const { event } = await setup();
    const outsider = await makeUser("Eve");
    const before = await rowsForPlan(event.id);
    await expect(leavePlan(event.id, outsider.id)).rejects.toBeInstanceOf(AccessError);
    expect(await rowsForPlan(event.id)).toEqual(before);
  });

  it("hands the plan to the earliest remaining member when the creator leaves", async () => {
    const { a, b, event } = await setup();
    const c = await makeUser("Cat");
    await joinEvent(event.inviteCode, c.id);
    await leavePlan(event.id, a.id);

    const [plan] = await listMyEvents(b.id);
    expect(plan.id).toBe(event.id);
    expect(plan.creatorId).toBe(b.id);
    expect((await listMembers(event.id, b.id)).map((m) => m.displayName)).toEqual(["Bob", "Cat"]);
    expect(await count("SELECT COUNT(*) AS n FROM messages WHERE user_id = ?", a.id)).toBe(0);
  });

  it("deletes the plan when the creator was the only member", async () => {
    const a = await makeUser("Alice");
    const event = await createEvent(a.id, "Solo plan");
    await leavePlan(event.id, a.id);
    expect(await rowsForPlan(event.id)).toEqual(NONE_FOR_PLAN);
  });
});

describe("deleteAccount", () => {
  it("leaves no row for the user in any table and ends their sessions", async () => {
    const { a, b, event } = await setup();
    const { token } = await createSession(a.id);
    const solo = await createEvent(a.id, "Solo plan");
    const bobsPlan = await createEvent(b.id, "Bob's plan");
    await joinEvent(bobsPlan.inviteCode, a.id);
    await decide(bobsPlan.id);

    await deleteAccount(a.id);

    expect(await rowsForUser(a.id)).toEqual(NONE_FOR_USER);
    expect(await getUserBySession(token)).toBeNull();
    // A plan only Alice was in is gone entirely.
    expect(await rowsForPlan(solo.id)).toEqual(NONE_FOR_PLAN);
    // A shared plan Alice created now belongs to Bob, with Bob's chat intact.
    const shared = (await listMyEvents(b.id)).find((e) => e.id === event.id);
    expect(shared?.creatorId).toBe(b.id);
    expect((await getMyMessages(event.id, b.id)).length).toBeGreaterThan(0);
    // Bob's own plan is un-decided because its result named Alice.
    expect(await isDecided(bobsPlan.id)).toBe(false);
    expect((await listMembers(bobsPlan.id, b.id)).map((m) => m.displayName)).toEqual(["Bob"]);
  });

  it("does not touch other users", async () => {
    const { a, b } = await setup();
    const before = await rowsForUser(b.id);
    await deleteAccount(a.id);
    expect(await rowsForUser(b.id)).toEqual({ ...before, createdEvents: before.createdEvents + 1 });
  });
});
