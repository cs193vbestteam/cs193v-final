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
  event_date  TEXT                      -- the day of the plan, YYYY-MM-DD (public)
);

-- Columns added after v1, for databases whose events table already exists.
ALTER TABLE events ADD COLUMN IF NOT EXISTS location TEXT;
ALTER TABLE events ADD COLUMN IF NOT EXISTS pool_json TEXT;
ALTER TABLE events ADD COLUMN IF NOT EXISTS pool_source TEXT;
ALTER TABLE events ADD COLUMN IF NOT EXISTS scenario TEXT NOT NULL DEFAULT 'meal';
ALTER TABLE events ADD COLUMN IF NOT EXISTS event_date TEXT;

CREATE TABLE IF NOT EXISTS members (
  event_id        TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  constraints_enc TEXT NOT NULL,        -- AES-GCM encrypted Constraints JSON
  ready           INTEGER NOT NULL DEFAULT 0,
  joined_at       BIGINT NOT NULL,
  PRIMARY KEY (event_id, user_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id          BIGSERIAL PRIMARY KEY,
  event_id    TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content_enc TEXT NOT NULL,            -- AES-GCM encrypted
  created_at  BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS messages_by_chat ON messages (event_id, user_id, id);

-- Fixed-window rate-limit counters (src/lib/ratelimit.ts). Emails and IPs appear only as HMACs.
CREATE TABLE IF NOT EXISTS rate_limits (
  key          TEXT PRIMARY KEY,
  window_start BIGINT NOT NULL,
  count        INTEGER NOT NULL
);
`;

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
