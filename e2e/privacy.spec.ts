import { expect, test } from "@playwright/test";

/**
 * The privacy page (#111): what happens to what people tell Settle, readable before signing up
 * and reachable from every page.
 */

test("the privacy page is public, titled, and says who reads the chat and for how long", async ({ page }) => {
  const res = await page.goto("/privacy");
  expect(res?.status()).toBe(200);
  await expect(page).toHaveURL(/\/privacy$/); // not sent to log in
  await expect(page).toHaveTitle("Privacy — Settle");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("What happens to what you");

  for (const heading of [
    "What your group sees",
    "What the AI reads",
    "What Anthropic does with it",
    "Places and starting points",
    "What Settle keeps",
    "What you cannot choose yet",
  ]) {
    await expect(page.getByRole("heading", { level: 2, name: heading })).toBeVisible();
  }

  // The facts a person needs: the provider, training, how long, and that the server can read it.
  const text = await page.locator("main").innerText();
  expect(text).toContain("Claude, an AI model made by Anthropic");
  expect(text).toMatch(/does not use what we send to train its models by default/);
  expect(text).toMatch(/within 30 days/);
  expect(text).toMatch(/Our server can decrypt them/);
  expect(text).toMatch(/no way to use Settle without the AI reading your chat/);

  // Anthropic's own pages, for anyone who wants to check.
  for (const name of ["Training policy", "Retention policy", "How the API handles data"]) {
    const link = page.getByRole("link", { name: new RegExp(name) });
    await expect(link).toHaveAttribute("href", /^https:\/\/(privacy|platform)\.claude\.com\//);
    await expect(link).toHaveAttribute("rel", /noopener/);
  }
});

test("every page links to the privacy page from its footer", async ({ page }) => {
  for (const path of ["/", "/login", "/signup"]) {
    await page.goto(path);
    await expect(page.getByRole("contentinfo").getByRole("link", { name: "Privacy" })).toHaveAttribute(
      "href",
      "/privacy",
    );
  }
  await page.goto("/");
  await page.getByRole("contentinfo").getByRole("link", { name: "Privacy" }).click();
  await expect(page).toHaveURL(/\/privacy$/);
});
