// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfirmAction, PlanDangerZone } from "@/components/DangerActions";
import { deletePlanAction, leavePlanAction } from "@/app/actions";

vi.mock("@/app/actions", () => ({
  deletePlanAction: vi.fn(),
  leavePlanAction: vi.fn(),
  deleteAccountAction: vi.fn(),
}));
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

async function mount(element: React.ReactElement) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(element));
  return container;
}

const button = (name: string) =>
  [...container!.querySelectorAll("button")].find((b) => b.textContent?.trim() === name) as
    HTMLButtonElement | undefined;
const click = (name: string) => act(async () => button(name)!.click());

function confirmAction(action = vi.fn().mockResolvedValue({})) {
  return {
    action,
    element: createElement(ConfirmAction, {
      label: "Delete this plan",
      title: "Delete the plan?",
      consequences: ["The plan and its result", "Everyone's private chat"],
      confirmLabel: "Delete plan",
      action,
    }),
  };
}

describe("ConfirmAction", () => {
  it("does nothing on the first click except explain what will be removed", async () => {
    const { action, element } = confirmAction();
    await mount(element);
    expect(button("Delete plan")).toBeUndefined();

    await click("Delete this plan");
    expect(action).not.toHaveBeenCalled();
    expect(container!.textContent).toContain("The plan and its result");
    expect(container!.textContent).toContain("Everyone's private chat");
    expect(container!.textContent).toContain("This cannot be undone.");
    expect(button("Delete this plan")!.getAttribute("aria-expanded")).toBe("true");
    // Focus lands on the safe choice, not the destructive one.
    expect(document.activeElement).toBe(button("Cancel"));
  });

  it("runs the action only on the explicit confirm", async () => {
    const { action, element } = confirmAction();
    await mount(element);
    await click("Delete this plan");
    await click("Delete plan");
    expect(action).toHaveBeenCalledTimes(1);
  });

  it("cancel closes the panel without acting and returns focus to the trigger", async () => {
    const { action, element } = confirmAction();
    await mount(element);
    await click("Delete this plan");
    await click("Cancel");
    expect(action).not.toHaveBeenCalled();
    expect(button("Delete plan")).toBeUndefined();
    expect(document.activeElement).toBe(button("Delete this plan"));
  });

  it("Escape cancels", async () => {
    const { action, element } = confirmAction();
    await mount(element);
    await click("Delete this plan");
    await act(async () => {
      button("Cancel")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(action).not.toHaveBeenCalled();
    expect(button("Delete plan")).toBeUndefined();
    expect(document.activeElement).toBe(button("Delete this plan"));
  });

  it("shows the server's error and keeps the panel open", async () => {
    const { element } = confirmAction(
      vi.fn().mockResolvedValue({ error: "Only the person who created this plan can delete it" }),
    );
    await mount(element);
    await click("Delete this plan");
    await click("Delete plan");
    expect(container!.querySelector('[role="alert"]')!.textContent).toBe(
      "Only the person who created this plan can delete it",
    );
    expect(button("Delete plan")).toBeDefined();
  });
});

describe("PlanDangerZone", () => {
  const props = { eventId: "event-1", inviteCode: "invite-1", title: "Weekend dinner" };

  it("offers a creator who is alone delete only: leaving would delete the plan anyway", async () => {
    vi.mocked(deletePlanAction).mockResolvedValue({});
    await mount(createElement(PlanDangerZone, { ...props, isCreator: true }));
    expect(button("Leave this plan")).toBeUndefined();
    await click("Delete this plan");
    expect(container!.textContent).toContain("Every member's private chat and constraints");
    await click("Delete plan");
    expect(deletePlanAction).toHaveBeenCalledWith("event-1", "invite-1");
    expect(leavePlanAction).not.toHaveBeenCalled();
  });

  it("lets a creator with other members leave, and says who the plan passes to", async () => {
    vi.mocked(leavePlanAction).mockResolvedValue({});
    await mount(createElement(PlanDangerZone, { ...props, isCreator: true, nextOwner: "Blake" }));
    expect(button("Delete this plan")).toBeDefined();
    await click("Leave this plan");
    expect(container!.textContent).toContain("The plan stays for the others and passes to Blake");
    await click("Leave plan");
    expect(leavePlanAction).toHaveBeenCalledWith("event-1", "invite-1");
    expect(deletePlanAction).not.toHaveBeenCalled();
  });

  it("does not mention a hand-over to members who are not the creator", async () => {
    await mount(createElement(PlanDangerZone, { ...props, isCreator: false, nextOwner: "Blake" }));
    await click("Leave this plan");
    expect(container!.textContent).not.toContain("passes to");
  });

  it("offers everyone else leave, not delete", async () => {
    vi.mocked(leavePlanAction).mockResolvedValue({});
    await mount(createElement(PlanDangerZone, { ...props, isCreator: false }));
    expect(button("Delete this plan")).toBeUndefined();
    await click("Leave this plan");
    expect(container!.textContent).toContain("Your private chat and constraints for this plan");
    await click("Leave plan");
    expect(leavePlanAction).toHaveBeenCalledWith("event-1", "invite-1");
    expect(deletePlanAction).not.toHaveBeenCalled();
  });
});
