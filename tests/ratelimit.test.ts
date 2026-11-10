import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthError, authenticate, checkIpLimit, createUser } from "@/lib/auth";
import { db, resetDbForTests } from "@/lib/db";
import { createEvent, deleteAccount, getMyMessages, RateLimitError, sendMessage } from "@/lib/events";
import { extract } from "@/lib/extract";
import { emptyConstraints } from "@/lib/constraints";
import { hit, LIMITS, prune, rateKey, waitText } from "@/lib/ratelimit";

beforeEach(async () => {
  delete process.env.ANTHROPIC_API_KEY;
  await resetDbForTests();
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.ANTHROPIC_API_KEY;
});

let n = 0;
const makeUser = (name: string) =>
  createUser({ email: `${name}${n++}@test.dev`, displayName: name, password: "password123" });

/** Puts a counter in a given state without sending dozens of real requests. */
async function setCounter(key: string, count: number, windowStart = Date.now()) {
  await (
    await db()
  ).execute({
    sql: `INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, ?)
          ON CONFLICT (key) DO UPDATE SET count = EXCLUDED.count, window_start = EXCLUDED.window_start`,
    args: [key, windowStart, count],
  });
}

describe("hit (fixed window)", () => {
  const limit = { max: 3, windowMs: 60_000 };
  const t0 = 1_800_000_000_000;

  it("allows up to the limit and refuses the next hit", async () => {
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await hit("k", limit, t0 + i));
    expect(results.map((r) => r.allowed)).toEqual([true, true, true, false]);
    expect(results.map((r) => r.remaining)).toEqual([2, 1, 0, 0]);
    expect(results[3].retryAfterMs).toBe(60_000 - 3);
  });

  it("starts a fresh window once the old one has passed", async () => {
    for (let i = 0; i < 4; i++) await hit("k", limit, t0);
    expect((await hit("k", limit, t0 + 59_999)).allowed).toBe(false);
    const fresh = await hit("k", limit, t0 + 60_000);
    expect(fresh).toEqual({ allowed: true, remaining: 2, retryAfterMs: 0 });
  });

  it("keeps keys independent", async () => {
    for (let i = 0; i < 4; i++) await hit("a", limit, t0);
    expect((await hit("b", limit, t0)).allowed).toBe(true);
  });

  it("counts concurrent hits exactly (single atomic upsert)", async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => hit("k", limit, t0)));
    expect(results.filter((r) => r.allowed)).toHaveLength(3);
  });

  it("never stores an email or IP in the clear", async () => {
    await hit(rateKey.loginEmail("Alice@Example.com"), LIMITS.loginPerEmail);
    await hit(rateKey.loginIp("203.0.113.7"), LIMITS.loginPerIp);
    const { rows } = await (await db()).execute("SELECT key FROM rate_limits");
    const keys = rows.map((r) => String(r.key)).join(" ");
    expect(keys).not.toMatch(/alice|example|203\.0\.113/i);
  });

  it("prunes counters that ended long ago", async () => {
    await setCounter("old", 5, t0);
    await setCounter("new", 5, t0 + 3 * 86_400_000);
    await prune(t0 + 3 * 86_400_000);
    const { rows } = await (await db()).execute("SELECT key FROM rate_limits");
    expect(rows.map((r) => r.key)).toEqual(["new"]);
  });

  it("formats the wait time", () => {
    expect(waitText(5_000)).toBe("in a few seconds");
    expect(waitText(60_000)).toBe("in 1 minute");
    expect(waitText(4 * 60_000 + 1)).toBe("in 5 minutes");
    expect(waitText(2 * 3_600_000)).toBe("in 2 hours");
  });
});

describe("chat messages", () => {
  it("accepts messages under the limit and refuses the one past it with a friendly error", async () => {
    const a = await makeUser("Alice");
    const e = await createEvent(a.id, "Dinner");
    await setCounter(rateKey.chat(a.id), LIMITS.chatPerUser.max - 1);

    await sendMessage(e.id, a.id, "Saturday dinner works"); // the last allowed one
    const before = (await getMyMessages(e.id, a.id)).length;
    const err = await sendMessage(e.id, a.id, "and under $40").catch((x) => x);
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.message).toMatch(/sending messages very quickly.*try again in \d+ minutes?/);
    // The refused message is not stored, and no reply is generated.
    expect((await getMyMessages(e.id, a.id)).length).toBe(before);
  });

  it("works again once the window has passed", async () => {
    const a = await makeUser("Alice");
    const e = await createEvent(a.id, "Dinner");
    await setCounter(rateKey.chat(a.id), LIMITS.chatPerUser.max + 5, Date.now() - LIMITS.chatPerUser.windowMs);
    await expect(sendMessage(e.id, a.id, "Saturday dinner works")).resolves.toBeDefined();
  });

  it("does not count messages from people outside the plan", async () => {
    const a = await makeUser("Alice");
    const outsider = await makeUser("Eve");
    const e = await createEvent(a.id, "Dinner");
    await expect(sendMessage(e.id, outsider.id, "hi")).rejects.toThrow();
    const { rows } = await (
      await db()
    ).execute({ sql: "SELECT 1 FROM rate_limits WHERE key = ?", args: [rateKey.chat(outsider.id)] });
    expect(rows).toHaveLength(0);
  });

  it("deleting the account removes the user's chat counter", async () => {
    const a = await makeUser("Alice");
    const e = await createEvent(a.id, "Dinner");
    await sendMessage(e.id, a.id, "Saturday dinner works");
    await deleteAccount(a.id);
    const { rows } = await (
      await db()
    ).execute({ sql: "SELECT 1 FROM rate_limits WHERE key = ?", args: [rateKey.chat(a.id)] });
    expect(rows).toHaveLength(0);
  });
});

describe("LLM budget per plan", () => {
  /** A fake Anthropic API that records calls and returns a valid tool call. */
  function fakeAnthropic() {
    const fetchMock = vi.fn(async () =>
      Response.json({
        content: [{ type: "tool_use", input: { reply: "Got it, Saturday dinner.", update: {} } }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    process.env.ANTHROPIC_API_KEY = "test-key-not-real";
    return fetchMock;
  }

  it("uses the LLM while the plan is under its daily budget", async () => {
    const a = await makeUser("Alice");
    const e = await createEvent(a.id, "Dinner");
    const fetchMock = fakeAnthropic();
    const { messages } = await sendMessage(e.id, a.id, "Saturday dinner works");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(messages.at(-1)?.content).toBe("Got it, Saturday dinner.");
  });

  it("falls back to the rule-based extractor once the budget is used up, instead of failing", async () => {
    const a = await makeUser("Alice");
    const e = await createEvent(a.id, "Dinner");
    await setCounter(rateKey.llm(e.id), LIMITS.llmPerPlan.max);
    const fetchMock = fakeAnthropic();
    const { messages } = await sendMessage(e.id, a.id, "Saturday dinner works");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(messages.at(-1)?.role).toBe("assistant");
    expect(messages.at(-1)?.content).not.toBe("Got it, Saturday dinner.");
  });

  it("extract() never calls the LLM when it isn't allowed to", async () => {
    const fetchMock = fakeAnthropic();
    const r = await extract([{ role: "user", content: "Saturday dinner" }], emptyConstraints(), {}, false);
    expect(r.source).toBe("rules");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("login and signup", () => {
  it("allows attempts under the per-email limit, then refuses even the right password", async () => {
    const u = await createUser({ email: "sam@test.dev", displayName: "Sam", password: "password123" });
    await setCounter(rateKey.loginEmail("sam@test.dev"), LIMITS.loginPerEmail.max - 1);
    await expect(authenticate({ email: "sam@test.dev", password: "password123" })).resolves.toMatchObject({
      id: u.id,
    });
    const err = await authenticate({ email: "SAM@test.dev", password: "password123" }).catch((x) => x);
    expect(err).toBeInstanceOf(AuthError);
    expect(err.message).toMatch(/Too many attempts for this account.*try again in \d+ minutes?/);
  });

  it("counts wrong passwords and unknown emails too", async () => {
    await createUser({ email: "sam@test.dev", displayName: "Sam", password: "password123" });
    for (let i = 0; i < LIMITS.loginPerEmail.max; i++) {
      await expect(authenticate({ email: "sam@test.dev", password: "wrong-password" })).rejects.toThrow(
        "Wrong email or password",
      );
    }
    await expect(authenticate({ email: "sam@test.dev", password: "password123" })).rejects.toThrow(/Too many/);
  });

  it("limits sign-in attempts and new accounts per IP", async () => {
    await setCounter(rateKey.loginIp("198.51.100.1"), LIMITS.loginPerIp.max);
    await expect(checkIpLimit("login", "198.51.100.1")).rejects.toThrow(/Too many sign-in attempts/);
    await expect(checkIpLimit("login", "198.51.100.2")).resolves.toBeUndefined();

    await setCounter(rateKey.signupIp("198.51.100.1"), LIMITS.signupPerIp.max);
    await expect(checkIpLimit("signup", "198.51.100.1")).rejects.toThrow(/Too many new accounts/);
  });
});
