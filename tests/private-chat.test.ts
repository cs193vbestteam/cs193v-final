// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PrivateChat } from "@/components/PrivateChat";

vi.mock("@/app/actions", () => ({
  sendMessageAction: vi.fn(),
  setReadyAction: vi.fn(),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  root = undefined;
  vi.clearAllMocks();
  vi.restoreAllMocks();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});

describe("PrivateChat auto-scroll", () => {
  it.each(["void", "promise"])("mounts, scrolls after sending, and unmounts when scrollIntoView returns %s", async (returnType) => {
    const scroll = vi.fn(() => returnType === "promise" ? Promise.resolve() : undefined);
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      writable: true,
      value: scroll,
    });
    const { sendMessageAction } = await import("@/app/actions");
    vi.mocked(sendMessageAction).mockResolvedValue({
      messages: [
        { role: "assistant", content: "Hello" },
        { role: "user", content: "Saturday dinner" },
        { role: "assistant", content: "What is your budget?" },
      ],
      summary: [],
      missing: ["budget", "distance", "diet"],
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root!.render(createElement(PrivateChat, {
      eventId: "event-1", inviteCode: "invite-1",
      initialMessages: [{ role: "assistant", content: "Hello" }],
      initialSummary: [], initialMissing: ["time", "budget", "distance", "diet"],
      ready: false,
    })));
    expect(scroll).toHaveBeenCalledWith({ behavior: "smooth", block: "nearest" });
    const initialScrollCount = scroll.mock.calls.length;

    const input = container.querySelector("input")!;
    await act(async () => {
      // Use the native setter so React observes a real input value change.
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Saturday dinner");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      container!.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(sendMessageAction).toHaveBeenCalledWith("event-1", "invite-1", "Saturday dinner");
    expect(container.textContent).toContain("What is your budget?");
    expect(scroll.mock.calls.length).toBeGreaterThan(initialScrollCount);

    await act(async () => root!.unmount());
    root = undefined;
  });
});
