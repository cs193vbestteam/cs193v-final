import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { authenticate, createUser } from "@/lib/auth";
import { db, isPostgresUrl, isUniqueViolation, resetDbForTests, toPostgresPlaceholders } from "@/lib/db";
import { createEvent, getMyMessages, joinEvent, listMembers, sendMessage } from "@/lib/events";

describe("helpers", () => {
  it("translates ? placeholders to $n", () => {
    expect(toPostgresPlaceholders("SELECT * FROM t WHERE a = ? AND b = ?")).toBe("SELECT * FROM t WHERE a = $1 AND b = $2");
    expect(toPostgresPlaceholders("SELECT 1")).toBe("SELECT 1");
  });

  it("recognizes Postgres URLs", () => {
    expect(isPostgresUrl("postgresql://u:p@host/db?sslmode=require")).toBe(true);
    expect(isPostgresUrl("postgres://u:p@host/db")).toBe(true);
    expect(isPostgresUrl("file:local.db")).toBe(false);
    expect(isPostgresUrl(":memory:")).toBe(false);
    expect(isPostgresUrl(undefined)).toBe(false);
  });

  it("detects unique violations by Postgres error code", () => {
    expect(isUniqueViolation({ code: "23505" })).toBe(true);
    expect(isUniqueViolation(new Error("boom"))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
  });
});

describe("schema (in-memory PGlite)", () => {
  beforeEach(() => resetDbForTests());

  it("creates all tables and stores millisecond timestamps (BIGINT)", async () => {
    const client = await db();
    const { rows } = await client.execute(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
    );
    expect(rows.map((r) => r.table_name)).toEqual(["events", "members", "messages", "sessions", "users"]);
    const u = await createUser({ email: "t@test.dev", displayName: "T", password: "password123" });
    const res = await client.execute({ sql: "SELECT created_at FROM users WHERE id = ?", args: [u.id] });
    expect(Number(res.rows[0].created_at)).toBeGreaterThan(1_700_000_000_000);
  });

  it("enforces foreign keys", async () => {
    const client = await db();
    await expect(
      client.execute({ sql: "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)", args: ["x", "nobody", 1] }),
    ).rejects.toThrow();
  });
});

/**
 * Runs the production code path (the `pg` driver over the real Postgres wire protocol)
 * against PGlite exposed on a local socket, so CI needs no Postgres server.
 */
describe("production driver (pg over the Postgres wire protocol)", () => {
  let server: PGLiteSocketServer;
  let pglite: PGlite;
  const oldUrl = process.env.DATABASE_URL;

  beforeAll(async () => {
    pglite = await PGlite.create();
    server = new PGLiteSocketServer({ db: pglite, port: 0, host: "127.0.0.1", maxConnections: 5 });
    await server.start();
    const port = Number(String(server.getServerConn()).split(":").pop());
    await resetDbForTests();
    process.env.DATABASE_URL = `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`;
  });

  afterAll(async () => {
    await resetDbForTests();
    process.env.DATABASE_URL = oldUrl;
    await server.stop();
    await pglite.close();
  });

  it("signs up, logs in, and rejects duplicate emails", async () => {
    const u = await createUser({ email: "pg@test.dev", displayName: "Pg", password: "password123" });
    expect((await authenticate({ email: "pg@test.dev", password: "password123" })).id).toBe(u.id);
    await expect(createUser({ email: "pg@test.dev", displayName: "Again", password: "password123" })).rejects.toThrow(
      "already exists",
    );
  });

  it("adds the plan columns to an events table created before they existed", async () => {
    await pglite.exec("ALTER TABLE events DROP COLUMN location, DROP COLUMN pool_json, DROP COLUMN pool_source");
    await resetDbForTests();
    const a = await createUser({ email: "old-pg@test.dev", displayName: "Old", password: "password123" });
    const e = await createEvent(a.id, "Brunch", "Palo Alto, CA");
    expect(e.location).toBe("Palo Alto, CA");
  });

  it("runs the plan flow: create, join twice, chat", async () => {
    const a = await createUser({ email: "a-pg@test.dev", displayName: "A", password: "password123" });
    const b = await createUser({ email: "b-pg@test.dev", displayName: "B", password: "password123" });
    const e = await createEvent(a.id, "Dinner");
    await joinEvent(e.inviteCode, b.id);
    await joinEvent(e.inviteCode, b.id); // ON CONFLICT DO NOTHING
    expect(await listMembers(e.id, a.id)).toHaveLength(2);
    const { constraints } = await sendMessage(e.id, b.id, "Saturday dinner, under $30");
    expect(constraints.budgetMax).toBe(30);
    expect((await getMyMessages(e.id, b.id)).map((m) => m.role)).toEqual(["assistant", "user", "assistant"]);
  });
});
