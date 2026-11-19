import { decryptJson, encryptJson, scope } from "./crypto";
import type { Row } from "./db";

/**
 * A member's bookkeeping in one plan: whether they are done, and when they joined, became done
 * and last changed an answer. It is stored encrypted (members.status_enc, one key per member per
 * plan), so a copy of the database does not show who finished when, who changed their mind after
 * a result, or the order people joined in. Only the server reads it.
 *
 * The plaintext columns it replaced (ready, joined_at, ready_at, changed_at) are written as
 * 0 / NULL for new rows. Rows from before keep them until `npm run migrate:encryption` moves
 * them into status_enc; until then they are read from there.
 */
export type MemberStatus = {
  ready: boolean;
  /** When they joined (ms). Members are listed in this order. */
  joinedAt: number;
  /** When they last became done and have stayed so; null while they are not. */
  readyAt: number | null;
  /** When they last changed what they want; null until they first say something that counts. */
  changedAt: number | null;
};

/** The columns `readStatus` needs; add them to any SELECT on members. */
export const STATUS_COLUMNS = "status_enc, ready, joined_at, ready_at, changed_at";

/** STATUS_COLUMNS with a table alias, for joins: prefixed("m", STATUS_COLUMNS). */
export function prefixed(alias: string, columns: string): string {
  return columns
    .split(",")
    .map((c) => `${alias}.${c.trim()}`)
    .join(", ");
}

export function newStatus(now = Date.now()): MemberStatus {
  return { ready: false, joinedAt: now, readyAt: null, changedAt: null };
}

export function encryptStatus(status: MemberStatus, eventId: string, userId: string): string {
  return encryptJson(status, scope.status(eventId, userId));
}

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

export function readStatus(row: Row, eventId: string, userId: string): MemberStatus {
  if (row.status_enc) return decryptJson<MemberStatus>(String(row.status_enc), scope.status(eventId, userId));
  // Written before status_enc existed.
  return {
    ready: Number(row.ready) === 1,
    joinedAt: Number(row.joined_at ?? 0),
    readyAt: num(row.ready_at),
    changedAt: num(row.changed_at),
  };
}

/** Members in the order they joined; ties (same millisecond) by user id, as SQL ordered them before. */
export function byJoinOrder<T extends { userId: string; status: MemberStatus }>(members: T[]): T[] {
  return [...members].sort(
    (a, b) => a.status.joinedAt - b.status.joinedAt || (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0),
  );
}
