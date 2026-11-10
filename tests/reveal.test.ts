// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Reveal } from "@/components/Reveal";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

type Callback = (entries: Partial<IntersectionObserverEntry>[]) => void;
let root: Root;
let container: HTMLDivElement;
let callbacks: Callback[];
let observe: ReturnType<typeof vi.fn>;
let disconnect: ReturnType<typeof vi.fn>;

function installObserver() {
  callbacks = [];
  observe = vi.fn();
  disconnect = vi.fn();
  class FakeIO {
    constructor(cb: Callback) {
      callbacks.push(cb);
    }
    observe = observe;
    disconnect = disconnect;
    unobserve = vi.fn();
    takeRecords = () => [];
  }
  Object.defineProperty(globalThis, "IntersectionObserver", { configurable: true, writable: true, value: FakeIO });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  Reflect.deleteProperty(globalThis, "IntersectionObserver");
});

// Reveal requires children in its props type, so pass them as a prop here.
const render = async (props: Partial<Parameters<typeof Reveal>[0]> = {}) => {
  // eslint-disable-next-line react/no-children-prop
  await act(async () => root.render(createElement(Reveal, { children: "hello", ...props })));
  return container.firstElementChild as HTMLElement;
};

describe("Reveal", () => {
  it("starts hidden, reveals once on intersection, then stops observing", async () => {
    installObserver();
    const el = await render({ delay: 0.3 });
    expect(el.classList.contains("reveal")).toBe(true);
    expect(el.classList.contains("is-in")).toBe(false);
    expect(el.style.getPropertyValue("--d")).toBe("0.3s");
    expect(observe).toHaveBeenCalledWith(el);

    await act(async () => callbacks[0]([{ isIntersecting: false }]));
    expect(el.classList.contains("is-in")).toBe(false);
    await act(async () => callbacks[0]([{ isIntersecting: true }]));
    expect(el.classList.contains("is-in")).toBe(true);
    expect(disconnect).toHaveBeenCalled();
  });

  it("renders visible immediately when IntersectionObserver is unavailable", async () => {
    const el = await render();
    expect(el.classList.contains("is-in")).toBe(true);
  });

  it("supports a custom tag and extra classes", async () => {
    installObserver();
    const el = await render({ as: "section", className: "card" });
    expect(el.tagName).toBe("SECTION");
    expect(el.classList.contains("card")).toBe(true);
    expect(el.textContent).toBe("hello");
  });

  it("disconnects the observer on unmount", async () => {
    installObserver();
    await render();
    await act(async () => root.unmount());
    expect(disconnect).toHaveBeenCalled();
    root = createRoot(container); // afterEach unmounts again
  });
});
