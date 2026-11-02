import { beforeEach, describe, expect, it } from "vitest";
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
  runNegotiation,
  sendMessage,
  setReady,
} from "@/lib/events";

beforeEach(() => {
  delete process.env.ANTHROPIC_API_KEY; // use the deterministic rule-based extractor
  resetDbForTests();
});

let n = 0;
const makeUser = (name: string) => createUser({ email: `${name}${n++}@test.dev`, displayName: name, password: "password123" });

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
    const { messages, constraints } = await sendMessage(event.id, a.id, "Saturday dinner, under $30, no spicy");
    expect(constraints.availableSlots).toEqual(["sat_dinner"]);
    expect(constraints.budgetMax).toBe(30);
    expect(constraints.dietary).toEqual(["no_spicy"]);
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

  it("needs two ready people to negotiate", async () => {
    const { a, event } = await setup();
    await sendMessage(event.id, a.id, "Saturday dinner, $40, 20 minutes, no restrictions");
    await setReady(event.id, a.id, true);
    await expect(runNegotiation(event.id, a.id)).rejects.toThrow(/2 people/);
  });

  it("end to end: two people agree on a plan; result has no private data", async () => {
    const { a, b, event } = await setup();
    await sendMessage(event.id, a.id, "Saturday night only, under $40, no spicy, max 20 minutes away");
    await setReady(event.id, a.id, true);
    await sendMessage(event.id, b.id, "free all weekend, $35 max, 15 minutes, vegetarian");
    await setReady(event.id, b.id, true);

    const result = await runNegotiation(event.id, b.id);
    expect(result.status).toBe("agreed");
    expect(result.proposal?.slot).toBe("sat_dinner");
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

  it("the stored result carries public place summaries for everything the rounds mention", async () => {
    const { a, b, event } = await setup();
    await sendMessage(event.id, a.id, "Saturday dinner, under $40, 20 minutes, no restrictions");
    await sendMessage(event.id, b.id, "Saturday dinner, under $40, 20 minutes, no restrictions");
    await setReady(event.id, a.id, true);
    await setReady(event.id, b.id, true);
    const result = await runNegotiation(event.id, a.id);
    const mentioned = new Set(result.rounds.flatMap((r) => r.proposals.map((p) => p.proposal.restaurantId)));
    for (const id of mentioned) expect(result.places[id]).toMatchObject({ name: expect.any(String), pricePerPerson: expect.any(Number) });
    expect(JSON.stringify(result.places)).not.toMatch(/budget|constraints|weight/);
    const stored = await getResult(event.id, b.id);
    expect(stored?.places).toEqual(result.places);
  });
});
