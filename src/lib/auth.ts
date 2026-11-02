import bcrypt from "bcryptjs";
import { z } from "zod";
import { db, isUniqueViolation } from "./db";
import { blindIndex, decrypt, encrypt, randomToken, sha256 } from "./crypto";

/** bcrypt generates and embeds a random salt per hash. */
const BCRYPT_ROUNDS = 12;
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const SignupSchema = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email"),
  displayName: z.string().trim().min(1, "Enter a name").max(40, "Name is too long"),
  password: z.string().min(8, "Password must be at least 8 characters").max(200),
});

export const LoginSchema = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email"),
  password: z.string().min(1, "Enter your password"),
});

export type User = { id: string; displayName: string; email: string };

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export class AuthError extends Error {}

export async function createUser(input: z.input<typeof SignupSchema>): Promise<User> {
  const { email, displayName, password } = SignupSchema.parse(input);
  const client = await db();
  const id = crypto.randomUUID();
  try {
    await client.execute({
      sql: "INSERT INTO users (id, email_index, email_enc, display_name, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      args: [id, blindIndex(email), encrypt(email), displayName, await hashPassword(password), Date.now()],
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new AuthError("An account with that email already exists");
    throw err;
  }
  return { id, displayName, email };
}

// A real hash of a random string, so failed lookups take as long as a wrong password.
const DUMMY_HASH = bcrypt.hashSync(randomToken(), BCRYPT_ROUNDS);

export async function authenticate(input: z.input<typeof LoginSchema>): Promise<User> {
  const { email, password } = LoginSchema.parse(input);
  const client = await db();
  const { rows } = await client.execute({
    sql: "SELECT id, display_name, email_enc, password_hash FROM users WHERE email_index = ?",
    args: [blindIndex(email)],
  });
  const row = rows[0];
  const ok = await verifyPassword(password, row ? String(row.password_hash) : DUMMY_HASH);
  if (!row || !ok) throw new AuthError("Wrong email or password");
  return { id: String(row.id), displayName: String(row.display_name), email: decrypt(String(row.email_enc)) };
}

/** Returns the raw token for the cookie. Only its hash is stored. */
export async function createSession(userId: string): Promise<{ token: string; expiresAt: number }> {
  const token = randomToken();
  const expiresAt = Date.now() + SESSION_TTL_MS;
  const client = await db();
  await client.execute({
    sql: "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)",
    args: [sha256(token), userId, expiresAt],
  });
  return { token, expiresAt };
}

export async function getUserBySession(token: string | undefined): Promise<User | null> {
  if (!token) return null;
  const client = await db();
  const { rows } = await client.execute({
    sql: `SELECT u.id, u.display_name, u.email_enc, s.expires_at
          FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
    args: [sha256(token)],
  });
  const row = rows[0];
  if (!row) return null;
  if (Number(row.expires_at) < Date.now()) {
    await deleteSession(token);
    return null;
  }
  return { id: String(row.id), displayName: String(row.display_name), email: decrypt(String(row.email_enc)) };
}

export async function deleteSession(token: string): Promise<void> {
  const client = await db();
  await client.execute({ sql: "DELETE FROM sessions WHERE token_hash = ?", args: [sha256(token)] });
}
