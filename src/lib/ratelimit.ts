import { blindIndex } from "./crypto";
import { db } from "./db";

/**
 * Fixed-window rate limits stored in the database, so they hold across serverless
 * instances (#4). One row per key: when the window started and how many hits it has.
 *
 * Keys never contain an email or IP address in the clear: those go through the same
 * keyed HMAC as the email lookup index (`blindIndex`). User and plan ids are random
 * UUIDs, so they are stored as-is.
 */

export type Limit = { max: number; windowMs: number };

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const LIMITS = {
  /** Chat messages one person can send, across all their plans. */
  chatPerUser: { max: 30, windowMs: 10 * MINUTE },
  /** LLM extraction calls per plan per day; after that, the rule-based extractor answers. */
  llmPerPlan: { max: 300, windowMs: DAY },
  /** Login attempts per email address (also covers the password check before deleting an account). */
  loginPerEmail: { max: 10, windowMs: 15 * MINUTE },
  /** Login attempts per IP address (many emails from one place). */
  loginPerIp: { max: 50, windowMs: 15 * MINUTE },
  /** New accounts per IP address. */
  signupPerIp: { max: 10, windowMs: HOUR },
} satisfies Record<string, Limit>;

export const rateKey = {
  chat: (userId: string) => `chat:${userId}`,
  llm: (eventId: string) => `llm:${eventId}`,
  loginEmail: (email: string) => `login-email:${blindIndex(email)}`,
  loginIp: (ip: string) => `login-ip:${blindIndex(ip)}`,
  signupIp: (ip: string) => `signup-ip:${blindIndex(ip)}`,
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
