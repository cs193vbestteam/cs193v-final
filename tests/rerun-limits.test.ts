import { beforeEach, describe, expect, it } from "vitest";
import { createUser } from "@/lib/auth";
import { db, resetDbForTests } from "@/lib/db";
import {
  AccessError,
  NOTHING_CHANGED,
  RateLimitError,
  canRerun,
  createEvent,
  deletePlan,
  getResult,
  joinEvent,
  runNegotiation,
  sendMessage,
  setReady,
} from "@/lib/events";
import { LIMITS } from "@/lib/ratelimit";

/**
 * Running a plan again (#118). Every run shows a plan made from everyone's answers, so someone
 * who changes their own answers and runs it over and over can work out what another person said.
 * A plan is only run again after a real change, and only so many times a day.
 */

beforeEach(async () => {
  delete process.env.ANTHROPIC_API_KEY; // deterministic rule-based extractor
  delete process.env.GOOGLE_PLACES_API_KEY; // seed restaurants
  await resetDbForTests();
});

let n = 0;
const makeUser = (name: string) =>
  createUser({ email: `${name}${n++}@test.dev`, displayName: name, password: "password123" });

const ANSWER = "dinner at 7pm works, up to $60 per person, 30 minutes away at most, no restrictions";

async function tell(eventId: string, userId: string, text: string) {
  await sendMessage(eventId, userId, text);
  await setReady(eventId, userId, true);
}

/** Two people, both done, and a first plan found. */
async function decided() {
  const a = await makeUser("Alice");
  const b = await makeUser("Bob");
  const event = await createEvent(a.id, "Dinner");
  await joinEvent(event.inviteCode, b.id);
  await tell(event.id, a.id, ANSWER);
  await tell(event.id, b.id, ANSWER);
  const first = await runNegotiation(event.id, a.id);
  return { a, b, event, first };
}

describe("running a decided plan again", () => {
  it("is refused while nobody has changed an answer, and leaves the result as it was", async () => {
    const { a, b, event, first } = await decided();
    expect(await canRerun(event.id, a.id)).toBe(false);
    await expect(runNegotiation(event.id, a.id)).rejects.toThrow(NOTHING_CHANGED);
    await expect(runNegotiation(event.id, b.id)).rejects.toBeInstanceOf(AccessError);
    expect((await getResult(event.id, a.id))?.decidedAt).toBe(first.decidedAt);
  });

  it("is not unlocked by pressing not done and done again", async () => {
    const { a, event } = await decided();
    await setReady(event.id, a.id, false);
    await setReady(event.id, a.id, true);
    expect(await canRerun(event.id, a.id)).toBe(false);
    await expect(runNegotiation(event.id, a.id)).rejects.toThrow(NOTHING_CHANGED);
  });

  it("is not unlocked by a message that changes nothing", async () => {
    const { a, event } = await decided();
    await sendMessage(event.id, a.id, "thanks!");
    expect(await canRerun(event.id, a.id)).toBe(false);
  });

  it("is allowed once someone changes what they want", async () => {
    const { a, b, event, first } = await decided();
    await tell(event.id, b.id, "actually make my budget 35 dollars");
    expect(await canRerun(event.id, a.id)).toBe(true);
    const second = await runNegotiation(event.id, a.id);
    expect(second.decidedAt).toBeGreaterThanOrEqual(first.decidedAt);
    // That change is used up: the new result is the plan for the current answers.
    expect(await canRerun(event.id, a.id)).toBe(false);
    await expect(runNegotiation(event.id, b.id)).rejects.toThrow(NOTHING_CHANGED);
  });

  it("is allowed once someone new has joined and is done", async () => {
    const { a, event } = await decided();
    const c = await makeUser("Carol");
    await joinEvent(event.inviteCode, c.id);
    await tell(event.id, c.id, ANSWER);
    expect(await canRerun(event.id, a.id)).toBe(true);
    expect((await runNegotiation(event.id, a.id)).participants).toBe(3);
  });

  it("only answers members", async () => {
    const { event } = await decided();
    const outsider = await makeUser("Eve");
    await expect(canRerun(event.id, outsider.id)).rejects.toBeInstanceOf(AccessError);
  });
});

describe("runs per plan per day", () => {
  /** Alice changes her budget and runs the plan again, the way someone probing Bob's limit would. */
  async function probe(eventId: string, userId: string, budget: number) {
    await tell(eventId, userId, "make my budget " + budget + " dollars");
    return runNegotiation(eventId, userId);
  }

  it("stops someone who keeps changing their own answers and running it again", async () => {
    const { a, event } = await decided(); // run 1
    let budget = 59;
    for (let run = 2; run <= LIMITS.runsPerPlan.max; run++) await probe(event.id, a.id, budget--);
    const before = await getResult(event.id, a.id);

    await expect(probe(event.id, a.id, budget--)).rejects.toBeInstanceOf(RateLimitError);
    await expect(probe(event.id, a.id, budget--)).rejects.toThrow(/most allowed/);
    // The refused runs showed nothing new.
    expect((await getResult(event.id, a.id))?.decidedAt).toBe(before?.decidedAt);
  });

  it("does not count attempts that could not start", async () => {
    const { a, b, event } = await decided(); // run 1
    for (let i = 0; i < LIMITS.runsPerPlan.max * 2; i++) {
      await expect(runNegotiation(event.id, a.id)).rejects.toThrow(NOTHING_CHANGED);
    }
    await setReady(event.id, b.id, false);
    for (let i = 0; i < LIMITS.runsPerPlan.max * 2; i++) {
      await expect(runNegotiation(event.id, a.id)).rejects.toThrow(/need to be ready first/);
    }
    await setReady(event.id, b.id, true);
    await expect(probe(event.id, a.id, 58)).resolves.toMatchObject({ engine: "optimizer" }); // run 2
  });

  it("is counted per plan, and forgotten when the plan is deleted", async () => {
    const one = await decided();
    let budget = 59;
    for (let run = 2; run <= LIMITS.runsPerPlan.max; run++) await probe(one.event.id, one.a.id, budget--);
    await expect(probe(one.event.id, one.a.id, budget--)).rejects.toBeInstanceOf(RateLimitError);

    const other = await decided();
    await expect(probe(other.event.id, other.a.id, 58)).resolves.toMatchObject({ engine: "optimizer" });

    await deletePlan(one.event.id, one.a.id);
    const { rows } = await (
      await db()
    ).execute({ sql: "SELECT COUNT(*) AS n FROM rate_limits WHERE key = ?", args: ["runs:" + one.event.id] });
    expect(Number(rows[0].n)).toBe(0);
  });
});
