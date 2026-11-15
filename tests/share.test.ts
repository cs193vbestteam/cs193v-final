// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ShareMessage } from "@/components/GroupActions";
import { nudgeMessage, resultMessage } from "@/lib/share";

vi.mock("next/navigation", () => ({ useRouter: vi.fn() }));
vi.mock("@/app/actions", () => ({ runNegotiationAction: vi.fn() }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const url = "http://localhost/e/abc";

describe("messages for the group chat", () => {
  it("the result message names the plan, the time and the link, and nothing else", () => {
    const text = resultMessage({ title: "Saturday dinner", place: "Bibim Bowl", when: "Sat dinner", options: 6, url });
    expect(text).toBe(`Saturday dinner is settled: Sat dinner · Bibim Bowl. See all 6 options: ${url}`);
  });

  it("a single option is called the plan", () => {
    expect(resultMessage({ title: "Dinner", place: "Noodle Lab", when: "Sun lunch", options: 1, url })).toContain(
      "See the plan:",
    );
  });

  it("the nudge gives a count and never a name", () => {
    const text = nudgeMessage({ title: "Saturday dinner", ready: 2, members: 4, url });
    expect(text).toContain("2 of 4 of us are done");
    expect(text.endsWith(url)).toBe(true);
  });
});

describe("ShareMessage", () => {
  const message = `Saturday dinner is settled. ${url}`;
  const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  const writeText = vi.fn<(text: string) => Promise<void>>();
  let root: Root;
  let container: HTMLDivElement;
  const render = async () => {
    await act(async () => root.render(createElement(ShareMessage, { label: "Share with the group", message })));
  };
  const click = async () => {
    await act(async () => container.querySelector("button")!.click());
  };
  const status = () => container.querySelector('[role="status"]')!.textContent;

  beforeEach(() => {
    writeText.mockReset().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    Reflect.deleteProperty(navigator, "share");
    if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
    else Reflect.deleteProperty(navigator, "clipboard");
  });

  it("uses the share sheet where the browser has one", async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "share", { configurable: true, value: share });
    await render();
    await click();
    expect(share).toHaveBeenCalledWith({ text: message });
    expect(writeText).not.toHaveBeenCalled();
  });

  it("closing the share sheet is not treated as a failure", async () => {
    const share = vi.fn().mockRejectedValue(Object.assign(new Error("closed"), { name: "AbortError" }));
    Object.defineProperty(navigator, "share", { configurable: true, value: share });
    await render();
    await click();
    expect(writeText).not.toHaveBeenCalled();
    expect(status()).toBe("");
  });

  it("copies the message when there is no share sheet, and says so", async () => {
    await render();
    await click();
    expect(writeText).toHaveBeenCalledWith(message);
    expect(status()).toContain("Message copied");
  });

  it("shows the message to copy by hand when the clipboard is blocked", async () => {
    writeText.mockRejectedValue(new Error("denied"));
    await render();
    await click();
    expect(status()).toContain("Couldn't copy");
    expect(container.querySelector("textarea")!.value).toBe(message);
  });
});
