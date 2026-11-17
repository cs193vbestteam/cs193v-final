import { beforeEach, describe, expect, it } from "vitest";
import { createUser } from "@/lib/auth";
import { resetDbForTests } from "@/lib/db";
import { createEvent, joinEvent, sendMessage, setReady } from "@/lib/events";
import { optimize, rankOptions } from "@/lib/optimizer";
import { OptimizerInputSchema, assembleOptimizerInput, type OptimizerInput } from "@/lib/optimizer-handoff";
import { START_TIMES, type CandidateRestaurant, type PersonPreferences } from "@/lib/optimizer-input";
import { loadOptimizerInput } from "@/lib/optimizer-source";
import { RESTAURANTS } from "@/lib/restaurants";

/**
 * Whoever finished telling their assistant first wins an exact tie, and nothing more than a
 * tie. The order is recorded when a member becomes ready, reaches the optimizer as a rank
 * with no time in it, and is one step in the optimizer's tie-breaks.
 */
const wants = (type: string, strength: "must" | "strong" | "mild"): PersonPreferences => ({
  version: 1,
  cuisine: { scores: { [type]: 1 }, strength },
});
const place = (id: string, type: string, travel = 10): CandidateRestaurant => ({
  id,
  name: id,
  types: [type],
  primaryType: type,
  style: ["casual"],
  price: { low: 20, high: 30 },
  servesVegetarian: true,
  openAt: ["18:00"],
  travelMin: { p1: travel, p2: travel },
});
/** Two people and two places; `finished` gives each person's place in the order, or none. */
function pair(a: PersonPreferences, b: PersonPreferences, finished: (number | undefined)[]): OptimizerInput {
  return OptimizerInputSchema.parse({
    plan: { date: "2026-11-21", startTimes: [...START_TIMES], anchor: { label: "Test", lat: 37.43, lng: -122.17 } },
    people: [a, b].map((prefs, i) => ({
      id: `p${i + 1}`,
      prefs,
      ...(finished[i] ? { finished: finished[i] } : {}),
    })),
    // The Mexican place is nearer, so with no order known the tie goes to it.
    candidates: [place("mexican", "mexican_restaurant", 5), place("italian", "italian_restaurant", 10)],
  });
}
const pick = (input: OptimizerInput) => {
  const result = optimize(input);
  return result.restaurantId;
};

describe("the tie-break for whoever finished first", () => {
  const mexican = wants("mexican_restaurant", "must");
  const italian = wants("italian_restaurant", "must");

  it("settles two musts that contradict each other for the person who finished first", () => {
    expect(pick(pair(mexican, italian, [1, 2]))).toBe("mexican");
    expect(pick(pair(mexican, italian, [2, 1]))).toBe("italian");
  });

  it("is only a tie-break: both options are worth the same to the group either way", () => {
    const [first, second] = rankOptions(pair(mexican, italian, [2, 1]));
    expect(first.restaurantId).toBe("italian");
    expect(first.welfare).toBeCloseTo(second.welfare, 9);
  });

  it("never outweighs a stronger wish from someone who finished later", () => {
    const input = pair(wants("mexican_restaurant", "mild"), wants("italian_restaurant", "strong"), [1, 2]);
    expect(pick(input)).toBe("italian");
  });

  it("changes nothing when no order is known, or when both finished at the same moment", () => {
    expect(pick(pair(mexican, italian, [undefined, undefined]))).toBe("mexican"); // the shorter trip
    expect(pick(pair(mexican, italian, [1, 1]))).toBe("mexican");
    // Listed the other way round too: neither of two who finished together is ahead.
    expect(pick(pair(italian, mexican, [undefined, undefined]))).toBe("mexican");
    expect(pick(pair(italian, mexican, [1, 1]))).toBe("mexican");
  });

  it("counts only people whose place in the order is known", () => {
    expect(pick(pair(mexican, italian, [undefined, 1]))).toBe("italian");
  });

  it("does not depend on which of them is listed first", () => {
    const input = pair(mexican, italian, [2, 1]);
    const swapped = pair(italian, mexican, [1, 2]);
    expect(pick(input)).toBe("italian");
    expect(pick(swapped)).toBe("italian");
  });
});

describe("the order as the optimizer's input carries it", () => {
  const member = (finishedAt?: number | null) => ({
    prefs: { version: 1 } as PersonPreferences,
    startPoint: null,
    finishedAt,
  });
  const assemble = (...times: (number | null | undefined)[]) =>
    assembleOptimizerInput({
      date: "2026-11-21",
      location: null,
      restaurants: RESTAURANTS.slice(0, 2),
      members: times.map(member),
    }).people.map((p) => p.finished);

  it("is a rank, first to finish first, with no time in it", () => {
    expect(assemble(1_700_000_300_000, 1_700_000_100_000, 1_700_000_200_000)).toEqual([3, 1, 2]);
  });

  it("leaves out anyone who is not done, and gives the same rank to the same moment", () => {
    expect(assemble(500, null, 100, undefined, 100)).toEqual([2, undefined, 1, undefined, 1]);
  });
});

describe("the order as storage records it", () => {
  beforeEach(() => {
    delete process.env.ANTHROPIC_API_KEY; // the rule-based reader, so the test needs no model
    resetDbForTests();
  });
  const later = () => new Promise((resolve) => setTimeout(resolve, 5));
  const order = async (eventId: string) => (await loadOptimizerInput(eventId)).input.people.map((p) => p.finished);

  it("follows who became ready first, and gives up the place of someone who stops being ready", async () => {
    const alice = await createUser({ email: "alice@finish.dev", displayName: "Alice", password: "password123" });
    const bob = await createUser({ email: "bob@finish.dev", displayName: "Bob", password: "password123" });
    const event = await createEvent(alice.id, "Saturday dinner", null, "meal", "2026-11-21");
    await joinEvent(event.inviteCode, bob.id);
    await sendMessage(event.id, alice.id, "dinner works, I'm vegetarian, under $40");
    await sendMessage(event.id, bob.id, "lunch or dinner, no restrictions");
    expect(await order(event.id)).toEqual([undefined, undefined]);

    // Alice joined first, but Bob finishes first.
    await setReady(event.id, bob.id, true);
    await later();
    await setReady(event.id, alice.id, true);
    expect(await order(event.id)).toEqual([2, 1]);

    // Being ready again without having stopped does not move anyone.
    await later();
    await setReady(event.id, bob.id, true);
    expect(await order(event.id)).toEqual([2, 1]);

    // Bob takes his answer back and finishes again: he is now after Alice.
    await setReady(event.id, bob.id, false);
    expect(await order(event.id)).toEqual([1, undefined]);
    await later();
    await setReady(event.id, bob.id, true);
    expect(await order(event.id)).toEqual([1, 2]);

    const text = JSON.stringify((await loadOptimizerInput(event.id)).input);
    expect(text).not.toMatch(/\d{13}/); // no timestamp reaches the optimizer
  });
});
