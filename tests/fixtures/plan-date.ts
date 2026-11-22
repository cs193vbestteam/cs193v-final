import { addDays, todayPacific } from "@/lib/plan-date";

/**
 * A date a plan can be made for whenever the tests run: the first Saturday from today on, in
 * California. A date written out by hand passes until that day and then fails every run after it,
 * because a plan cannot be made for a day that has passed. Saturday, so opening hours and anything
 * else that goes by the day of the week stay what they were.
 */
export function upcomingSaturday(now: Date = new Date()): string {
  const today = todayPacific(now);
  const weekday = new Date(`${today}T00:00:00Z`).getUTCDay();
  return addDays(today, (6 - weekday + 7) % 7);
}
