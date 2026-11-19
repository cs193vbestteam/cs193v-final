// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NotifyToggle, PlanReadyWatcher } from "@/components/NotifyToggle";

/**
 * "Notify me when it's ready": the choice lives in this browser, a refusal is said in words,
 * and the person is told once, when a plan arrives that was not there before.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root;
let container: HTMLDivElement;
const shown: { title: string; body?: string }[] = [];

function fakeNotifications(permission: NotificationPermission, onAsk: NotificationPermission = permission) {
  class Fake {
    static permission = permission;
    static requestPermission = vi.fn(async () => (Fake.permission = onAsk));
    onclick: (() => void) | null = null;
    constructor(title: string, options?: NotificationOptions) {
      shown.push({ title, body: options?.body });
    }
    close() {}
  }
  Object.defineProperty(window, "Notification", { configurable: true, writable: true, value: Fake });
  return Fake;
}

beforeEach(() => {
  shown.length = 0;
  window.localStorage.clear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const button = () => container.querySelector("button")!;
const press = () => act(async () => button().click());
const render = (ready: boolean) =>
  act(async () =>
    root.render(
      createElement("div", null, [
        createElement(PlanReadyWatcher, { key: "w", eventId: "e1", title: "Weekend dinner", ready }),
        ready ? null : createElement(NotifyToggle, { key: "t", eventId: "e1" }),
      ]),
    ),
  );

describe("notify me when the plan is ready", () => {
  it("asks the browser once, then says it is on", async () => {
    const Fake = fakeNotifications("default", "granted");
    await render(false);
    expect(button().getAttribute("aria-pressed")).toBe("false");
    await press();
    expect(Fake.requestPermission).toHaveBeenCalledTimes(1);
    expect(button().getAttribute("aria-pressed")).toBe("true");
    expect(window.localStorage.getItem("settle-notify:e1")).toBe("1");
    await press();
    expect(button().getAttribute("aria-pressed")).toBe("false");
    expect(window.localStorage.getItem("settle-notify:e1")).toBeNull();
  });

  it("says so in words when the browser refuses, and stays off", async () => {
    fakeNotifications("default", "denied");
    await render(false);
    await press();
    expect(button().getAttribute("aria-pressed")).toBe("false");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("blocked");
    expect(window.localStorage.getItem("settle-notify:e1")).toBeNull();
  });

  it("tells the person once when the plan arrives, with nothing but its name", async () => {
    fakeNotifications("granted");
    await render(false);
    await press();
    await render(true);
    expect(shown).toEqual([{ title: "The plan is ready", body: "Weekend dinner" }]);
    expect(window.localStorage.getItem("settle-notify:e1")).toBeNull();
    await render(true);
    expect(shown).toHaveLength(1);
  });

  it("stays quiet for someone who did not ask, and for a plan that was already there", async () => {
    fakeNotifications("granted");
    await render(false);
    await render(true);
    expect(shown).toHaveLength(0);

    await act(async () => root.unmount());
    root = createRoot(container);
    window.localStorage.setItem("settle-notify:e1", "1");
    await render(true);
    expect(shown).toHaveLength(0);
  });
});
