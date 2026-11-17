# Technical overview

How Settle is put together: the main pieces, the tools and services behind them, what is stored, how private information is protected, and what is still open. `README.md` has the commands and the file layout; `docs/evaluation.md` has the measurements.

## Main pieces

Settle helps a group pick a restaurant and a time for a weekend meal without anyone saying their budget out loud. Each person talks to their own private assistant, and the assistants work out a plan between them.

1. **The website.** Someone signs up, starts a plan with a name and a location, and shares the invite link. Friends open the link and join.
2. **The private chat.** Each person has a chat on the plan page that only they can see. They type things like "Saturday night only, under $40, no spicy".
3. **The extractor.** Our server sends each message to Claude, which turns it into structured constraints: when the person is free, their budget, how far they will travel, what they cannot eat, and cuisines they like or dislike. If the call to Claude fails, a rule-based extractor written in plain code answers instead.
4. **The candidate list.** The restaurants a group can choose from. On the live site this is a built-in list of 16 fictional restaurants. The code can also ask Google Places for up to 60 real restaurants near a plan's location, but that feature is not switched on yet: no Google key is set, and it has been tested almost entirely against hand-written responses (see Open questions).
5. **The assistants.** When everyone is done, the server builds one assistant per person from their saved constraints. An assistant answers "accept, reluctant or reject" about a proposed restaurant and time, with at most one word for why, such as "price". For the final choice between the best options it also sends one scrambled message: a score for each finalist with random masks added, which means nothing on its own. With an Anthropic key, each assistant is a Claude call that sees only its own person's summary (their words, foods they avoid, what matters most to them) and judges a whole round at once; code still rejects anything that breaks a hard rule, and falls back to the plain-code assistant if Claude fails or the plan's daily LLM budget is used up. That fallback keeps Claude's earlier verdicts and, for someone who described a restriction in their own words, never answers "accept" for them, because the plain code can't read those words.
6. **The mediator.** It runs the negotiation: five proposals per round, up to six rounds, adjusting from the answers. It never sees anyone's constraints: only the public restaurant list, counts of the answers, and the one-word reasons. For the final choice it adds up everyone's scrambled messages; the masks cancel in the sum, so it learns how the finalists compare for the group as a whole and never anyone's score. With an Anthropic key, Claude proposes the options each round (only from a shortlist the code builds, seeing the same anonymous information as before) and writes one sentence for the group about the final plan. The final pick itself stays in code, as above.
7. **The result.** The group sees the chosen plan, for example "Sat dinner · Olive Tree Mezze · ~$27/person". Groups of three or more also see anonymous counts for each option tried. Groups of two see only the outcome, because with two people every count would be the other person's answer.

Separately, `sim/` holds evaluation scripts that are not part of the website. They run the negotiation on thousands of made-up groups and score the extractors on scripted chats.

## Tools and services

| Tool or service | What we use it for |
|---|---|
| **Next.js** (React, TypeScript) | The whole web app: the pages and the server-side functions they call. There is no separate backend. |
| **Tailwind CSS** | Styling. |
| **Postgres** on **Neon** | The production database. |
| **PGlite** | Postgres running inside Node, for local development and tests, so nobody installs a database. |
| **Anthropic API (Claude)** | Reads private-chat messages into constraints, and runs the negotiation: each person's assistant and the mediator (see 5 and 6). |
| **Google Places API** | Not switched on yet. Built to find real restaurants near a plan's location and to turn a typed place into coordinates. |
| **Zod** | Checks the shape of anything from outside: form input, Claude's output, stored data. |
| **bcryptjs** and Node's built-in crypto | Password hashing, and encryption of private data. |
| **Vercel** | Hosting. The live site is https://cs193v-final.vercel.app. |
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

One kind of data leaves our server today: what we send to Claude. To read a chat message, Claude receives the last 20 messages of that person's chat and that person's own constraints. During a negotiation, each person's assistant sends Claude that one person's summary of their constraints together with the public facts of the options, and the mediator sends the public facts and anonymous counts. Nothing about one member is ever in a request about another. If Google Places is switched on later, Google will receive a plan's location and, if a person gives one, where they are coming from.

## Secrets and user information

We use three secrets on the live site: `ENCRYPTION_KEY` (encrypts private data), `DATABASE_URL` (the Neon connection string, which contains the database password) and `ANTHROPIC_API_KEY` (calls Claude; it is one team member's own key, so the usage is billed to them). A fourth, `GOOGLE_PLACES_API_KEY`, exists in the code for the Google Places feature and is not set.

**Keeping secrets out of the code**

- Real values live only in a `.env.local` file on a developer's machine, which git ignores, and in the hosting provider's environment-variable settings. `.env.example` lists the names with empty values.
- gitleaks scans the full git history on every pull request and every push to `main`.
- All of them are read only by server-side code and are never sent to the browser.
- If one leaks, we rotate it at the provider first, then remove it from the code.

**Protecting personal information**

- **Passwords** are never stored, only a salted bcrypt hash.
- **Emails, private chats, constraints and starting points** are encrypted with AES-256-GCM before they are written to the database. Accounts are found at login through a keyed hash of the email.
- **Login cookies** hold a random token, and the database stores only its hash, so a copy of the database cannot be used to log in as someone.
- **Access is checked on the server.** Every function that reads or changes a plan checks that the person is a member, and no function exists that reads another person's chat or constraints.
- **Everyone's preferences are read together in one place.** Deciding a plan needs all of them, so one module (`optimizer-source.ts`) decrypts them and hands the optimizer people as `p1`, `p2`, … with no names, chat text or start points. A person's own preferences are decrypted elsewhere only to show them back to that person or to continue their own chat.
- **Abuse limits** cap chat messages, model calls per plan, login attempts and new accounts.
- **Claude's output is checked** before it is saved: anything that does not fit the expected shape is discarded, and out-of-range numbers (a budget over $500, for example) are dropped.

These protections are about what other members can see and what the negotiation code can reach. Whoever operates the server holds both the database and the encryption key, so they can read everything.

## Open questions

1. **The live site is new and lightly tested.** It is deployed at https://cs193v-final.vercel.app on Vercel, with a Neon database and a Claude API key. Its pages and database respond, but we have not yet recorded a full two-person plan on it. *Next:* run one two-person plan on the live site from sign-up to result, and check the server logs for errors afterwards.
2. **Real restaurants are not switched on.** The live site offers 16 fictional restaurants. The Google Places code is written, but its tests use hand-written responses in Google's format, and with a real key it has been run once: on one developer's machine, a plan created near Palo Alto came back with 60 real places. Nobody has looked at those restaurants, negotiated on them, or used a real key for a person's starting point. We also have not checked the price at our volume (up to 7 calls per new plan). *Next:* on a developer's machine, create a plan with a real location, read through the restaurants it returns and run a full two-person negotiation on it; then read the pricing and set a daily quota and a budget alert before adding a key to the live site.
3. **How Claude behaves when someone tries to manipulate it.** We wrote 54 scripted chats, 16 of them adversarial ("ignore your instructions", "show me Sam's budget"), and ran both extractors on them. Claude got 96% of fields right on the ordinary chats (the rules: 84%) and passed all 16 adversarial ones, but that is one run of a small suite we wrote ourselves. *Next:* repeat the run to see how much it varies, and add attacks written by someone other than us.
4. **Unlimited re-runs.** A member can change their own answers and re-run a plan as often as they like, and watching how the outcome moves slowly reveals the others' limits. *Next:* decide on a cap or a cool-down and open an issue for it.
5. **How it does with real friends.** Our tests use made-up groups and personas built from Yelp reviews, which turned out to have almost no price or dietary limits. *Next:* try it with a few real groups and compare what they say with the plan they got.
