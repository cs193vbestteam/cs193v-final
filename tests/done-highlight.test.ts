// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PrivateChat } from "@/components/PrivateChat";
import type { MissingField } from "@/lib/constraints";
import type { ChatTurn } from "@/lib/extract";

vi.mock("@/app/actions", () => ({
  sendMessageAction: vi.fn(),
  setReadyAction: vi.fn(async () => ({})),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: () => {} });

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  root = undefined;
});

const ASKS_TO_FINISH = "Got it. That's everything I need. Otherwise hit \"I'm done\".";

async function render(props: { messages: ChatTurn[]; missing: MissingField[]; ready: boolean }) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      createElement(PrivateChat, {
        eventId: "event-1",
        inviteCode: "invite-1",
        initialMessages: props.messages,
        initialSummary: [],
        initialMissing: props.missing,
        ready: props.ready,
      }),
    ),
  );
  return [...container.querySelectorAll("button")].find((b) => /I'm done|Not done yet/.test(b.textContent ?? ""))!;
}

describe('D. highlighting "I\'m done"', () => {
  it("glows when the assistant has asked the person to click it", async () => {
    const button = await render({
      messages: [{ role: "assistant", content: ASKS_TO_FINISH }],
      missing: [],
      ready: false,
    });
    expect(button.textContent).toBe("I'm done");
    expect(button.className).toContain("btn-attention");
    expect(button.disabled).toBe(false);
  });

  it("stays plain while there are still questions", async () => {
    const asking = await render({
      messages: [{ role: "assistant", content: "Last one. If something has to give, what goes first?" }],
      missing: [],
      ready: false,
    });
    expect(asking.className).not.toContain("btn-attention");
  });

  it("stays plain while essentials are missing, even if the message mentions it", async () => {
    const button = await render({
      messages: [{ role: "assistant", content: ASKS_TO_FINISH }],
      missing: ["budget"],
      ready: false,
    });
    expect(button.className).not.toContain("btn-attention");
  });

  it("stops glowing once they are done", async () => {
    const button = await render({
      messages: [{ role: "assistant", content: ASKS_TO_FINISH }],
      missing: [],
      ready: true,
    });
    expect(button.textContent).toBe("Not done yet");
    expect(button.className).not.toContain("btn-attention");
  });

  it("respects reduced motion: the pulse is switched off and only the outline remains", async () => {
    const { readFileSync } = await import("node:fs");
    const css = readFileSync("src/app/globals.css", "utf8");
    const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reduced).toMatch(/\.btn-attention\s*\{\s*animation:\s*none;/);
  });
});
