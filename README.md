# Settle

Group plans without the group-chat drama. Everyone tells **their own private assistant** their real constraints (budget, when they're free, what they won't eat, how far they'll travel). A program then scores every restaurant and start time against what each person said and picks the plan the most people can come to and that suits the group best. Nobody's numbers are shown. The group only sees the answer: *"Sat dinner · Olive Tree Mezze · ~$27/person · everyone can come."*

It covers one kind of plan: picking a restaurant and a start time for a meal on a day the plan's creator chooses.

For how the system is put together, what it stores and how private data is protected, see [TECHNICAL.md](TECHNICAL.md).

## See it live

**Live site:** https://cs193v-final.vercel.app

On the live site Claude reads each person's private chat, and code chooses the plan, with no model involved. A plan created with a location picks from real restaurants from Google Places. One created without a location picks from 16 made-up ones, and the plan page says so.

To try the whole flow you need two people, or two browser windows:

1. Sign up, start a plan (a name, a location if you want real restaurants, a date, and the most people it can hold), and copy the invite link.
2. Open the link in a private (incognito) window and sign up as a second person.
3. Tell each assistant something like `Saturday dinner, under $40, 20 minutes, no restrictions`, and press "I'm done" in both windows.

The plan appears in both windows when the second person is done. Nobody has to press anything else.

## Run your own copy

**You need** [Node.js](https://nodejs.org) 22.22.2 or newer on 22, or 24.15 or newer (`.nvmrc` says 24; with nvm, `nvm install && nvm use`). An older Node prints `EBADENGINE` warnings on `npm install`. Nothing else: no database to install and no API keys.

**1. Get the code and install it.**

```bash
git clone https://github.com/cs193vbestteam/cs193v-final.git
cd cs193v-final
npm install
```

**2. Make your settings file and an encryption key.**

```bash
cp .env.example .env.local
npm run gen-key
```

`npm run gen-key` prints a random key. Open `.env.local` and paste it after `ENCRYPTION_KEY=`.

**3. Start it.**

```bash
npm run dev
```

Open http://localhost:3000 and follow the three steps under [See it live](#see-it-live), with two browser windows.

That is a complete working copy. With no keys it stores its data in a local folder (`.pglite/`), reads the chat with a rule-based extractor instead of Claude, and offers 16 made-up restaurants. To see the plan-choosing code on real restaurant data without any keys, open http://localhost:3000/optimizer-demo: it runs nine recorded groups from three areas.

### Optional: Claude and real restaurants

Add either of these to `.env.local` and restart `npm run dev`.

| Variable | What it switches on | Where to get it |
|---|---|---|
| `ANTHROPIC_API_KEY` | Claude reads the private chat instead of the rule-based extractor. | [console.anthropic.com](https://console.anthropic.com) |
| `GOOGLE_PLACES_API_KEY` | A plan created with a location picks from real restaurants nearby (20 to start, up to 160 once everyone has said what they want), with their Google rating, address and a Maps link. | Google Cloud Console: enable **Places API (New)**, create an API key, and restrict it to that API. |

Both are paid services billed to whoever owns the key.

- **Google:** a plan with a location makes at most 9 calls: one to find the location and one general search when it is created, then, when everyone is done chatting, one search for each diet, cuisine or kind of place somebody asked for (7 at most).
- **Anthropic:** only the private chat calls a model. A plan is decided by code (`src/lib/optimizer.ts`).
- **Limits in the app** (`src/lib/spend.ts`, `src/lib/ratelimit.ts`): one person can create 10 plans a day. Once a person's chat has cost $1 in a calendar month, or the whole app $10, the rule-based code answers instead of Claude until the month ends (`LLM_MONTHLY_CAP_PER_USER_USD`, `LLM_MONTHLY_CAP_TOTAL_USD`).

These limits count what the app asked for. Also set a spend limit on the Anthropic account and a budget on the Google Cloud project, which hold even if the app's counting is wrong.

### Put your own copy online

1. **Database.** Create a free Postgres database at [Neon](https://neon.tech) and copy its connection string (it starts with `postgresql://`).
2. **Hosting.** Import this repository into [Vercel](https://vercel.com) as a new project.
3. **Environment variables.** In the Vercel project's settings, add:
   - `ENCRYPTION_KEY`: the output of `npm run gen-key`. Use a new one, not the one from your laptop.
   - `DATABASE_URL`: the Neon connection string.
   - `ANTHROPIC_API_KEY` and `GOOGLE_PLACES_API_KEY`, if you want Claude and real restaurants.
4. **Deploy,** then sign up on the deployed site to check it. The tables are created on the first request.

If something goes wrong:

- Sign-up fails with "Something went wrong": `DATABASE_URL` is missing, is not enabled for Production, or does not start with `postgresql://`.
- A variable you added or changed has no effect: redeploy. Vercel does not apply it to a deployment that already exists.

Never change `ENCRYPTION_KEY` once there is real data: everything encrypted with the old key becomes unreadable. Never commit `.env.local` or any real key; `CONTRIBUTING.md` says what to do if one leaks.

Any Postgres and any Node host work the same way; Neon and Vercel are what we chose.

## Tests

```bash
npm test          # unit tests (Vitest)
npm run typecheck
npm run lint
npm run test:e2e  # two people go from sign-up to a plan in a real browser (Playwright)
```

The browser tests need a one-time `npx playwright install chromium`. CI runs all of these, a production build and a secret scan on every pull request (`.github/workflows/`).

## How it works

The picture below is the whole flow. [TECHNICAL.md](TECHNICAL.md) is the plain-language overview.

```
 private chat (per person)          server                           group view
 ─────────────────────────   ──────────────────────────────   ────────────────────────
 "Sat night only, under $40, →  assistant → preferences JSON
  no spicy"                     (Claude or rule-based)
                                 │ AES-GCM encrypted in DB
                                 ▼
                             when everyone is done:
                             the optimizer scores every      →  "Everyone can come ✓"
                             restaurant × start time             or "Works for 3 of 4"
                             (code, no model)                    + up to 5 other places
```

## Reference

You do not need anything below to run Settle. It is here for readers who want to know what each part does and where it lives in the code.

### The parts, one by one

- **Elicitation** (`src/lib/assistant.ts`, `assistant-prompt.ts`, `member-state.ts`): the private chat. Claude lets the person say what they want in their own words and asks about what they left out (time, budget, travel, diet, cuisine), in at most 8 replies; code decides which questions are still allowed. It records what the optimizer reads (`optimizer-input.ts`): what the person cannot do, what they would like, and how much each wish matters (`must`, `strong`, `mild`). Anything the model returns that does not fit that format is dropped. With no `ANTHROPIC_API_KEY`, or when a call fails or a spending limit is reached, a simpler rule-based reader (`extract-rules.ts`) answers instead.
- **Deciding a plan** (`src/lib/optimizer.ts`, `optimizer-source.ts`, `optimizer-handoff.ts`): when everyone is done, code scores every restaurant and start time against what each person's chat recorded. It picks the one the fewest people are kept out of, then the one that suits the group best. No model is involved. The group sees the place, the time, up to five other places and how many can come.
- **Candidates** (`src/lib/places.ts`, `pool.ts`): with `GOOGLE_PLACES_API_KEY`, real restaurants near the plan's location (opening hours → the start times a place can take on the plan's date, price level → $/person, distance → minutes); otherwise a seeded set. Nearby Search returns at most 20 places per call, so a plan starts with one general query and is widened once everyone is done chatting (`pool-extend.ts`, `pool-refresh.ts`): one more query per cuisine or kind of place somebody asked for, merged and de-duplicated by place id. Places whose food is none of the ten cuisines the earlier negotiation engine knew are in the pool too: the optimizer reads Google's own types. Places that are closed, or rated under 3.5 by 20 or more reviewers, are left out, and the mediator tries better-rated places first among otherwise similar ones: up to 160 places from at most 8 Nearby Search calls per plan. For free local development, `YELP_DATASET_DIR` can point at the Yelp Open Dataset instead (`yelp-pool.ts`; it only works under `npm run dev` and is ignored in production builds, see `sim/yelp/README.md`).
- **Per-person travel** (`src/lib/geo.ts`, `start-point.ts`, `optimizer-handoff.ts`): on a plan with real places, a person can say where they are coming from. The place is geocoded once and stored encrypted with their preferences. When the plan is decided it is turned into that person's travel minutes to each place; the start point itself is not in the optimizer's input and never reaches the group. Without a start point, or on the seed pool, travel is measured from the plan's location.
- **Evaluation harness, for the earlier negotiation engine** (`sim/`, `npm run sim`): it measures the negotiation that decided plans before the optimizer, not the optimizer. 200 synthetic groups, brute-force no-privacy oracle, naive baseline, Nash / max-min ratios, leaked dimension names. See `sim/README.md` and `docs/evaluation.md`.
- **Evaluation on real reviewers, also for the earlier engine** (`sim/yelp/`, `npm run sim:yelp`): the same comparison with restaurants, personas and friend groups from the Yelp Open Dataset. The dataset is not in this repository: it is for educational, non-commercial use under Yelp's Dataset User Agreement and may not be redistributed. See `sim/yelp/README.md`.
- **Privacy:** private chat messages, constraints and emails are encrypted at rest (AES-256-GCM). Emails are looked up through an HMAC blind index. Passwords use bcrypt (salted, cost 12). Session cookies are random tokens, and only their SHA-256 hashes are stored.
- **Small groups** (`forGroupSize` in `src/lib/events.ts`): with two people every "anonymous" count would be the other person's answer, so a plan with fewer than three members stores and shows only the plan and the other places on the list, with no count of who can come. A plan only one of the two could come to is shown as no plan.
- **Abuse limits** (`src/lib/ratelimit.ts`): fixed-window counters in the database, so they hold across serverless instances. 30 chat messages per person per 10 minutes; 300 LLM calls per plan per day, after which replies come from the rule-based extractor; 10 sign-in attempts per email and 50 per IP per 15 minutes; 10 new accounts per IP per hour. Emails and IPs are stored only as HMACs.

### Project layout

```
src/
  app/                   Next.js App Router pages + server actions (actions.ts)
    e/[code]/page.tsx    plan page: private chat + group panel
    optimizer-demo/      development-only page: the optimizer on nine recorded groups
  components/            client components (chat, result card, auth form, buttons)
  lib/
    scenario.ts          what a group is deciding (today: a meal); the one place a new scenario plugs in
    assistant*.ts        the private chat: Claude fills in the preferences; the limits are kept in code
    extract*.ts          the rule-based reader, used with no key or past the spending caps
    member-state.ts      what is stored for each person
    cuisine-table.ts     cuisines and kinds of place in Google Places' vocabulary
    optimizer-input.ts   the format the optimizer reads: plan, person, restaurant
    optimizer-source.ts  loads a plan as the optimizer's input (the one place that reads everyone's preferences together)
    optimizer-handoff.ts builds that input and checks the result
    optimizer.ts         decides a plan: scores every place and start time (no model)
    places.ts, pool*.ts  Google Places adapter; the per-plan pool and its second round of searches
    opening-hours.ts     which start times a place can take on the plan's date
    restaurants.ts       seed pool (used when Places is off)
    spend.ts, ratelimit.ts  spending caps and abuse limits
    crypto.ts            AES-GCM, blind index, tokens
    auth.ts, session.ts
    db.ts, events.ts     Postgres schema + data access with membership checks
sim/                     synthetic-group evaluation of the negotiation; the optimizer's recorded cases
docs/                    evaluation.md (the evaluation chapter) and user-tests/ (notes from user tests)
tests/                   vitest suites
```

Not part of the workflow above: the earlier negotiation engine. It no longer decides plans. Its files are kept because `npm run sim` and `docs/evaluation.md` measure it, and because the result card still shows plans it decided before the change.

```
src/lib/
    preferences.ts       hard and soft rules compiled from a person's constraints
    evaluate.ts          one person's verdict on a proposal: accept, reluctant or reject
    agent.ts, masked-sum.ts  a per-person assistant, and the masked comparison of finalists
    mediator.ts          proposes options from anonymous tallies
    negotiate.ts         the rounds, concessions and final pick
```

### Ideas for next steps

- Check the optimizer's weights against what real groups choose (`PROGRESS.md` has the plan)
- Decide a plan without the server reading everyone's preferences together, which `optimizer-source.ts` does today
- More kinds of plan: trips, roommate chores, splitting rent
