// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setReadyAction } from "@/app/actions";
import { PrivateChat } from "@/components/PrivateChat";
import type { MissingField } from "@/lib/constraints";

/**
 * After "I'm done" (#153). In the November 16 user test the button was hard to find, "Not done yet"
 * was not read as a way to go back, and nothing said what happened next.
 */

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

type Next = { text: string; href?: string; link?: string } | null;

async function render(props: { ready: boolean; missing?: MissingField[]; next?: Next }) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      createElement(PrivateChat, {
        eventId: "event-1",
        inviteCode: "invite-1",
        initialMessages: [{ role: "assistant", content: "Hi" }],
        initialSummary: ["Budget: up to $40/person"],
        initialMissing: props.missing ?? [],
        ready: props.ready,
        next: props.next ?? null,
      }),
    ),
  );
  return container;
}

const button = (el: HTMLElement, name: string) =>
  [...el.querySelectorAll("button")].find((b) => b.textContent === name);

describe("finishing, and what comes after", () => {
  it("puts the way to finish between the conversation and the message box, not under the summary", async () => {
    const el = await render({ ready: false });
    const done = button(el, "I'm done")!;
    const log = el.querySelector('[role="log"]')!;
    const message = el.querySelector('input[aria-label="Message your assistant"]')!;
    const summary = [...el.querySelectorAll("div")].find((d) => d.textContent === "What your assistant knows")!;
    const after = (a: Node, b: Node) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(after(log, done)).toBe(true);
    expect(after(done, message)).toBe(true);
    expect(after(done, summary)).toBe(true);
  });

  it("says what is still missing next to the button it holds back", async () => {
    const el = await render({ ready: false, missing: ["budget", "time"] });
    expect(el.textContent).toContain("Still needs: budget, when");
    expect(button(el, "I'm done")!.disabled).toBe(true);
  });

  it("tells someone who is done that their part is over, and what the group is waiting for", async () => {
    const el = await render({
      ready: true,
      next: { text: "Waiting for 2 other people to finish. The plan will appear on this page by itself." },
    });
    const status = el.querySelector('[role="status"]')!;
    expect(status.textContent).toContain("Your part is done.");
    expect(status.textContent).toContain("Waiting for 2 other people to finish.");
    expect(el.textContent).not.toContain("All set");
  });

  it("links to where the next step is", async () => {
    const el = await render({ ready: true, next: { text: "The plan is ready.", href: "#plan", link: "See the plan" } });
    const link = el.querySelector('[role="status"] a')!;
    expect(link.textContent).toBe("See the plan");
    expect(link.getAttribute("href")).toBe("#plan");
  });

  it('offers going back as "Change my answers", and returns to the message box', async () => {
    const el = await render({ ready: true });
    expect(el.textContent).not.toContain("Not done yet");
    const change = button(el, "Change my answers")!;
    await act(async () => change.click());
    expect(setReadyAction).toHaveBeenCalledWith("event-1", "invite-1", false);
    expect(document.activeElement).toBe(el.querySelector('input[aria-label="Message your assistant"]'));
  });
});
