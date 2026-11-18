import bcrypt from "bcryptjs";
import { z } from "zod";
import { db, isUniqueViolation } from "./db";
import { blindIndex, decrypt, decryptOrPlain, encrypt, legacyBlindIndex, randomToken, scope, sha256 } from "./crypto";
import { hit, LIMITS, rateKey, waitText } from "./ratelimit";

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

/** A guest gives a name and nothing else. */
export const GuestSchema = z.object({
  displayName: z.string().trim().min(1, "Enter a name").max(40, "Name is too long"),
});

/** `guest`: joined with a plan code, with no email or password. `email` is empty for a guest. */
export type User = { id: string; displayName: string; email: string; guest: boolean };

/**
 * What a guest's row holds where an account holds a password hash. It is not a bcrypt hash, so
 * no password can ever match it: the only way in as a guest is the session cookie.
 */
const NO_PASSWORD = "!";
/** A guest has no email, but the column is unique and not null. `.invalid` can never be a real address. */
const guestEmail = (id: string) => `${id}@guest.invalid`;

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export class AuthError extends Error {}

/** Each user's name and email are decrypted with that user's own keys. */
function userFromRow(row: Record<string, unknown>): User {
  const id = String(row.id);
  const guest = Number(row.is_guest ?? 0) === 1;
  return {
    id,
    displayName: decryptOrPlain(String(row.display_name), scope.displayName(id)),
    email: guest ? "" : decrypt(String(row.email_enc), scope.email(id)),
    guest,
  };
}

export async function createUser(input: z.input<typeof SignupSchema>): Promise<User> {
  const { email, displayName, password } = SignupSchema.parse(input);
  const client = await db();
  const id = crypto.randomUUID();
  try {
    await client.execute({
      sql: "INSERT INTO users (id, email_index, email_enc, display_name, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      args: [
        id,
        blindIndex(email, "email"),
        encrypt(email, scope.email(id)),
        encrypt(displayName, scope.displayName(id)),
        await hashPassword(password),
        Date.now(),
      ],
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new AuthError("An account with that email already exists");
    throw err;
  }
  return { id, displayName, email, guest: false };
}

/**
 * Someone who joins with a plan code and a name, without registering (#160). They are a user like
 * any other to the rest of the program: their chat is encrypted under their own keys, they count
 * toward the same limits, and they can delete everything. They cannot log in again from another
 * browser, because there is nothing to log in with.
 */
export async function createGuest(input: z.input<typeof GuestSchema>): Promise<User> {
  const { displayName } = GuestSchema.parse(input);
  const client = await db();
  const id = crypto.randomUUID();
  const email = guestEmail(id);
  await client.execute({
    sql: "INSERT INTO users (id, email_index, email_enc, display_name, password_hash, created_at, is_guest) VALUES (?, ?, ?, ?, ?, ?, 1)",
    args: [
      id,
      blindIndex(email, "email"),
      encrypt(email, scope.email(id)),
      encrypt(displayName, scope.displayName(id)),
      NO_PASSWORD,
      Date.now(),
    ],
  });
  return { id, displayName, email: "", guest: true };
}

/** A guest adds an email and a password and keeps their plans and chats: the same row becomes an account. */
export async function upgradeGuest(userId: string, input: z.input<typeof SignupSchema>): Promise<User> {
  const { email, displayName, password } = SignupSchema.parse(input);
  const client = await db();
  try {
    const { rowCount } = await client.execute({
      sql: "UPDATE users SET email_index = ?, email_enc = ?, display_name = ?, password_hash = ?, is_guest = 0 WHERE id = ? AND is_guest = 1",
      args: [
        blindIndex(email, "email"),
        encrypt(email, scope.email(userId)),
        encrypt(displayName, scope.displayName(userId)),
        await hashPassword(password),
        userId,
      ],
    });
    if (!rowCount) throw new AuthError("This is already an account");
  } catch (err) {
    if (isUniqueViolation(err)) throw new AuthError("An account with that email already exists");
    throw err;
  }
  return { id: userId, displayName, email, guest: false };
}

// A real hash of a random string, so failed lookups take as long as a wrong password.
const DUMMY_HASH = bcrypt.hashSync(randomToken(), BCRYPT_ROUNDS);

export async function authenticate(input: z.input<typeof LoginSchema>): Promise<User> {
  const { email, password } = LoginSchema.parse(input);
  // Checked before bcrypt, so a guessing script can't make us burn CPU either.
  const attempts = await hit(rateKey.loginEmail(email), LIMITS.loginPerEmail);
  if (!attempts.allowed) {
    throw new AuthError(`Too many attempts for this account. Please try again ${waitText(attempts.retryAfterMs)}.`);
  }
  const client = await db();
  const { rows } = await client.execute({
    // The second index finds accounts created before per-purpose keys and not yet migrated.
    sql: "SELECT id, display_name, email_enc, password_hash, is_guest FROM users WHERE is_guest = 0 AND email_index IN (?, ?)",
    args: [blindIndex(email, "email"), legacyBlindIndex(email)],
  });
  const row = rows[0];
  const ok = await verifyPassword(password, row ? String(row.password_hash) : DUMMY_HASH);
  if (!row || !ok) throw new AuthError("Wrong email or password");
  return userFromRow(row);
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
    sql: `SELECT u.id, u.display_name, u.email_enc, u.is_guest, s.expires_at
          FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
    args: [sha256(token)],
  });
  const row = rows[0];
  if (!row) return null;
  if (Number(row.expires_at) < Date.now()) {
    await deleteSession(token);
    return null;
  }
  return userFromRow(row);
}

export async function deleteSession(token: string): Promise<void> {
  const client = await db();
  await client.execute({ sql: "DELETE FROM sessions WHERE token_hash = ?", args: [sha256(token)] });
}

/** Per-IP limits on login and signup (#4). `ip` comes from the request headers (see actions.ts). */
export async function checkIpLimit(kind: "login" | "signup", ip: string): Promise<void> {
  const key = kind === "login" ? rateKey.loginIp(ip) : rateKey.signupIp(ip);
  const r = await hit(key, kind === "login" ? LIMITS.loginPerIp : LIMITS.signupPerIp);
  if (!r.allowed) {
    const what = kind === "login" ? "sign-in attempts" : "new accounts";
    throw new AuthError(`Too many ${what} from your network. Please try again ${waitText(r.retryAfterMs)}.`);
  }
}
