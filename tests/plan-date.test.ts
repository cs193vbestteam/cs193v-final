import { beforeEach, describe, expect, it } from "vitest";
import { createUser } from "@/lib/auth";
import { clockLabel, describeSlots, SLOTS } from "@/lib/constraints";
import { resetDbForTests } from "@/lib/db";
import { createEvent, getEventByCode } from "@/lib/events";
import {
  MAX_DAYS_AHEAD,
  addDays,
  formatPlanDate,
  formatWhen,
  latestPlanDate,
  planDateSchema,
  todayPacific,
} from "@/lib/plan-date";

describe("today in California", () => {
  it("is still the day before when it is past midnight UTC but evening in California", () => {
    expect(todayPacific(new Date("2026-11-21T03:00:00Z"))).toBe("2026-11-20");
    expect(todayPacific(new Date("2026-11-21T20:00:00Z"))).toBe("2026-11-21");
  });

  it("moves a date by whole days, across months and years", () => {
    expect(addDays("2026-11-30", 1)).toBe("2026-12-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(latestPlanDate(new Date("2026-11-21T20:00:00Z"))).toBe(addDays("2026-11-21", MAX_DAYS_AHEAD));
  });
});

describe("a plan's date", () => {
  const now = new Date("2026-11-21T20:00:00Z"); // noon on Nov 21 in California
  const ok = (date: unknown) => planDateSchema(now).safeParse(date).success;

  it("can be today, or any day up to 60 days ahead", () => {
    expect(ok("2026-11-21")).toBe(true);
    expect(ok("2026-12-25")).toBe(true);
    expect(ok(addDays("2026-11-21", MAX_DAYS_AHEAD))).toBe(true);
  });

  it("cannot be in the past or further ahead than that", () => {
    expect(ok("2026-11-20")).toBe(false);
    expect(ok(addDays("2026-11-21", MAX_DAYS_AHEAD + 1))).toBe(false);
  });

  it("has to be given, and has to be a real day", () => {
    expect(ok("")).toBe(false);
    expect(ok(undefined)).toBe(false);
    expect(ok("next Saturday")).toBe(false);
    expect(ok("2026-11-31")).toBe(false);
    expect(ok("11/21/2026")).toBe(false);
  });

  it("says what is wrong in words a person can act on", () => {
    const message = (date: string) => planDateSchema(now).safeParse(date).error?.issues[0]?.message;
    expect(message("")).toBe("Pick a date for the plan");
    expect(message("2026-11-20")).toBe("The date has already passed");
    expect(message("2027-06-01")).toBe(`Pick a date within the next ${MAX_DAYS_AHEAD} days`);
  });
});

describe("how a date and a time are shown", () => {
  it("writes the date with its weekday and the time on a 12-hour clock", () => {
    expect(formatPlanDate("2026-11-21")).toBe("Sat, Nov 21");
    expect(formatWhen("2026-11-21", "19:00")).toBe("Sat, Nov 21 · 7:00 PM");
    expect(formatWhen(null, "12:00")).toBe("12:00 PM");
  });

  it("labels every start time", () => {
    expect(clockLabel("10:00")).toBe("10:00 AM");
    expect(clockLabel("12:00")).toBe("12:00 PM");
    expect(clockLabel("23:00")).toBe("11:00 PM");
  });

  it("describes a set of times as ranges", () => {
    expect(describeSlots([...SLOTS])).toBe("any time");
    expect(describeSlots(["18:00", "19:00", "20:00"])).toBe("6:00 PM to 8:00 PM");
    expect(describeSlots(["20:00", "12:00", "18:00", "19:00"])).toBe("12:00 PM, 6:00 PM to 8:00 PM");
  });
});

describe("a plan stores its date", () => {
  beforeEach(() => {
    delete process.env.GOOGLE_PLACES_API_KEY;
    resetDbForTests();
  });

  let n = 0;
  const creator = () => createUser({ email: `dana${n++}@test.dev`, displayName: "Dana", password: "password123" });

  it("keeps the date the creator chose and gives it back with the plan", async () => {
    const user = await creator();
    const date = addDays(todayPacific(), 7);
    const event = await createEvent(user.id, "Team lunch", null, "meal", date);
    expect(event.date).toBe(date);
    expect((await getEventByCode(event.inviteCode))?.date).toBe(date);
  });

  it("refuses a date in the past or too far ahead", async () => {
    const user = await creator();
    await expect(createEvent(user.id, "Too late", null, "meal", addDays(todayPacific(), -1))).rejects.toThrow();
    await expect(
      createEvent(user.id, "Too far", null, "meal", addDays(todayPacific(), MAX_DAYS_AHEAD + 1)),
    ).rejects.toThrow();
    await expect(createEvent(user.id, "Not a date", null, "meal", "soon")).rejects.toThrow();
  });
});
