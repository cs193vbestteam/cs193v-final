import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";
import { ResultCard } from "@/components/ResultCard";
import { createUser } from "@/lib/auth";
import { db, resetDbForTests } from "@/lib/db";
import {
  MIN_GROUP_FOR_DETAIL,
  createEvent,
  forGroupSize,
  getResult,
  joinEvent,
  runNegotiation,
  sendMessage,
  setReady,
  SHORTLIST,
  type StoredResult,
} from "@/lib/events";

/**
 * #45: in a plan of two, every "anonymous" count is the other person's answer.
 * Such a plan may show the outcome and the number of rounds, nothing else, and
 * the rest must not even be stored.
 */

beforeEach(() => {
  delete process.env.ANTHROPIC_API_KEY; // deterministic rule-based extractor
  delete process.env.GOOGLE_PLACES_API_KEY; // seed pool
  resetDbForTests();
});

let n = 0;
const makeUser = (name: string) =>
  createUser({ email: `${name}-two${n++}@test.dev`, displayName: name, password: "password123" });

async function plan(messages: Record<string, string>) {
  const users = [];
  for (const name of Object.keys(messages)) users.push(await makeUser(name));
  const event = await createEvent(users[0].id, "Dinner");
  for (const u of users.slice(1)) await joinEvent(event.inviteCode, u.id);
  for (const u of users) {
    await sendMessage(event.id, u.id, messages[u.displayName]);
    await setReady(event.id, u.id, true);
  }
  return { event, users };
}

/** Exactly what is in the database row, before any read-side handling. */
async function storedRow(eventId: string): Promise<string> {
  const client = await db();
  const { rows } = await client.execute({ sql: "SELECT result_json FROM events WHERE id = ?", args: [eventId] });
  return String(rows[0].result_json);
}

const card = (result: StoredResult) => renderToStaticMarkup(createElement(ResultCard, { result }));

/** Anything that would tell one member how the other answered. */
const VERDICTS = /reject|reluctant|\baccept\b|rejectDims|"dims"/i;
const DIM_WORDS = /\b(price|budget|timing|distance|diet)\b/i;

const ANY_WEEKEND = "free all weekend, 30 minutes, no restrictions";

describe("a two-person plan shows the outcome only", () => {
  it("stores and renders no tally and no dimension name when one person rejects on budget", async () => {
    // Bob's ceiling rules out most of the seed pool, so the rounds are full of price rejects.
    const { event, users } = await plan({
      Alice: `${ANY_WEEKEND}, up to $80`,
      Bob: `${ANY_WEEKEND}, $20 max`,
    });
    const [alice, bob] = users;
    const result = await runNegotiation(event.id, alice.id);

    expect(result.participants).toBe(2);
    expect(result.detail).toBe("outcome");
    expect(result.status).not.toBe("no_deal");
    expect(result.proposal).not.toBeNull();
    expect(result.roundCount).toBeGreaterThanOrEqual(1);
    expect(result).toMatchObject({
      tally: null,
      rounds: [],
      finalists: [],
      reservations: [],
      conflicts: [],
      memberNames: [],
      leakedDims: 0,
      concessionLevel: 0,
    });
    // The places that may be named are the shortlist's, the chosen one first: as places only, with
    // no counts and no word on who fully accepts which.
    const listed = result.options!.map((o) => o.proposal.restaurantId);
    expect(listed[0]).toBe(result.proposal!.restaurantId);
    expect(listed.length).toBeLessThanOrEqual(SHORTLIST);
    expect(Object.keys(result.places).sort()).toEqual([...listed].sort());
    for (const o of result.options!) expect(Object.keys(o)).toEqual(["proposal"]);

    // The row itself, and what each member reads back, carry nothing more.
    const row = await storedRow(event.id);
    expect(row).not.toMatch(VERDICTS);
    expect(row).not.toMatch(/Alice|Bob|buckets|nash/);
    expect(JSON.parse(row)).toEqual(result);
    expect(await getResult(event.id, bob.id)).toEqual(result);

    const html = card(result);
    expect(html).toContain(result.places[result.proposal!.restaurantId].name);
    expect(html).toMatch(/\d+ rounds?, 2 people/);
    expect(html).toContain("stays hidden");
    expect(html).not.toMatch(VERDICTS);
    expect(html).not.toMatch(DIM_WORDS);
    expect(html).not.toMatch(/How they decided|Round \d|concession|bucket|dimension name/i);
    expect(html).not.toMatch(/Alice|Bob/);
  });

  it("says only that there is no plan when the two cannot agree, not what the sticking point is", async () => {
    const { event, users } = await plan({
      Alice: `${ANY_WEEKEND}, up to $80`,
      Bob: `${ANY_WEEKEND}, $5 max`,
    });
    const result = await runNegotiation(event.id, users[0].id);
    expect(result).toMatchObject({ status: "no_deal", detail: "outcome", proposal: null, conflicts: [], places: {} });

    const row = await storedRow(event.id);
    expect(row).not.toMatch(VERDICTS);
    expect(row).not.toMatch(DIM_WORDS);

    const html = card(result);
    expect(html).toContain("No plan works for everyone yet");
    expect(html).not.toContain("sticking point");
    expect(html).not.toMatch(VERDICTS);
    expect(html).not.toMatch(DIM_WORDS);
  });

  it("hides the details of a two-person result stored before this rule existed", async () => {
    const { event, users } = await plan({ Alice: `${ANY_WEEKEND}, up to $80`, Bob: `${ANY_WEEKEND}, $20 max` });
    const old = {
      status: "compromise",
      proposal: { restaurantId: "olive-tree-mezze", slot: "sat_dinner" },
      tally: { accept: 1, reluctant: 1, reject: 0, dims: { price: 1 }, rejectDims: {} },
      rounds: [
        {
          round: 1,
          level: 0,
          proposals: [
            {
              proposal: { restaurantId: "sakura-table", slot: "sat_dinner" },
              tally: { accept: 1, reluctant: 0, reject: 1, dims: {}, rejectDims: { price: 1 } },
            },
          ],
        },
      ],
      concessionLevel: 1,
      finalists: [
        {
          proposal: { restaurantId: "olive-tree-mezze", slot: "sat_dinner" },
          tally: { accept: 1, reluctant: 1, reject: 0, dims: { price: 1 }, rejectDims: {} },
          buckets: [5, 3],
          nash: 15,
          min: 3,
        },
      ],
      reservations: [{ member: 1, dim: "price" }],
      conflicts: [],
      leakedDims: 2,
      participants: 2,
      memberNames: ["Alice", "Bob"],
      places: {
        "olive-tree-mezze": { name: "Olive Tree Mezze", cuisine: "mediterranean", pricePerPerson: 27, travelMin: 11 },
        "sakura-table": { name: "Sakura Table", cuisine: "japanese", pricePerPerson: 45, travelMin: 10 },
      },
      decidedAt: 1,
    };
    const client = await db();
    await client.execute({
      sql: "UPDATE events SET result_json = ?, decided_at = 1 WHERE id = ?",
      args: [JSON.stringify(old), event.id],
    });

    const read = (await getResult(event.id, users[0].id))!;
    expect(read).toMatchObject({ status: "compromise", detail: "outcome", roundCount: 1, tally: null, rounds: [] });
    expect(Object.keys(read.places)).toEqual(["olive-tree-mezze"]);
    const seen = JSON.stringify(read);
    expect(seen).not.toMatch(VERDICTS);
    expect(seen).not.toMatch(/Sakura|Alice|Bob|buckets/);
    expect(card(read)).not.toMatch(/reservations|Sakura|Bob/);
  });
});

describe("plans of three or more are unchanged", () => {
  it("keeps the round log, the counts and the dimension names", async () => {
    const { event, users } = await plan({
      Alice: `${ANY_WEEKEND}, up to $80`,
      Bob: `${ANY_WEEKEND}, $20 max`,
      Cara: `${ANY_WEEKEND}, up to $60`,
    });
    const result = await runNegotiation(event.id, users[0].id);
    expect(result.participants).toBe(MIN_GROUP_FOR_DETAIL);
    expect(result.detail).toBe("full");
    expect(result.rounds.length).toBe(result.roundCount);
    expect(result.rounds.length).toBeGreaterThan(0);
    expect(result.memberNames).toEqual(["Alice", "Bob", "Cara"]);
    expect(result.tally).not.toBeNull();
    expect(result.leakedDims).toBeGreaterThan(0);
    expect(JSON.parse(await storedRow(event.id))).toEqual(result);
    expect(await getResult(event.id, users[2].id)).toEqual(result);

    const html = card(result);
    expect(html).toContain("How they decided");
    // The shortlist: the plan on top, the other options under it, each a place nobody rejected.
    expect(result.options![0].proposal).toEqual(result.proposal);
    expect(result.options!.length).toBeGreaterThan(1);
    expect(html).toMatch(/Best fit above · \d more that works? for the group/);
    for (const o of result.options!) {
      expect(html).toContain(result.places[o.proposal.restaurantId].name);
      expect(typeof o.everyoneIn).toBe("boolean");
    }
    expect(html).toContain("Round 1");
    expect(html).toMatch(/1× reject · price/);
    expect(html).not.toContain("stays hidden");
    // The finalists are shown by how they compare with the pick, never by anyone's score (#15).
    expect(result.finalists.length).toBeGreaterThan(0);
    expect(html).toContain("group score relative to the pick");
    expect(html).toContain(">pick<");
    expect(html).not.toMatch(/buckets \d/);
    expect(JSON.stringify(result)).not.toMatch(/"buckets"|"nash"/);
  });
});

describe("forGroupSize", () => {
  const full = (participants: number): StoredResult => ({
    status: "agreed",
    proposal: { restaurantId: "x", slot: "sat_dinner" },
    tally: { accept: participants, reluctant: 0, reject: 0, dims: {}, rejectDims: {} },
    rounds: [{ round: 1, level: 0, proposals: [] }],
    concessionLevel: 0,
    finalists: [],
    reservations: [],
    conflicts: [],
    leakedDims: 3,
    participants,
    memberNames: Array.from({ length: participants }, (_, i) => `P${i}`),
    places: {
      x: { name: "X", cuisine: "thai", pricePerPerson: 20, travelMin: 5 },
      y: { name: "Y", cuisine: "thai", pricePerPerson: 30, travelMin: 5 },
    },
    decidedAt: 1,
    detail: "full",
    roundCount: 1,
  });

  it("draws the line at three people", () => {
    expect(forGroupSize(full(1)).detail).toBe("outcome");
    expect(forGroupSize(full(2)).detail).toBe("outcome");
    expect(forGroupSize(full(3))).toEqual(full(3));
    expect(forGroupSize(full(6))).toEqual(full(6));
  });

  it("is safe to apply twice", () => {
    const once = forGroupSize(full(2));
    expect(forGroupSize(once)).toEqual(once);
    expect(Object.keys(once.places)).toEqual(["x"]);
  });
});
