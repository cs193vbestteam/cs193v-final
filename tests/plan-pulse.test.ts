import { beforeEach, describe, expect, it } from "vitest";
import { createUser } from "@/lib/auth";
import { db, resetDbForTests } from "@/lib/db";
import {
  ALREADY_RUNNING,
  createEvent,
  getMyMessages,
  getResult,
  joinEvent,
  leavePlan,
  listMembers,
  planPulse,
  runNegotiation,
  sendMessage,
  setReady,
} from "@/lib/events";

/**
 * What the open plan page costs the server. The page used to re-render every five seconds,
 * which re-read and decrypted the whole plan each time for every open tab. It now asks for a
 * short string and re-renders only when the string differs; these tests hold that the string
 * changes when the page would, stays put when it would not, and says nothing to outsiders.
 */

beforeEach(async () => {
  delete process.env.ANTHROPIC_API_KEY; // the rule-based reader answers
  delete process.env.GOOGLE_PLACES_API_KEY; // seed restaurants
  await resetDbForTests();
});

let n = 0;
const makeUser = (name: string) =>
  createUser({ email: `${name}${n++}@test.dev`, displayName: name, password: "password123" });
const ANSWER = "dinner at 7pm works, up to $60 per person, 30 minutes away at most, no restrictions";

async function plan() {
  const a = await makeUser("Alice");
  const b = await makeUser("Bob");
  const event = await createEvent(a.id, "Dinner");
  await joinEvent(event.inviteCode, b.id);
  return { a, b, event };
}

describe("the plan's pulse", () => {
  it("stays the same while nothing happens, for every member", async () => {
    const { a, b, event } = await plan();
    const first = await planPulse(event.id, a.id);
    expect(first).toMatch(/^[0-9a-f]{32}\.[0-9a-f]{32}$/);
    expect(await planPulse(event.id, a.id)).toBe(first);
    // It is about the plan, not about who asks.
    expect(await planPulse(event.id, b.id)).toBe(first);
  });

  it("changes when someone joins, finishes, changes an answer or leaves", async () => {
    const { a, b, event } = await plan();
    const seen = new Set([await planPulse(event.id, a.id)]);
    const moved = async (what: string) => {
      const now = await planPulse(event.id, a.id);
      expect(seen.has(now), what).toBe(false);
      seen.add(now);
    };
    const c = await makeUser("Cara");
    await joinEvent(event.inviteCode, c.id);
    await moved("someone joined");
    await sendMessage(event.id, b.id, ANSWER);
    await moved("someone answered");
    await setReady(event.id, b.id, true);
    await moved("someone finished");
    await leavePlan(event.id, c.id);
    await moved("someone left");
  });

  it("changes when the plan is found", async () => {
    const { a, b, event } = await plan();
    for (const u of [a, b]) {
      await sendMessage(event.id, u.id, ANSWER);
      await setReady(event.id, u.id, true);
    }
    const before = await planPulse(event.id, a.id);
    await runNegotiation(event.id, a.id);
    expect(await planPulse(event.id, a.id)).not.toBe(before);
  });

  it("is null for someone who is not in the plan, and for a plan that does not exist", async () => {
    const { event } = await plan();
    const outsider = await makeUser("Mallory");
    expect(await planPulse(event.id, outsider.id)).toBeNull();
    expect(await planPulse("no-such-plan", outsider.id)).toBeNull();
  });

  it("carries nothing readable: two plans with the same people and answers have different pulses", async () => {
    const one = await plan();
    const two = await plan();
    expect(await planPulse(one.event.id, one.a.id)).not.toBe(await planPulse(two.event.id, two.a.id));
  });
});

describe("a chat message", () => {
  it("returns the same conversation a fresh read gives", async () => {
    const { a, event } = await plan();
    const first = await sendMessage(event.id, a.id, "dinner works for me");
    expect(first.messages).toEqual(await getMyMessages(event.id, a.id));
    const second = await sendMessage(event.id, a.id, "around $30");
    expect(second.messages).toEqual(await getMyMessages(event.id, a.id));
    expect(second.messages.at(-1)?.role).toBe("assistant");
  });

  it("is refused for someone who is not in the plan, and stores nothing", async () => {
    const { event } = await plan();
    const outsider = await makeUser("Mallory");
    await expect(sendMessage(event.id, outsider.id, "hello")).rejects.toThrow("not part of this plan");
    const client = await db();
    const { rows } = await client.execute({
      sql: "SELECT 1 FROM messages WHERE user_id = ?",
      args: [outsider.id],
    });
    expect(rows).toHaveLength(0);
  });

  it("un-readies a member whose answers changed, and leaves one whose answers did not", async () => {
    const { a, event } = await plan();
    const isReady = async () => (await listMembers(event.id, a.id)).find((m) => m.userId === a.id)?.ready;
    await sendMessage(event.id, a.id, ANSWER);
    await setReady(event.id, a.id, true);
    await sendMessage(event.id, a.id, "thanks!");
    expect(await isReady()).toBe(true);
    await sendMessage(event.id, a.id, "actually make it $20 at most");
    expect(await isReady()).toBe(false);
  });
});

describe("finding the plan", () => {
  it("runs once when it is started twice at the same moment; the second is told it is under way", async () => {
    const { a, b, event } = await plan();
    for (const u of [a, b]) {
      await sendMessage(event.id, u.id, ANSWER);
      await setReady(event.id, u.id, true);
    }
    const both = await Promise.allSettled([runNegotiation(event.id, a.id), runNegotiation(event.id, a.id)]);
    const ok = both.filter((r) => r.status === "fulfilled");
    const refused = both.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(ok).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(String(refused[0].reason.message)).toBe(ALREADY_RUNNING);
    expect(await getResult(event.id, a.id)).not.toBeNull();
  });

  it("lets the next run start once one has ended, also after a run that failed", async () => {
    const { a, b, event } = await plan();
    // Nobody is done: the run is refused before it starts, and must not leave the lock held.
    await expect(runNegotiation(event.id, a.id)).rejects.toThrow();
    for (const u of [a, b]) {
      await sendMessage(event.id, u.id, ANSWER);
      await setReady(event.id, u.id, true);
    }
    await expect(runNegotiation(event.id, a.id)).resolves.toBeTruthy();
  });
});
