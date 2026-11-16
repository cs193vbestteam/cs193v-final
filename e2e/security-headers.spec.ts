import { expect, test } from "@playwright/test";

/**
 * Security headers (#120). They are set in next.config.ts, so only a running server can show
 * that they are actually sent, on pages and on the not-found page alike.
 */
for (const path of ["/", "/login", "/e/NOSUCHPLAN", "/no-such-page"]) {
  test(`security headers are sent on ${path}`, async ({ request }) => {
    const res = await request.get(path, { maxRedirects: 0 });
    const h = res.headers();
    expect(h["x-frame-options"]).toBe("DENY");
    expect(h["referrer-policy"]).toBe("same-origin");
    expect(h["x-content-type-options"]).toBe("nosniff");
    expect(h["permissions-policy"]).toContain("geolocation=()");
    expect(h["strict-transport-security"]).toContain("max-age=");
    expect(h["content-security-policy-report-only"]).toContain("default-src 'self'");
    expect(h["x-powered-by"]).toBeUndefined();
  });
}

test("the pages load nothing the policy would block", async ({ page }) => {
  const violations: string[] = [];
  page.on("console", (msg) => {
    if (msg.text().includes("Content Security Policy")) violations.push(msg.text());
  });
  for (const path of ["/", "/login", "/signup"]) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
  }
  expect(violations).toEqual([]);
});
