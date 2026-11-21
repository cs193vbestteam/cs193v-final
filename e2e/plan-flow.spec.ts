import { randomBytes } from "node:crypto";
import { expect, test, type Browser, type Page } from "@playwright/test";

/**
 * The whole product in one pass: two people sign up, one starts a plan, the
 * other joins by invite link, each tells their own assistant their limits,
 * and the group gets a plan. Along the way it checks the promise the product
 * makes: what one person told their assistant never shows up for anyone else.
 */

type Person = {
  name: string;
  email: string;
  password: string;
  /** What they tell their assistant. One message covers time, budget, distance and diet. */
  message: string;
  /** Strings that only this person's private side may ever show. */
  secrets: string[];
};

// Fresh per run: nothing here is a real credential, and the database starts empty.
const run = randomBytes(4).toString("hex");
const person = (name: string, message: string, secrets: string[]): Person => ({
  name,
  email: `${name.toLowerCase()}-${run}@e2e.test`,
  password: randomBytes(12).toString("base64url"),
  message,
  secrets,
});

// Budgets and travel limits are numbers no seed restaurant uses, so they can only appear on a page by leaking.
const ALEX = person("Alex", "Lunch or dinner, under $47, up to 29 minutes, no spicy", [
  "$47",
  "29 min",
  "under $47",
  "no spicy",
]);
const BLAKE = person("Blake", "I'm free all day, max $53 per person, 33 minutes, no restrictions", [
  "$53",
  "33 min",
  "max $53",
]);
const CASEY = person("Casey", "", []);

async function newSession(browser: Browser): Promise<Page> {
  const context = await browser.newContext();
  return context.newPage();
}

async function signUp(page: Page, who: Person, next = "/") {
  await page.goto(`/signup?next=${encodeURIComponent(next)}`);
  await page.getByLabel("Name your friends will see").fill(who.name);
  await page.getByLabel("Email").fill(who.email);
  await page.getByLabel("Password").fill(who.password);
  await page.getByRole("button", { name: "Create account" }).click();
}

async function tellAssistant(page: Page, who: Person) {
  await page.getByLabel("Message your assistant").fill(who.message);
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText("All set ✓")).toBeVisible();
  // The owner sees their own numbers in "What your assistant knows".
  await expect(page.getByText(`Budget: up to ${who.secrets[0]}/person`)).toBeVisible();
  await page.getByRole("button", { name: "I'm done" }).click();
  await expect(page.getByRole("button", { name: "Change my answers" })).toBeVisible();
}

async function expectNoSecrets(page: Page, of: Person) {
  const text = await page.locator("body").innerText();
  for (const secret of of.secrets) expect(text, `"${secret}" leaked to another person's page`).not.toContain(secret);
}

test("two people plan a meal without seeing each other's limits", async ({ browser }) => {
  const alex = await newSession(browser);
  const blake = await newSession(browser);
  const casey = await newSession(browser);

  await test.step("Alex signs up and starts a plan", async () => {
    await signUp(alex, ALEX);
    await alex.getByLabel("Plan name").fill("Weekend dinner");
    await alex.getByRole("button", { name: "Start a plan" }).click();
    await expect(alex).toHaveURL(/\/e\/[a-z0-9]+$/);
    await expect(alex.getByRole("heading", { name: "Weekend dinner" })).toBeVisible();
    await expect(alex.getByText("Sample data")).toBeVisible();
    await expect(alex.getByText("They are not real places.")).toBeVisible();
  });
  const planPath = new URL(alex.url()).pathname;

  await test.step("Blake follows the invite link, signs up and joins", async () => {
    await blake.goto(planPath);
    await expect(blake).toHaveURL(/\/login\?next=/);
    await signUp(blake, BLAKE, planPath);
    await expect(blake.getByText("You've been invited to")).toBeVisible();
    await blake.getByRole("button", { name: "Join plan" }).click();
    await expect(blake.getByRole("heading", { name: "Your private assistant" })).toBeVisible();
    await expect(blake.getByText("2 joined · limit 12")).toBeVisible();
  });

  await test.step("a plan cannot be found until everyone is done", async () => {
    await expect(alex.getByRole("button", { name: "Find a plan" })).toBeDisabled();
  });

  await test.step("Alex finishes first; Blake's page shows none of it", async () => {
    await tellAssistant(alex, ALEX);
    // Alex is told their part is over and what the group is waiting for.
    await expect(alex.getByText("Your part is done.")).toBeVisible();
    await expect(alex.getByText(/Waiting for 1 other person to finish/)).toBeVisible();
    await blake.reload();
    await expectNoSecrets(blake, ALEX);
    await expect(blake.getByText("1 of 2 ready")).toBeVisible();
  });

  await test.step("the creator can nudge the group with a count, never a name or a limit", async () => {
    await alex.reload();
    await expect(alex.getByRole("button", { name: "Nudge the group" })).toBeVisible();
    await expect(blake.getByRole("button", { name: "Nudge the group" })).toHaveCount(0);
  });

  await test.step("the last person finishes and the plan is found without anyone pressing a button", async () => {
    await tellAssistant(blake, BLAKE);
    await expect(blake.getByText("Everyone can come")).toBeVisible();
    await alex.reload();
    await expectNoSecrets(alex, BLAKE);
    await expect(alex.getByText("2 of 2 ready")).toBeVisible();
    await expect(alex.getByText("Everyone can come")).toBeVisible();
    // The plan is the first thing on the page, above the conversation, and the done note points to it.
    for (const page of [alex, blake]) {
      const plan = await page.getByRole("heading", { name: "The plan" }).boundingBox();
      const chat = await page.getByRole("heading", { name: "Your private assistant" }).boundingBox();
      expect(plan!.y).toBeLessThan(chat!.y);
      await expect(page.getByText("The plan is ready.")).toBeVisible();
      await expect(page.getByRole("link", { name: "See the plan" })).toHaveAttribute("href", "#plan");
    }
    // The plan on the page is the first price line; the same line is repeated on the tiles of the pop-out.
    const planLine = (page: Page) => page.getByText(/~\$\d+\/person/).first();
    await expect(planLine(alex)).toBeVisible();
    // Both see the same plan.
    expect(await planLine(blake).innerText()).toBe(await planLine(alex).innerText());

    // The pop-out lists the options, one tile each, the plan first.
    await alex.getByRole("button", { name: /See (all \d options|the plan)/ }).click();
    const window = alex.getByRole("dialog", { name: "The plan" });
    await expect(window).toBeVisible();
    await expect(window.getByText("1 · Best fit")).toBeVisible();
    expect(await window.getByRole("listitem").count()).toBeGreaterThanOrEqual(1);
    await window.getByRole("button", { name: "Close" }).click();
    await expect(window).toBeHidden();
  });

  await test.step("the message for the group chat carries the plan and the link, and nobody's limits", async () => {
    await alex.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await alex.evaluate(() => Reflect.deleteProperty(Navigator.prototype, "share"));
    await alex.getByRole("button", { name: "Share with the group" }).click();
    await expect(alex.getByText("Message copied")).toBeVisible();
    const copied = await alex.evaluate(() => navigator.clipboard.readText());
    expect(copied).toContain("Weekend dinner is settled:");
    expect(copied).toContain(planPath);
    for (const secret of [...ALEX.secrets, ...BLAKE.secrets]) expect(copied).not.toContain(secret);
  });

  await test.step("with nothing changed, the plan cannot be run again", async () => {
    for (const page of [alex, blake]) {
      await expect(page.getByRole("button", { name: "Re-run with latest info" })).toBeDisabled();
      await expect(page.getByText(/It can be run again once someone changes theirs/)).toBeVisible();
    }
  });

  await test.step("the result reveals nobody's limits", async () => {
    await expectNoSecrets(blake, ALEX);
    await expectNoSecrets(alex, BLAKE);
  });

  await test.step("with two people, only the outcome is shown: any count would be the other person's answer", async () => {
    for (const page of [alex, blake]) {
      // The optimizer decided it: how many options it scored, and nothing about either person.
      await expect(page.getByText(/How it was decided: \d+ options, 2 people, no model/)).toBeVisible();
      await expect(page.getByText("How they decided")).toHaveCount(0);
      const text = await page.locator("body").innerText();
      expect(text).not.toMatch(/reject|reluctant|Round \d|Works for \d of|cannot come/i);
    }
  });

  await test.step("when someone changes their answers, the plan is marked out of date until it is re-run", async () => {
    await blake.getByLabel("Message your assistant").fill("Actually make my budget $50");
    await blake.getByRole("button", { name: "Send" }).click();
    await expect(blake.getByText("1 of 2 ready")).toBeVisible();
    for (const page of [blake, alex]) {
      await page.reload();
      await expect(page.getByText("Out of date").first()).toBeVisible();
      await expect(page.getByText(/answers have changed since this was decided/)).toBeVisible();
      // The plan is still there to read, but it no longer says it works for everyone, and it is not offered for sharing.
      await expect(page.getByText("Everyone can come")).toHaveCount(0);
      await expect(page.getByText(/~\$\d+\/person/).first()).toBeVisible();
      await expect(page.getByRole("button", { name: "Share with the group" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Re-run with latest info" })).toBeDisabled();
    }
    await expectNoSecrets(alex, BLAKE);

    await blake.getByRole("button", { name: "I'm done" }).click();
    await expect(blake.getByText("2 of 2 ready")).toBeVisible();
    // Being done again does not make the old plan current: it stays out of date until the re-run.
    await expect(blake.getByText(/Everyone is done, but the plan is out of date/)).toBeVisible();
    await expect(blake.getByText("Everyone can come")).toHaveCount(0);
    await blake.getByRole("button", { name: "Re-run with latest info" }).click();
    await expect(blake.getByText("Out of date")).toHaveCount(0);
    await expect(blake.getByRole("button", { name: "Share with the group" })).toBeVisible();
  });

  await test.step("someone outside the plan sees only the invitation", async () => {
    await signUp(casey, CASEY, planPath);
    await expect(casey.getByRole("button", { name: "Join plan" })).toBeVisible();
    const text = await casey.locator("body").innerText();
    expect(text).not.toContain("Everyone can come");
    expect(text).not.toContain(ALEX.name);
    expect(text).not.toContain(BLAKE.name);
    await expectNoSecrets(casey, ALEX);
    await expectNoSecrets(casey, BLAKE);
  });

  await test.step("when someone joins after the plan is decided, it says so and is out of date", async () => {
    await casey.getByRole("button", { name: "Join plan" }).click();
    await expect(casey.getByText("3 joined · limit 12")).toBeVisible();
    for (const page of [casey, alex]) {
      await page.reload();
      await expect(page.getByText("Out of date").first()).toBeVisible();
      // The person who joined is told it is them; everyone else that someone did.
      await expect(
        page.getByText(page === casey ? /You joined after this was decided/ : /Someone joined after this was decided/),
      ).toBeVisible();
      await expect(page.getByText(/answers have changed/)).toHaveCount(0);
    }
  });
});

test("the plan page requires an account", async ({ page }) => {
  await page.goto("/e/doesnotexist");
  await expect(page).toHaveURL(/\/login\?next=/);
});

test("someone invited who signs up from the header still lands on the plan", async ({ page }) => {
  const dana = person("Dana", "", []);
  await page.goto("/e/invitedplan");
  await expect(page).toHaveURL(/\/login\?next=/);
  // The header link is the one a newcomer reaches for; it must carry the invite along.
  await page.getByRole("banner").getByRole("link", { name: "Sign up" }).click();
  await page.getByLabel("Name your friends will see").fill(dana.name);
  await page.getByLabel("Email").fill(dana.email);
  await page.getByLabel("Password").fill(dana.password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/e\/invitedplan$/);
});
