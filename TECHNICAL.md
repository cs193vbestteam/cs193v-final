# Technical overview

How Settle is put together: the main pieces, the services behind them, what is stored, how private information is protected, and what is still open. `README.md` has the commands and the file layout; `docs/evaluation.md` and `AI-EVALS.md` have the measurements.

## Main pieces

Settle helps a group pick a restaurant and a time for a meal without anyone saying their budget out loud. Each person talks to their own private assistant. When everyone is done, a program scores every option and picks the plan.

1. **The website.** Someone signs up, starts a plan (name, location, date, group size) and shares the invite link. Friends open it and join.
2. **The private chat.** Each person has a chat only they can see. They type things like "Saturday night only, under $40, no spicy".
3. **The assistant.** Claude records what the person said in a fixed format: times, budget, travel, diet, cuisines, kind of place, and restaurants they name. Each wish is marked mild, strong or must. If the call to Claude fails or a spending limit is reached, a rule-based reader in plain code answers instead.
4. **The candidate list.** A plan with a location gets 20 real restaurants from Google Places when it is created, and up to 160 after a second round of searches for the diets, cuisines and kinds of place people asked for. A plan without a location uses 16 made-up restaurants.
5. **The optimizer.** Code decides the plan; no model is involved. With at most 160 restaurants and 14 hourly start times there are 2,240 options, so it scores every one (about 30 ms, same answer every time).
   - **Who can come.** An option that falls in a time someone is unavailable, breaks their diet, or is something they ruled out keeps that person out.
   - **Each person's score.** Start at 1 and subtract for every wish the option misses: `weight × strength × how far off`. Each of time, budget, travel, cuisine and kind of place weighs a fifth, shifted by the person's own priorities. Strength is 0.5 for mild, 1 for strong, 3 for must. A must is the heaviest weight and not a filter, because two people's musts can contradict each other.
   - **The group's choice.** Fewest people kept out first; then the highest product of everyone's scores, which counts one unhappy person for more than one delighted one.
   - **Ties,** in order: whoever finished first, a restaurant whose main Google type is what someone asked for, a start between 17:00 and 20:00, less travel, the cheaper place.
6. **The result.** The group sees the plan and up to five other restaurants. Groups of three or more see how many can come. Groups of two see no count, because it would be the other person's answer. Nobody's answers or scores are shown.

The negotiation engine that decided plans before the optimizer is still in the repository, because `sim/` measures it. The website no longer runs it.

## Tools and services

| Tool or service | What we use it for |
|---|---|
| **Next.js** (React, TypeScript) | The whole web app: pages and server-side functions. There is no separate backend. |
| **Postgres** on **Neon** | The production database. Locally and in tests, PGlite runs Postgres inside Node. |
| **Anthropic API (Claude)** | Reads private-chat messages into each person's preferences. Nothing else calls a model. |
| **Google Places API** | Finds real restaurants near a plan's location, and turns a typed place into coordinates. |
| **Vercel** | Hosting. The live site is https://cs193v-final.vercel.app. |
| **GitHub Actions** | On every pull request: lint, type check, unit tests (Vitest), a production build, browser tests (Playwright) and a secret scan (gitleaks). |

## Stored information

Everything is in one Postgres database.

| Table | What it holds |
|---|---|
| `users` | Display name and email (both encrypted) and password hash. |
| `sessions` | A hash of each login cookie and when it expires (30 days). |
| `events` | One row per plan: name, invite code, location, date, group size, the restaurant list, and the result. |
| `members` | Who is in which plan, whether they are done and when, and their preferences (encrypted). |
| `messages` | Every private-chat message (encrypted). |
| `rate_limits`, `llm_spend` | Counters for the abuse limits and the spending caps. |

A plan's name, location, date, members, restaurants and result are visible to the group. A person's chat, preferences and starting point are visible only to them. The stored result holds the place, the time, the other places and one count, never anyone's preferences or scores.

People can delete what they stored: a creator can delete a plan, a member can leave one, and anyone can delete their account.

Two kinds of data leave our server:

- **To Claude:** the last 20 messages of one person's chat and that person's own preferences. Deciding a plan sends nothing to a model.
- **To Google Places:** a plan's location, the kinds of place being searched for, and a person's starting point if they give one. Never who asked for what.

## Secrets and user information

Four secrets are in use on the live site: `ENCRYPTION_KEY`, `DATABASE_URL`, `ANTHROPIC_API_KEY` (one team member's own key) and `GOOGLE_PLACES_API_KEY`. Real values live only in a developer's git-ignored `.env.local` and in Vercel's settings, are read only by server-side code, and gitleaks scans the history on every pull request. If one leaks, we rotate it first.

**Protecting personal information**

- **Passwords** are stored only as a salted bcrypt hash. **Login cookies** hold a random token; the database keeps only its hash.
- **Private data is encrypted** with AES-256-GCM before it reaches the database: names, emails, chats, preferences and starting points, and a plan's name, location, date, restaurants and result. Each field of each user or plan has its own key (`ENCRYPTION.md`).
- **Access is checked on the server.** Every function that reads or changes a plan checks membership, and none reads another person's chat or preferences.
- **Everyone's preferences are read together in one place.** Deciding a plan needs all of them, so one module (`optimizer-source.ts`) decrypts them and hands the optimizer people as `p1`, `p2`, … with no names, chat text or start points.
- **Limits:** chat messages, login attempts and new accounts are capped; a person can create 10 plans a day; a plan can be re-run only after someone changes an answer, six times a day at most. Model spending is capped at $1 per person and $10 in total each month (`COST-CONTROLS.md`).
- **Claude's output is checked** before it is saved; anything that does not fit the format is dropped.

Whoever operates the server holds both the database and the encryption key, so they can read everything. The optimizer reads everyone's preferences together on the server, where the earlier negotiation's mediator saw only anonymous counts.

## Open questions

1. **The optimizer's weights are numbers we chose** and have not been checked against people. _Next:_ have two groups of three or four rank their own options and compare each ranking with that person's score.
2. **A "must" limit can still be exceeded.** "At most $20" can end at a $45 place when nothing better exists. _Next:_ ask the class which outcome is fair, and decide whether a broken must becomes its own level.
3. **What a small group can work out from the result,** and that extra accounts get around the three-person rule (#117). _Next:_ write down what each group size can infer and decide what to withhold.
4. **Real groups.** One test so far, with two people outside the team (`docs/user-tests/`). _Next:_ a group of three or more.
5. **Loose ends:** Google's tags are generous and juice bars pass as restaurants; four backend items from `SECURITY-AUDIT.md` are open.
