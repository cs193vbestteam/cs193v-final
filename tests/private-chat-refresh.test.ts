// @vitest-environment jsdom
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PrivateChat } from "@/components/PrivateChat";
import { sendMessageAction, type ChatState } from "@/app/actions";

vi.mock("@/app/actions", () => ({ sendMessageAction: vi.fn(), setReadyAction: vi.fn() }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
type Props = ComponentProps<typeof PrivateChat>;
const initial: Props = {
  eventId: "event-1",
  inviteCode: "invite-1",
  ready: false,
  initialMessages: [{ role: "assistant", content: "Hello" }],
  initialSummary: [],
  initialMissing: ["budget"],
};
const response: ChatState = {
  messages: [
    ...initial.initialMessages,
    { role: "user", content: "Under $40" },
    { role: "assistant", content: "Budget saved privately" },
  ],
  summary: ["Budget: up to $40/person"],
  missing: [],
  progress: [],
};
const updated: Props = {
  ...initial,
  initialMessages: response.messages,
  initialSummary: response.summary,
  initialMissing: [],
  ready: true,
};
let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.resetAllMocks();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});
const render = async (props: Props) => {
  await act(async () => root.render(createElement(PrivateChat, props)));
};
const input = () => container.querySelector("input")!;
async function type(value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(), value);
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function submit() {
  await act(async () => {
    container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}
function expectUpdated() {
  expect(container.textContent).toContain("Budget saved privately");
  // Nothing is missing any more: "All set" for someone still chatting, the done note for someone who is done.
  expect(container.textContent).toMatch(/All set ✓|Your part is done\./);
  expect(container.textContent).not.toContain("Still needs: budget");
}

describe("PrivateChat server refresh", () => {
  it("updates messages and missing fields together with readiness", async () => {
    await render(initial);
    await render(updated);
    expectUpdated();
    expect(container.textContent).toContain("Change my answers");
  });

  it("preserves an unsent draft when another tab updates the server snapshot", async () => {
    await render(initial);
    await type("I also prefer Italian");
    await render(updated);
    expectUpdated();
    expect(input().value).toBe("I also prefer Italian");
  });

  it("preserves a pending send, ignores a stale refresh and deduplicates the response", async () => {
    let resolve!: (value: ChatState) => void;
    vi.mocked(sendMessageAction).mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    await render(initial);
    await type("Under $40");
    await submit();
    await type("And no spicy food");
    await render({ ...initial, initialMessages: [...initial.initialMessages] });
    expect(container.textContent).toContain("Under $40");
    expect(container.textContent).toContain("Assistant is thinking");

    await act(async () => resolve(response));
    expectUpdated();
    expect(input().value).toBe("And no spicy food");
    await render({ ...initial, initialMessages: [...initial.initialMessages] });
    expectUpdated();
    await render(updated);
    const userMessages = [...container.querySelectorAll("p")].filter((p) => p.textContent === "Under $40");
    expect(userMessages).toHaveLength(1);
    expect(sendMessageAction).toHaveBeenCalledTimes(1);
  });

  it("uses a newer remote snapshot even if an older local send resolves afterwards", async () => {
    let resolve!: (value: ChatState) => void;
    vi.mocked(sendMessageAction).mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    await render(initial);
    await type("Under $40");
    await submit();
    const newer: Props = {
      ...updated,
      initialMessages: [
        ...response.messages,
        { role: "user", content: "Actually under $30" },
        { role: "assistant", content: "Budget reduced" },
      ],
      initialSummary: ["Budget: up to $30/person"],
    };
    await render(newer);
    await act(async () => resolve(response));
    expect(container.textContent).toContain("Budget reduced");
  });

  it("accepts later server updates after a completed local send", async () => {
    vi.mocked(sendMessageAction).mockResolvedValue(response);
    await render(initial);
    await type("Under $40");
    await submit();
    expectUpdated();
    await render({
      ...updated,
      ready: false,
      initialMessages: [
        ...response.messages,
        { role: "user", content: "Saturday only" },
        { role: "assistant", content: "Saturday saved" },
      ],
      initialSummary: [...response.summary, "Saturday dinner only"],
    });
    expect(container.textContent).toContain("Saturday saved");
    expect(container.textContent).toContain("I'm done");
  });

  it("restores a failed submission without leaving a duplicate optimistic message", async () => {
    vi.mocked(sendMessageAction).mockResolvedValue({ error: "Please try again" });
    await render(initial);
    await type("Under $40");
    await submit();
    expect(input().value).toBe("Under $40");
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Please try again");
    expect([...container.querySelectorAll("p")].some((p) => p.textContent === "Under $40")).toBe(false);
  });

  it("preserves a new draft and refreshed data after a rejected send", async () => {
    let reject!: (reason: Error) => void;
    vi.mocked(sendMessageAction).mockReturnValue(
      new Promise((_, r) => {
        reject = r;
      }),
    );
    await render(initial);
    await type("Under $40");
    await submit();
    await type("And no spicy food");
    await render(updated);
    await act(async () => reject(new Error("Connection lost")));
    expectUpdated();
    expect(input().value).toBe("And no spicy food");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Couldn't send");
  });
});
