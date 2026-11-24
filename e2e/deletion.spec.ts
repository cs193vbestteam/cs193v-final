import { randomBytes } from "node:crypto";
import { expect, test, type Browser, type Page } from "@playwright/test";

/**
 * Leaving a plan, deleting a plan and deleting an account, as a user does them:
 * each is a two-step confirmation, and afterwards the data is really gone.
 */

const run = randomBytes(4).toString("hex");
const person = (name: string) => ({
  name,
  email: `${name.toLowerCase()}-${run}@e2e.test`,
  password: randomBytes(12).toString("base64url"),
});
type Person = ReturnType<typeof person>;

async function signUp(browser: Browser, who: Person, next = "/"): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto(`/signup?next=${encodeURIComponent(next)}`);
  await page.getByLabel("Name your friends will see").fill(who.name);
  await page.getByLabel("Email").fill(who.email);
  await page.getByLabel("Password").fill(who.password);
  await page.getByRole("button", { name: "Create account" }).click();
  return page;
}

// Next.js keeps its own role="alert" route announcer on every page; this is the form's message.
const formError = (page: Page) => page.locator('p[role="alert"]');

async function startPlan(page: Page, title: string): Promise<string> {
  await page.getByLabel("Plan name").fill(title);
  await page.getByRole("button", { name: "Start a plan" }).click();
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  return new URL(page.url()).pathname;
}

test("a member leaves a plan; the creator then deletes it for everyone", async ({ browser }) => {
  const dana = person("Dana");
  const eli = person("Eli");
  const creator = await signUp(browser, dana);
  const planPath = await startPlan(creator, "Trip dinner");

  const member = await signUp(browser, eli, planPath);
  await member.getByRole("button", { name: "Join plan" }).click();
  await expect(member.getByText("2 joined · limit 12")).toBeVisible();

  await test.step("a member can leave but not delete", async () => {
    await expect(member.getByRole("button", { name: "Delete this plan" })).toHaveCount(0);
    await member.getByText("More", { exact: true }).click();
    await member.getByRole("button", { name: "Leave this plan" }).click();
    await expect(member.getByText("This cannot be undone.")).toBeVisible();
  });

  await test.step("cancel changes nothing", async () => {
    await member.getByRole("button", { name: "Cancel" }).click();
    await expect(member.getByText("This cannot be undone.")).toHaveCount(0);
    await expect(member.getByText("2 joined · limit 12")).toBeVisible();
  });

  await test.step("confirming removes them from the plan", async () => {
    await member.getByRole("button", { name: "Leave this plan" }).click();
    await member.getByRole("button", { name: "Leave plan", exact: true }).click();
    await expect(member).toHaveURL(/\/$/);
    await creator.reload();
    await expect(creator.getByText("1 joined · limit 12")).toBeVisible();
    await expect(creator.getByText(eli.name)).toHaveCount(0);
  });

  await test.step("the creator deletes the plan and the link stops working", async () => {
    await expect(creator.getByRole("button", { name: "Leave this plan" })).toHaveCount(0);
    await creator.getByText("More", { exact: true }).click();
    await creator.getByRole("button", { name: "Delete this plan" }).click();
    await creator.getByRole("button", { name: "Delete plan", exact: true }).click();
    await expect(creator).toHaveURL(/\/$/);
    const response = await creator.goto(planPath);
    expect(response?.status()).toBe(404);
  });
});

test("a creator leaves and the plan passes to the next member", async ({ browser }) => {
  const gia = person("Gia");
  const hal = person("Hal");
  const creator = await signUp(browser, gia);
  const planPath = await startPlan(creator, "Handover lunch");

  await test.step("alone, the creator can only delete", async () => {
    await expect(creator.getByRole("button", { name: "Leave this plan" })).toHaveCount(0);
    await creator.getByText("More", { exact: true }).click();
    await expect(creator.getByRole("button", { name: "Delete this plan" })).toBeVisible();
  });

  const member = await signUp(browser, hal, planPath);
  await member.getByRole("button", { name: "Join plan" }).click();
  await expect(member.getByText("2 joined · limit 12")).toBeVisible();
  await expect(member.getByRole("button", { name: "Delete this plan" })).toHaveCount(0);

  await test.step("with a second member, the creator can leave and is told who takes over", async () => {
    await creator.reload();
    await creator.getByText("More", { exact: true }).click();
    await creator.getByRole("button", { name: "Leave this plan" }).click();
    await expect(creator.getByText(`passes to ${hal.name}`)).toBeVisible();
    await creator.getByRole("button", { name: "Leave plan", exact: true }).click();
    await expect(creator).toHaveURL(/\/$/);
  });

  await test.step("the plan survives and the remaining member now owns it", async () => {
    await member.reload();
    await expect(member.getByRole("heading", { name: "Handover lunch" })).toBeVisible();
    await expect(member.getByText("1 joined · limit 12")).toBeVisible();
    await expect(member.getByText(gia.name)).toHaveCount(0);
    await member.getByText("More", { exact: true }).click();
    await expect(member.getByRole("button", { name: "Delete this plan" })).toBeVisible();
  });
});

test("deleting an account needs the password and really removes the account", async ({ browser }) => {
  const fern = person("Fern");
  const page = await signUp(browser, fern);
  await startPlan(page, "Solo plan");

  await page.getByRole("link", { name: "Account" }).click();
  await expect(page.getByRole("heading", { name: fern.name })).toBeVisible();
  await expect(page.getByText(fern.email)).toBeVisible();

  await test.step("a wrong password deletes nothing", async () => {
    await page.getByRole("button", { name: "Delete my account…" }).click();
    await page.getByLabel("Confirm with your password").fill("not-the-password");
    await page.getByRole("button", { name: "Delete account permanently" }).click();
    await expect(formError(page)).toHaveText("That password isn't right");
    await expect(page).toHaveURL(/\/account$/);
  });

  await test.step("the right password deletes the account and signs out", async () => {
    await page.getByLabel("Confirm with your password").fill(fern.password);
    await page.getByRole("button", { name: "Delete account permanently" }).click();
    await expect(page).toHaveURL(/\/signup/);
  });

  await test.step("the old credentials no longer work", async () => {
    await page.goto("/login");
    await page.getByLabel("Email").fill(fern.email);
    await page.getByLabel("Password").fill(fern.password);
    await page.getByRole("button", { name: "Log in" }).click();
    await expect(formError(page)).toHaveText("Wrong email or password");
  });
});

test("the account page requires a session", async ({ page }) => {
  await page.goto("/account");
  await expect(page).toHaveURL(/\/login\?next=%2Faccount/);
});
