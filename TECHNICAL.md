# Technical overview

How Settle is put together: the main pieces, the tools and services behind them, what is stored, how private information is protected, and what is still open. `README.md` has the commands and a file-by-file layout; `docs/evaluation.md` has the measurements. This file is the map.

## Main pieces

Settle helps a group pick a restaurant and a time for a weekend meal without anyone having to say their budget out loud. Each person talks to their own private assistant, and the assistants work out a plan between them.

1. **The website.** Pages for signing up and logging in, a home page that lists your plans and lets you start one, a plan page, and an account page. Someone starts a plan, gives it a name and optionally a location, and shares the invite link with the group.
2. **The private chat.** On the plan page each person has a chat that only they can see. They type things like "Saturday night only, under $40, no spicy". The server turns each message into structured constraints: when they are free, their budget, how far they will travel, what they cannot eat, and cuisines they like or dislike.
3. **The extractor.** The part that reads a chat message. There are two: one that calls Claude, used when an Anthropic API key is configured, and a rule-based one written in plain code, used otherwise and as the fallback whenever the model call fails or a plan has used up its daily model budget. Whatever either one records has to be in a plausible range (a budget of $1 to $500, travel of 1 to 180 minutes).
4. **The candidate list.** When a plan is created the server builds the list of restaurants the group could go to. With a Google Places key and a location, these are up to 60 real restaurants nearby. Without one, a built-in list of 16 fictional restaurants is used.
5. **The assistants.** When everyone has marked themselves done, the server builds one assistant per person from their saved constraints. An assistant can answer exactly two kinds of question about a proposed restaurant and time: "accept, reluctant or reject" (with at most one word for why, such as "price"), and its part of a final comparison between finalists.
6. **The mediator.** The part that runs the negotiation. It proposes five options per round for up to six rounds, hears the assistants' answers, and adjusts. It never sees anyone's constraints: only the public restaurant list and counts of answers. The final choice between the best options uses a masked sum, so it does not see individual scores either.
7. **The result.** The group sees the chosen plan ("Sat dinner · Olive Tree Mezze · ~$27/person"). Groups of three or more also see anonymous counts for each option that was tried. Groups of two see only the outcome, because with two people every count would be the other person's answer.
8. **The evaluation harness** (`sim/`). Not part of the website. Scripts that run the negotiation on thousands of made-up groups, on personas derived from the Yelp Open Dataset, and that score the extractors on a set of scripted chats. Their results are in `docs/evaluation.md`.

The pieces that handle private data are kept apart on purpose. Only one module (`vault.ts`) can decrypt constraints, and it hands out assistants, never the constraints themselves. A test reads the code's import graph and fails if the negotiation code can reach the database, the encryption code or the vault.

## Tools and services

| Tool or service | What we use it for |
|---|---|
| **Next.js** (React, TypeScript) | The whole web app: pages, and the server-side functions the pages call. There is no separate backend. |
| **Tailwind CSS** | Styling. |
| **Postgres** | The database. In production this is a hosted Postgres such as **Neon**, reached with the `pg` driver. |
| **PGlite** | Postgres compiled to run inside Node. Used for local development and tests, so nobody has to install a database. |
| **Zod** | Checks the shape of anything that comes from outside: form input, the model's output, stored data. |
| **bcryptjs** | Hashes passwords. |
| **Node's built-in crypto** | Encrypts private data, hashes session tokens, and makes the masks for the final comparison. No third-party crypto library. |
| **Anthropic API (Claude)** | Optional. Reads private-chat messages into constraints, and can optionally re-rank the mediator's shortlist. Default model `claude-haiku-5-5`. |
| **Google Places API (New)** | Optional. Finds real restaurants near a plan's location and turns a typed place into coordinates. |
| **Yelp Open Dataset** | Not a live service. A downloaded file used for the evaluation and, in local development only, as a free source of real restaurants. It is never deployed and never committed. |
| **Vercel** | Hosting. An earlier version of the app is deployed there; this repository is not yet (see Open questions). |
| **GitHub Actions** | On every pull request: lint, type check, unit tests, a production build, browser tests and a secret scan. |
| **Vitest, Playwright** | Unit tests and end-to-end browser tests. |
| **ESLint, Prettier** | Code style. |
| **gitleaks** | Scans the repository's history for committed secrets. |
| **Dependabot** | Opens pull requests for dependency updates. |

The app works with none of the optional services: without an Anthropic key the rule-based extractor answers, and without a Google key the built-in restaurant list is used.

## Stored information

Everything is in one Postgres database, in six tables.

| Table | What it holds |
|---|---|
| `users` | Display name, the email (encrypted, plus a keyed hash used to look it up), and the password hash. |
| `sessions` | A hash of each login cookie, who it belongs to, and when it expires (30 days). |
| `events` | One row per plan: its name, invite code, creator, optional location, the candidate restaurant list, and the result once decided. |
| `members` | Who is in which plan, whether they have marked themselves done, and their constraints (encrypted). |
| `messages` | Every private-chat message, from the person and from their assistant (encrypted). |
| `rate_limits` | Counters for the abuse limits. Emails and IP addresses appear here only as keyed hashes. |

What counts as public and private inside a plan:

- **Public to the group:** the plan's name and location, who has joined and who is done, the restaurant list, and the result.
- **Private to one person:** their chat, their constraints, and, if they gave one, where they are travelling from.

The stored result never contains constraints. For a group of two it contains only the chosen plan and the number of rounds.

People can delete what they stored. A plan's creator can delete the plan; a member can leave it, which removes their constraints and chat; and anyone can delete their account, which removes their account, sessions, memberships, constraints and chats.

Nothing is stored in the browser except the login cookie.

**What leaves our server.** When the optional services are on, some data is sent to them:

- **Anthropic:** the last 20 messages of one person's private chat and that person's own constraints, to read their latest message. Nothing about any other member is included. If the shortlist re-ranker is on, it is sent restaurant names and anonymous answer counts.
- **Google:** the plan's location as typed, and the place a person says they are coming from, to turn them into coordinates.

## Secrets and user information

**Secrets the project uses**

| Secret | What it is for |
|---|---|
| `ENCRYPTION_KEY` | Encrypts private data in the database. Required. |
| `DATABASE_URL` | The Postgres connection string, which includes the database password. |
| `ANTHROPIC_API_KEY` | Optional. Calls Claude. |
| `GOOGLE_PLACES_API_KEY` | Optional. Calls Google Places. |

**How we keep them out of the code**

- Real values live in two places only: a `.env.local` file on a developer's machine, which git ignores, and the hosting provider's environment-variable settings.
- `.env.example` in the repository lists the names with empty values.
- A secret scan (gitleaks) runs over the full git history on every pull request and every push to `main`.
- All four are read only by server-side code. None is sent to the browser.
- If one leaks, the rule in `CONTRIBUTING.md` is to rotate it at the provider first, then remove it from the code.
- `ENCRYPTION_KEY` must never change once there is real data, because everything encrypted with the old key would become unreadable.

**How we protect personal information**

- **Passwords** are never stored. We store a bcrypt hash (salted, cost 12).
- **Emails** are encrypted. To find an account at login we look up a keyed hash of the email, so the database never holds a readable address.
- **Private chats, constraints and starting points** are encrypted with AES-256-GCM before they are written.
- **Login cookies** hold a random token. The database stores only its SHA-256 hash, so a copy of the database cannot be used to log in as someone. The cookie is HTTP-only, and HTTPS-only in production.
- **Access checks** are on the server. Every function that reads or changes a plan takes the acting user and checks they are a member. There is deliberately no function that reads another person's chat or constraints.
- **The negotiation never sees constraints.** It gets assistants that answer accept, reluctant or reject, plus a masked message for the final comparison.
- **Abuse limits:** 30 chat messages per person per 10 minutes, 300 model calls per plan per day, 10 login attempts per email and 50 per IP address per 15 minutes, and 10 new accounts per IP address per hour.
- **Out-of-range values** from either extractor are dropped, and model output that does not fit the expected shape is discarded.

**What this does not protect against.** Anyone who has both the database and the `ENCRYPTION_KEY` can read everything, and our server necessarily has both. The privacy guarantees are about what other members of a plan can see and what the negotiation code can reach, not about hiding data from whoever operates the server. Plan names, locations, results and display names are stored unencrypted.

## Open questions

1. **This repository has not been deployed.** The "Live site" link in the README points at a deployment built from an earlier repository. *Next:* create the hosted Postgres database, set `ENCRYPTION_KEY` and `DATABASE_URL` in the hosting project, deploy from this repository, then sign up and run one two-person plan on the live site and update the link.
2. **Real restaurants in production.** The Google Places integration works locally but no key is set for a deployment, and we have not checked what it costs at our volume (up to 7 calls per new plan). *Next:* read the current pricing, set a daily quota and a budget alert, add the key to the hosting project, and create one plan with a real location.
3. **How the model behaves when someone tries to manipulate it.** We built a set of 48 scripted chats, 16 of them adversarial, and scored the rule-based extractor on it (78% of fields right on ordinary chats, no violations). The model has not been run on it. *Next:* run `npm run sim:extract -- --llm` with a key and add the results to `docs/evaluation.md`, looking first at how often the model call fails and falls back to the rules.
4. **Other languages.** The rule-based extractor reads English only; on the non-English chats it gets 30% of fields right. *Next:* see how the model does on the same chats, then decide whether the rule-based fallback needs to say "I only understand English" instead of guessing.
5. **Hotel picking.** We wanted a second kind of plan. The code now has a place where a second scenario plugs in, but no hotel scenario exists, and we found no free source of hotel prices (Booking.com needs a partner contract). *Next:* decide whether to build it on a small built-in list first or to drop it.
6. **Privacy against the server itself.** Everything above trusts the server. Keeping constraints from the server would mean running each assistant on its owner's device. *Next:* none planned for this course; it is written up as a limit in `docs/evaluation.md`.
7. **Unlimited re-runs.** A member can change their own answers and re-run a plan as often as they like, watching how the outcome moves, which slowly reveals the other members' limits. *Next:* decide on a cap or a cool-down, and open an issue for it.
8. **Realistic test groups.** On personas built from Yelp reviewers the negotiation agrees almost at once, largely because those personas have almost no price or dietary limits. We cannot yet say how it does on real friends with real constraints. *Next:* try it with a few real groups and compare what they say with what the plan gave them.
