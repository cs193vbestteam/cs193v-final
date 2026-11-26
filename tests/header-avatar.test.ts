// @vitest-environment jsdom
import { act, createElement, Fragment } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HeaderAvatar, PlanAvatar } from "@/components/HeaderAvatar";

vi.mock("next/image", () => ({
  default: (props: Record<string, unknown>) => createElement("img", { "data-avatar": props["data-avatar"] }),
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  root = container = undefined;
});

async function render(inPlan?: "panda") {
  if (!container) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  }
  await act(async () =>
    root!.render(
      createElement(
        Fragment,
        null,
        createElement(HeaderAvatar, { name: "frog" }),
        inPlan ? createElement(PlanAvatar, { name: inPlan }) : null,
      ),
    ),
  );
  return container.querySelector("img")!.getAttribute("data-avatar");
}

describe("the animal in the header", () => {
  it("is the person's own outside a plan", async () => {
    expect(await render()).toBe("frog");
  });

  it("is the one the group list shows while a plan is open, and their own again after", async () => {
    // Two people landed on the frog; this one was moved to the panda in the plan.
    expect(await render("panda")).toBe("panda");
    expect(await render()).toBe("frog");
  });
});
