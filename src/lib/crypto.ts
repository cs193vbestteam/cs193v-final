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
 * Format: "v3." + base64(iv[12] | tag[16] | ciphertext). Before sealing, the plaintext is
 * padded to a multiple of PAD_BLOCK bytes (a 0x80 byte, then zeros), so a ciphertext only
 * tells its length to the nearest PAD_BLOCK: "$30" and a paragraph about allergies look the same.
 *
 * Older values still read: "v2." (per-scope keys, no padding), values encrypted with the
 * master key before per-scope keys (no prefix), and formerly plaintext columns as they are.
 * `npm run migrate:encryption` rewrites them all in the current format.
 */

const IV_LEN = 12;
const TAG_LEN = 16;
const PREFIX = "v3.";
/** Per-scope keys without padding. Still read; the migration rewrites them as v3. */
const V2_PREFIX = "v2.";
/** Plaintexts are padded to a multiple of this many bytes before encryption. */
export const PAD_BLOCK = 256;
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
  /**
   * One member's status in one plan (members.status_enc): whether they are done, and when they
   * joined, finished and last changed an answer. Only the server reads it, to order members and
   * to know whether a plan can be run again.
   */
  status: (eventId: string, userId: string) => make("member", eventId, userId, "status"),
  /**
   * A plan's shared fields, visible to its members (events.title, location, event_date, pool_json,
   * pool_meta, result_json, invite_enc), and its bookkeeping (events.meta_enc: when it was created,
   * how many people fit, where its restaurants came from).
   */
  plan: (eventId: string, field: "title" | "location" | "date" | "pool" | "pool_meta" | "result" | "invite" | "meta") =>
    make("plan", eventId, field),
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

function seal(plaintext: string | Buffer, key: Buffer, aad?: string): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  if (aad !== undefined) cipher.setAAD(Buffer.from(aad, "utf8"));
  const data = typeof plaintext === "string" ? Buffer.from(plaintext, "utf8") : plaintext;
  const ct = Buffer.concat([cipher.update(data), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64");
}

function openBytes(b64: string, key: Buffer, aad?: string): Buffer {
  const buf = Buffer.from(b64, "base64");
  if (buf.length < IV_LEN + TAG_LEN) throw new Error("Ciphertext too short");
  const decipher = createDecipheriv("aes-256-gcm", key, buf.subarray(0, IV_LEN));
  if (aad !== undefined) decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(buf.subarray(IV_LEN, IV_LEN + TAG_LEN));
  return Buffer.concat([decipher.update(buf.subarray(IV_LEN + TAG_LEN)), decipher.final()]);
}

const open = (b64: string, key: Buffer, aad?: string) => openBytes(b64, key, aad).toString("utf8");

/** ISO/IEC 7816-4 padding: the text, a 0x80 byte, then zeros up to a multiple of PAD_BLOCK. */
export function pad(plaintext: string): Buffer {
  const text = Buffer.from(plaintext, "utf8");
  const out = Buffer.alloc(Math.ceil((text.length + 1) / PAD_BLOCK) * PAD_BLOCK);
  text.copy(out);
  out[text.length] = 0x80;
  return out;
}

export function unpad(padded: Buffer): string {
  let end = padded.length - 1;
  while (end >= 0 && padded[end] === 0) end--;
  if (end < 0 || padded[end] !== 0x80) throw new Error("Bad padding");
  return padded.subarray(0, end).toString("utf8");
}

/** Whether a stored value is in the current format (per-scope key and padded). */
export function isCurrent(payload: string): boolean {
  return payload.startsWith(PREFIX);
}

/** Whether a value was encrypted with its own scope's key (current or v2). */
function isScoped(payload: string): boolean {
  return payload.startsWith(PREFIX) || payload.startsWith(V2_PREFIX);
}

export function encrypt(plaintext: string, s: Scope): string {
  return PREFIX + seal(pad(plaintext), keyFor(s), s);
}

/** Decrypts a value that has always been encrypted. Old values fall back to the master key. */
export function decrypt(payload: string, s: Scope): string {
  if (payload.startsWith(PREFIX)) return unpad(openBytes(payload.slice(PREFIX.length), keyFor(s), s));
  if (payload.startsWith(V2_PREFIX)) return open(payload.slice(V2_PREFIX.length), keyFor(s), s);
  return open(payload, masterKey());
}

/** For columns that used to be plaintext (names, plan fields): old values are returned as they are. */
export function decryptOrPlain(payload: string, s: Scope): string {
  return isScoped(payload) ? decrypt(payload, s) : payload;
}

/** Whether a value in a formerly plaintext column is encrypted (in any per-scope format). */
export function isEncrypted(payload: string): boolean {
  return isScoped(payload);
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
export function blindIndex(value: string, purpose: "email" | "ratelimit" | "invite" | "spend"): string {
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

/** Tests only: encrypts the way values were stored with per-scope keys but no padding (v2). */
export function v2Encrypt(plaintext: string, s: Scope): string {
  return V2_PREFIX + seal(plaintext, keyFor(s), s);
}

/** Tests and the migration only: encrypts the way values were stored before per-scope keys. */
export function legacyEncrypt(plaintext: string): string {
  return seal(plaintext, masterKey());
}
