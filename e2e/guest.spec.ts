import { randomBytes } from "node:crypto";
import { expect, test } from "@playwright/test";

/**
 * Joining as a guest (#160): a plan code and a name, no account. Then the guest adds an email
 * and password and keeps the plan they joined.
 */

const run = randomBytes(4).toString("hex");
const password = () => randomBytes(12).toString("base64url");
// Its own address, so the people made here do not use up the sign-up allowance the other files share.
const FROM = { "x-forwarded-for": "203.0.113.41" };

test("a guest joins with the plan code, then keeps the plan by adding an email", async ({ browser }) => {
  const owner = await (await browser.newContext({ extraHTTPHeaders: FROM })).newPage();
  await owner.goto("/signup");
  await owner.getByLabel("Name your friends will see").fill("Alex");
  await owner.getByLabel("Email").fill(`alex-guest-${run}@e2e.test`);
  await owner.getByLabel("Password").fill(password());
  await owner.getByRole("button", { name: "Create account" }).click();
  await owner.getByLabel("Plan name").fill("Guest dinner");
  await owner.getByRole("button", { name: "Start a plan" }).click();
  await owner.waitForURL(/\/e\//);
  const code = new URL(owner.url()).pathname.split("/").pop()!;

  // The invite link, opened signed out, offers the guest way in with the code filled in.
  const guest = await (await browser.newContext({ extraHTTPHeaders: FROM })).newPage();
  await guest.goto(`/e/${code}`);
  await guest.getByRole("link", { name: "Continue as a guest" }).click();
  await expect(guest.getByLabel("Plan code")).toHaveValue(code);

  // A code that leads nowhere is refused without making anyone.
  await guest.getByLabel("Plan code").fill("zzzz9999");
  await guest.getByLabel("Name your friends will see").fill("Gus");
  await guest.getByRole("button", { name: "Continue as a guest" }).click();
  await expect(guest.getByText("No plan has that code")).toBeVisible();

  // The code typed in capitals, as the plan page prints it.
  await guest.getByLabel("Plan code").fill(code.toUpperCase());
  await guest.getByRole("button", { name: "Continue as a guest" }).click();
  await guest.waitForURL(`**/e/${code}`);
  await expect(guest.getByRole("heading", { name: "Your private assistant" })).toBeVisible();
  await expect(guest.getByText("Here as a guest:")).toBeVisible();
  await expect(guest.getByRole("button", { name: "Log out" })).toHaveCount(0);

  await owner.reload();
  await expect(owner.getByText("Gus", { exact: true }).first()).toBeVisible();

  // Guests join plans; they do not start them.
  await guest.goto("/");
  await expect(guest.getByText("guests can join plans but not start them")).toBeVisible();
  await expect(guest.getByLabel("Plan name")).toHaveCount(0);
  await expect(guest.getByRole("link", { name: /Guest dinner/ })).toBeVisible();

  // Adding an email and password keeps the plan.
  await guest.getByRole("link", { name: "Save account" }).click();
  await expect(guest.getByLabel("Name your friends will see")).toHaveValue("Gus");
  await guest.getByLabel("Email").fill(`gus-${run}@e2e.test`);
  await guest.getByLabel("Password").fill(password());
  await guest.getByRole("button", { name: "Create account" }).click();
  await expect(guest.getByText("Signed in as")).toBeVisible();
  await expect(guest.getByRole("button", { name: "Log out" })).toBeVisible();
  await expect(guest.getByLabel("Plan name")).toBeVisible();
  await expect(guest.getByRole("link", { name: /Guest dinner/ })).toBeVisible();
});
