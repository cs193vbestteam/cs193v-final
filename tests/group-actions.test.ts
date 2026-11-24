// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NegotiateButton } from "@/components/GroupActions";
import { runNegotiationAction } from "@/app/actions";

vi.mock("@/app/actions", () => ({ runNegotiationAction: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: vi.fn() }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  vi.clearAllMocks();
});

async function render(readyCount: number, memberCount: number, decided = false) {
  if (!container) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  }
  await act(async () =>
    root!.render(
      createElement(NegotiateButton, {
        eventId: "event-1",
        inviteCode: "invite-1",
        readyCount,
        memberCount,
        decided,
      }),
    ),
  );
  return container.querySelector("button")!;
}

describe("group negotiation readiness", () => {
  it("offers nothing to press with two ready members while a third is still chatting", async () => {
    // The plan page says what is awaited; a button that cannot be pressed is not shown.
    expect(await render(2, 3)).toBeNull();
    expect(runNegotiationAction).not.toHaveBeenCalled();
  });

  it("enables the action once the last member is ready", async () => {
    vi.mocked(runNegotiationAction).mockResolvedValue({});
    await render(2, 3);
    const button = await render(3, 3);
    expect(button.disabled).toBe(false);
    expect(container!.textContent).not.toContain("Waiting for everyone");
    await act(async () => button.click());
    expect(runNegotiationAction).toHaveBeenCalledWith("event-1", "invite-1");
  });

  it("offers nothing to press on a one-person plan, even when that person is ready", async () => {
    expect(await render(1, 1)).toBeNull();
  });

  it("disables reruns when a participant is no longer ready", async () => {
    expect((await render(3, 3, true)).disabled).toBe(false);
    const button = await render(2, 3, true);
    expect(button.textContent).toBe("Re-run with latest info");
    expect(button.disabled).toBe(true);
  });
});
