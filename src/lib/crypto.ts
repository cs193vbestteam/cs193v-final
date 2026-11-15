import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes } from "node:crypto";

/**
 * Field-level encryption for everything users give us.
 *
 * One master secret (ENCRYPTION_KEY) never encrypts anything itself. Each value is
 * encrypted with its own key, derived from the master with HKDF for one *scope*:
 * one field of one user (their email, their name) or of one member of one plan
 * (their constraints, their private chat), or one field of one plan (its title,
 * location, date, candidate pool, result). See `scope` below for the full list.
 *
 * So code that reads Alice's email holds a key that opens Alice's email and
 * nothing else: pointed at Bob's row, or at Alice's chat, by a bug or a prompt
 * injection, decryption fails instead of leaking. The scope is also bound into
 * each ciphertext as GCM associated data, so a value copied into another row
 * fails to decrypt there too.
 *
 * AES-256-GCM: authenticated, so tampered ciphertext fails instead of returning garbage.
 * Format: "v2." + base64(iv[12] | tag[16] | ciphertext)
 *
 * Values written before per-scope keys (no "v2." prefix) still read: encrypted ones
 * with the master key, formerly plaintext columns as they are. `npm run
 * migrate:encryption` rewrites them all in the current format.
 */

const IV_LEN = 12;
const TAG_LEN = 16;
const PREFIX = "v2.";
/** HKDF salt: fixed and public. It separates this app's keys from any other use of the same secret. */
const HKDF_SALT = "settle/field-encryption";

/** Which value a key is for. Only the helpers in `scope` make one, so call sites can't pass a free-form string. */
export type Scope = string & { readonly __scope: unique symbol };

const make = (...parts: string[]): Scope => {
  for (const p of parts) if (!p || p.includes("/")) throw new Error(`Bad encryption scope part: ${JSON.stringify(p)}`);
  return parts.join("/") as Scope;
};

export const scope = {
  /** A user's email (users.email_enc). */
  email: (userId: string) => make("user", userId, "email"),
  /** A user's display name (users.display_name). */
  displayName: (userId: string) => make("user", userId, "display_name"),
  /** One member's constraints in one plan (members.constraints_enc). */
  constraints: (eventId: string, userId: string) => make("member", eventId, userId, "constraints"),
  /** One member's private chat in one plan (messages.content_enc). */
  chat: (eventId: string, userId: string) => make("member", eventId, userId, "chat"),
  /** A plan's shared fields, visible to its members (events.title, location, event_date, pool_json, result_json). */
  plan: (eventId: string, field: "title" | "location" | "date" | "pool" | "result") => make("plan", eventId, field),
};

function masterKey(): Buffer {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) throw new Error("ENCRYPTION_KEY is not set (run `npm run gen-key`)");
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error("ENCRYPTION_KEY must decode to exactly 32 bytes");
  return key;
}

function derive(info: string): Buffer {
  return Buffer.from(hkdfSync("sha256", masterKey(), HKDF_SALT, info, 32));
}

const keyFor = (s: Scope) => derive(`field/${s}`);

function seal(plaintext: string, key: Buffer, aad?: string): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  if (aad !== undefined) cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64");
}

function open(b64: string, key: Buffer, aad?: string): string {
  const buf = Buffer.from(b64, "base64");
  if (buf.length < IV_LEN + TAG_LEN) throw new Error("Ciphertext too short");
  const decipher = createDecipheriv("aes-256-gcm", key, buf.subarray(0, IV_LEN));
  if (aad !== undefined) decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(buf.subarray(IV_LEN, IV_LEN + TAG_LEN));
  return Buffer.concat([decipher.update(buf.subarray(IV_LEN + TAG_LEN)), decipher.final()]).toString("utf8");
}

/** Whether a stored value is in the current format (else it predates per-scope keys). */
export function isCurrent(payload: string): boolean {
  return payload.startsWith(PREFIX);
}

export function encrypt(plaintext: string, s: Scope): string {
  return PREFIX + seal(plaintext, keyFor(s), s);
}

/** Decrypts a value that has always been encrypted. Old values fall back to the master key. */
export function decrypt(payload: string, s: Scope): string {
  if (isCurrent(payload)) return open(payload.slice(PREFIX.length), keyFor(s), s);
  return open(payload, masterKey());
}

/** For columns that used to be plaintext (names, plan fields): old values are returned as they are. */
export function decryptOrPlain(payload: string, s: Scope): string {
  return isCurrent(payload) ? decrypt(payload, s) : payload;
}

export function encryptJson(value: unknown, s: Scope): string {
  return encrypt(JSON.stringify(value), s);
}

export function decryptJson<T>(payload: string, s: Scope): T {
  return JSON.parse(decrypt(payload, s)) as T;
}

export function decryptJsonOrPlain<T>(payload: string, s: Scope): T {
  return JSON.parse(decryptOrPlain(payload, s)) as T;
}

/**
 * Deterministic keyed hash, so we can look up a user by email (or count attempts per
 * email or IP) without storing the value. Each purpose has its own derived key.
 */
export function blindIndex(value: string, purpose: "email" | "ratelimit"): string {
  return createHmac("sha256", derive(`blind-index/${purpose}`))
    .update(value.trim().toLowerCase())
    .digest("hex");
}

/** The email index as computed before per-purpose keys, so accounts not yet migrated can still log in. */
export function legacyBlindIndex(value: string): string {
  return createHmac("sha256", masterKey()).update(value.trim().toLowerCase()).digest("hex");
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Tests and the migration only: encrypts the way values were stored before per-scope keys. */
export function legacyEncrypt(plaintext: string): string {
  return seal(plaintext, masterKey());
}
