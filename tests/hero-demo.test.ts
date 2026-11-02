// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEMO_RESULT, DEMO_THREAD, HeroDemo } from "@/components/HeroDemo";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("HeroDemo", () => {
  it("renders every thread message with a stagger index and the final plan", async () => {
    await act(async () => root.render(createElement(HeroDemo)));
    const items = container.querySelectorAll("li.demo-msg");
    expect(items).toHaveLength(DEMO_THREAD.length);
    items.forEach((li, i) => {
      expect((li as HTMLElement).style.getPropertyValue("--i")).toBe(String(i));
      expect(li.textContent).toContain(DEMO_THREAD[i].text);
    });
    const result = container.querySelector(".demo-result")!;
    expect(result.textContent).toContain(DEMO_RESULT.where);
    expect(result.textContent).toContain(DEMO_RESULT.when);
    expect(result.textContent).toContain(DEMO_RESULT.cost);
  });

  it("never shows a person's private numbers in the group thread", async () => {
    await act(async () => root.render(createElement(HeroDemo)));
    const thread = container.querySelector("ol")!.textContent ?? "";
    expect(thread).not.toMatch(/\$\d/);
    expect(DEMO_THREAD.some((m) => /whatever works/i.test(m.text))).toBe(true);
  });

  it("marks the one external link so it reads as noise, not content", async () => {
    await act(async () => root.render(createElement(HeroDemo)));
    const links = DEMO_THREAD.filter((m) => m.link);
    expect(links).toHaveLength(1);
    const underlined = container.querySelectorAll("li.demo-msg .underline");
    expect(underlined).toHaveLength(1);
    expect(underlined[0].textContent).toBe(links[0].text);
  });
});
