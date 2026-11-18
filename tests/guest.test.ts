import { beforeEach, describe, expect, it } from "vitest";
import {
  AuthError,
  authenticate,
  createGuest,
  createSession,
  createUser,
  getUserBySession,
  upgradeGuest,
} from "@/lib/auth";
import { db, resetDbForTests } from "@/lib/db";
import { createEvent, deleteAccount, getMyMessages, joinEvent, listMembers, sendMessage } from "@/lib/events";
import { planCodeFrom } from "@/lib/plan-code";

/**
 * Joining with a plan code and a name, without an account (#160). A tester in the November 16
 * user test asked why people could not just join as guests.
 */

beforeEach(async () => {
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.GOOGLE_PLACES_API_KEY;
  await resetDbForTests();
});

const alice = { email: "alice@test.dev", displayName: "Alice", password: "correct horse battery" };

describe("a guest", () => {
  it("is a user with a name, no email, and a session", async () => {
    const guest = await createGuest({ displayName: "  Gus " });
    expect(guest).toMatchObject({ displayName: "Gus", email: "", guest: true });
    const { token } = await createSession(guest.id);
    expect(await getUserBySession(token)).toEqual(guest);
  });

  it("needs a name", async () => {
    await expect(createGuest({ displayName: "   " })).rejects.toThrow();
    await expect(createGuest({ displayName: "x".repeat(41) })).rejects.toThrow();
  });

  it("stores the name encrypted, and nothing a password could match", async () => {
    const guest = await createGuest({ displayName: "Gustavo" });
    const { rows } = await (await db()).execute({ sql: "SELECT * FROM users WHERE id = ?", args: [guest.id] });
    expect(JSON.stringify(rows[0])).not.toContain("Gustavo");
    expect(String(rows[0].password_hash)).not.toMatch(/^\$2/);
    expect(Number(rows[0].is_guest)).toBe(1);
  });

  it("cannot be logged into, whatever password is tried", async () => {
    const guest = await createGuest({ displayName: "Gus" });
    for (const password of ["!", "", "password123"]) {
      await expect(authenticate({ email: `${guest.id}@guest.invalid`, password: password || "x" })).rejects.toThrow(
        AuthError,
      );
    }
  });

  it("joins a plan and gets a private chat like anyone else", async () => {
    const owner = await createUser(alice);
    const event = await createEvent(owner.id, "Dinner");
    const guest = await createGuest({ displayName: "Gus" });
    await joinEvent(event.inviteCode, guest.id);
    await sendMessage(event.id, guest.id, "dinner at 7pm, up to $41 per person, no restrictions");
    expect((await listMembers(event.id, owner.id)).map((m) => m.displayName).sort()).toEqual(["Alice", "Gus"]);
    expect(JSON.stringify(await getMyMessages(event.id, owner.id))).not.toContain("$41");
    expect(JSON.stringify(await getMyMessages(event.id, guest.id))).toContain("$41");
  });

  it("can delete everything", async () => {
    const owner = await createUser(alice);
    const event = await createEvent(owner.id, "Dinner");
    const guest = await createGuest({ displayName: "Gus" });
    await joinEvent(event.inviteCode, guest.id);
    await deleteAccount(guest.id);
    const client = await db();
    for (const table of ["users", "members", "messages", "sessions"]) {
      const column = table === "users" ? "id" : "user_id";
      const { rows } = await client.execute({ sql: `SELECT 1 FROM ${table} WHERE ${column} = ?`, args: [guest.id] });
      expect(rows).toHaveLength(0);
    }
  });
});

describe("a guest who adds an email and password", () => {
  it("keeps the same id, plans and session, and can then log in", async () => {
    const owner = await createUser(alice);
    const event = await createEvent(owner.id, "Dinner");
    const guest = await createGuest({ displayName: "Gus" });
    const { token } = await createSession(guest.id);
    await joinEvent(event.inviteCode, guest.id);

    const account = await upgradeGuest(guest.id, {
      email: "Gus@Test.dev",
      displayName: "Gus",
      password: "long enough",
    });
    expect(account).toEqual({ id: guest.id, displayName: "Gus", email: "gus@test.dev", guest: false });
    expect(await getUserBySession(token)).toEqual(account);
    expect((await authenticate({ email: "gus@test.dev", password: "long enough" })).id).toBe(guest.id);
    expect((await listMembers(event.id, owner.id)).some((m) => m.userId === guest.id)).toBe(true);
  });

  it("is refused an email someone already has, and stays a guest", async () => {
    await createUser(alice);
    const guest = await createGuest({ displayName: "Gus" });
    await expect(upgradeGuest(guest.id, { ...alice, displayName: "Gus" })).rejects.toThrow(/already exists/);
    const { token } = await createSession(guest.id);
    expect((await getUserBySession(token))?.guest).toBe(true);
  });

  it("does nothing to an account that is not a guest", async () => {
    const owner = await createUser(alice);
    await expect(
      upgradeGuest(owner.id, { email: "other@test.dev", displayName: "Other", password: "long enough" }),
    ).rejects.toThrow(AuthError);
    expect((await authenticate(alice)).id).toBe(owner.id);
  });
});

describe("planCodeFrom", () => {
  it("reads a code typed in any case, with spaces, or pasted as a whole link", () => {
    expect(planCodeFrom("2cpnnb97")).toBe("2cpnnb97");
    expect(planCodeFrom(" 2CPN NB97 ")).toBe("2cpnnb97");
    expect(planCodeFrom("https://settle.example/e/2cpnnb97?x=1")).toBe("2cpnnb97");
    expect(planCodeFrom("/e/2CPNNB97")).toBe("2cpnnb97");
  });

  it("gives nothing for input that could not be a code", () => {
    for (const bad of ["", "ab", "../../etc", "a b c", "<script>", null, undefined, 7, "x".repeat(40)])
      expect(planCodeFrom(bad)).toBe("");
  });
});
