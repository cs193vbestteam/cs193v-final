// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setReadyAction } from "@/app/actions";
import { PrivateChat } from "@/components/PrivateChat";

vi.mock("@/app/actions", () => ({ sendMessageAction: vi.fn(), setReadyAction: vi.fn() }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: () => {} });

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  root = undefined;
});

async function pressDone(result: { error?: string; notice?: string }) {
  vi.mocked(setReadyAction).mockResolvedValue(result);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      createElement(PrivateChat, {
        eventId: "event-1",
        inviteCode: "invite-1",
        initialMessages: [],
        initialSummary: [],
        initialMissing: [],
        ready: false,
        lastOne: true,
      }),
    ),
  );
  const done = [...container.querySelectorAll("button")].find((b) => b.textContent === "I'm done")!;
  await act(async () => done.click());
  return container.querySelector('[role="alert"]')?.textContent ?? null;
}

describe("when the automatic run fails", () => {
  it("tells the person who finished last to press Find a plan", async () => {
    const notice =
      "You're marked done, but the plan couldn't be found automatically. Press \"Find a plan\" to try again.";
    expect(await pressDone({ notice })).toBe(notice);
  });

  it("says nothing when the run went through", async () => {
    expect(await pressDone({})).toBeNull();
  });
});
