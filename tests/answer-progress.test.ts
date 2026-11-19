// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PrivateChat } from "@/components/PrivateChat";
import { answerProgress, emptyMemberState, missingRequired, type AnswerStep } from "@/lib/member-state";

/**
 * The bar above "I'm done": five questions, which are answered, and which two are needed.
 * It is there so a person can tell whether they have finished answering without reading the chat back.
 */

vi.mock("@/app/actions", () => ({ sendMessageAction: vi.fn(), setReadyAction: vi.fn(async () => ({})) }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: () => {} });

describe("answerProgress", () => {
  it("starts with nothing answered and two of the five needed", () => {
    const steps = answerProgress(emptyMemberState());
    expect(steps.map((s) => s.label)).toEqual(["When", "Budget", "Distance", "Diet", "Food"]);
    expect(steps.filter((s) => s.required).map((s) => s.topic)).toEqual(["time", "diet"]);
    expect(steps.some((s) => s.done)).toBe(false);
  });

  it("agrees with what holds back the button", () => {
    const state = emptyMemberState();
    state.chat.answered = ["time"];
    const undone = answerProgress(state)
      .filter((s) => s.required && !s.done)
      .map((s) => s.topic);
    expect(undone).toEqual(missingRequired(state));
    state.chat.answered = ["time", "diet"];
    expect(answerProgress(state).filter((s) => s.required && !s.done)).toEqual([]);
    expect(missingRequired(state)).toEqual([]);
  });

  it("marks the question the assistant asked last, until it is answered", () => {
    const state = emptyMemberState();
    expect(answerProgress(state).some((s) => s.asking)).toBe(false);
    state.chat.lastAsked = "budget";
    expect(
      answerProgress(state)
        .filter((s) => s.asking)
        .map((s) => s.topic),
    ).toEqual(["budget"]);
    state.prefs.budget = { max: 30, strength: "strong" };
    expect(answerProgress(state).some((s) => s.asking)).toBe(false);
  });

  it("counts a budget the person brought up without being asked", () => {
    const state = emptyMemberState();
    state.prefs.budget = { max: 30, strength: "strong" };
    expect(answerProgress(state).find((s) => s.topic === "budget")?.done).toBe(true);
  });
});

describe("the bar in the chat", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;
  afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    container?.remove();
    root = undefined;
  });

  const steps = (done: string[]): AnswerStep[] =>
    answerProgress(emptyMemberState()).map((s) => ({ ...s, done: done.includes(s.topic) }));

  async function render(progress: AnswerStep[], ready = false) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () =>
      root!.render(
        createElement(PrivateChat, {
          eventId: "event-1",
          inviteCode: "invite-1",
          initialMessages: [{ role: "assistant", content: "Hi" }],
          initialSummary: [],
          initialMissing: progress.filter((s) => s.required && !s.done).map((s) => s.topic as "time" | "diet"),
          initialProgress: progress,
          ready,
        }),
      ),
    );
    return container;
  }

  it("says how many are answered and, in words, which are still needed", async () => {
    const el = await render(steps(["time", "budget"]));
    expect(el.textContent).toContain("2 of 5 answered");
    const items = [...el.querySelectorAll("ol[aria-labelledby='answers-label'] li")];
    expect(items).toHaveLength(5);
    expect(items[0].textContent).toContain("When: answered");
    expect(items[3].textContent).toContain("Diet: needed before you can finish");
    expect(items[4].textContent).toContain("Food: optional, not answered");
    expect(el.textContent).toContain("Still needs: what you can't eat");
  });

  it("says the rest is optional once the needed two are in, and stops saying so when all five are", async () => {
    const some = await render(steps(["time", "diet"]));
    expect(some.textContent).toContain("All set ✓ The rest is optional");
    await act(async () => root!.unmount());
    some.remove();
    const all = await render(steps(["time", "budget", "travel", "diet", "cuisine"]));
    expect(all.textContent).toContain("5 of 5 answered");
    expect(all.textContent).not.toContain("optional");
  });

  const quickAnswers = (el: HTMLElement) =>
    [...el.querySelectorAll("[aria-label='Quick answers'] button")].map((b) => b.textContent);

  it("offers answers to the question the assistant is asking, not to the first unanswered one", async () => {
    const el = await render(steps([]).map((s) => ({ ...s, asking: s.topic === "budget" })));
    expect(el.querySelector("[aria-label='Quick answers']")?.textContent).toContain("Budget?");
    expect(quickAnswers(el)).toEqual(["Around $30", "Up to $50", "No budget limit"]);
    const chips = [...el.querySelectorAll("ol[aria-labelledby='answers-label'] button")];
    expect(chips[1].textContent).toContain("Budget: the assistant is asking this now");
    expect(chips.map((c) => c.getAttribute("aria-pressed"))).toEqual(["false", "true", "false", "false", "false"]);
  });

  it("after an open question, offers one answer for each thing still unanswered", async () => {
    const el = await render(steps(["time"]));
    expect(quickAnswers(el)).toEqual(["Around $30", "15 minutes at most", "Nothing I can't eat", "Thai"]);
  });

  it("shows another question's answers when the person presses that question", async () => {
    const el = await render(steps([]).map((s) => ({ ...s, asking: s.topic === "budget" })));
    const diet = el.querySelectorAll<HTMLButtonElement>("ol[aria-labelledby='answers-label'] button")[3];
    await act(async () => diet.click());
    expect(quickAnswers(el)).toEqual(["Nothing I can't eat", "Vegetarian", "No spicy food"]);
  });

  it("leaves what Anthropic keeps to the privacy page", async () => {
    const el = await render(steps([]));
    expect(el.textContent).not.toContain("retention");
  });

  it("is put away once the person is done", async () => {
    const el = await render(steps(["time", "diet"]), true);
    expect(el.querySelector("ol[aria-labelledby='answers-label']")).toBeNull();
    expect(el.textContent).toContain("Your part is done.");
  });
});
