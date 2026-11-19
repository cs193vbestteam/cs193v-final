import { beforeEach, describe, expect, it } from "vitest";
import { authenticate, createUser, hashPassword } from "@/lib/auth";
import { isCurrent, legacyBlindIndex, legacyEncrypt } from "@/lib/crypto";
import { db, resetDbForTests } from "@/lib/db";
import {
  createEvent,
  getMyConstraints,
  getMyMessages,
  getResult,
  joinEvent,
  listMembers,
  listMyEvents,
  runNegotiation,
  sendMessage,
  setReady,
} from "@/lib/events";
import { migrateEncryption } from "@/lib/migrate-encryption";
import { scenarioFor } from "@/lib/scenario";

const EMPTY = scenarioFor("meal").emptyConstraints();

beforeEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
  resetDbForTests();
});

const dump = async (sql: string) => JSON.stringify((await (await db()).execute(sql)).rows);
const READY = "Saturday dinner, under $40, 30 minutes, no restrictions";

describe("everything users give us is encrypted at rest", () => {
  it("names, plan titles, locations, pools and results are not stored in plaintext", async () => {
    const a = await createUser({ email: "zelda@test.dev", displayName: "Zelda Quokka", password: "password123" });
    const b = await createUser({ email: "yuri@test.dev", displayName: "Yuri Pangolin", password: "password123" });
    const event = await createEvent(a.id, "Marmalade birthday", "Palo Alto, CA");
    await joinEvent(event.inviteCode, b.id);
    for (const u of [a, b]) {
      await sendMessage(event.id, u.id, READY);
      await setReady(event.id, u.id, true);
    }
    await runNegotiation(event.id, a.id);

    const all = (await dump("SELECT * FROM users")) + (await dump("SELECT * FROM events"));
    for (const word of ["Zelda", "Quokka", "Pangolin", "Marmalade", "Palo Alto", "memberNames"]) {
      expect(all).not.toContain(word);
    }
    // ...and everything still reads back for the people allowed to see it.
    expect((await listMyEvents(b.id))[0]).toMatchObject({
      title: "Marmalade birthday",
      location: "Palo Alto, CA",
      date: event.date,
    });
    expect(all).not.toContain(String(event.date));
    expect((await listMembers(event.id, b.id)).map((m) => m.displayName)).toEqual(["Zelda Quokka", "Yuri Pangolin"]);
    expect(await getResult(event.id, b.id)).toBeTruthy();
  });
});

describe("migrating data stored before per-scope keys", () => {
  /** Writes rows the way the app stored them before this change. */
  async function legacyRows() {
    const client = await db();
    await client.execute({
      sql: "INSERT INTO users (id, email_index, email_enc, display_name, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      args: [
        "old-user",
        legacyBlindIndex("old@test.dev"),
        legacyEncrypt("old@test.dev"),
        "Olive",
        await hashPassword("password123"),
        1,
      ],
    });
    await client.execute({
      sql: "INSERT INTO events (id, title, invite_code, creator_id, created_at, location, event_date, scenario) VALUES (?, ?, ?, ?, ?, ?, ?, 'meal')",
      args: ["old-plan", "Old picnic", "oldcode1", "old-user", 1, "Menlo Park", "2026-12-01"],
    });
    await client.execute({
      sql: "INSERT INTO members (event_id, user_id, constraints_enc, ready, joined_at) VALUES (?, ?, ?, 0, 1)",
      args: ["old-plan", "old-user", legacyEncrypt(JSON.stringify(EMPTY))],
    });
    await client.execute({
      sql: "INSERT INTO messages (event_id, user_id, role, content_enc, created_at) VALUES (?, ?, 'user', ?, 1)",
      args: ["old-plan", "old-user", legacyEncrypt("hello from before")],
    });
  }

  it("old rows still work before the migration runs", async () => {
    await legacyRows();
    const u = await authenticate({ email: "old@test.dev", password: "password123" });
    expect(u).toMatchObject({ id: "old-user", displayName: "Olive", email: "old@test.dev" });
    expect((await listMyEvents("old-user"))[0]).toMatchObject({
      title: "Old picnic",
      location: "Menlo Park",
      date: "2026-12-01",
    });
    expect((await getMyMessages("old-plan", "old-user"))[0].content).toBe("hello from before");
  });

  it("re-encrypts every row with its own key, keeps it readable, and can run twice", async () => {
    await legacyRows();
    expect(await migrateEncryption()).toMatchObject({ users: 1, members: 1, messages: 1, events: 1 });
    // The old invite code still works, but only a hash of it is stored now.
    expect(await dump("SELECT * FROM events")).not.toContain("oldcode1");
    expect((await joinEvent("oldcode1", "old-user")).inviteCode).toBe("oldcode1");

    const client = await db();
    const user = (await client.execute("SELECT * FROM users")).rows[0];
    const ev = (await client.execute("SELECT * FROM events")).rows[0];
    for (const v of [user.email_enc, user.display_name, ev.title, ev.location, ev.event_date])
      expect(isCurrent(String(v))).toBe(true);
    expect(user.email_index).not.toBe(legacyBlindIndex("old@test.dev"));
    expect(await dump("SELECT * FROM users")).not.toContain("Olive");

    const u = await authenticate({ email: "old@test.dev", password: "password123" });
    expect(u).toMatchObject({ id: "old-user", displayName: "Olive" });
    expect((await listMyEvents("old-user"))[0]).toMatchObject({
      title: "Old picnic",
      location: "Menlo Park",
      date: "2026-12-01",
    });
    expect((await getMyMessages("old-plan", "old-user"))[0].content).toBe("hello from before");
    expect(await getMyConstraints("old-plan", "old-user")).toEqual(EMPTY);

    expect(await migrateEncryption()).toEqual({
      users: 0,
      members: 0,
      messages: 0,
      events: 0,
      spend: 0,
      rateLimits: 0,
    });
  });
});
