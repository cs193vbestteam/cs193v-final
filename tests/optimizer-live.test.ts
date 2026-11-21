import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";
import { ResultCard } from "@/components/ResultCard";
import { createUser } from "@/lib/auth";
import { resetDbForTests } from "@/lib/db";
import {
  createEvent,
  forGroupSize,
  getResult,
  joinEvent,
  listMyEvents,
  negotiateWhenAllReady,
  runNegotiation,
  sendMessage,
  setReady,
  type StoredResult,
} from "@/lib/events";
import { summarize, summarizePlaces } from "@/lib/pool";
import { RESTAURANTS } from "@/lib/restaurants";

/**
 * The optimizer in the real plan flow: a plan made through the app is decided by optimizer.ts,
 * and what is stored and shown is the place, the time, the other places and one count.
 */
beforeEach(() => {
  delete process.env.ANTHROPIC_API_KEY; // the rule-based reader
  delete process.env.GOOGLE_PLACES_API_KEY; // the seed pool
  resetDbForTests();
});

let n = 0;
async function plan(messages: string[], ready = true) {
  const users = [];
  for (const [i] of messages.entries())
    users.push(await createUser({ email: `live${n++}@test.dev`, displayName: `Person${i}`, password: "password123" }));
  const event = await createEvent(users[0].id, "Dinner");
  for (const u of users.slice(1)) await joinEvent(event.inviteCode, u.id);
  for (const [i, u] of users.entries()) {
    await sendMessage(event.id, u.id, messages[i]);
    if (ready) await setReady(event.id, u.id, true);
  }
  return { event, users };
}
const card = (result: StoredResult) => renderToStaticMarkup(createElement(ResultCard, { result }));
const EASY = "free all day, 30 minutes, no restrictions, up to $60";

describe("a plan made through the app", () => {
  it("is decided by the optimizer as soon as the last person is done", async () => {
    const { event, users } = await plan([EASY, EASY, EASY], false);
    for (const u of users) await setReady(event.id, u.id, true);
    expect(await negotiateWhenAllReady(event.id, users[2].id)).toBe(true);
    const result = (await getResult(event.id, users[0].id))!;
    expect(result).toMatchObject({ engine: "optimizer", status: "agreed", cannotCome: 0, participants: 3 });
    // Sixteen seed places; every open place-and-time was scored.
    expect(result.optionsScored).toBe(RESTAURANTS.reduce((sum, r) => sum + r.open.length, 0));
    expect(result.options!.length).toBeGreaterThan(1);
  });

  it("refuses to decide before everyone is done", async () => {
    const { event, users } = await plan([EASY, EASY], false);
    await setReady(event.id, users[0].id, true);
    await expect(runNegotiation(event.id, users[0].id)).rejects.toThrow(/Everyone who joined must be ready|At least 2/);
  });

  it("sends someone who eats halal to a seed place that is halal, with everyone able to come", async () => {
    // The seed places say halal with a flag, not a Google type; the handoff gives them the type.
    const { event, users } = await plan([`${EASY}, I eat halal`, EASY, EASY]);
    const result = await runNegotiation(event.id, users[0].id);
    expect(result).toMatchObject({ status: "agreed", cannotCome: 0 });
    const halal = new Set(RESTAURANTS.filter((r) => r.halal).map((r) => r.id));
    expect(halal.size).toBeGreaterThan(0);
    for (const o of result.options!) expect(halal.has(o.proposal.restaurantId)).toBe(true);
  });

  it("stores nothing anyone said: no preferences, scores, names or finishing order", async () => {
    const { event, users } = await plan([
      `${EASY}, I'm vegetarian, allergic to peanuts`,
      "dinner only, 20 minutes, no restrictions, $25 max",
      EASY,
    ]);
    const stored = JSON.stringify(await runNegotiation(event.id, users[0].id));
    expect(stored).not.toMatch(/vegetarian|peanut|\$25|prefs|scores|finished|Person\d|strength|must/);
  });
});

describe("the place summaries of an optimizer result", () => {
  it("say what each place is in words, and are otherwise what the negotiation engine stored", () => {
    const ids = RESTAURANTS.slice(0, 2).map((r) => r.id);
    const plain = summarize(RESTAURANTS, ids);
    const withKind = summarizePlaces(RESTAURANTS, ids);
    for (const id of ids) {
      expect(withKind[id]).toEqual({ ...plain[id], kind: expect.any(String) });
      expect(plain[id]).not.toHaveProperty("kind");
    }
  });
});

describe("what the card says when the optimizer finds no plan", () => {
  const none = (participants: number, noPlan: "no_candidates" | "nobody_can_come"): StoredResult => ({
    status: "no_deal",
    proposal: null,
    tally: null,
    rounds: [],
    concessionLevel: 0,
    finalists: [],
    reservations: [],
    conflicts: [],
    leakedDims: 0,
    participants,
    memberNames: [],
    places: {},
    decidedAt: 1,
    detail: "full",
    roundCount: 0,
    engine: "optimizer",
    optionsScored: 0,
    noPlan,
  });

  it("says nothing is open, to a group of any size: that is about the places", () => {
    for (const people of [2, 4]) {
      const result = forGroupSize(none(people, "no_candidates"));
      expect(result.noPlan).toBe("no_candidates");
      expect(card(result)).toContain("Nothing is open that day");
    }
  });

  it("tells a group of three or more that every option keeps everyone out", () => {
    const html = card(forGroupSize(none(3, "nobody_can_come")));
    expect(html).toContain("No plan works for everyone yet");
    expect(html).toContain("for every person");
  });

  it("does not tell a pair that nobody can come: that would be about the other person", () => {
    const result = forGroupSize(none(2, "nobody_can_come"));
    expect(result).not.toHaveProperty("noPlan");
    const html = card(result);
    expect(html).toContain("No plan works for both of you yet");
    expect(html).not.toContain("for every person");
  });

  it("turns a plan only one of a pair can come to into no plan, and is safe to apply twice", () => {
    const partial: StoredResult = {
      ...none(2, "no_candidates"),
      noPlan: undefined,
      status: "partial",
      proposal: { restaurantId: "x", slot: "18:00" },
      options: [{ proposal: { restaurantId: "x", slot: "18:00" } }],
      places: { x: { name: "X", cuisine: "thai", pricePerPerson: 20 } },
      cannotCome: 1,
    };
    const once = forGroupSize(partial);
    expect(once).toMatchObject({ status: "no_deal", proposal: null, places: {} });
    expect(once).not.toHaveProperty("cannotCome");
    expect(once).not.toHaveProperty("options");
    expect(forGroupSize(once)).toEqual(once);
    // Three people keep the plan and the count.
    expect(forGroupSize({ ...partial, participants: 3 })).toMatchObject({ status: "partial", cannotCome: 1 });
  });
});

describe("the list of someone's plans", () => {
  it("calls a plan decided when there is a place, and stuck when the run found none", async () => {
    const good = await plan([EASY, EASY]);
    await runNegotiation(good.event.id, good.users[0].id);
    const [listed] = await listMyEvents(good.users[0].id);
    expect(listed).toMatchObject({ decided: true, stuck: false });

    const clash = await plan([
      "only 6pm works for me, max $15 per person, vegan, 10 minutes away at most",
      "only 9pm works for me, I want steak, at least $80 per person, no restrictions, 20 minutes",
    ]);
    const result = await runNegotiation(clash.event.id, clash.users[0].id);
    expect(result.status).toBe("no_deal");
    const [stuck] = await listMyEvents(clash.users[0].id);
    expect(stuck).toMatchObject({ decided: true, stuck: true });
  });
});
