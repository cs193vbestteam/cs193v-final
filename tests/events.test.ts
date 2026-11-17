import { beforeEach, describe, expect, it, vi } from "vitest";
import { createUser } from "@/lib/auth";
import { db, resetDbForTests } from "@/lib/db";
import {
  AccessError,
  createEvent,
  getMyConstraints,
  getMyMessages,
  getResult,
  joinEvent,
  listMembers,
  listMyEvents,
  negotiateWhenAllReady,
  runNegotiation,
  sendMessage,
  setReady,
} from "@/lib/events";

beforeEach(() => {
  delete process.env.ANTHROPIC_API_KEY; // use the deterministic rule-based extractor
  resetDbForTests();
});

let n = 0;
const makeUser = (name: string) =>
  createUser({ email: `${name}${n++}@test.dev`, displayName: name, password: "password123" });

async function setup() {
  const a = await makeUser("Alice");
  const b = await makeUser("Bob");
  const event = await createEvent(a.id, "Saturday dinner");
  await joinEvent(event.inviteCode, b.id);
  return { a, b, event };
}

describe("events", () => {
  it("creates an event with an invite code and greets the creator privately", async () => {
    const a = await makeUser("Alice");
    const e = await createEvent(a.id, "  Dinner  ");
    expect(e.title).toBe("Dinner");
    expect(e.inviteCode).toMatch(/^[a-z2-9]{8}$/);
    const msgs = await getMyMessages(e.id, a.id);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe("assistant");
  });

  it("joining twice is harmless", async () => {
    const { b, event } = await setup();
    await joinEvent(event.inviteCode, b.id);
    expect(await listMembers(event.id, b.id)).toHaveLength(2);
    expect(await getMyMessages(event.id, b.id)).toHaveLength(1);
  });

  it("rejects bad invite codes and empty titles", async () => {
    const a = await makeUser("Alice");
    await expect(joinEvent("nope", a.id)).rejects.toThrow(AccessError);
    await expect(createEvent(a.id, "   ")).rejects.toThrow();
  });

  it("lists a user's events", async () => {
    const { a, b, event } = await setup();
    expect((await listMyEvents(a.id)).map((e) => e.id)).toEqual([event.id]);
    expect((await listMyEvents(b.id)).map((e) => e.id)).toEqual([event.id]);
  });
});

describe("privacy & authorization", () => {
  it("non-members can't read anything", async () => {
    const { event } = await setup();
    const eve = await makeUser("Eve");
    await expect(getMyMessages(event.id, eve.id)).rejects.toThrow(AccessError);
    await expect(getMyConstraints(event.id, eve.id)).rejects.toThrow(AccessError);
    await expect(listMembers(event.id, eve.id)).rejects.toThrow(AccessError);
    await expect(sendMessage(event.id, eve.id, "hi")).rejects.toThrow(AccessError);
    await expect(runNegotiation(event.id, eve.id)).rejects.toThrow(AccessError);
    await expect(getResult(event.id, eve.id)).rejects.toThrow(AccessError);
  });

  it("each person only sees their own chat", async () => {
    const { a, b, event } = await setup();
    await sendMessage(event.id, a.id, "my budget is 25");
    const bobsChat = await getMyMessages(event.id, b.id);
    expect(JSON.stringify(bobsChat)).not.toContain("25");
  });

  it("members list exposes no constraints", async () => {
    const { a, event } = await setup();
    await sendMessage(event.id, a.id, "my budget is 25");
    const members = await listMembers(event.id, a.id);
    expect(Object.keys(members[0]).sort()).toEqual(["displayName", "ready", "userId"]);
  });

  it("messages and constraints are encrypted at rest", async () => {
    const { a, event } = await setup();
    await sendMessage(event.id, a.id, "my pineapple secret: budget is 37 dollars, vegetarian");
    const client = await db();
    const dump = JSON.stringify([
      (await client.execute("SELECT * FROM messages")).rows,
      (await client.execute("SELECT * FROM members")).rows,
    ]);
    expect(dump).not.toContain("pineapple");
    expect(dump).not.toContain("vegetarian");
    expect(dump).not.toContain("budgetMax");
    expect(dump).not.toContain("budget");
  });
});

describe("chat → constraints → negotiation", () => {
  it("extracts constraints from chat and replies", async () => {
    const { a, event } = await setup();
    const { messages, constraints } = await sendMessage(event.id, a.id, "Dinner, under $30, no spicy");
    // Stored in the format the optimizer reads (#83): the times they cannot make, a ceiling, and
    // a note for what no restaurant data can confirm.
    expect(constraints.prefs.time?.unavailable).toEqual([
      { from: "10:00", to: "16:00" },
      { from: "21:00", to: "23:00" },
    ]);
    expect(constraints.prefs.budget).toEqual({ max: 30, strength: "must" });
    expect(constraints.prefs.dietary).toBeUndefined();
    expect(constraints.prefs.notes).toEqual([{ type: "other", text: "No spicy food" }]);
    expect(messages.at(-1)?.role).toBe("assistant");
  });

  it("won't mark you ready until hard constraints are known", async () => {
    const { a, event } = await setup();
    await expect(setReady(event.id, a.id, true)).rejects.toThrow(/still needs/);
  });

  it("changing constraints un-readies you", async () => {
    const { a, event } = await setup();
    await sendMessage(event.id, a.id, "Saturday dinner, $40, 20 minutes, no restrictions");
    await setReady(event.id, a.id, true);
    await sendMessage(event.id, a.id, "actually $25");
    expect((await listMembers(event.id, a.id))[0].ready).toBe(false);
  });

  it("a message that changes nothing they want leaves them ready", async () => {
    const { a, event } = await setup();
    await sendMessage(event.id, a.id, "Saturday dinner, $40, 20 minutes, no restrictions");
    await setReady(event.id, a.id, true);
    // The reply is counted and may ask something, but what Alice wants is the same.
    await sendMessage(event.id, a.id, "thanks!");
    expect((await listMembers(event.id, a.id))[0].ready).toBe(true);
  });

  it('lets someone be done with only a time and the "anything you can\'t eat" answer (#83)', async () => {
    const { a, event } = await setup();
    await sendMessage(event.id, a.id, "dinner");
    await expect(setReady(event.id, a.id, true)).rejects.toThrow(/still needs diet/);
    await sendMessage(event.id, a.id, "no restrictions");
    // No budget and no distance: both may stay empty.
    const mine = await getMyConstraints(event.id, a.id);
    expect(mine.prefs.budget).toBeUndefined();
    expect(mine.prefs.travel).toBeUndefined();
    await expect(setReady(event.id, a.id, true)).resolves.toBeUndefined();
  });

  it("needs two ready people to negotiate", async () => {
    const { a, event } = await setup();
    await sendMessage(event.id, a.id, "Saturday dinner, $40, 20 minutes, no restrictions");
    await setReady(event.id, a.id, true);
    await expect(runNegotiation(event.id, a.id)).rejects.toThrow(/2 people/);
  });

  it("finds the plan by itself once the last person is done, and never re-runs a decided plan", async () => {
    const { a, b, event } = await setup();
    await sendMessage(event.id, a.id, "Saturday night only, under $40, no spicy, max 20 minutes away");
    await setReady(event.id, a.id, true);
    // One of two done: nothing happens yet.
    expect(await negotiateWhenAllReady(event.id, a.id)).toBe(false);
    expect(await getResult(event.id, a.id)).toBeNull();

    await sendMessage(event.id, b.id, "free all weekend, $35 max, 15 minutes, vegetarian");
    await setReady(event.id, b.id, true);
    expect(await negotiateWhenAllReady(event.id, b.id)).toBe(true);
    const first = await getResult(event.id, a.id);
    expect(first?.status).toBe("agreed");

    // Marking done again leaves the decided plan alone: a re-run is always an explicit choice.
    await setReady(event.id, b.id, false);
    await setReady(event.id, b.id, true);
    expect(await negotiateWhenAllReady(event.id, b.id)).toBe(false);
    expect(await getResult(event.id, a.id)).toEqual(first);
  });

  it("does not start a plan for one person, or for someone outside it", async () => {
    const a = await makeUser("Alice");
    const eve = await makeUser("Eve");
    const event = await createEvent(a.id, "Solo");
    await sendMessage(event.id, a.id, "Saturday dinner, $40, 20 minutes, no restrictions");
    await setReady(event.id, a.id, true);
    expect(await negotiateWhenAllReady(event.id, a.id)).toBe(false);
    await expect(negotiateWhenAllReady(event.id, eve.id)).rejects.toThrow(AccessError);
  });

  it("end to end: two people agree on a plan; result has no private data", async () => {
    const { a, b, event } = await setup();
    await sendMessage(event.id, a.id, "Saturday night only, under $40, no spicy, max 20 minutes away");
    await setReady(event.id, a.id, true);
    await sendMessage(event.id, b.id, "free all day, $35 max, 15 minutes, vegetarian");
    await setReady(event.id, b.id, true);

    const result = await runNegotiation(event.id, b.id);
    expect(result.status).toBe("agreed");
    // The one person with a limit on time said the evening.
    expect(["17:00", "18:00", "19:00", "20:00"]).toContain(result.proposal?.slot);
    expect(result.participants).toBe(2);
    expect(await getResult(event.id, a.id)).toEqual(result);

    // Only aggregate tallies are stored for the group: no constraint fields, no per-person entries.
    const stored = JSON.stringify(result);
    expect(stored).not.toMatch(/budget|dietary|maxTravel|availableSlots|userId/);
  });

  it("does not exclude an unready third member from the group agreement", async () => {
    const { a, b, event } = await setup();
    const c = await makeUser("Charlie");
    await joinEvent(event.inviteCode, c.id);
    for (const user of [a, b]) {
      await sendMessage(event.id, user.id, "Saturday dinner, $40, 20 minutes, no restrictions");
      await setReady(event.id, user.id, true);
    }

    await expect(runNegotiation(event.id, a.id)).rejects.toThrow(/everyone.*ready/i);
    expect(await getResult(event.id, a.id)).toBeNull();

    await sendMessage(event.id, c.id, "Saturday dinner, $40, 20 minutes, no restrictions");
    await setReady(event.id, c.id, true);
    const result = await runNegotiation(event.id, a.id);
    expect(result.status).toBe("agreed");
    expect(result.participants).toBe(3);
  });

  it("blocks a new negotiation when one of three ready members withdraws readiness", async () => {
    const { a, b, event } = await setup();
    const c = await makeUser("Charlie");
    await joinEvent(event.inviteCode, c.id);
    for (const user of [a, b, c]) {
      await sendMessage(event.id, user.id, "Saturday dinner, $40, 20 minutes, no restrictions");
      await setReady(event.id, user.id, true);
    }
    await setReady(event.id, c.id, false);

    await expect(runNegotiation(event.id, b.id)).rejects.toThrow(/everyone.*ready/i);
    expect(await getResult(event.id, a.id)).toBeNull();
  });
});

describe("candidate pool per plan", () => {
  it("stores the location and falls back to the seed pool without a Places key", async () => {
    delete process.env.GOOGLE_PLACES_API_KEY;
    const a = await makeUser("Alice");
    const e = await createEvent(a.id, "Dinner", "  Palo Alto, CA ");
    expect(e.location).toBe("Palo Alto, CA");
    expect(e.poolSource).toBe("seed");
    expect(e.poolSize).toBe(16);
    const { poolForEvent } = await import("@/lib/pool");
    expect((await poolForEvent(e.id)).source).toBe("seed");
    expect((await listMyEvents(a.id))[0]).toMatchObject({ location: "Palo Alto, CA", poolSource: "seed" });
  });

  it("rejects an absurdly long location", async () => {
    const a = await makeUser("Alice");
    await expect(createEvent(a.id, "Dinner", "x".repeat(121))).rejects.toThrow();
  });

  it("the stored result carries public place summaries for the plan and the other places listed", async () => {
    const { a, b, event } = await setup();
    const c = await makeUser("Charlie");
    await joinEvent(event.inviteCode, c.id);
    for (const u of [a, b, c]) {
      await sendMessage(event.id, u.id, "Saturday dinner, under $40, 20 minutes, no restrictions");
      await setReady(event.id, u.id, true);
    }
    const result = await runNegotiation(event.id, a.id);
    const listed = result.options!.map((o) => o.proposal.restaurantId);
    expect(listed[0]).toBe(result.proposal!.restaurantId);
    expect(new Set(listed).size).toBe(listed.length); // every place once
    expect(listed.length).toBeGreaterThan(1);
    expect(Object.keys(result.places).sort()).toEqual([...listed].sort());
    for (const id of listed)
      expect(result.places[id]).toMatchObject({
        name: expect.any(String),
        pricePerPerson: expect.any(Number),
        kind: expect.any(String),
      });
    expect(JSON.stringify(result.places)).not.toMatch(/budget|constraints|weight/);
    const stored = await getResult(event.id, b.id);
    expect(stored?.places).toEqual(result.places);
  });
});

describe("the automatic run is claimed by one caller", () => {
  async function allReady() {
    const { a, b, event } = await setup();
    for (const u of [a, b]) {
      await sendMessage(event.id, u.id, "Saturday dinner, $40, 20 minutes, no restrictions");
      await setReady(event.id, u.id, true);
    }
    return { a, b, event };
  }

  it("two people finishing in the same instant start one negotiation, not two", async () => {
    const { a, b, event } = await allReady();
    const ran = await Promise.all([negotiateWhenAllReady(event.id, a.id), negotiateWhenAllReady(event.id, b.id)]);
    expect(ran.filter(Boolean)).toHaveLength(1);
    expect((await getResult(event.id, a.id))?.status).toBe("agreed");
  });

  it("a run that fails gives the claim back, so the next person done can try", async () => {
    const { a, b, event } = await allReady();
    const pool = await import("@/lib/pool");
    const broken = vi.spyOn(pool, "poolForEvent").mockRejectedValueOnce(new Error("pool unavailable"));
    await expect(negotiateWhenAllReady(event.id, a.id)).rejects.toThrow("pool unavailable");
    expect(await getResult(event.id, a.id)).toBeNull();
    broken.mockRestore();
    expect(await negotiateWhenAllReady(event.id, b.id)).toBe(true);
  });
});
