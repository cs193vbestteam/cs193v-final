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
    // A test file that touches the database starts an in-memory Postgres once (PGlite, ~3-4 s
    // cold). Under a full parallel run the first test of a file can pass the 5 s default.
    testTimeout: 20_000,
    env: {
      // Test-only key. Never use this anywhere real.
      ENCRYPTION_KEY: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
      DATABASE_URL: ":memory:",
    },
  },
});
