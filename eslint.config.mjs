import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import prettier from "eslint-config-prettier/flat";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // CommonJS shims (loaded with `node --require`) have to use require().
    files: ["**/*.cjs"],
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
  {
    // Existing pattern in GroupActions; tracked as a follow-up instead of rewriting it here.
    files: ["src/**/*.{ts,tsx}"],
    rules: { "react-hooks/set-state-in-effect": "warn" },
  },
  // Must stay last: turns off stylistic rules that Prettier owns.
  prettier,
  globalIgnores([".next/**", "out/**", "build/**", "coverage/**", "sim/out/**", "next-env.d.ts"]),
]);
