import { beforeEach, describe, expect, it } from "vitest";
import { AuthError, authenticate, createSession, createUser, deleteSession, getUserBySession, hashPassword, verifyPassword } from "@/lib/auth";
import { db, resetDbForTests } from "@/lib/db";

beforeEach(() => resetDbForTests());

const alice = { email: "Alice@Stanford.edu", displayName: "Alice", password: "correct horse battery" };

describe("password hashing", () => {
  it("hashes with a per-hash salt and verifies", async () => {
    const [a, b] = await Promise.all([hashPassword("hunter22!"), hashPassword("hunter22!")]);
    expect(a).not.toBe(b); // different salts
    expect(a).toMatch(/^\$2[aby]\$12\$/); // bcrypt, cost 12
    expect(await verifyPassword("hunter22!", a)).toBe(true);
    expect(await verifyPassword("wrong", a)).toBe(false);
  });
});

describe("users", () => {
  it("signs up and logs in (email is case-insensitive)", async () => {
    const u = await createUser(alice);
    const logged = await authenticate({ email: "alice@stanford.edu", password: alice.password });
    expect(logged.id).toBe(u.id);
    expect(logged.email).toBe("alice@stanford.edu");
  });

  it("stores neither the email nor the password in plaintext", async () => {
    await createUser(alice);
    const { rows } = await (await db()).execute("SELECT * FROM users");
    const dump = JSON.stringify(rows);
    expect(dump).not.toMatch(/alice@stanford\.edu/i);
    expect(dump).not.toContain(alice.password);
  });

  it("rejects duplicate emails", async () => {
    await createUser(alice);
    await expect(createUser({ ...alice, email: "alice@stanford.edu" })).rejects.toThrow(AuthError);
  });

  it("rejects wrong passwords and unknown users with the same message", async () => {
    await createUser(alice);
    await expect(authenticate({ email: alice.email, password: "nope" })).rejects.toThrow("Wrong email or password");
    await expect(authenticate({ email: "bob@x.com", password: "nope" })).rejects.toThrow("Wrong email or password");
  });

  it("validates input", async () => {
    await expect(createUser({ ...alice, password: "short" })).rejects.toThrow();
    await expect(createUser({ ...alice, email: "not-an-email" })).rejects.toThrow();
    await expect(createUser({ ...alice, displayName: "  " })).rejects.toThrow();
  });
});

describe("sessions", () => {
  it("creates, resolves and deletes sessions; stores only the token hash", async () => {
    const u = await createUser(alice);
    const { token } = await createSession(u.id);
    expect((await getUserBySession(token))?.id).toBe(u.id);

    const { rows } = await (await db()).execute("SELECT token_hash FROM sessions");
    expect(String(rows[0].token_hash)).not.toBe(token);

    await deleteSession(token);
    expect(await getUserBySession(token)).toBeNull();
  });

  it("ignores missing, unknown and expired tokens", async () => {
    expect(await getUserBySession(undefined)).toBeNull();
    expect(await getUserBySession("made-up")).toBeNull();
    const u = await createUser(alice);
    const { token } = await createSession(u.id);
    await (await db()).execute({ sql: "UPDATE sessions SET expires_at = ?", args: [Date.now() - 1] });
    expect(await getUserBySession(token)).toBeNull();
  });
});
