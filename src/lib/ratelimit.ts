import { blindIndex } from "./crypto";
import { db } from "./db";

/**
 * Fixed-window rate limits stored in the database, so they hold across serverless
 * instances (#4). One row per key: when the window started and how many hits it has.
 *
 * Keys never contain an email, IP address, user id or plan id in the clear: they go
 * through a keyed HMAC (`blindIndex`), like the email lookup index.
 */

export type Limit = { max: number; windowMs: number };

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const LIMITS = {
  /** Chat messages one person can send, across all their plans. */
  chatPerUser: { max: 30, windowMs: 10 * MINUTE },
  /** Plans one person can create per day. Each new plan costs a geocode and a restaurant search (Google Places). */
  createPlanPerUser: { max: 10, windowMs: DAY },
  /** Model calls from a plan's private chats per day, everyone's together; after that, the rule-based reader answers. */
  llmPerPlan: { max: 300, windowMs: DAY },
  /** Login attempts per email address (also covers the password check before deleting an account). */
  loginPerEmail: { max: 10, windowMs: 15 * MINUTE },
  /** Login attempts per IP address (many emails from one place). */
  loginPerIp: { max: 50, windowMs: 15 * MINUTE },
  /** New accounts per IP address. */
  signupPerIp: { max: 10, windowMs: HOUR },
  /**
   * The claim on a plan's automatic negotiation: one at a time. Two people can press "I'm done" in
   * the same instant; only the one who takes the claim starts the run. Longer than a run can last.
   */
  autoNegotiate: { max: 1, windowMs: 2 * MINUTE },
  /**
   * Times a plan can be decided in a day, the first time included. Every run shows the group a
   * plan made from everyone's answers, so someone who keeps changing their own answers and running
   * it again can work out what another person said (#118). A group that is really changing its mind
   * needs a handful of runs; nobody needs dozens.
   */
  runsPerPlan: { max: 6, windowMs: DAY },
} satisfies Record<string, Limit>;

/**
 * Keys never name a user or a plan either: their ids go through the same keyed hash, so the
 * table does not show who has been chatting or which plans were run, only anonymous counters.
 */
const anon = (id: string) => blindIndex(id, "ratelimit");

export const rateKey = {
  chat: (userId: string) => `chat:${anon(userId)}`,
  llm: (eventId: string) => `llm:${anon(eventId)}`,
  createPlan: (userId: string) => `create-plan:${anon(userId)}`,
  autoNegotiate: (eventId: string) => `auto-negotiate:${anon(eventId)}`,
  runs: (eventId: string) => `runs:${anon(eventId)}`,
  loginEmail: (email: string) => `login-email:${blindIndex(email, "ratelimit")}`,
  loginIp: (ip: string) => `login-ip:${blindIndex(ip, "ratelimit")}`,
  signupIp: (ip: string) => `signup-ip:${blindIndex(ip, "ratelimit")}`,
};

export type RateResult = { allowed: boolean; remaining: number; retryAfterMs: number };

/**
 * Counts one hit against `key` and says whether it is within `limit`.
 * A single upsert, so concurrent requests on different instances can't both slip through.
 */
export async function hit(key: string, limit: Limit, now = Date.now()): Promise<RateResult> {
  const client = await db();
  const expired = now - limit.windowMs; // a window that started at or before this is over
  const { rows } = await client.execute({
    sql: `INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)
          ON CONFLICT (key) DO UPDATE SET
            count        = CASE WHEN rate_limits.window_start <= ? THEN 1 ELSE rate_limits.count + 1 END,
            window_start = CASE WHEN rate_limits.window_start <= ? THEN EXCLUDED.window_start ELSE rate_limits.window_start END
          RETURNING count, window_start`,
    args: [key, now, expired, expired],
  });
  if (Math.random() < 0.01) await prune(now);
  const count = Number(rows[0].count);
  const windowStart = Number(rows[0].window_start);
  return {
    allowed: count <= limit.max,
    remaining: Math.max(0, limit.max - count),
    retryAfterMs: count <= limit.max ? 0 : windowStart + limit.windowMs - now,
  };
}

/** Rows whose window ended more than a day ago carry no information any more. */
export async function prune(now = Date.now()): Promise<void> {
  const client = await db();
  const longest = Math.max(...Object.values(LIMITS).map((l) => l.windowMs));
  await client.execute({ sql: "DELETE FROM rate_limits WHERE window_start < ?", args: [now - longest - DAY] });
}

/** Drops a key's counter, e.g. a user's chat counter when their account is deleted. */
export async function clearRateKey(key: string): Promise<void> {
  const client = await db();
  await client.execute({ sql: "DELETE FROM rate_limits WHERE key = ?", args: [key] });
}

/** "in 4 minutes" / "in a few seconds", for friendly errors. */
export function waitText(ms: number): string {
  const minutes = Math.ceil(ms / MINUTE);
  if (ms < MINUTE) return "in a few seconds";
  if (minutes < 60) return `in ${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.ceil(ms / HOUR);
  return `in ${hours} hour${hours === 1 ? "" : "s"}`;
}
