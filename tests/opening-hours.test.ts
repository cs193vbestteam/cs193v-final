import { describe, expect, it } from "vitest";
import {
  ALWAYS_OPEN,
  MIN_OPEN_AFTER_START_MIN,
  dailyHours,
  openStartTimes,
  weekdayOf,
  weeklyHoursFromGoogle,
  type GooglePeriod,
} from "@/lib/opening-hours";
import { START_TIMES } from "@/lib/optimizer-input";
import { RESTAURANTS } from "@/lib/restaurants";

// 2026-11-21 is a Saturday, 2026-11-22 a Sunday, 2026-11-23 a Monday.
const SAT = "2026-11-21";
const SUN = "2026-11-22";
const MON = "2026-11-23";

const period = (day: number, open: [number, number], closeDay: number, close: [number, number]): GooglePeriod => ({
  open: { day, hour: open[0], minute: open[1] },
  close: { day: closeDay, hour: close[0], minute: close[1] },
});

describe("weekdayOf", () => {
  it("reads a plain date with Sunday as 0", () => {
    expect(weekdayOf(SAT)).toBe(6);
    expect(weekdayOf(SUN)).toBe(0);
    expect(weekdayOf(MON)).toBe(1);
  });

  it("refuses something that is not a date", () => {
    expect(() => weekdayOf("next Saturday")).toThrow();
  });
});

describe("weeklyHoursFromGoogle", () => {
  it("is null when Google gives no hours", () => {
    expect(weeklyHoursFromGoogle(undefined)).toBeNull();
    expect(weeklyHoursFromGoogle([])).toBeNull();
  });

  it("treats a period with no close as open all week", () => {
    expect(weeklyHoursFromGoogle([{ open: { day: 0, hour: 0, minute: 0 } }])).toEqual(ALWAYS_OPEN);
  });

  it("keeps a Saturday night that runs into Sunday as one interval", () => {
    const hours = weeklyHoursFromGoogle([period(6, [18, 0], 0, [2, 0])])!;
    expect(hours).toHaveLength(1);
    expect(hours[0]![1] - hours[0]![0]).toBe(8 * 60);
  });
});

describe("openStartTimes", () => {
  it("is null, not open, when hours are unknown", () => {
    expect(openStartTimes(null, SAT)).toBeNull();
    expect(openStartTimes(undefined, SAT)).toBeNull();
  });

  it("offers every start time at a place that never closes", () => {
    expect(openStartTimes(ALWAYS_OPEN, SAT)).toEqual([...START_TIMES]);
    expect(openStartTimes(ALWAYS_OPEN, SUN)).toEqual([...START_TIMES]);
  });

  it("offers the hours a place is open on that weekday", () => {
    const hours = weeklyHoursFromGoogle([period(6, [11, 0], 6, [15, 0]), period(6, [17, 0], 6, [22, 0])]);
    expect(openStartTimes(hours, SAT)).toEqual([
      "11:00", "12:00", "13:00", "14:00",
      "17:00", "18:00", "19:00", "20:00", "21:00",
    ]);
  });

  it("offers nothing on a weekday the place is closed", () => {
    const hours = weeklyHoursFromGoogle([period(6, [11, 0], 6, [22, 0])]);
    expect(openStartTimes(hours, MON)).toEqual([]);
  });

  it("does not offer a start time the place closes soon after", () => {
    // Closes at 21:30: a 21:00 start leaves 30 minutes, a 20:00 start leaves 90.
    const hours = weeklyHoursFromGoogle([period(6, [17, 0], 6, [21, 30])]);
    const open = openStartTimes(hours, SAT)!;
    expect(open).toContain("20:00");
    expect(open).not.toContain("21:00");
    expect(MIN_OPEN_AFTER_START_MIN).toBe(60);
  });

  it("offers a start time exactly one hour before closing", () => {
    const hours = weeklyHoursFromGoogle([period(6, [17, 0], 6, [22, 0])]);
    expect(openStartTimes(hours, SAT)).toContain("21:00");
    expect(openStartTimes(hours, SAT)).not.toContain("22:00");
  });

  it("does not offer a start time before the place opens", () => {
    const hours = weeklyHoursFromGoogle([period(6, [11, 30], 6, [15, 0])]);
    expect(openStartTimes(hours, SAT)).toEqual(["12:00", "13:00", "14:00"]);
  });

  it("follows a place that stays open past midnight", () => {
    const hours = weeklyHoursFromGoogle([period(6, [18, 0], 0, [2, 0])]);
    expect(openStartTimes(hours, SAT)).toEqual(["18:00", "19:00", "20:00", "21:00", "22:00", "23:00"]);
    // The small hours of Sunday are before our first start time, so Sunday itself has nothing.
    expect(openStartTimes(hours, SUN)).toEqual([]);
  });

  it("can be asked for a different minimum", () => {
    const hours = weeklyHoursFromGoogle([period(6, [17, 0], 6, [21, 30])]);
    expect(openStartTimes(hours, SAT, 30)).toContain("21:00");
  });
});

describe("dailyHours", () => {
  it("repeats the same ranges on all seven days", () => {
    const hours = dailyHours([11, 15], [17, 22]);
    expect(hours).toHaveLength(14);
    for (const date of [SAT, SUN, MON]) {
      expect(openStartTimes(hours, date)).toEqual([
        "11:00", "12:00", "13:00", "14:00",
        "17:00", "18:00", "19:00", "20:00", "21:00",
      ]);
    }
  });

  it("lets a close hour above 24 run past midnight", () => {
    expect(openStartTimes(dailyHours([17, 26]), SAT)).toEqual(["17:00", "18:00", "19:00", "20:00", "21:00", "22:00", "23:00"]);
  });
});

describe("the seed restaurants", () => {
  it("all have hours, and every one can take some start time on any day", () => {
    for (const r of RESTAURANTS) {
      for (const date of [SAT, SUN, MON]) {
        const open = openStartTimes(r.hours, date);
        expect(open, r.name).not.toBeNull();
        expect(open!.length, r.name).toBeGreaterThan(0);
      }
    }
  });
});
