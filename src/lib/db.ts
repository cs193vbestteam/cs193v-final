import { createClient, type Client } from "@libsql/client";

/**
 * libSQL (SQLite-compatible). Local dev uses a file; production uses Turso.
 * Schema is created on first use, so there is no separate migration step for v1.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email_index   TEXT NOT NULL UNIQUE,   -- HMAC of email, for lookup
  email_enc     TEXT NOT NULL,          -- AES-GCM encrypted email
  display_name  TEXT NOT NULL,
  password_hash TEXT NOT NULL,          -- bcrypt (salted)
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,          -- sha256 of the cookie token; raw token never stored
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  invite_code TEXT NOT NULL UNIQUE,
  creator_id  TEXT NOT NULL REFERENCES users(id),
  result_json TEXT,                     -- group-visible result only (no private data)
  decided_at  INTEGER,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS members (
  event_id        TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  constraints_enc TEXT NOT NULL,        -- AES-GCM encrypted Constraints JSON
  ready           INTEGER NOT NULL DEFAULT 0,
  joined_at       INTEGER NOT NULL,
  PRIMARY KEY (event_id, user_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id    TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content_enc TEXT NOT NULL,            -- AES-GCM encrypted
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS messages_by_chat ON messages (event_id, user_id, id);
`;

let client: Client | null = null;
let ready: Promise<void> | null = null;

export async function db(): Promise<Client> {
  if (!client) {
    client = createClient({
      url: process.env.DATABASE_URL || "file:local.db",
      authToken: process.env.DATABASE_AUTH_TOKEN || undefined,
    });
    const c = client;
    ready = c.executeMultiple(SCHEMA).then(() => c.execute("PRAGMA foreign_keys = ON")).then(() => undefined);
  }
  await ready;
  return client;
}

/** Tests only: drop the connection so the next call gets a fresh in-memory database. */
export function resetDbForTests() {
  client?.close();
  client = null;
  ready = null;
}
