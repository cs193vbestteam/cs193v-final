import { START_TIMES, type StartTime } from "./optimizer-input";

/**
 * Opening hours by the hour: which start times a restaurant can take on a given date.
 *
 * Hours are kept as intervals in minutes since Sunday 00:00, the way Google Places
 * counts days (0 = Sunday … 6 = Saturday). An interval that runs past Saturday midnight
 * ends above MINUTES_PER_WEEK instead of wrapping, so "open until 2 am" stays one piece.
 */

export const MINUTES_PER_DAY = 24 * 60;
export const MINUTES_PER_WEEK = 7 * MINUTES_PER_DAY;

/**
 * A start time is offered only if the place stays open at least this long after it,
 * so nobody is sent to dinner at 21:00 somewhere that closes at 21:30.
 */
export const MIN_OPEN_AFTER_START_MIN = 60;

/** `[opens, closes)` in minutes since Sunday 00:00. */
export type OpenInterval = readonly [start: number, end: number];
export type WeeklyHours = OpenInterval[];

export const ALWAYS_OPEN: WeeklyHours = [[0, MINUTES_PER_WEEK]];

/** A Google Places opening period. No `close` means the place never closes. */
export type GooglePeriod = {
  open: { day: number; hour: number; minute?: number };
  close?: { day: number; hour: number; minute?: number };
};

const minuteOfWeek = (p: { day: number; hour: number; minute?: number }) =>
  p.day * MINUTES_PER_DAY + p.hour * 60 + (p.minute ?? 0);

/** Google's periods as weekly intervals. Returns null when Google gives no hours at all. */
export function weeklyHoursFromGoogle(periods: readonly GooglePeriod[] | undefined): WeeklyHours | null {
  if (!periods || periods.length === 0) return null;
  if (periods.some((p) => !p.close)) return ALWAYS_OPEN;
  return periods.map((p) => {
    const start = minuteOfWeek(p.open);
    let end = minuteOfWeek(p.close!);
    if (end <= start) end += MINUTES_PER_WEEK; // Saturday night into Sunday morning
    return [start, end] as const;
  });
}

/** The same hours every day of the week, as `[openHour, closeHour]` pairs. A close hour above 24 runs past midnight. */
export function dailyHours(...ranges: readonly (readonly [openHour: number, closeHour: number])[]): WeeklyHours {
  const out: OpenInterval[] = [];
  for (let day = 0; day < 7; day++) {
    for (const [open, close] of ranges) {
      out.push([day * MINUTES_PER_DAY + open * 60, day * MINUTES_PER_DAY + close * 60]);
    }
  }
  return out;
}

/** 0 = Sunday … 6 = Saturday for a plain `YYYY-MM-DD` date. No time zone is involved. */
export function weekdayOf(date: string): number {
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) throw new Error(`Not a date: ${date}`);
  return d.getUTCDay();
}

/**
 * The start times a place can take on a date, or null when its hours are unknown.
 * Unknown is not the same as open: a place with unknown hours is not selectable.
 */
export function openStartTimes(
  hours: WeeklyHours | null | undefined,
  date: string,
  minOpenMin: number = MIN_OPEN_AFTER_START_MIN,
): StartTime[] | null {
  if (!hours) return null;
  const day = weekdayOf(date);
  return START_TIMES.filter((time) => {
    const begin = day * MINUTES_PER_DAY + Number(time.slice(0, 2)) * 60;
    const until = begin + minOpenMin;
    // The second test catches an interval that started last Saturday and ran into Sunday.
    return hours.some(
      ([s, e]) => (s <= begin && until <= e) || (s <= begin + MINUTES_PER_WEEK && until + MINUTES_PER_WEEK <= e),
    );
  });
}
