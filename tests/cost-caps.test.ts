import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createUser } from "@/lib/auth";
import { resetDbForTests } from "@/lib/db";
import {
  createEvent,
  deleteAccount,
  joinEvent,
  RateLimitError,
  runNegotiation,
  sendMessage,
  setReady,
} from "@/lib/events";
import { LIMITS } from "@/lib/ratelimit";
import {
  canSpend,
  costMicros,
  GLOBAL_PAYER,
  globalMonthlyCap,
  monthOf,
  perUserMonthlyCap,
  recordSpend,
  spentThisMonth,
} from "@/lib/spend";

const USAGE = { input_tokens: 1000, output_tokens: 100 }; // 1000 × $0.10/M + 100 × $0.50/M = $0.00015

/** A fake Anthropic API that answers every tool and reports `USAGE` on each reply. */
function fakeAnthropic() {
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    const tool = body.tools[0].name as string;
    let input: unknown;
    if (tool === "judge_options") {
      const { options } = JSON.parse(body.messages[0].content);
      input = { verdicts: options.map((o: { id: number }) => ({ id: o.id, verdict: "accept" })) };
    } else if (tool === "pick") {
      input = { ids: [0, 1, 2] };
    } else if (tool === "explain_plan") {
      input = { explanation: "A relaxed dinner." };
    } else {
      input = { reply: "Got it, Saturday dinner.", onTopic: true, asks: "none", update: {} };
    }
    return Response.json({ content: [{ type: "tool_use", input }], usage: USAGE });
  });
  vi.stubGlobal("fetch", fetchMock);
  process.env.ANTHROPIC_API_KEY = "test-key-not-real";
  return fetchMock;
}

beforeEach(async () => {
  delete process.env.ANTHROPIC_API_KEY;
  await resetDbForTests();
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.LLM_MONTHLY_CAP_PER_USER_USD;
  delete process.env.LLM_MONTHLY_CAP_TOTAL_USD;
});

let n = 0;
const makeUser = (name: string) =>
  createUser({ email: `${name}${n++}@test.dev`, displayName: name, password: "password123" });

describe("plans per person per day", () => {
  it("allows the daily number of plans, then refuses the next with a friendly error", async () => {
    const a = await makeUser("Alice");
    for (let i = 0; i < LIMITS.createPlanPerUser.max; i++) await createEvent(a.id, `Dinner ${i}`);
    await expect(createEvent(a.id, "One too many")).rejects.toThrow(RateLimitError);
    await expect(createEvent(a.id, "One too many")).rejects.toThrow(/plans today/);
    // Someone else still can.
    const b = await makeUser("Blake");
    await expect(createEvent(b.id, "Lunch")).resolves.toBeTruthy();
  });

  it("a form with a bad title does not use up one of the day's plans", async () => {
    const a = await makeUser("Alice");
    await expect(createEvent(a.id, "")).rejects.toThrow();
    for (let i = 0; i < LIMITS.createPlanPerUser.max; i++) await createEvent(a.id, `Dinner ${i}`);
  });
});

describe("what a call costs", () => {
  it("prices input and output tokens separately, in millionths of a dollar", () => {
    expect(costMicros({ input_tokens: 1_000_000 })).toBe(100_000); // $0.10
    expect(costMicros({ output_tokens: 1_000_000 })).toBe(500_000); // $0.50
    expect(costMicros(USAGE)).toBe(150);
    expect(costMicros(undefined)).toBe(0);
  });

  it("defaults to $10 a person and $10 in total per month", () => {
    expect(perUserMonthlyCap()).toBe(10);
    expect(globalMonthlyCap()).toBe(10);
  });

  it("a new month starts from zero", async () => {
    const t = Date.UTC(2026, 10, 15);
    await recordSpend("u1", 10_000_000, t);
    expect(await canSpend("u1", t)).toBe(false);
    expect(await canSpend("u1", Date.UTC(2026, 11, 1))).toBe(true);
    expect(monthOf(t)).toBe("2026-11");
  });
});

describe("who pays", () => {
  it("your chat is charged to you, not to the plan's creator", async () => {
    const a = await makeUser("Alice");
    const b = await makeUser("Blake");
    const e = await createEvent(a.id, "Dinner");
    await joinEvent(e.inviteCode, b.id);
    fakeAnthropic();
    await sendMessage(e.id, b.id, "Saturday dinner works");
    expect(await spentThisMonth(b.id)).toBeCloseTo(0.00015);
    expect(await spentThisMonth(a.id)).toBe(0);
    expect(await spentThisMonth(GLOBAL_PAYER)).toBeCloseTo(0.00015);
  });

  it("the negotiation is charged to the plan's creator, whoever starts it", async () => {
    const a = await makeUser("Alice");
    const b = await makeUser("Blake");
    const e = await createEvent(a.id, "Dinner");
    await joinEvent(e.inviteCode, b.id);
    await sendMessage(e.id, a.id, "Saturday dinner, under $50, 30 minutes, no restrictions");
    await sendMessage(e.id, b.id, "Saturday dinner, under $50, 30 minutes, no restrictions");
    await setReady(e.id, a.id, true);
    await setReady(e.id, b.id, true);
    const fetchMock = fakeAnthropic();
    await runNegotiation(e.id, b.id);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(0);
    expect(await spentThisMonth(a.id)).toBeCloseTo(0.00015 * fetchMock.mock.calls.length);
    expect(await spentThisMonth(b.id)).toBe(0);
  });
});

describe("when a cap is reached, the rules answer instead of the model", () => {
  it("your own cap: your chat stops calling the model, other people's doesn't", async () => {
    const a = await makeUser("Alice");
    const b = await makeUser("Blake");
    const e = await createEvent(a.id, "Dinner");
    await joinEvent(e.inviteCode, b.id);
    process.env.LLM_MONTHLY_CAP_TOTAL_USD = "100";
    await recordSpend(a.id, perUserMonthlyCap() * 1e6);
    const fetchMock = fakeAnthropic();
    const { messages } = await sendMessage(e.id, a.id, "Saturday dinner works");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(messages.at(-1)?.role).toBe("assistant");
    await sendMessage(e.id, b.id, "Saturday dinner works");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("the app's total cap: nobody's chat calls the model", async () => {
    const a = await makeUser("Alice");
    const e = await createEvent(a.id, "Dinner");
    await recordSpend("someone-else", globalMonthlyCap() * 1e6);
    const fetchMock = fakeAnthropic();
    await sendMessage(e.id, a.id, "Saturday dinner works");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("the creator's cap: the negotiation runs on code alone and still finds a plan", async () => {
    const a = await makeUser("Alice");
    const b = await makeUser("Blake");
    const e = await createEvent(a.id, "Dinner");
    await joinEvent(e.inviteCode, b.id);
    await sendMessage(e.id, a.id, "Saturday dinner, under $50, 30 minutes, no restrictions");
    await sendMessage(e.id, b.id, "Saturday dinner, under $50, 30 minutes, no restrictions");
    await setReady(e.id, a.id, true);
    await setReady(e.id, b.id, true);
    process.env.LLM_MONTHLY_CAP_TOTAL_USD = "100";
    await recordSpend(a.id, perUserMonthlyCap() * 1e6);
    const fetchMock = fakeAnthropic();
    const result = await runNegotiation(e.id, b.id);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.status).not.toBe("no_deal");
  });
});

describe("deleting an account", () => {
  it("removes the person's spending row but keeps the app's total", async () => {
    const a = await makeUser("Alice");
    await recordSpend(a.id, 500);
    await deleteAccount(a.id);
    expect(await spentThisMonth(a.id)).toBe(0);
    expect(await spentThisMonth(GLOBAL_PAYER)).toBeCloseTo(0.0005);
  });
});
