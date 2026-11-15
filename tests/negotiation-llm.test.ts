import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeAgent, maskGroup } from "@/lib/agent";
import { agentPrompt, guard, llmJudge, maxTokensFor } from "@/lib/agent-llm";
import { createUser } from "@/lib/auth";
import { compile } from "@/lib/preferences";
import { emptyConstraints, type Constraints } from "@/lib/constraints";
import { db, resetDbForTests } from "@/lib/db";
import {
  createEvent,
  joinEvent,
  LLM_NEGOTIATION_MS,
  llmGate,
  runNegotiation,
  sendMessage,
  setReady,
} from "@/lib/events";
import { llmExplainer, REVEALING } from "@/lib/mediator-llm";
import { negotiate } from "@/lib/negotiate";
import { LIMITS, rateKey } from "@/lib/ratelimit";
import { RESTAURANTS, getRestaurant } from "@/lib/restaurants";

type Call = { tool: string; system: string; user: string };

/**
 * A fake Anthropic API: answers by tool name and records every request.
 * `judge` decides each agent verdict; the mediator takes the first ids / finalist 0.
 */
function fakeAnthropic(judge: (option: Record<string, unknown>) => string = () => "accept") {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    const tool = body.tools[0].name as string;
    const user = body.messages[0].content as string;
    calls.push({ tool, system: body.system, user });
    let input: unknown;
    if (tool === "judge_options") {
      const { options } = JSON.parse(user);
      input = { verdicts: options.map((o: Record<string, unknown>) => ({ id: o.id, verdict: judge(o) })) };
    } else if (tool === "pick") {
      const k = Number(/Pick exactly (\d+)/.exec(body.system)?.[1] ?? 5);
      input = { ids: Array.from({ length: k }, (_, i) => i) };
    } else {
      input = { explanation: "A relaxed Saturday dinner that suits the group's budget." };
    }
    return Response.json({ content: [{ type: "tool_use", input }] });
  });
  vi.stubGlobal("fetch", fetchMock);
  process.env.ANTHROPIC_API_KEY = "test-key-not-real";
  return { calls, fetchMock };
}

beforeEach(async () => {
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.SETTLE_LLM_NEGOTIATION;
  await resetDbForTests();
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.SETTLE_LLM_NEGOTIATION;
});

const person = (over: Partial<Constraints>): Constraints => ({
  ...emptyConstraints(),
  availableSlots: ["18:00", "20:00", "12:00", "13:00", "19:00"],
  budgetMax: 40,
  budgetFlex: 0,
  maxTravelMin: 30,
  dietaryConfirmed: true,
  ...over,
});

describe("the LLM agent's guardrails (guard)", () => {
  const prefs = compile(person({ budgetMax: 20 }));
  const cheap = RESTAURANTS.find((r) => r.pricePerPerson <= 20 && r.open.includes("18:00"))!;
  const pricey = RESTAURANTS.find((r) => r.pricePerPerson > 30 && r.open.includes("18:00"))!;
  const proposals = [
    { restaurantId: cheap.id, slot: "18:00" as const },
    { restaurantId: pricey.id, slot: "18:00" as const },
  ];
  const rs = [cheap, pricey];

  it("a hard rule always wins: the model accepting something over budget becomes a price reject", () => {
    const out = {
      verdicts: [
        { id: 0, verdict: "accept" },
        { id: 1, verdict: "accept" },
      ],
    };
    expect(guard(prefs, proposals, rs, 0, out)).toEqual([{ verdict: "accept" }, { verdict: "reject", dim: "price" }]);
  });

  it("keeps the model's own judgement where no hard rule is broken (e.g. an allergy note)", () => {
    const out = {
      verdicts: [
        { id: 0, verdict: "reject", dim: "diet" },
        { id: 1, verdict: "accept" },
      ],
    };
    expect(guard(prefs, proposals, rs, 0, out)[0]).toEqual({ verdict: "reject", dim: "diet" });
  });

  it("falls back to the code verdict for a missing id, and for malformed output", () => {
    const code = proposals.map((p, i) => makeAgent(prefs, () => rs[i]).judge(p, 0));
    expect(guard(prefs, proposals, rs, 0, { verdicts: [] })).toEqual(code);
    expect(guard(prefs, proposals, rs, 0, "not json")).toEqual(code);
    expect(guard(prefs, proposals, rs, 0, { verdicts: [{ id: 0, verdict: "maybe" }] })).toEqual(code);
  });

  it("drops a dimension on accept and an unknown dimension", () => {
    const out = { verdicts: [{ id: 0, verdict: "accept", dim: "price" }] };
    expect(guard(prefs, proposals.slice(0, 1), rs.slice(0, 1), 0, out)).toEqual([{ verdict: "accept" }]);
  });
});

describe("llmJudge", () => {
  const c = person({ avoidNotes: ["allergic to peanuts"] });
  const prefs = compile(c);
  const about = ["Budget: up to $40/person", "Avoids: allergic to peanuts"];
  const ps = RESTAURANTS.slice(0, 5).map((r) => ({ restaurantId: r.id, slot: r.open[0] }));

  it("judges a whole round in ONE call, with this person's words and public facts only", async () => {
    const { calls } = fakeAnthropic();
    const out = await llmJudge({ apiKey: "k", about, prefs, resolve: (p) => getRestaurant(p.restaurantId) })(ps, 0);
    expect(out).toHaveLength(5);
    expect(calls).toHaveLength(1);
    expect(calls[0].user).toContain("allergic to peanuts");
    expect(JSON.parse(calls[0].user).options).toHaveLength(5);
  });

  it("uses the code verdicts without calling the model when the budget is spent", async () => {
    const { calls } = fakeAnthropic(() => "reject");
    const judge = llmJudge({
      apiKey: "k",
      about,
      prefs,
      resolve: (p) => getRestaurant(p.restaurantId),
      budget: async () => false,
    });
    const code = ps.map((p) => makeAgent(prefs).judge(p, 0));
    expect(await judge(ps, 0)).toEqual(code);
    expect(calls).toHaveLength(0);
  });

  it("uses the code verdicts when the call fails or times out", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("timeout");
      }),
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    const judge = llmJudge({ apiKey: "k", about, prefs, resolve: (p) => getRestaurant(p.restaurantId) });
    expect(await judge(ps, 0)).toEqual(ps.map((p) => makeAgent(prefs).judge(p, 0)));
  });

  it("tells the model which dimensions it was asked to concede on", () => {
    const user = JSON.parse(
      agentPrompt(
        about,
        prefs,
        ps,
        ps.map((p) => getRestaurant(p.restaurantId)),
        1,
      ),
    );
    expect(user.askedToBeMoreFlexibleAbout).toEqual(["cuisine"]); // default concession order starts with cuisine
  });
});

describe("the final pick: code decides, the LLM only explains", () => {
  const three = () => maskGroup([person({}), person({}), person({})].map((c) => makeAgent(compile(c))));

  it("the plan is exactly the code's pick, whatever the explainer says", async () => {
    const agents = three();
    const code = await negotiate(agents, { maxRounds: 3 });
    const explained = await negotiate(agents, {
      maxRounds: 3,
      explainer: async () => "Pick the last finalist instead!",
    });
    expect(explained.proposal).toEqual(code.proposal);
    expect(explained.finalists).toEqual(code.finalists);
    expect(explained.explanation).toBe("Pick the last finalist instead!");
  });

  it("the explainer sees only the chosen plan", async () => {
    const agents = three();
    const seen: unknown[] = [];
    const r = await negotiate(agents, { maxRounds: 3, explainer: async (p) => (seen.push(p), "ok") });
    expect(seen).toEqual([r.proposal]);
  });

  it("no sentence on a failure or an empty answer, and the plan is unchanged", async () => {
    const agents = three();
    const code = await negotiate(agents, { maxRounds: 3 });
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (const explainer of [
      async () => null,
      async () => "   ",
      async () => {
        throw new Error("down");
      },
    ]) {
      const r = await negotiate(agents, { maxRounds: 3, explainer });
      expect(r.proposal).toEqual(code.proposal);
      expect(r.explanation).toBeUndefined();
    }
  });

  it("drops a group sentence that hints at individual answers, and sends only public facts", async () => {
    for (const bad of [
      "Someone was reluctant about price, but",
      "Two of you voted for it",
      "Everyone but one person agreed",
    ])
      expect(REVEALING.test(bad), bad).toBe(true);
    expect(REVEALING.test("A relaxed Saturday dinner close to campus.")).toBe(false);

    const bodies: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(String(init.body));
        return Response.json({
          content: [{ type: "tool_use", input: { explanation: "Someone was reluctant, but it's cheap." } }],
        });
      }),
    );
    const plan = { restaurantId: RESTAURANTS[0].id, slot: RESTAURANTS[0].open[0] };
    expect(await llmExplainer("k", getRestaurant)(plan)).toBeNull();
    const user = JSON.parse(JSON.parse(bodies[0]).messages[0].content);
    expect(Object.keys(user.plan).sort()).toEqual([
      "cuisine",
      "name",
      "pricePerPerson",
      "travelMinFromPlanLocation",
      "when",
    ]);
  });
});

describe("a whole negotiation in LLM mode (runNegotiation)", () => {
  let n = 0;
  async function readyGroup(messages: string[]) {
    const users = await Promise.all(
      messages.map((_, i) =>
        createUser({ email: `p${i}-${n++}@test.dev`, displayName: `P${i}`, password: "password123" }),
      ),
    );
    const event = await createEvent(users[0].id, "Dinner");
    for (const u of users.slice(1)) await joinEvent(event.inviteCode, u.id);
    // The chat runs on the rule-based path (no key yet); the negotiation is what's under test.
    for (const [i, u] of users.entries()) {
      await sendMessage(event.id, u.id, messages[i]);
      await setReady(event.id, u.id, true);
    }
    return { users, event };
  }

  const ALEX = "Saturday dinner or Sunday lunch, under $47, up to 29 minutes, no restrictions";
  const BLAKE = "I'm free all day, max $53 per person, 33 minutes, I'm allergic to peanuts";
  const CASEY = "Sunday lunch or Saturday dinner, under $41, 25 minutes, I can't eat mushrooms";

  it("keeps everyone's words out of everyone else's prompt and out of the mediator's", async () => {
    const { users, event } = await readyGroup([ALEX, BLAKE, CASEY]);
    const { calls } = fakeAnthropic();
    const result = await runNegotiation(event.id, users[0].id);
    expect(result.status).not.toBe("no_deal");

    const agentCalls = calls.filter((c) => c.tool === "judge_options");
    const mediatorCalls = calls.filter((c) => c.tool !== "judge_options");
    expect(agentCalls.length).toBeGreaterThan(0);
    expect(mediatorCalls.length).toBeGreaterThan(0);
    // Each agent prompt mentions exactly one person's private note (or none, for Alex).
    for (const c of agentCalls) {
      const notes = ["peanuts", "mushrooms"].filter((w) => c.user.includes(w));
      expect(notes.length, c.user).toBeLessThanOrEqual(1);
      const budgets = ["up to $47/person", "up to $53/person", "up to $41/person"].filter((b) => c.user.includes(b));
      expect(budgets, c.user).toHaveLength(1);
    }
    for (const c of mediatorCalls) {
      expect(c.user).not.toMatch(/peanut|mushroom|up to \$|P0|P1|P2/);
    }
    // The group sees the mediator's sentence (3+ people).
    expect(result.explanation).toBe("A relaxed Saturday dinner that suits the group's budget.");
  });

  it("makes a bounded number of calls: one per person per round, plus the mediator", async () => {
    const { users, event } = await readyGroup([ALEX, BLAKE, CASEY]);
    const { calls } = fakeAnthropic();
    const result = await runNegotiation(event.id, users[0].id);
    const rounds = result.rounds.length;
    const agentCalls = calls.filter((c) => c.tool === "judge_options").length;
    expect(agentCalls).toBeLessThanOrEqual(3 * (rounds + 1));
    expect(calls.filter((c) => c.tool === "pick").length).toBeLessThanOrEqual(rounds);
    expect(calls.filter((c) => c.tool === "explain_plan").length).toBeLessThanOrEqual(1);
    // ...and every one of them was counted against the plan's daily LLM budget.
    const { rows } = await (
      await db()
    ).execute({ sql: "SELECT count FROM rate_limits WHERE key = ?", args: [rateKey.llm(event.id)] });
    expect(Number(rows[0].count)).toBe(calls.length);
  });

  it("an LLM agent can never accept what breaks a hard rule, whatever the model says", async () => {
    const { users, event } = await readyGroup([
      "Saturday dinner only, under $15, up to 29 minutes, no restrictions",
      BLAKE,
    ]);
    fakeAnthropic(() => "accept"); // a model that accepts everything
    const result = await runNegotiation(event.id, users[0].id);
    const place = result.proposal ? RESTAURANTS.find((r) => r.id === result.proposal!.restaurantId) : undefined;
    if (place) {
      expect(place.pricePerPerson).toBeLessThanOrEqual(15);
      expect(["17:00", "18:00", "19:00", "20:00"]).toContain(result.proposal!.slot);
    } else {
      expect(result.status).toBe("no_deal");
    }
  });

  it("falls back to code entirely once the plan's LLM budget is spent", async () => {
    const { users, event } = await readyGroup([ALEX, BLAKE]);
    await (
      await db()
    ).execute({
      sql: "INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, ?)",
      args: [rateKey.llm(event.id), Date.now(), LIMITS.llmPerPlan.max],
    });
    const { calls } = fakeAnthropic();
    const result = await runNegotiation(event.id, users[0].id);
    expect(calls).toHaveLength(0);
    expect(result.status).not.toBe("no_deal");
  });

  it("SETTLE_LLM_NEGOTIATION=0 switches back to the code-only negotiation", async () => {
    const { users, event } = await readyGroup([ALEX, BLAKE]);
    const { calls } = fakeAnthropic();
    process.env.SETTLE_LLM_NEGOTIATION = "0";
    await runNegotiation(event.id, users[0].id);
    expect(calls).toHaveLength(0);
  });
});

describe("a failed or partial model call never turns a rejection into agreement (review of #57)", () => {
  /**
   * Alice's agent is an LLM that rejects every option for her peanut allergy, which the code agent
   * cannot see. `fail(n)` says whether call n returns 529; `keep` truncates each reply's verdicts.
   */
  function aliceWith(fail: (n: number) => boolean, keep = Infinity) {
    let n = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        n++;
        if (fail(n)) return new Response("overloaded", { status: 529 });
        const { options } = JSON.parse(JSON.parse(String(init.body)).messages[0].content);
        const verdicts = options
          .slice(0, keep)
          .map((o: { id: number }) => ({ id: o.id, verdict: "reject", dim: "diet" }));
        return Response.json({ content: [{ type: "tool_use", input: { verdicts } }] });
      }),
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    const prefs = compile(person({ avoidNotes: ["allergic to peanuts"] }));
    const alice = makeAgent(prefs);
    alice.judgeAll = llmJudge({
      apiKey: "k",
      about: ["Avoids: allergic to peanuts"],
      prefs,
      resolve: (p) => getRestaurant(p.restaurantId),
      codeSeesAll: false,
    });
    const bob = makeAgent(compile(person({})));
    return maskGroup([alice, bob]);
  }

  it("baseline: every call answered → no plan", async () => {
    expect((await negotiate(aliceWith(() => false))).status).toBe("no_deal");
  });

  it("the last call (the final re-check) fails → still no plan", async () => {
    expect((await negotiate(aliceWith((n) => n === 7))).status).toBe("no_deal");
  });

  it("every reply cut short after 12 verdicts → still no plan", async () => {
    expect((await negotiate(aliceWith(() => false, 12))).status).toBe("no_deal");
  });

  it("one failed call mid-way does not make that round's options unanimous", async () => {
    for (const bad of [1, 2, 3]) {
      const r = await negotiate(aliceWith((n) => n === bad));
      expect(r.status, `call ${bad} failed`).toBe("no_deal");
    }
  });

  it("with the model down entirely, an option is never 'everyone's in' for someone whose notes code can't check", async () => {
    const r = await negotiate(aliceWith(() => true));
    expect(r.status).not.toBe("agreed");
  });
});

describe("the negotiation's LLM time limit", () => {
  it("stops starting LLM calls after the deadline, without counting them", async () => {
    let t = 1_000;
    const gate = llmGate("plan-1", 2_000, () => t);
    expect(await gate()).toBe(true);
    t = 2_000;
    expect(await gate()).toBe(false);
    const { rows } = await (
      await db()
    ).execute({ sql: "SELECT count FROM rate_limits WHERE key = ?", args: [rateKey.llm("plan-1")] });
    expect(Number(rows[0].count)).toBe(1);
  });

  it("leaves room under the route's 60 s limit for one more 12 s proposer call and one agent call", () => {
    expect(LLM_NEGOTIATION_MS + 2 * 12_000).toBeLessThan(60_000);
  });
});

describe("replies cut off at the token limit", () => {
  it("are treated as partial: nothing in them is trusted as a fresh 'accept'", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const { options } = JSON.parse(JSON.parse(String(init.body)).messages[0].content);
        const verdicts = options.map((o: { id: number }) => ({ id: o.id, verdict: "accept" }));
        return Response.json({ content: [{ type: "tool_use", input: { verdicts } }], stop_reason: "max_tokens" });
      }),
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    const prefs = compile(person({ avoidNotes: ["allergic to peanuts"] }));
    const ps = RESTAURANTS.slice(0, 3).map((r) => ({ restaurantId: r.id, slot: r.open[0] }));
    const judge = llmJudge({
      apiKey: "k",
      about: [],
      prefs,
      resolve: (p) => getRestaurant(p.restaurantId),
      codeSeesAll: false,
    });
    const out = await judge(ps, 0);
    expect(out.some((j) => j.verdict === "accept")).toBe(false);
  });

  it("asks for enough tokens for the whole batch", () => {
    expect(maxTokensFor(5)).toBeGreaterThanOrEqual(5 * 40);
    expect(maxTokensFor(30)).toBeGreaterThanOrEqual(30 * 40);
  });
});

describe("an option asked again after a concession (#64)", () => {
  const c = person({});
  const prefs = compile({ ...c, concessionOrder: ["cuisine", "travel", "budget"] });
  const ps = RESTAURANTS.slice(0, 4).map((r) => ({ restaurantId: r.id, slot: r.open[0] }));
  const judgeWith = () => llmJudge({ apiKey: "k", about: [], prefs, resolve: (p) => getRestaurant(p.restaurantId) });

  it("an accept stands without another call", async () => {
    const { calls } = fakeAnthropic();
    const judge = judgeWith();
    const first = await judge(ps, 0);
    expect(calls).toHaveLength(1);
    expect(await judge(ps, 1)).toEqual(first);
    expect(calls).toHaveLength(1);
  });

  it("an objection is asked again only once the thing objected to has been loosened", async () => {
    // Every option comes back "reluctant: price".
    const calls: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        calls.push(init.body);
        const { options } = JSON.parse(JSON.parse(String(init.body)).messages[0].content);
        const verdicts = options.map((o: { id: number }) => ({ id: o.id, verdict: "reluctant", dim: "price" }));
        return Response.json({ content: [{ type: "tool_use", input: { verdicts } }] });
      }),
    );
    const judge = judgeWith();
    const first = await judge(ps, 0);
    if (!first.some((j) => j.verdict === "reluctant" && j.dim === "price")) return; // guard overrode every answer
    const n = calls.length;
    // Levels 1 and 2 loosen cuisine, then travel: nothing to do with price.
    await judge(ps, 1);
    await judge(ps, 2);
    expect(calls).toHaveLength(n);
    // Level 3 loosens budget: now it is worth asking.
    await judge(ps, 3);
    expect(calls.length).toBeGreaterThan(n);
  });
});
