import { randomBytes } from "node:crypto";
import { expect, test, type Browser, type Page } from "@playwright/test";

/**
 * What the plan's creator controls (#119): how many people fit, who is in the plan, and the
 * invite link. Done as a user does it, with a second person to be turned away and removed.
 */

const run = randomBytes(4).toString("hex");
const person = (name: string) => ({
  name,
  email: `${name.toLowerCase()}-${run}@e2e.test`,
  password: randomBytes(12).toString("base64url"),
});
type Person = ReturnType<typeof person>;

/**
 * Sign-ups are limited to ten an hour per address, and the other specs already use most of
 * that against one server. These three people arrive from an address of their own (one reserved
 * for documentation), which is how the server sees separate visitors.
 */
const FROM = { "x-forwarded-for": "203.0.113.19" };

async function signUp(browser: Browser, who: Person, next = "/"): Promise<Page> {
  const page = await (await browser.newContext({ extraHTTPHeaders: FROM })).newPage();
  await page.goto(`/signup?next=${encodeURIComponent(next)}`);
  await page.getByLabel("Name your friends will see").fill(who.name);
  await page.getByLabel("Email").fill(who.email);
  await page.getByLabel("Password").fill(who.password);
  await page.getByRole("button", { name: "Create account" }).click();
  return page;
}

test("the creator sets the size, makes room, removes someone and replaces the link", async ({ browser }) => {
  const creator = await signUp(browser, person("Faye"));
  await creator.getByLabel("Plan name").fill("Small table");
  await creator.getByLabel("Up to").selectOption("2");
  await creator.getByRole("button", { name: "Start a plan" }).click();
  await expect(creator.getByRole("heading", { name: "Small table" })).toBeVisible();
  const planPath = new URL(creator.url()).pathname;
  await expect(creator.getByText("1 of 2 joined")).toBeVisible();

  const second = await signUp(browser, person("Gus"), planPath);
  await second.getByRole("button", { name: "Join plan" }).click();
  await expect(second.getByText("2 of 2 joined")).toBeVisible();

  const third = await signUp(browser, person("Hana"), planPath);
  await test.step("a full plan says so instead of offering to join", async () => {
    await expect(third.getByText("This plan is full.")).toBeVisible();
    await expect(third.getByRole("button", { name: "Join plan" })).toHaveCount(0);
  });

  await test.step("members who did not create the plan see no controls", async () => {
    await expect(second.getByText("Manage people and the invite link")).toHaveCount(0);
  });

  await test.step("the creator makes room and the third person gets in", async () => {
    await creator.reload();
    await creator.getByText("Manage people and the invite link").click();
    await creator.getByLabel("How many people can join").selectOption("3");
    await creator.getByRole("button", { name: "Save" }).click();
    await expect(creator.getByText("Up to 3 people can be in this plan.")).toBeVisible();
    await third.reload();
    await third.getByRole("button", { name: "Join plan" }).click();
    await expect(third.getByText("3 of 3 joined")).toBeVisible();
  });

  await test.step("removing someone asks first, then takes them out", async () => {
    await creator.reload();
    await creator.getByText("Manage people and the invite link").click();
    await creator.getByRole("button", { name: "Remove Hana", exact: true }).click();
    await expect(creator.getByText("This cannot be undone.")).toBeVisible();
    await creator.getByRole("button", { name: "Cancel" }).click();
    await expect(creator.getByText("3 of 3 joined")).toBeVisible();

    await creator.getByRole("button", { name: "Remove Hana", exact: true }).click();
    await creator
      .getByRole("group", { name: /Remove Hana from this plan/ })
      .getByRole("button", { name: "Remove Hana" })
      .click();
    await expect(creator.getByText("2 of 3 joined")).toBeVisible();
    await third.reload();
    await expect(third.getByRole("button", { name: "Join plan" })).toBeVisible();
  });

  await test.step("replacing the link moves the plan and kills the old address", async () => {
    await creator.getByRole("button", { name: "Replace the invite link" }).click();
    await creator.getByRole("button", { name: "Replace link" }).click();
    await expect(creator).not.toHaveURL(new RegExp(`${planPath}$`));
    await expect(creator.getByRole("heading", { name: "Small table" })).toBeVisible();
    await expect(creator.getByText("2 of 3 joined")).toBeVisible();

    const old = await third.goto(planPath);
    expect(old?.status()).toBe(404);
    // Someone already in the plan follows it from their own list.
    await second.goto("/");
    await second.getByRole("link", { name: /Small table/ }).click();
    await expect(second.getByText("2 of 3 joined")).toBeVisible();
  });
});
