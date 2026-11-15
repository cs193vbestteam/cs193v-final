import { z } from "zod";
import { clockLabel } from "./constraints";

/**
 * The date of a plan: one calendar day, chosen by the creator, written YYYY-MM-DD.
 * "Today" is today in California, where the people using this are; a plain date has
 * no time zone of its own.
 */

export const PLAN_TIME_ZONE = "America/Los_Angeles";
/** How far ahead a plan can be: opening hours and people's calendars are guesses beyond this. */
export const MAX_DAYS_AHEAD = 60;

const DAY_MS = 24 * 60 * 60 * 1000;
const asUtc = (date: string) => new Date(`${date}T00:00:00Z`);

/** Today's date in California, as YYYY-MM-DD. */
export function todayPacific(now: Date = new Date()): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone: PLAN_TIME_ZONE }).format(now);
}

/** `date` moved by a number of days. */
export function addDays(date: string, days: number): string {
  return new Date(asUtc(date).getTime() + days * DAY_MS).toISOString().slice(0, 10);
}

/** The last date a plan can be made for today. */
export function latestPlanDate(now: Date = new Date()): string {
  return addDays(todayPacific(now), MAX_DAYS_AHEAD);
}

const isRealDate = (s: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(asUtc(s).getTime()) && asUtc(s).toISOString().slice(0, 10) === s;

/** A plan's date: a real day, from today to MAX_DAYS_AHEAD days from now. */
export function planDateSchema(now: Date = new Date()) {
  const first = todayPacific(now);
  const last = latestPlanDate(now);
  return z
    .string({ error: "Pick a date for the plan" })
    .trim()
    .min(1, "Pick a date for the plan")
    .refine(isRealDate, { message: "That is not a date" })
    .refine((d) => d >= first, { message: "The date has already passed" })
    .refine((d) => d <= last, { message: `Pick a date within the next ${MAX_DAYS_AHEAD} days` });
}

/** "2026-11-21" → "Sat, Nov 21". */
export function formatPlanDate(date: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" }).format(
    asUtc(date),
  );
}

/** When a proposal is: "Sat, Nov 21 · 7:00 PM", or the time alone for a plan with no date. */
export function formatWhen(date: string | null | undefined, time: string): string {
  return date ? `${formatPlanDate(date)} · ${clockLabel(time)}` : clockLabel(time);
}
