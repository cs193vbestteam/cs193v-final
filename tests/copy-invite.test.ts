// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CopyInvite } from "@/components/GroupActions";

vi.mock("next/navigation", () => ({ useRouter: vi.fn() }));
vi.mock("@/app/actions", () => ({ runNegotiationAction: vi.fn() }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const firstUrl = "http://localhost/e/first";
const secondUrl = "http://localhost/e/second";
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
let root: Root;
let container: HTMLDivElement;
let mounted: boolean;
const writeText = vi.fn<(text: string) => Promise<void>>();
function clipboard(value: unknown) {
  Object.defineProperty(navigator, "clipboard", { configurable: true, value });
}
const render = async (url = firstUrl) => {
  await act(async () => root.render(createElement(CopyInvite, { url })));
};
const button = () => container.querySelector("button")!;
const click = async () => {
  await act(async () => button().click());
};
const status = () => container.querySelector('[role="status"]')!.textContent;

beforeEach(() => {
  vi.useFakeTimers();
  writeText.mockReset().mockResolvedValue(undefined);
  clipboard({ writeText });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  mounted = true;
});
afterEach(async () => {
  if (mounted) await act(async () => root.unmount());
  container.remove();
  if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
  else Reflect.deleteProperty(navigator, "clipboard");
  vi.useRealTimers();
});

describe("CopyInvite", () => {
  it("confirms success only after the write resolves and resets the confirmation", async () => {
    let resolve!: () => void;
    writeText.mockReturnValue(
      new Promise<void>((r) => {
        resolve = r;
      }),
    );
    await render();
    await click();
    expect(writeText).toHaveBeenCalledWith(firstUrl);
    expect(button().textContent).toBe("Copying…");
    expect(button().disabled).toBe(true);
    expect(status()).not.toContain("copied");
    await act(async () => resolve());
    expect(button().textContent).toBe("Copied!");
    expect(status()).toBe("Invitation link copied.");
    await act(async () => vi.advanceTimersByTime(1500));
    expect(button().textContent).toBe("Copy invite link");
    expect(status()).toBe("");
  });

  it.each(["denied", "unavailable", "missing-method", "synchronous-error"])(
    "offers manual copying when clipboard is %s",
    async (failure) => {
      if (failure === "denied") writeText.mockRejectedValue(new Error("Permission denied"));
      if (failure === "unavailable") clipboard(undefined);
      if (failure === "missing-method") clipboard({});
      if (failure === "synchronous-error")
        writeText.mockImplementation(() => {
          throw new Error("Blocked");
        });
      await render();
      await click();
      expect(status()).toContain("Couldn't copy automatically");
      expect(button().textContent).toBe("Copy invite link");
      expect(button().disabled).toBe(false);
      const input = container.querySelector("input")!;
      expect(input.readOnly).toBe(true);
      expect(input.value).toBe(firstUrl);
      expect(input.closest("label")?.textContent).toContain("Invitation link");
      await act(async () => input.focus());
      expect(input.selectionStart).toBe(0);
      expect(input.selectionEnd).toBe(firstUrl.length);
    },
  );

  it("can retry successfully after a failure and removes the manual fallback", async () => {
    writeText.mockRejectedValueOnce(new Error("Denied"));
    await render();
    await click();
    expect(container.querySelector("input")).not.toBeNull();
    await click();
    expect(writeText).toHaveBeenCalledTimes(2);
    expect(button().textContent).toBe("Copied!");
    expect(container.querySelector("input")).toBeNull();
    expect(status()).not.toContain("Couldn't");
  });

  it.each(["copied", "failed"])("clears %s feedback on a URL change and copies the current URL", async (previous) => {
    if (previous === "failed") writeText.mockRejectedValueOnce(new Error("Denied"));
    await render();
    await click();
    await render(secondUrl);
    expect(status()).toBe("");
    expect(container.querySelector("input")).toBeNull();
    expect(button().textContent).toBe("Copy invite link");
    expect(vi.getTimerCount()).toBe(0);
    await click();
    expect(writeText).toHaveBeenLastCalledWith(secondUrl);
    expect(button().textContent).toBe("Copied!");
  });

  it.each(["resolve", "reject"])(
    "ignores an old pending write that later %ss after the URL changes",
    async (outcome) => {
      let resolve!: () => void;
      let reject!: (error: Error) => void;
      writeText.mockReturnValueOnce(
        new Promise<void>((yes, no) => {
          resolve = yes;
          reject = no;
        }),
      );
      await render();
      await click();
      await render(secondUrl);
      await click();
      expect(button().textContent).toBe("Copied!");
      await act(async () => (outcome === "resolve" ? resolve() : reject(new Error("Old failure"))));
      expect(button().textContent).toBe("Copied!");
      expect(status()).not.toContain("Couldn't");
      expect(writeText).toHaveBeenLastCalledWith(secondUrl);
    },
  );

  it("cleans up the success timer on unmount", async () => {
    await render();
    await click();
    expect(vi.getTimerCount()).toBe(1);
    await act(async () => root.unmount());
    mounted = false;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not start a timer if a pending write resolves after unmount", async () => {
    let resolve!: () => void;
    writeText.mockReturnValue(
      new Promise<void>((r) => {
        resolve = r;
      }),
    );
    await render();
    await click();
    await act(async () => root.unmount());
    mounted = false;
    await act(async () => resolve());
    expect(vi.getTimerCount()).toBe(0);
  });
});
