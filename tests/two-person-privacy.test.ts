import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";
import { ResultCard } from "@/components/ResultCard";
import { createUser } from "@/lib/auth";
import { decryptOrPlain, scope } from "@/lib/crypto";
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
  // Stored encrypted with the plan's key (see crypto.ts); what matters here is what is inside.
  return decryptOrPlain(String(rows[0].result_json), scope.plan(eventId, "result"));
}

const card = (result: StoredResult) => renderToStaticMarkup(createElement(ResultCard, { result }));

/** Anything that would tell one member how the other answered. */
const VERDICTS = /reject|reluctant|\baccept\b|rejectDims|"dims"/i;
const DIM_WORDS = /\b(price|budget|timing|distance|diet)\b/i;

const ANY_TIME = "free all day, 30 minutes, no restrictions";

describe("a two-person plan shows the outcome only", () => {
  it("stores and renders the plan and the other places, and nothing about how either person answered", async () => {
    // Bob's ceiling is far under Alice's. The optimizer weighs that; it shows neither of them.
    const { event, users } = await plan({
      Alice: `${ANY_TIME}, up to $80`,
      Bob: `${ANY_TIME}, $20 max`,
    });
    const [alice, bob] = users;
    const result = await runNegotiation(event.id, alice.id);

    expect(result.participants).toBe(2);
    expect(result.detail).toBe("outcome");
    expect(result).toMatchObject({ status: "agreed", engine: "optimizer" });
    expect(result.proposal).not.toBeNull();
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
    // In a pair a count of who can come is the other person's answer: it is not stored at all.
    expect(result).not.toHaveProperty("cannotCome");
    // The places that may be named are the shortlist's, the chosen one first: as places only.
    const listed = result.options!.map((o) => o.proposal.restaurantId);
    expect(listed[0]).toBe(result.proposal!.restaurantId);
    expect(listed.length).toBeLessThanOrEqual(SHORTLIST);
    expect(new Set(listed).size).toBe(listed.length);
    expect(Object.keys(result.places).sort()).toEqual([...listed].sort());
    for (const o of result.options!) expect(Object.keys(o)).toEqual(["proposal"]);

    // The row itself, and what each member reads back, carry nothing more.
    const row = await storedRow(event.id);
    expect(row).not.toMatch(VERDICTS);
    expect(row).not.toMatch(/Alice|Bob|buckets|nash|cannotCome|scores|prefs|\$20|\$80/);
    expect(JSON.parse(row)).toEqual(result);
    expect(await getResult(event.id, bob.id)).toEqual(result);

    const html = card(result);
    expect(html).toContain(result.places[result.proposal!.restaurantId].name);
    expect(html).toContain("Everyone can come");
    expect(html).toMatch(/How it was decided: \d+ options, 2 people, no model/);
    expect(html).not.toMatch(VERDICTS);
    expect(html).not.toMatch(DIM_WORDS);
    expect(html).not.toMatch(/How they decided|Round \d|concession|bucket|dimension name|Works for \d/i);
    expect(html).not.toMatch(/Alice|Bob/);
  });

  it("says only that there is no plan when a hard rule keeps one of the two out, not which or whose", async () => {
    // One can only do lunch and the other only dinner, so every plan leaves one of them out.
    const { event, users } = await plan({
      Alice: "lunch only, 30 minutes, no restrictions, up to $50",
      Bob: "dinner only, 30 minutes, no restrictions, up to $50",
    });
    const result = await runNegotiation(event.id, users[0].id);
    expect(result).toMatchObject({ status: "no_deal", detail: "outcome", proposal: null, conflicts: [], places: {} });
    expect(result).not.toHaveProperty("cannotCome");
    expect(result).not.toHaveProperty("noPlan");
    expect(result).not.toHaveProperty("options");

    // "A plan one of you can come to" is never written down: to each of them it would be about the other.
    const row = await storedRow(event.id);
    expect(row).not.toMatch(VERDICTS);
    expect(row).not.toMatch(DIM_WORDS);
    expect(row).not.toMatch(/partial|cannotCome|nobody_can_come|lunch|dinner/);
    expect(await getResult(event.id, users[1].id)).toEqual(result);

    const html = card(result);
    expect(html).toContain("No plan works for both of you yet");
    expect(html).not.toContain("sticking point");
    expect(html).not.toMatch(VERDICTS);
    expect(html).not.toMatch(DIM_WORDS);
    expect(html).not.toMatch(/Works for \d|one person|lunch|dinner/);
  });

  it("hides the details of a two-person result stored before this rule existed", async () => {
    const { event, users } = await plan({ Alice: `${ANY_TIME}, up to $80`, Bob: `${ANY_TIME}, $20 max` });
    const old = {
      status: "compromise",
      proposal: { restaurantId: "olive-tree-mezze", slot: "18:00" },
      tally: { accept: 1, reluctant: 1, reject: 0, dims: { price: 1 }, rejectDims: {} },
      rounds: [
        {
          round: 1,
          level: 0,
          proposals: [
            {
              proposal: { restaurantId: "sakura-table", slot: "18:00" },
              tally: { accept: 1, reluctant: 0, reject: 1, dims: {}, rejectDims: { price: 1 } },
            },
          ],
        },
      ],
      concessionLevel: 1,
      finalists: [
        {
          proposal: { restaurantId: "olive-tree-mezze", slot: "18:00" },
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

describe("plans of three or more", () => {
  it("say how many can come, and never who or why", async () => {
    // Alice can only do lunch; the other two only dinner. The closest plan leaves one person out.
    const { event, users } = await plan({
      Alice: "lunch only, 30 minutes, no restrictions, up to $50",
      Bob: "dinner only, 30 minutes, no restrictions, up to $50",
      Cara: "dinner only, 30 minutes, no restrictions, up to $60",
    });
    const result = await runNegotiation(event.id, users[0].id);
    expect(result.participants).toBe(MIN_GROUP_FOR_DETAIL);
    expect(result).toMatchObject({ detail: "full", status: "partial", engine: "optimizer", cannotCome: 1 });
    expect(["17:00", "18:00", "19:00", "20:00"]).toContain(result.proposal!.slot);
    // Nothing of the old round log is produced, and no names are stored: there is nobody to name.
    expect(result).toMatchObject({ rounds: [], finalists: [], reservations: [], tally: null, memberNames: [] });
    expect(JSON.parse(await storedRow(event.id))).toEqual(result);
    expect(await getResult(event.id, users[2].id)).toEqual(result);
    expect(await storedRow(event.id)).not.toMatch(/Alice|Bob|Cara|scores|prefs|lunch/);

    const html = card(result);
    expect(html).toContain("Works for 2 of 3");
    expect(html).toContain("one person");
    expect(html).toMatch(/How it was decided: \d+ options, 3 people, no model/);
    expect(html).not.toMatch(/Alice|Bob|Cara|How they decided|Round \d|stays hidden/);
    expect(html).not.toMatch(VERDICTS);
    // The shortlist: the plan on top, the other places under it, each one a different place that
    // as many people can come to.
    expect(result.options![0].proposal).toEqual(result.proposal);
    expect(result.options!.length).toBeGreaterThan(1);
    expect(new Set(result.options!.map((o) => o.proposal.restaurantId)).size).toBe(result.options!.length);
    expect(html).toMatch(/Best fit of \d places that as many people can come to/);
    expect(html).toMatch(/See all \d options/);
    // The pop-out holds one tile per option, the best fit first.
    expect(html.match(/<li class="rounded-xl border p-4/g)).toHaveLength(result.options!.length);
    expect(html).toContain("1 · Best fit");
    for (const o of result.options!) expect(html).toContain(result.places[o.proposal.restaurantId].name);
  });

  it("say that everyone can come when nothing keeps anyone out", async () => {
    const { event, users } = await plan({
      Alice: `${ANY_TIME}, up to $80`,
      Bob: `${ANY_TIME}, $20 max`,
      Cara: `${ANY_TIME}, up to $60`,
    });
    const result = await runNegotiation(event.id, users[0].id);
    expect(result).toMatchObject({ detail: "full", status: "agreed", cannotCome: 0 });
    const html = card(result);
    expect(html).toContain("Everyone can come");
    expect(html).toMatch(/Best fit of \d places that work for the group/);
    expect(html).not.toMatch(/Works for \d of/);
  });
});

describe("forGroupSize", () => {
  const full = (participants: number): StoredResult => ({
    status: "agreed",
    proposal: { restaurantId: "x", slot: "18:00" },
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
