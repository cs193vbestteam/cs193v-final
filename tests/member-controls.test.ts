import { beforeEach, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { createUser } from "@/lib/auth";
import { db, resetDbForTests } from "@/lib/db";
import {
  AccessError,
  DEFAULT_PLAN_SIZE,
  MAX_PLAN_SIZE,
  createEvent,
  getEventByCode,
  getMyMessages,
  joinEvent,
  listMembers,
  newInviteCode,
  removeMember,
  resetInviteCode,
  sendMessage,
  setMaxMembers,
} from "@/lib/events";

/** What the plan's creator controls (#119): who is in it, the invite link, and how many people fit. */

beforeEach(async () => {
  delete process.env.ANTHROPIC_API_KEY; // deterministic rule-based extractor
  await resetDbForTests();
});

let n = 0;
const makeUser = (name: string) =>
  createUser({ email: `${name}${n++}@test.dev`, displayName: name, password: "password123" });

const count = async (sql: string, ...args: unknown[]) => Number((await (await db()).execute({ sql, args })).rows[0].n);
const names = async (eventId: string, viewerId: string) =>
  (await listMembers(eventId, viewerId)).map((m) => m.displayName);

async function plan(size?: number) {
  const a = await makeUser("Alice");
  const b = await makeUser("Bob");
  const event = await createEvent(a.id, "Dinner", null, undefined, undefined, size);
  return { a, b, event };
}

describe("how many people fit", () => {
  it("is what the creator chose, and a default when they chose nothing", async () => {
    expect((await plan(5)).event.maxMembers).toBe(5);
    const { event } = await plan();
    expect(event.maxMembers).toBe(DEFAULT_PLAN_SIZE);
    expect((await getEventByCode(event.inviteCode))?.maxMembers).toBe(DEFAULT_PLAN_SIZE);
  });

  it("refuses a size outside the allowed range", async () => {
    const a = await makeUser("Alice");
    for (const size of [1, 0, -3, MAX_PLAN_SIZE + 1, 2.5]) {
      await expect(createEvent(a.id, "Dinner", null, undefined, undefined, size)).rejects.toBeInstanceOf(ZodError);
    }
  });

  it("turns away whoever comes after the last place is taken", async () => {
    const { a, b, event } = await plan(2);
    await joinEvent(event.inviteCode, b.id);
    const late = await makeUser("Carol");
    await expect(joinEvent(event.inviteCode, late.id)).rejects.toThrow(/full/);
    expect(await names(event.id, a.id)).toEqual(["Alice", "Bob"]);
    expect(await count("SELECT COUNT(*) AS n FROM messages WHERE user_id = ?", late.id)).toBe(0);
  });

  it("still lets someone already in a full plan open it again", async () => {
    const { b, event } = await plan(2);
    await joinEvent(event.inviteCode, b.id);
    await expect(joinEvent(event.inviteCode, b.id)).resolves.toMatchObject({ id: event.id });
  });

  it("gives the last place to exactly one of two people who ask at once", async () => {
    const { a, b, event } = await plan(2);
    const c = await makeUser("Carol");
    const results = await Promise.allSettled([joinEvent(event.inviteCode, b.id), joinEvent(event.inviteCode, c.id)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await names(event.id, a.id)).toHaveLength(2);
  });

  it("can be raised by the creator to let the next person in", async () => {
    const { a, b, event } = await plan(2);
    await joinEvent(event.inviteCode, b.id);
    const c = await makeUser("Carol");
    await setMaxMembers(event.id, a.id, 3);
    await joinEvent(event.inviteCode, c.id);
    expect(await names(event.id, a.id)).toEqual(["Alice", "Bob", "Carol"]);
  });

  it("cannot go below the number of people already in the plan", async () => {
    const { a, b, event } = await plan(4);
    await joinEvent(event.inviteCode, b.id);
    const c = await makeUser("Carol");
    await joinEvent(event.inviteCode, c.id);
    await expect(setMaxMembers(event.id, a.id, 2)).rejects.toThrow(/3 people are already in this plan/);
    expect((await getEventByCode(event.inviteCode))?.maxMembers).toBe(4);
  });

  it("can only be changed by the creator", async () => {
    const { b, event } = await plan(4);
    await joinEvent(event.inviteCode, b.id);
    await expect(setMaxMembers(event.id, b.id, 10)).rejects.toBeInstanceOf(AccessError);
    expect((await getEventByCode(event.inviteCode))?.maxMembers).toBe(4);
  });
});

describe("removeMember", () => {
  it("takes the person out with their chat and constraints, and un-decides the plan", async () => {
    const { a, b, event } = await plan();
    await joinEvent(event.inviteCode, b.id);
    await sendMessage(event.id, b.id, "under $30, vegetarian");
    await (
      await db()
    ).execute({
      sql: "UPDATE events SET result_json = ?, decided_at = ? WHERE id = ?",
      args: [JSON.stringify({ status: "agreed", memberNames: ["Alice", "Bob"] }), Date.now(), event.id],
    });
    const aliceChat = await getMyMessages(event.id, a.id);

    await removeMember(event.id, a.id, b.id);

    expect(await names(event.id, a.id)).toEqual(["Alice"]);
    expect(await count("SELECT COUNT(*) AS n FROM messages WHERE event_id = ? AND user_id = ?", event.id, b.id)).toBe(
      0,
    );
    expect(await count("SELECT COUNT(*) AS n FROM events WHERE id = ? AND result_json IS NOT NULL", event.id)).toBe(0);
    expect(await getMyMessages(event.id, a.id)).toEqual(aliceChat);
    await expect(getMyMessages(event.id, b.id)).rejects.toBeInstanceOf(AccessError);
  });

  it("is refused for anyone but the creator, and changes nothing", async () => {
    const { a, b, event } = await plan();
    await joinEvent(event.inviteCode, b.id);
    const c = await makeUser("Carol");
    await joinEvent(event.inviteCode, c.id);
    await expect(removeMember(event.id, b.id, c.id)).rejects.toBeInstanceOf(AccessError);
    await expect(removeMember(event.id, b.id, a.id)).rejects.toBeInstanceOf(AccessError);
    const outsider = await makeUser("Eve");
    await expect(removeMember(event.id, outsider.id, b.id)).rejects.toBeInstanceOf(AccessError);
    expect(await names(event.id, a.id)).toEqual(["Alice", "Bob", "Carol"]);
  });

  it("does not let the creator remove themselves or someone who is not in the plan", async () => {
    const { a, b, event } = await plan();
    await expect(removeMember(event.id, a.id, a.id)).rejects.toThrow(/leave the plan/);
    await expect(removeMember(event.id, a.id, b.id)).rejects.toThrow(/not in this plan/);
    expect(await names(event.id, a.id)).toEqual(["Alice"]);
  });
});

describe("resetInviteCode", () => {
  it("makes the old link stop working and keeps everyone who is already in", async () => {
    const { a, b, event } = await plan();
    await joinEvent(event.inviteCode, b.id);
    const code = await resetInviteCode(event.id, a.id);

    expect(code).not.toBe(event.inviteCode);
    expect(await getEventByCode(event.inviteCode)).toBeNull();
    expect((await getEventByCode(code))?.id).toBe(event.id);
    expect(await names(event.id, a.id)).toEqual(["Alice", "Bob"]);
    const late = await makeUser("Carol");
    await expect(joinEvent(event.inviteCode, late.id)).rejects.toBeInstanceOf(AccessError);
    await expect(joinEvent(code, late.id)).resolves.toMatchObject({ id: event.id });
  });

  it("keeps a removed person out once the link is replaced", async () => {
    const { a, b, event } = await plan();
    await joinEvent(event.inviteCode, b.id);
    await removeMember(event.id, a.id, b.id);
    await resetInviteCode(event.id, a.id);
    await expect(joinEvent(event.inviteCode, b.id)).rejects.toBeInstanceOf(AccessError);
    expect(await names(event.id, a.id)).toEqual(["Alice"]);
  });

  it("is refused for anyone but the creator", async () => {
    const { b, event } = await plan();
    await joinEvent(event.inviteCode, b.id);
    await expect(resetInviteCode(event.id, b.id)).rejects.toBeInstanceOf(AccessError);
    expect((await getEventByCode(event.inviteCode))?.id).toBe(event.id);
  });
});

describe("newInviteCode", () => {
  it("is six digits", () => {
    for (let i = 0; i < 200; i++) expect(newInviteCode()).toMatch(/^[0-9]{6}$/);
  });

  it("throws away the bytes that would favour the first digits", () => {
    // 250..255 are past the last whole multiple of 10; taken modulo 10 they would be 0..5.
    const biased = new Uint8Array(12).fill(252);
    const fair = Uint8Array.from({ length: 12 }, (_, i) => i); // 0, 1, 2, …
    let call = 0;
    const code = newInviteCode(() => (call++ === 0 ? biased : fair));
    expect(code).toBe("012345");
    expect(call).toBe(2);
  });
});
