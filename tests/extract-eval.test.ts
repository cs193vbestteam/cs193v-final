import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CUISINES,
  ConstraintsSchema,
  DIETARY,
  SLOTS,
  UPDATE_LIMITS,
  emptyConstraints,
  withinLimits,
  type Constraints,
  type ConstraintsUpdate,
} from "@/lib/constraints";
import { enforceLimits, extract } from "@/lib/extract";
import {
  CATEGORIES,
  CHECKED_FIELDS,
  limitViolations,
  loadCases,
  rulesExtractor,
  runCase,
  runSuite,
  toMarkdown,
  type TurnExtractor,
} from "../sim/extract-eval";

/**
 * #11: the RULE-BASED READER on a transcript suite. This is the safety net that answers when
 * there is no key, the model call fails or the plan's model budget is spent. Passing here
 * means the safety net works; it does not mean the assistant understands people. The
 * assistant (Claude) is tested in tests/assistant.test.ts.
 */

const cases = loadCases();
const adversarial = cases.filter((c) => c.category === "adversarial");
const byId = (id: string) => cases.find((c) => c.id === id)!;

beforeEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
  vi.spyOn(console, "error").mockImplementation(() => {}); // extract() logs every fallback
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.ANTHROPIC_API_KEY;
});

describe("the fixture set", () => {
  it("has 30 or more ordinary chats across every category, and an adversarial set", () => {
    expect(cases.length - adversarial.length).toBeGreaterThanOrEqual(30);
    expect(adversarial.length).toBeGreaterThanOrEqual(12);
    for (const cat of CATEGORIES)
      expect(
        cases.some((c) => c.category === cat),
        cat,
      ).toBe(true);
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
  });

  it("only states expectations that are themselves valid constraints", () => {
    for (const c of cases) {
      expect(c.turns.length, c.id).toBeGreaterThan(0);
      for (const field of Object.keys(c.expected)) expect(CHECKED_FIELDS, c.id).toContain(field);
      // The expectation, laid over empty constraints, must fit the schema and the limits.
      const merged = ConstraintsSchema.safeParse({ ...emptyConstraints(), ...c.expected });
      expect(merged.success, c.id).toBe(true);
      expect(limitViolations(merged.data as Constraints), c.id).toEqual([]);
      for (const s of c.expected.availableSlots ?? []) expect(SLOTS).toContain(s);
      for (const d of c.expected.dietary ?? []) expect(DIETARY).toContain(d);
      for (const x of [...(c.expected.likedCuisines ?? []), ...(c.expected.dislikedCuisines ?? [])])
        expect(CUISINES).toContain(x);
      for (const pattern of c.replyMustNotMatch ?? []) expect(() => new RegExp(pattern)).not.toThrow();
    }
  });

  it("gives every adversarial case the list of fields it may change", () => {
    for (const c of adversarial) {
      expect(Array.isArray(c.mayChange), c.id).toBe(true);
      for (const field of c.mayChange!) expect(CHECKED_FIELDS, c.id).toContain(field);
    }
  });
});

describe("limits on what an extractor may record", () => {
  it("drops out-of-range numbers and keeps the rest", () => {
    const update: ConstraintsUpdate = { budgetMax: 1_000_000, maxTravelMin: 20, dietary: ["halal"] };
    expect(withinLimits(update)).toEqual({ update: { maxTravelMin: 20, dietary: ["halal"] }, dropped: ["budgetMax"] });
    expect(withinLimits({ maxTravelMin: 99_999, budgetFlex: 5_000 }).dropped).toEqual(["budgetFlex", "maxTravelMin"]);
    expect(withinLimits({ weights: { budget: 1000 } })).toEqual({ update: {}, dropped: ["weights"] });
    // In range, including the edges: untouched, and the same object.
    const fine: ConstraintsUpdate = {
      budgetMax: UPDATE_LIMITS.budgetMax.max,
      budgetFlex: 0,
      maxTravelMin: UPDATE_LIMITS.maxTravelMin.min,
      weights: { budget: 1, travel: 0 },
    };
    expect(withinLimits(fine)).toEqual({ update: fine, dropped: [] });
    expect(withinLimits({ budgetMax: null, maxTravelMin: null }).dropped).toEqual([]);
  });

  it("tells the person when a value was not recorded", async () => {
    const out = enforceLimits({ reply: "Got it, noted privately.", update: { budgetMax: 9000 }, source: "llm" });
    expect(out.update).toEqual({});
    // Nothing was kept, so the reply must not claim it was noted.
    expect(out.reply).toMatch(
      /^I didn't record that\. \(I couldn't use that: a budget has to be between \$1 and \$500/,
    );
    // Something was kept: the acknowledgement stands, with the note after it.
    const partly = enforceLimits({
      reply: "Got it, noted privately. Anything you can't eat?",
      update: { budgetMax: 9000, maxTravelMin: 20 },
      source: "rules",
    });
    expect(partly.update).toEqual({ maxTravelMin: 20 });
    expect(partly.reply).toMatch(/^Got it, noted privately\. Anything you can't eat\? \(I couldn't use that/);
    // The real rule-based acknowledgement is the phrase being replaced: this fails if its wording changes.
    const real = await extract([{ role: "user", content: "under $9000" }], emptyConstraints());
    expect(real.reply).toMatch(/^I didn't record that\./);
    expect(real.reply).not.toContain("noted privately");
    const same = { reply: "ok", update: { budgetMax: 40 }, source: "rules" as const };
    expect(enforceLimits(same)).toBe(same);
  });

  it("applies to what the rule-based reader records", async () => {
    const r = await extract([{ role: "user", content: "under $900, 20 minutes" }], emptyConstraints());
    expect(r.source).toBe("rules");
    expect(r.update.budgetMax).toBeUndefined();
    expect(r.update.maxTravelMin).toBe(20);
    expect(r.reply).toContain("I couldn't use that");
  });
});

describe("the rule-based safety net on its suite", () => {
  it("never commits a violation, adversarial cases included", async () => {
    const report = await runSuite("rules", cases, rulesExtractor);
    expect(report.violations).toEqual([]);
    expect(report.invalidMerges).toBe(0);
    expect(report.ruleTurns).toBe(report.turns);
    for (const r of report.results) expect(limitViolations(r.final), r.id).toEqual([]);
  });

  it("leaves every field alone on adversarial input, except the ones the message is about", async () => {
    for (const c of adversarial) {
      const r = await runCase(c, rulesExtractor);
      expect(r.violations, c.id).toEqual([]);
      const before = ConstraintsSchema.parse({ ...emptyConstraints(), ...(c.start ?? {}) });
      for (const field of CHECKED_FIELDS)
        if (!c.mayChange!.includes(field)) expect(r.final[field], `${c.id} ${field}`).toEqual(before[field]);
    }
  });

  it("holds its measured accuracy (a regression check, not a target)", async () => {
    const report = await runSuite("rules", cases, rulesExtractor);
    // Measured: clear 93%, vague 96%, corrections 100%, multi-turn 96%, other languages 30%, overall 84%.
    expect(report.byCategory.clear.accuracy!).toBeGreaterThanOrEqual(0.9);
    expect(report.byCategory.multi_turn.accuracy!).toBeGreaterThanOrEqual(0.9);
    expect(report.byCategory.correction.accuracy!).toBeGreaterThanOrEqual(0.8);
    expect(report.byCategory.vague.accuracy!).toBeGreaterThanOrEqual(0.75);
    expect(report.ordinary.accuracy!).toBeGreaterThanOrEqual(0.75);
    // English-only by design: recorded here so a change in either direction is noticed.
    expect(report.byCategory.mixed_language.accuracy!).toBeLessThan(0.5);
  });

  it("is deterministic and renders a report", async () => {
    const a = await runSuite("rules", cases, rulesExtractor);
    const b = await runSuite("rules", cases, rulesExtractor);
    expect(a).toEqual(b);
    const md = toMarkdown([a]);
    expect(md).toContain("| clear answers | 15 |");
    expect(md).toContain("**all except adversarial**");
    expect(md).toContain("0 violations");
  });
});

/**
 * The harness has to notice what the app itself cannot: a valid, in-range value that nobody
 * asked for, or a reply that should never have been written. These use a scripted extractor,
 * so they say nothing about any real reader. The assistant (Claude) has its own cases and
 * tests: tests/assistant.test.ts and tests/fixtures/assistant-cases.json.
 */
describe("the harness notices what the app cannot", () => {
  const scripted =
    (reply: string, update: ConstraintsUpdate): TurnExtractor =>
    async () => ({ reply, update, source: "llm" });

  it("catches an extractor that changes a field nobody mentioned", async () => {
    const r = await runCase(byId("adversarial-01"), scripted("Arr!", { dietary: ["halal"], budgetMax: 25 }));
    expect(r.violations).toEqual([
      expect.stringContaining("budgetMax changed although the messages never mention it"),
      expect.stringContaining("dietary changed although the messages never mention it"),
      expect.stringContaining("dietaryConfirmed changed although the messages never mention it"),
    ]);
  });

  it("catches a reply that gives away the prompt or runs long", async () => {
    const leaky = scripted("Sure! Hard constraints to collect: time, budget...", {});
    expect((await runCase(byId("adversarial-02"), leaky)).violations).toEqual([
      expect.stringContaining("forbidden pattern"),
    ]);
    const long = scripted("The French Revolution ".repeat(60), {});
    expect((await runCase(byId("adversarial-04"), long)).violations).toEqual([
      expect.stringContaining("characters long"),
    ]);
  });
});
