import { beforeEach, describe, expect, it } from "vitest";
import { createUser } from "@/lib/auth";
import { decrypt, encrypt, isCurrent, pad, PAD_BLOCK, scope, unpad, v2Encrypt } from "@/lib/crypto";
import { db, resetDbForTests } from "@/lib/db";
import {
  canRerun,
  createEvent,
  getEventByCode,
  joinEvent,
  leavePlan,
  listMembers,
  listMyEvents,
  resetInviteCode,
  runNegotiation,
  sendMessage,
  setMaxMembers,
  setReady,
} from "@/lib/events";
import { migrateEncryption } from "@/lib/migrate-encryption";
import { recordSpend, spentThisMonth } from "@/lib/spend";

beforeEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
  resetDbForTests();
});

const rows = async (sql: string) => (await (await db()).execute(sql)).rows;
const dump = async (sql: string) => JSON.stringify(await rows(sql));
const DAY = 86_400_000;
const READY = "Saturday dinner, under $40, 30 minutes, no restrictions";

let n = 0;
const makeUser = (name: string) =>
  createUser({ email: `${name}${n++}@test.dev`, displayName: name, password: "password123" });

describe("padding hides how long a value is", () => {
  it("round-trips text of every length, including at a block boundary and in other scripts", () => {
    for (const text of ["", "$30", "x".repeat(PAD_BLOCK - 1), "x".repeat(PAD_BLOCK), "不吃辣，花生过敏 🥜"]) {
      expect(pad(text).length % PAD_BLOCK).toBe(0);
      expect(unpad(pad(text))).toBe(text);
    }
  });

  it("a short answer and a long one encrypt to the same length", () => {
    const s = scope.chat("p", "u");
    const short = encrypt("$30", s);
    const long = encrypt("I'm allergic to peanuts and shellfish, and I'd rather not go too far.", s);
    expect(short.length).toBe(long.length);
  });

  it("values written before padding (v2) still read, and the migration pads them", async () => {
    const s = scope.chat("p", "u");
    expect(decrypt(v2Encrypt("hello", s), s)).toBe("hello");
    const a = await makeUser("Alice");
    const e = await createEvent(a.id, "Dinner");
    const client = await db();
    await client.execute({
      sql: "UPDATE events SET title = ? WHERE id = ?",
      args: [v2Encrypt("Old title", scope.plan(e.id, "title")), e.id],
    });
    expect((await listMyEvents(a.id))[0].title).toBe("Old title");
    expect((await migrateEncryption()).events).toBe(1);
    const title = String((await rows("SELECT title FROM events"))[0].title);
    expect(isCurrent(title)).toBe(true);
    expect((await listMyEvents(a.id))[0].title).toBe("Old title");
  });
});

describe("a copy of the database shows no metadata about people", () => {
  it("after a whole plan, the plaintext columns hold no times, codes, ids or counts that name anyone", async () => {
    const a = await makeUser("Alice");
    const b = await makeUser("Blake");
    const e = await createEvent(a.id, "Dinner");
    await joinEvent(e.inviteCode, b.id);
    for (const u of [a, b]) {
      await sendMessage(e.id, u.id, READY);
      await setReady(e.id, u.id, true);
    }
    await runNegotiation(e.id, a.id);
    await recordSpend(a.id, 100);

    // The invite code is only stored as a keyed hash.
    expect(await dump("SELECT * FROM events")).not.toContain(e.inviteCode);
    // Who finished, joined and changed when is encrypted; the plaintext columns are blank.
    for (const m of await rows("SELECT * FROM members")) {
      expect(Number(m.ready)).toBe(0);
      expect(Number(m.joined_at)).toBe(0);
      expect(m.ready_at).toBeNull();
      expect(m.changed_at).toBeNull();
      expect(isCurrent(String(m.status_enc))).toBe(true);
    }
    // A plan's exact creation time, size and decision time are encrypted.
    const ev = (await rows("SELECT * FROM events"))[0];
    expect(ev.decided_at).toBeNull();
    expect(Number(ev.max_members)).toBe(0);
    expect(Number(ev.created_at) % DAY).toBe(0);
    expect(isCurrent(String(ev.meta_enc))).toBe(true);
    // Housekeeping times are only the day.
    for (const r of await rows("SELECT created_at FROM messages")) expect(Number(r.created_at) % DAY).toBe(0);
    for (const r of await rows("SELECT created_at FROM users")) expect(Number(r.created_at) % DAY).toBe(0);
    // Counters and spending don't name a user or a plan.
    const counters = (await dump("SELECT * FROM rate_limits")) + (await dump("SELECT * FROM llm_spend"));
    for (const id of [a.id, b.id, e.id]) expect(counters).not.toContain(id);
    expect(await spentThisMonth(a.id)).toBeCloseTo(0.0001);
  });
});

describe("the app still does everything it did with the metadata", () => {
  it("lists members in the order they joined and shows who is done", async () => {
    const a = await makeUser("Alice");
    const b = await makeUser("Blake");
    const c = await makeUser("Casey");
    const e = await createEvent(a.id, "Dinner");
    await joinEvent(e.inviteCode, b.id);
    await joinEvent(e.inviteCode, c.id);
    await sendMessage(e.id, b.id, READY);
    await setReady(e.id, b.id, true);
    const members = await listMembers(e.id, c.id);
    expect(members.map((m) => m.displayName)).toEqual(["Alice", "Blake", "Casey"]);
    expect(members.map((m) => m.ready)).toEqual([false, true, false]);
  });

  it("finds a plan by its code, any case, and a replaced code stops working", async () => {
    const a = await makeUser("Alice");
    const e = await createEvent(a.id, "Dinner");
    expect((await getEventByCode(e.inviteCode.toUpperCase()))?.id).toBe(e.id);
    const next = await resetInviteCode(e.id, a.id);
    expect(await getEventByCode(e.inviteCode)).toBeNull();
    expect((await getEventByCode(next))?.inviteCode).toBe(next);
    // The stored hash is not itself a code.
    const stored = String((await rows("SELECT invite_code FROM events"))[0].invite_code);
    expect(await getEventByCode(stored)).toBeNull();
  });

  it("keeps the plan size, lists newest plans first, and hands a plan to whoever joined next", async () => {
    const a = await makeUser("Alice");
    const b = await makeUser("Blake");
    const c = await makeUser("Casey");
    const first = await createEvent(a.id, "First");
    const second = await createEvent(a.id, "Second");
    expect((await listMyEvents(a.id)).map((x) => x.title)).toEqual(["Second", "First"]);
    expect(await setMaxMembers(first.id, a.id, 3)).toBe(3);
    expect((await getEventByCode(first.inviteCode))?.maxMembers).toBe(3);
    await joinEvent(first.inviteCode, b.id);
    await joinEvent(first.inviteCode, c.id);
    await leavePlan(first.id, a.id);
    expect((await getEventByCode(first.inviteCode))?.creatorId).toBe(b.id);
    await leavePlan(second.id, a.id);
    expect(await getEventByCode(second.inviteCode)).toBeNull();
  });

  it("a plan can be run again only after someone changes an answer", async () => {
    const a = await makeUser("Alice");
    const b = await makeUser("Blake");
    const e = await createEvent(a.id, "Dinner");
    await joinEvent(e.inviteCode, b.id);
    for (const u of [a, b]) {
      await sendMessage(e.id, u.id, READY);
      await setReady(e.id, u.id, true);
    }
    await runNegotiation(e.id, a.id);
    expect(await canRerun(e.id, a.id)).toBe(false);
    await new Promise((r) => setTimeout(r, 5));
    await sendMessage(e.id, b.id, "Actually under $25");
    await setReady(e.id, b.id, true);
    expect(await canRerun(e.id, a.id)).toBe(true);
  });
});

describe("migrating plaintext metadata", () => {
  it("moves member status, plan bookkeeping, invite codes and spending into their encrypted form", async () => {
    const client = await db();
    const a = await makeUser("Alice");
    const b = await makeUser("Blake");
    const e = await createEvent(a.id, "Dinner");
    await joinEvent(e.inviteCode, b.id);
    // Make the rows look the way they were stored before this change.
    await client.execute({
      sql: "UPDATE members SET status_enc = NULL, ready = CASE WHEN user_id = ? THEN 1 ELSE 0 END, joined_at = CASE WHEN user_id = ? THEN 1000 ELSE 2000 END, ready_at = CASE WHEN user_id = ? THEN 1500 ELSE NULL END",
      args: [b.id, a.id, b.id],
    });
    await client.execute({
      sql: "UPDATE events SET invite_code = ?, invite_enc = NULL, meta_enc = NULL, created_at = 12345, max_members = 7",
      args: [e.inviteCode],
    });
    await client.execute({ sql: "DELETE FROM llm_spend" });
    await client.execute({
      sql: "INSERT INTO llm_spend (payer, month, micros) VALUES (?, ?, 500)",
      args: [a.id, new Date().toISOString().slice(0, 7)],
    });
    await client.execute({
      sql: "INSERT INTO rate_limits (key, window_start, count) VALUES (?, 0, 1)",
      args: [`chat:${a.id}`],
    });

    // Before the migration, everything reads from the old columns.
    expect((await listMembers(e.id, a.id)).map((m) => m.ready)).toEqual([false, true]);
    expect((await getEventByCode(e.inviteCode))?.maxMembers).toBe(7);

    const counts = await migrateEncryption();
    expect(counts).toMatchObject({ members: 2, events: 1, spend: 1, rateLimits: 1 });

    expect(await dump("SELECT * FROM events")).not.toContain(e.inviteCode);
    expect((await listMembers(e.id, a.id)).map((m) => [m.displayName, m.ready])).toEqual([
      ["Alice", false],
      ["Blake", true],
    ]);
    expect((await getEventByCode(e.inviteCode))?.maxMembers).toBe(7);
    expect(await spentThisMonth(a.id)).toBeCloseTo(0.0005);
    expect(await dump("SELECT * FROM llm_spend")).not.toContain(a.id);
    expect(await dump("SELECT * FROM rate_limits")).not.toContain(a.id);

    // Running it again changes nothing.
    expect(await migrateEncryption()).toMatchObject({ users: 0, members: 0, messages: 0, events: 0, spend: 0 });
  });
});
