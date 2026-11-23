import { describe, expect, it } from "vitest";
import { NOTHING_OFF_LIMITS, applyAssistantOutput, type AssistantOutput } from "@/lib/assistant";
import { RUBRIC } from "@/lib/assistant-prompt";
import { emptyMemberState, type MemberState } from "@/lib/member-state";

/**
 * Confirming "there is nothing I can't eat" (#157). In the November 16 user test the model
 * answered a bare "No" to the diet question with "You can't eat anything restricted", which
 * reads as the opposite. The model is a stub here: this is the part code decides.
 */

const out = (update: Record<string, unknown>, extra: Partial<AssistantOutput> = {}): AssistantOutput => ({
  reply: "Noted.",
  onTopic: true,
  asks: "none",
  update,
  ...extra,
});
const state = (chat: Partial<MemberState["chat"]> = {}): MemberState => {
  const empty = emptyMemberState();
  return { ...empty, chat: { ...empty.chat, ...chat } };
};
const apply = (s: MemberState, o: AssistantOutput) => applyAssistantOutput(s, o, [], "");

describe("confirming that there is nothing they cannot eat (#157)", () => {
  it("answers a bare no in code's words, whatever the model wrote", () => {
    const asked = state({ asked: ["diet"], lastAsked: "diet" });
    for (const reply of [
      "Got it. You can't eat anything restricted.",
      "Understood, nothing restricted for you.",
      "Okay! No restrictions noted, I'll keep that in mind for the group.",
    ]) {
      const res = apply(asked, out({ nothingTheyCannotEat: true }, { reply }));
      expect(res.reply).toBe(NOTHING_OFF_LIMITS);
      expect(res.state.chat.answered).toContain("diet");
    }
  });

  it("keeps the model's next question", () => {
    const res = apply(
      state({ lastAsked: "diet" }),
      out(
        { nothingTheyCannotEat: true },
        { reply: "Got it. You can't eat anything restricted. How far would you travel?", asks: "travel" },
      ),
    );
    expect(res.reply).toBe(`${NOTHING_OFF_LIMITS} How far would you travel?`);
  });

  it("in a longer message, replaces only a sentence that reads the wrong way round", () => {
    const fine = "Got it: after 7 PM, up to $40, and nothing is off limits for you.";
    expect(apply(state(), out({ nothingTheyCannotEat: true, budget: { max: 40 } }, { reply: fine })).reply).toBe(fine);

    const res = apply(
      state(),
      out(
        { nothingTheyCannotEat: true, budget: { max: 40 } },
        { reply: "Got it: up to $40. You cannot eat anything restricted. What time works?", asks: "time" },
      ),
    );
    expect(res.reply).toBe(`Got it: up to $40. ${NOTHING_OFF_LIMITS} What time works?`);
    expect(res.reply).not.toMatch(/can(no|')t eat anything/i);
  });

  it("leaves a reply in Chinese as the model wrote it", () => {
    const reply = "好的，你没有忌口。";
    expect(apply(state(), out({ nothingTheyCannotEat: true }, { reply })).reply).toBe(reply);
  });

  it("does not touch a reply about something they really cannot eat", () => {
    const reply = "Got it: vegetarian.";
    const res = apply(state(), out({ dietary: ["vegetarian"], saidWhatTheyCannotEat: true }, { reply }));
    expect(res.reply).toBe(reply);
  });
});

describe("what the model is told", () => {
  it("is given the words to use, and the ones to avoid", () => {
    expect(RUBRIC).toContain("there's nothing you can't eat");
    expect(RUBRIC).toContain("which reads as the opposite");
  });
});
