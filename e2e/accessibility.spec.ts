import { randomBytes } from "node:crypto";
import { expect, test } from "@playwright/test";

/**
 * Things a keyboard or screen-reader user depends on, checked in a real browser:
 * each page says what it is, the keyboard can skip the header, forms have labels
 * you can see, and the private chat can be reached and scrolled without a mouse.
 */

const run = randomBytes(4).toString("hex");
const user = { name: "Dana", email: `dana-${run}@e2e.test`, password: randomBytes(12).toString("base64url") };

test("signed-out pages are titled, and the first tab stop skips to the content", async ({ page }) => {
  await page.goto("/login");
  await expect(page).toHaveTitle("Log in — Settle");
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "Skip to content" });
  await expect(skip).toBeFocused();
  await expect(skip).toBeInViewport();
  await page.keyboard.press("Enter");
  await expect(page.locator("main#main")).toBeFocused();

  await page.goto("/signup");
  await expect(page).toHaveTitle("Sign up — Settle");
  await page.goto("/no-such-page");
  await expect(page).toHaveTitle("Page not found — Settle");
});

test("the landing demo can be paused", async ({ page }) => {
  await page.goto("/");
  const toggle = page.getByRole("button", { name: "Pause animation" });
  await toggle.click();
  await expect(page.getByRole("button", { name: "Play animation" })).toHaveAttribute("aria-pressed", "true");
  const states = await page
    .locator(".demo-msg")
    .evaluateAll((els) => els.map((el) => getComputedStyle(el).animationPlayState));
  expect(new Set(states)).toEqual(new Set(["paused"]));
});

test("the plan form has visible labels, the plan page is named after the plan, and the chat takes the keyboard", async ({
  page,
}) => {
  await page.goto("/signup");
  await page.getByLabel("Name your friends will see").fill(user.name);
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password").fill(user.password);
  await page.getByRole("button", { name: "Create account" }).click();

  // Labels that stay on screen while you type, not placeholders alone.
  await expect(page.locator('label[for="plan-title"]')).toBeVisible();
  await expect(page.locator('label[for="plan-location"]')).toBeVisible();
  await page.getByLabel("Plan name").fill("Sunday lunch");
  await page.getByRole("button", { name: "Start a plan" }).click();
  await expect(page).toHaveURL(/\/e\/[a-z0-9]+$/);
  await expect(page).toHaveTitle("Sunday lunch — Settle");

  const chat = page.getByRole("log", { name: "Conversation with your assistant" });
  await expect(chat).toBeVisible();
  await chat.focus();
  await expect(chat).toBeFocused();

  // Where people type, a title opens what is sent, to whom and for how long, with a link to the rest (#111).
  const notice = page.getByText("Processed by Anthropic's Claude. Where your messages go");
  await expect(notice).toBeVisible();
  await notice.click();
  await expect(page.getByText(/sent to Anthropic's Claude/)).toBeVisible();
  await expect(page.getByText(/standard retention policy is up to 30 days/)).toBeVisible();
  await expect(page.getByRole("link", { name: /How your data is used/ })).toHaveAttribute("href", "/privacy");

  // Nothing a person reads is smaller than 12px, and nothing they press is shorter than 24px.
  const { small, short } = await page.evaluate(() => {
    const shown = (el: Element) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && !el.closest("[aria-hidden=true], .sr-only, nextjs-portal");
    };
    const small: string[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const el = walker.currentNode.parentElement;
      if (!el || !walker.currentNode.textContent?.trim() || !shown(el)) continue;
      if (parseFloat(getComputedStyle(el).fontSize) < 12) small.push(walker.currentNode.textContent.trim());
    }
    const short = [...document.querySelectorAll("a, button, input, summary")]
      .filter((el) => shown(el) && el.getBoundingClientRect().height < 24)
      .map((el) => (el as HTMLElement).innerText || el.getAttribute("aria-label") || el.tagName);
    return { small, short };
  });
  expect(small).toEqual([]);
  expect(short).toEqual([]);
});
