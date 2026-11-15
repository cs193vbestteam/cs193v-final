import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { createUser } from "@/lib/auth";
import { toLegacyConstraints } from "@/lib/legacy-adapter";
import { describeState, emptyMemberState, missingRequired, type MemberState } from "@/lib/member-state";
import { db, resetDbForTests } from "@/lib/db";
import { createEvent, getEventByCode, getMyMessages, joinEvent, listMyEvents, sendMessage } from "@/lib/events";
import { OPENING_MESSAGE } from "@/lib/extract-rules";
import { compile } from "@/lib/preferences";
import { RESTAURANTS } from "@/lib/restaurants";
import { DEFAULT_SCENARIO, SCENARIOS, parseScenarioId, scenarioFor, type ScenarioId } from "@/lib/scenario";

beforeEach(() => {
  delete process.env.ANTHROPIC_API_KEY; // use the deterministic rule-based extractor
  delete process.env.GOOGLE_PLACES_API_KEY;
  resetDbForTests();
});

let n = 0;
const makeUser = (name: string) =>
  createUser({ email: `${name}-scenario${n++}@test.dev`, displayName: name, password: "password123" });

describe("scenario registry", () => {
  it("has a definition for every scenario id, and the default is one of them", () => {
    for (const id of SCENARIOS) expect(scenarioFor(id).id).toBe(id);
    expect(SCENARIOS).toContain(DEFAULT_SCENARIO);
  });

  it("reads anything unrecognised on a plan row as the default", () => {
    expect(parseScenarioId("meal")).toBe("meal");
    for (const raw of [null, undefined, "", "hotel", 3]) expect(parseScenarioId(raw)).toBe(DEFAULT_SCENARIO);
  });
});

describe("the meal scenario is the existing behaviour, unchanged", () => {
  const meal = scenarioFor("meal");

  it("uses the same opening message, empty constraints, seed pool and compile", () => {
    expect(meal.openingMessage).toBe(OPENING_MESSAGE);
    expect(meal.emptyConstraints()).toEqual(emptyMemberState());
    expect(meal.seedPool).toBe(RESTAURANTS);
    const state: MemberState = {
      ...emptyMemberState(),
      prefs: { version: 1, budget: { max: 30, strength: "must" }, travel: { maxMin: 20, strength: "must" } },
    };
    // The engine still reads the older format, through the transitional adapter.
    expect(meal.compile(state)).toEqual(compile(toLegacyConstraints(state)));
    expect(meal.missingFields(state)).toEqual(missingRequired(state));
    expect(meal.describeConstraints(state)).toEqual(describeState(state));
  });

  it("rejects stored constraints that do not fit its schema", () => {
    expect(() => meal.parseConstraints({ budgetMax: "cheap" })).toThrow(ZodError);
  });

  it("falls back to the seed pool without a location", async () => {
    expect(await meal.resolvePool(null, "2026-11-21")).toMatchObject({ source: "seed" });
  });

  it("keeps the current constraints when a chat turn changes nothing", async () => {
    const current = emptyMemberState();
    const { reply, constraints, changed } = await meal.chatTurn(
      [{ role: "user", content: "hello" }],
      current,
      RESTAURANTS,
    );
    expect(reply.length).toBeGreaterThan(0);
    expect(constraints.prefs).toEqual(current.prefs);
    expect(changed).toBe(false);
  });
});

describe("plans carry their scenario", () => {
  it("stores the default scenario and returns it everywhere a plan is read", async () => {
    const a = await makeUser("Alice");
    const e = await createEvent(a.id, "Dinner");
    expect(e.scenario).toBe("meal");
    expect((await getEventByCode(e.inviteCode))?.scenario).toBe("meal");
    expect((await listMyEvents(a.id))[0].scenario).toBe("meal");
    const client = await db();
    const { rows } = await client.execute({ sql: "SELECT scenario FROM events WHERE id = ?", args: [e.id] });
    expect(rows[0].scenario).toBe("meal");
  });

  it("refuses an unknown scenario and creates nothing", async () => {
    const a = await makeUser("Alice");
    await expect(createEvent(a.id, "Trip", null, "hotel" as ScenarioId)).rejects.toThrow(ZodError);
    expect(await listMyEvents(a.id)).toHaveLength(0);
  });

  it("greets a joining member with the scenario's opening message and reports the scenario from the chat", async () => {
    const a = await makeUser("Alice");
    const b = await makeUser("Bob");
    const e = await createEvent(a.id, "Dinner");
    await joinEvent(e.inviteCode, b.id);
    expect((await getMyMessages(e.id, b.id))[0].content).toBe(scenarioFor("meal").openingMessage);
    const turn = await sendMessage(e.id, b.id, "Saturday dinner, under $30");
    expect(turn.scenario).toBe("meal");
    expect(turn.constraints.prefs.budget?.max).toBe(30);
  });
});

/**
 * The point of the seam: a second scenario is added in scenario.ts and nowhere
 * else. So the engine must not know scenarios exist, and the data layer must
 * reach a scenario's modules only through the registry.
 */
describe("where scenario-specific code may live", () => {
  const read = (file: string) => readFileSync(path.resolve(__dirname, "../src/lib", `${file}.ts`), "utf8");
  const importsOf = (file: string) =>
    [...read(file).matchAll(/^\s*import\s+(type\s+)?[^'"]*['"]\.\/([^'"]+)['"]/gm)].map((m) => ({
      typeOnly: Boolean(m[1]),
      module: m[2],
    }));

  it.each(["negotiate", "mediator", "mediator-llm", "evaluate", "agent", "preferences"])(
    "%s.ts does not import the scenario registry",
    (file) => {
      expect(importsOf(file).map((i) => i.module)).not.toEqual(expect.arrayContaining(["scenario"]));
      expect(read(file)).not.toMatch(/scenario/i);
    },
  );

  it.each(["events", "vault", "pool"])("%s.ts reaches chat, candidates and compile only through a scenario", (file) => {
    const direct = importsOf(file)
      .filter((i) => !i.typeOnly)
      .map((i) => i.module);
    for (const mod of [
      "constraints",
      "extract",
      "extract-rules",
      "places",
      "yelp-pool",
      "preferences",
      "start-point",
      "restaurants",
    ])
      expect(direct, `${file}.ts imports ./${mod} directly`).not.toContain(mod);
  });
});

describe("features added since the seam still go through it", () => {
  it("passes the plan's LLM budget to the scenario's chat turn", async () => {
    // With the LLM not allowed, the turn must answer from the rules even when a key is present.
    process.env.ANTHROPIC_API_KEY = "test-key-not-real";
    const calls: unknown[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (...args: unknown[]) => {
      calls.push(args);
      throw new Error("the LLM must not be called");
    }) as typeof fetch;
    try {
      const { constraints } = await scenarioFor("meal").chatTurn(
        [{ role: "user", content: "Saturday dinner, under $30" }],
        emptyMemberState(),
        RESTAURANTS,
        { allowLLM: false },
      );
      expect(constraints.prefs.budget?.max).toBe(30);
      expect(calls).toHaveLength(0);
    } finally {
      globalThis.fetch = realFetch;
      delete process.env.ANTHROPIC_API_KEY;
    }
  });
});
