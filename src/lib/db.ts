/**
 * Postgres database access.
 *
 * - Production: a real Postgres server (Neon, Supabase, Vercel Postgres...) via `pg`,
 *   when DATABASE_URL starts with postgres:// or postgresql://.
 * - Local dev and tests: PGlite, a real Postgres compiled to WebAssembly that runs
 *   inside Node. No server to install. Data is kept in ./.pglite, or in memory
 *   when DATABASE_URL is ":memory:".
 *
 * Both run the exact same SQL. Queries use `?` placeholders, which are
 * translated to Postgres's `$1, $2, ...` before running.
 * The schema is created on first use, so there is no separate migration step.
 */

// Timestamps are milliseconds since 1970 (Date.now()), so they need BIGINT.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email_index   TEXT NOT NULL UNIQUE,   -- HMAC of email, for lookup
  email_enc     TEXT NOT NULL,          -- AES-GCM encrypted email
  display_name  TEXT NOT NULL,
  password_hash TEXT NOT NULL,          -- bcrypt (salted)
  created_at    BIGINT NOT NULL
);

-- A guest joined with a plan code and has no email or password (auth.ts). 0 for an account.
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_guest INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,          -- sha256 of the cookie token; raw token never stored
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  invite_code TEXT NOT NULL UNIQUE,
  creator_id  TEXT NOT NULL REFERENCES users(id),
  result_json TEXT,                     -- group-visible result only (no private data)
  decided_at  BIGINT,
  created_at  BIGINT NOT NULL,
  location    TEXT,                     -- where the plan happens (public)
  pool_json   TEXT,                     -- candidate restaurants for this plan (public)
  pool_source TEXT,                     -- 'places' | 'seed'
  scenario    TEXT NOT NULL DEFAULT 'meal', -- what the group is deciding (see scenario.ts)
  event_date  TEXT,                     -- the day of the plan, YYYY-MM-DD (public)
  pool_meta   TEXT,                     -- where the pool was searched from and what for (see pool-extend.ts)
  max_members INTEGER NOT NULL DEFAULT 12 -- how many people the creator lets into the plan (public)
);

-- Columns added after v1, for databases whose events table already exists.
ALTER TABLE events ADD COLUMN IF NOT EXISTS location TEXT;
ALTER TABLE events ADD COLUMN IF NOT EXISTS pool_json TEXT;
ALTER TABLE events ADD COLUMN IF NOT EXISTS pool_source TEXT;
ALTER TABLE events ADD COLUMN IF NOT EXISTS scenario TEXT NOT NULL DEFAULT 'meal';
ALTER TABLE events ADD COLUMN IF NOT EXISTS event_date TEXT;
ALTER TABLE events ADD COLUMN IF NOT EXISTS pool_meta TEXT;
ALTER TABLE events ADD COLUMN IF NOT EXISTS max_members INTEGER NOT NULL DEFAULT 12;
-- invite_code holds a keyed hash of the code (crypto.ts blindIndex), so a copy of the database
-- cannot be used to join a plan; invite_enc is the code itself, encrypted, to show to members.
-- meta_enc is the plan's bookkeeping, encrypted: when it was created and how many people fit.
-- For rows written since, created_at is only the day, decided_at is NULL and max_members is 0:
-- the result (encrypted) carries when it was decided.
ALTER TABLE events ADD COLUMN IF NOT EXISTS invite_enc TEXT;
ALTER TABLE events ADD COLUMN IF NOT EXISTS meta_enc TEXT;

CREATE TABLE IF NOT EXISTS members (
  event_id        TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  constraints_enc TEXT NOT NULL,        -- AES-GCM encrypted member state (member-state.ts)
  ready           INTEGER NOT NULL DEFAULT 0,
  joined_at       BIGINT NOT NULL,
  PRIMARY KEY (event_id, user_id)
);
-- When the member last became ready and has stayed so; NULL while they are not. The optimizer
-- uses the order, never the time, to settle exact ties in favour of whoever finished first.
ALTER TABLE members ADD COLUMN IF NOT EXISTS ready_at BIGINT;
-- When the member last changed what they want. A plan is only run again once this, or someone's
-- joined_at, is later than the stored result (#118). NULL until they first say something that counts.
ALTER TABLE members ADD COLUMN IF NOT EXISTS changed_at BIGINT;
-- The four columns above, encrypted together per member (member-status.ts). New rows write
-- ready = 0, joined_at = 0 and NULL times, so only status_enc says who did what when.
ALTER TABLE members ADD COLUMN IF NOT EXISTS status_enc TEXT;

CREATE TABLE IF NOT EXISTS messages (
  id          BIGSERIAL PRIMARY KEY,
  event_id    TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content_enc TEXT NOT NULL,            -- AES-GCM encrypted
  created_at  BIGINT NOT NULL           -- the day only (dayOf); the id gives the order
);

CREATE INDEX IF NOT EXISTS messages_by_chat ON messages (event_id, user_id, id);

-- Fixed-window rate-limit counters (src/lib/ratelimit.ts). Emails and IPs appear only as HMACs.
CREATE TABLE IF NOT EXISTS rate_limits (
  key          TEXT PRIMARY KEY,
  window_start BIGINT NOT NULL,
  count        INTEGER NOT NULL
);

-- Model spending per calendar month (src/lib/spend.ts), in millionths of a dollar.
-- payer is a keyed hash of a user id (spend.ts), or '*' for the whole app's total.
CREATE TABLE IF NOT EXISTS llm_spend (
  payer  TEXT NOT NULL,
  month  TEXT NOT NULL,
  micros BIGINT NOT NULL,
  PRIMARY KEY (payer, month)
);
`;

/**
 * The start of the UTC day `ms` falls in. Timestamps kept in plaintext only for housekeeping
 * (when an account or a message was created) are stored to the day, so a copy of the
 * database cannot line them up with when someone was seen using their phone.
 */
export function dayOf(ms = Date.now()): number {
  return ms - (ms % 86_400_000);
}

export type Row = Record<string, unknown>;
export type Statement = string | { sql: string; args?: unknown[] };

export interface Db {
  execute(stmt: Statement): Promise<{ rows: Row[]; rowCount: number }>;
}

interface Backend {
  query(sql: string, args: unknown[]): Promise<{ rows: Row[]; rowCount: number }>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

/** `?` → `$1, $2, ...` (our SQL never contains a literal question mark). */
export function toPostgresPlaceholders(sql: string): string {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

export function isPostgresUrl(url: string | undefined): boolean {
  return !!url && /^postgres(ql)?:\/\//i.test(url);
}

async function connectPostgres(url: string): Promise<Backend> {
  const { Pool } = await import("pg");
  // Serverless functions each hold a few connections; keep the pool small.
  const pool = new Pool({ connectionString: url, max: 3 });
  return {
    async query(sql, args) {
      const r = await pool.query(sql, args);
      return { rows: r.rows as Row[], rowCount: r.rowCount ?? 0 };
    },
    async exec(sql) {
      await pool.query(sql);
    },
    close: () => pool.end(),
  };
}

async function connectPglite(url: string | undefined): Promise<Backend> {
  const { PGlite } = await import("@electric-sql/pglite");
  const inMemory = url === ":memory:" || url === "memory://";
  const pg = inMemory ? new PGlite() : new PGlite(process.env.PGLITE_DIR || ".pglite");
  return {
    async query(sql, args) {
      const r = await pg.query<Row>(sql, args);
      return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
    },
    async exec(sql) {
      await pg.exec(sql);
    },
    close: () => pg.close(),
  };
}

async function createSchema(backend: Backend) {
  try {
    await backend.exec(SCHEMA);
  } catch (err) {
    // Two cold starts creating tables at the same moment can collide; the second try sees them.
    await backend.exec(SCHEMA).catch(() => {
      throw err;
    });
  }
}

let backend: Promise<Backend> | null = null;

function getBackend(): Promise<Backend> {
  if (!backend) {
    const url = process.env.DATABASE_URL;
    backend = (async () => {
      const b = isPostgresUrl(url) ? await connectPostgres(url!) : await connectPglite(url);
      await createSchema(b);
      return b;
    })();
    // Don't cache a failed connection; retry on the next request.
    const attempt = backend;
    attempt.catch(() => {
      if (backend === attempt) backend = null;
    });
  }
  return backend;
}

const client: Db = {
  async execute(stmt) {
    const { sql, args = [] } = typeof stmt === "string" ? { sql: stmt } : stmt;
    return (await getBackend()).query(toPostgresPlaceholders(sql), args);
  },
};

export async function db(): Promise<Db> {
  await getBackend();
  return client;
}

/** Postgres error code for a unique-constraint violation. */
export function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "23505";
}

/** Tests only: drop the connection so the next call gets a fresh in-memory database. */
export async function resetDbForTests() {
  const old = backend;
  backend = null;
  if (old) await (await old.catch(() => null))?.close();
}
