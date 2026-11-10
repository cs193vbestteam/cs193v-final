# Contributing

## Workflow

1. **Issue first.** Every piece of work has an issue, made with the *Bug report* or *Feature or task* template. Give it a type label, an area label and a priority, and assign it to the person doing it.
2. **Branch.** Never commit to `main`. Branch from the latest `main`, named after the issue: `feat/12-places-radius`, `fix/15-chat-refresh`, `chore/...`.
3. **Pull request.** Open a PR against `main` using the template. Its first line is `Closes #<issue>`, so GitHub links the PR and closes the issue when it merges.
4. **Review.** At least one teammate reviews and approves before merging. CI (lint, typecheck, tests, build, secret scan) must be green.
5. **Merge.** Use **Rebase and merge**; it's the only merge method enabled, which keeps `main` linear. The branch is deleted automatically afterwards.

## Labels

| Kind | Labels |
|---|---|
| Type | `bug`, `enhancement`, `feature`, `documentation`, `testing`, `chore`, `security`, `dependencies` |
| Area | `area: assistant`, `area: coordination`, `area: evaluation`, `area: frontend`, `area: backend`, `area: database`, `area: infra` |
| Priority | `priority: high` (this week / blocks someone), `priority: medium` (this milestone), `priority: low` (nice to have) |

## Before you push

```bash
npm run lint          # ESLint
npm run format        # Prettier: format your changed files (CI will check this after the one-time repo-wide format)
npm run typecheck
npm test
```

## Tests

Every bug fix comes with a test that fails without the fix. Every feature has tests for its core logic. Tests live in `tests/` (Vitest + jsdom), and LLM and Google Places calls are stubbed so tests never need a key. Changes to negotiation or scoring should also be checked with `npm run sim`.

End-to-end tests live in `e2e/` (Playwright). `npm run test:e2e` builds the app and drives a real browser through the whole flow with no API keys and an in-memory database. The first time, run `npx playwright install chromium`. Add to them when a change affects what a user can see or do across pages.

## Style guide

- **TypeScript:** strict mode (`tsconfig.json`).
- **Lint:** ESLint with Next.js's `core-web-vitals` + `typescript` rule sets (`eslint.config.mjs`).
- **Formatting:** Prettier with `printWidth: 120` and everything else at defaults (`.prettierrc.json`). Don't argue about formatting in reviews; run `npm run format`.
- Validate untrusted input with zod at the boundary (server actions, LLM tool output, external APIs).
- Server-only code imports `server-only`. Keep anything that touches the database, `crypto.ts` or `vault.ts` out of the negotiation modules: `tests/isolation.test.ts` enforces this.

## Secrets and security

- **Never commit secrets.** Real values live only in `.env.local` (git-ignored) on your machine, in Vercel → Project → Settings → Environment Variables for deploys, and in GitHub → Settings → Secrets if a workflow ever needs one. `.env.example` lists names only.
- **Secret scanning:** the *Secret scan* workflow runs gitleaks over the full history on every PR. To scan locally before pushing: `brew install gitleaks && gitleaks git .`
- **If a secret leaks**, rotate it at the provider immediately (Anthropic console, Google Cloud, Turso), then remove it from the code. Deleting the commit is not enough, since it is already in history and forks.
- **`ENCRYPTION_KEY`** encrypts chat messages, constraints and emails at rest (AES-256-GCM). Generate it with `npm run gen-key`, keep a copy in the team's password manager, and never change it in production: existing data could no longer be decrypted. Use different keys for local, preview and production.
- Don't paste real user data, keys or tokens into issues, PRs, logs or screenshots.
