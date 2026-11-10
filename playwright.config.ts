import { randomBytes } from "node:crypto";
import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests: a real browser against a production build of the app.
 *
 * The server runs with no API keys and an in-memory database, so the tests
 * exercise the rule-based assistant and the seed restaurants, need no
 * services, and start from an empty database every run. The encryption key
 * is generated per run and never leaves this process.
 */
const PORT = Number(process.env.E2E_PORT ?? 3210);
const CI = !!process.env.CI;

export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  reporter: CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `npm run build && npm run start -- --port ${PORT}`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    timeout: 240_000,
    stdout: "pipe",
    env: {
      ENCRYPTION_KEY: randomBytes(32).toString("base64"),
      DATABASE_URL: ":memory:",
      ANTHROPIC_API_KEY: "",
      GOOGLE_PLACES_API_KEY: "",
      SETTLE_LLM_MEDIATOR: "",
    },
  },
});
