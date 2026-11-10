import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      "server-only": path.resolve(__dirname, "tests/stubs/server-only.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Tests that touch the database start an in-memory Postgres (PGlite, ~3-4 s cold) and hash
    // passwords with bcrypt (cost 12). Under a full parallel run that can pass the 5 s default.
    testTimeout: 20_000,
    env: {
      // Test-only key. Never use this anywhere real.
      ENCRYPTION_KEY: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
      DATABASE_URL: ":memory:",
    },
  },
});
