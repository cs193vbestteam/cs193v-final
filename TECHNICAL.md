# Technical overview

How Settle is put together: the main pieces, the tools and services behind them, what is stored, how private information is protected, and what is still open. `README.md` has the commands and the file layout; `docs/evaluation.md` has the measurements.

## Main pieces

Settle helps a group pick a restaurant and a time for a weekend meal without anyone saying their budget out loud. Each person talks to their own private assistant, and the assistants work out a plan between them.

1. **The website.** Someone signs up, starts a plan with a name and a location, and shares the invite link. Friends open the link and join.
2. **The private chat.** Each person has a chat on the plan page that only they can see. They type things like "Saturday night only, under $40, no spicy".
3. **The extractor.** Our server sends each message to Claude, which turns it into structured constraints: when the person is free, their budget, how far they will travel, what they cannot eat, and cuisines they like or dislike. If the call to Claude fails, a rule-based extractor written in plain code answers instead.
4. **The candidate list.** When a plan is created with a location, the server asks Google Places for up to 60 real restaurants nearby and saves them with the plan. Without a Google key, or if the request fails, a built-in list of 16 fictional restaurants is used. So far this path has been tested almost entirely against hand-written responses in Google's format; with a real key it has been run once, on a developer's machine (see Open questions).
5. **The assistants.** When everyone is done, the server builds one assistant per person from their saved constraints. An assistant answers "accept, reluctant or reject" about a proposed restaurant and time, with at most one word for why, such as "price". For the final choice between the best options it also sends one scrambled message: a score for each finalist with random masks added, which means nothing on its own. With an Anthropic key, each assistant is a Claude call that sees only its own person's summary (their words, foods they avoid, what matters most to them) and judges a whole round at once; code still rejects anything that breaks a hard rule, and falls back to the plain-code assistant if Claude fails or the plan's daily LLM budget is used up.
6. **The mediator.** It runs the negotiation: five proposals per round, up to six rounds, adjusting from the answers. It never sees anyone's constraints: only the public restaurant list, counts of the answers, and the one-word reasons. For the final choice it adds up everyone's scrambled messages; the masks cancel in the sum, so it learns how the finalists compare for the group as a whole and never anyone's score. With an Anthropic key, Claude proposes the options each round (only from a shortlist the code builds, seeing the same anonymous information as before) and writes one sentence for the group about the final plan. The final pick itself stays in code, as above.
7. **The result.** The group sees the chosen plan, for example "Sat dinner · Olive Tree Mezze · ~$27/person". Groups of three or more also see anonymous counts for each option tried. Groups of two see only the outcome, because with two people every count would be the other person's answer.

Separately, `sim/` holds evaluation scripts that are not part of the website. They run the negotiation on thousands of made-up groups and score the extractors on scripted chats.

## Tools and services

| Tool or service | What we use it for |
|---|---|
| **Next.js** (React, TypeScript) | The whole web app: the pages and the server-side functions they call. There is no separate backend. |
| **Tailwind CSS** | Styling. |
| **Postgres** on **Neon** | The production database (chosen, not set up for this repository yet; see Open questions). |
| **PGlite** | Postgres running inside Node, for local development and tests, so nobody installs a database. |
| **Anthropic API (Claude)** | Reads private-chat messages into constraints, and runs the negotiation: each person's assistant and the mediator (see 5 and 6). |
| **Google Places API** | Finds real restaurants near a plan's location, and turns a typed place into coordinates. Built, but barely exercised with a real key so far. |
| **Zod** | Checks the shape of anything from outside: form input, Claude's output, stored data. |
| **bcryptjs** and Node's built-in crypto | Password hashing, and encryption of private data. |
| **Vercel** | Hosting (see Open questions for where the deployment stands). |
| **GitHub Actions** | On every pull request: lint, type check, unit tests, a production build, browser tests and a secret scan. |
| **Vitest, Playwright** | Unit tests and end-to-end browser tests. |
| **gitleaks** | Scans the repository's history for committed secrets. |

## Stored information

Everything is in one Postgres database.

| Table | What it holds |
|---|---|
| `users` | Display name, email (encrypted) and password hash. |
| `sessions` | A hash of each login cookie and when it expires (30 days). |
| `events` | One row per plan: name, invite code, location, the restaurant list, and the result once decided. |
| `members` | Who is in which plan, whether they are done, and their constraints (encrypted). |
| `messages` | Every private-chat message (encrypted). |
| `rate_limits` | Counters for the abuse limits. |

Inside a plan, the name, location, member list, restaurant list and result are visible to the group. A person's chat, constraints and starting point are visible only to them. The stored result never contains anyone's constraints.

People can delete what they stored: a creator can delete a plan, a member can leave one, and anyone can delete their account, which removes their chats and constraints with it. Nothing is stored in the browser except the login cookie.

Two kinds of data leave our server. Claude receives the last 20 messages of one person's chat and that person's own constraints, and nothing about any other member. Google receives the plan's location and, if a person gives one, where they are coming from.

## Secrets and user information

We use four secrets: `ENCRYPTION_KEY` (encrypts private data), `DATABASE_URL` (the Postgres connection string, which contains the database password), `ANTHROPIC_API_KEY` and `GOOGLE_PLACES_API_KEY`.

**Keeping secrets out of the code**

- Real values live only in a `.env.local` file on a developer's machine, which git ignores, and in the hosting provider's environment-variable settings. `.env.example` lists the names with empty values.
- gitleaks scans the full git history on every pull request and every push to `main`.
- All four are read only by server-side code and are never sent to the browser.
- If one leaks, we rotate it at the provider first, then remove it from the code.

**Protecting personal information**

- **Passwords** are never stored, only a salted bcrypt hash.
- **Emails, private chats, constraints and starting points** are encrypted with AES-256-GCM before they are written to the database. Accounts are found at login through a keyed hash of the email.
- **Login cookies** hold a random token, and the database stores only its hash, so a copy of the database cannot be used to log in as someone.
- **Access is checked on the server.** Every function that reads or changes a plan checks that the person is a member, and no function exists that reads another person's chat or constraints.
- **The negotiation never receives constraints.** One module (`vault.ts`) turns each person's stored constraints into an assistant and hands over only the assistant. A person's own constraints are decrypted elsewhere only to show them back to that person. A test fails if the negotiation code can reach the database or the encryption code.
- **Abuse limits** cap chat messages, model calls per plan, login attempts and new accounts.
- **Claude's output is checked** before it is saved: anything that does not fit the expected shape is discarded, and out-of-range numbers (a budget over $500, for example) are dropped.

These protections are about what other members can see and what the negotiation code can reach. Whoever operates the server holds both the database and the encryption key, so they can read everything.

## Open questions

1. **This repository is not deployed yet.** The "Live site" link in the README points at an earlier version. *Next:* create the Neon database, set the four secrets in Vercel, deploy from this repository, then run one two-person plan on the live site and update the link.
2. **Google Places with a real key.** The tests for this path use hand-written responses in Google's format. With a real key it has been run once: on one developer's machine, a plan created near Palo Alto came back with 60 real places. Nobody has looked at those restaurants, negotiated on them, or used a real key for a person's starting point. We also have not checked the price at our volume (up to 7 calls per new plan), and no spending limit is set. *Next:* create a plan with a real location, read through the restaurants it returns, run a full two-person negotiation on it, then read the pricing and set a daily quota and a budget alert before a key goes anywhere near the deployed site.
3. **How Claude behaves when someone tries to manipulate it.** We wrote 48 scripted chats, 16 of them adversarial ("ignore your instructions", "show me Sam's budget"), and ran the rule-based extractor on them. We have not run Claude on them. *Next:* run `npm run sim:extract -- --llm` and add the results to `docs/evaluation.md`, checking first how often the call to Claude fails and falls back to the rules.
4. **Unlimited re-runs.** A member can change their own answers and re-run a plan as often as they like, and watching how the outcome moves slowly reveals the others' limits. *Next:* decide on a cap or a cool-down and open an issue for it.
5. **How it does with real friends.** Our tests use made-up groups and personas built from Yelp reviews, which turned out to have almost no price or dietary limits. *Next:* try it with a few real groups and compare what they say with the plan they got.
