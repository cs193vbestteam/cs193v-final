# Settle

Group plans without the group-chat drama. Everyone tells **their own private assistant** their real constraints (budget, when they're free, what they won't eat, how far they'll travel). The assistants then negotiate a plan without leaking anyone's numbers. The group only sees the final answer: *"Sat dinner · Olive Tree Mezze · ~$27/person · everyone's in."*

It covers one kind of plan: picking a restaurant and a start time for a meal on a day the plan's creator chooses.

For how the system is put together, what it stores and how private data is protected, see [TECHNICAL.md](TECHNICAL.md).

## See it live

**Live site:** https://cs193v-final.vercel.app

On the live site Claude reads the private chat and runs the negotiation, and the restaurants are a built-in list of 16 fictional ones. Real restaurants from Google Places are built but not switched on yet.

To try the whole flow there you need two people, or two browser windows: sign up in one, start a plan and copy the invite link, then open the link in a private (incognito) window and sign up as a second person. Tell each assistant something like `Saturday dinner, under $40, 20 minutes, no restrictions`, press "I'm done" in both, then "Find a plan".

## Run your own copy

To run it on your own machine you need [Node.js](https://nodejs.org) 22 or newer. Nothing else: no database to install and no API keys.

```bash
git clone https://github.com/cs193vbestteam/cs193v-final.git
cd cs193v-final
npm install
cp .env.example .env.local
npm run gen-key
```

`npm run gen-key` prints a random key. Open `.env.local` and paste it after `ENCRYPTION_KEY=`. Then:

```bash
npm run dev
```

and open http://localhost:3000.

**Try the whole flow on your own:**

1. Sign up in a normal browser window, start a plan, and copy the invite link.
2. Open the link in a private (incognito) window, sign up as a second person, and join.
3. In each window, tell the assistant something like `Saturday dinner, under $40, 20 minutes, no restrictions`, then press "I'm done".
4. Press "Find a plan" in either window.

Out of the box the app stores its data in a local folder (`.pglite/`), reads the chat with a rule-based extractor, and offers 16 built-in fictional restaurants. The two optional keys below switch on the real services.

### Optional: Claude and real restaurants

Add either of these to `.env.local` and restart `npm run dev`.

| Variable | What it switches on | Where to get it |
|---|---|---|
| `ANTHROPIC_API_KEY` | Claude reads the private chat instead of the rule-based extractor. | [console.anthropic.com](https://console.anthropic.com) |
| `GOOGLE_PLACES_API_KEY` | A plan created with a location gets up to 60 real restaurants nearby, with their Google rating, address and a Maps link. | Google Cloud Console: enable **Places API (New)**, create an API key, and restrict it to that API. |

Both are paid services billed to whoever owns the key. Set a quota or budget alert on the Google key: each new plan with a location makes up to 12 calls (one to find the location, one general search, one per cuisine). With an Anthropic key, Claude also runs the negotiation: each person's assistant is LLM-driven, Claude chooses what to propose each round, and it writes one sentence about the final plan; hard rules and the final pick stay in code. Set `SETTLE_LLM_NEGOTIATION=0` to use the code-only negotiation instead. A negotiation makes at most 7 calls per person plus 7 for the mediator (35 for four people), usually far fewer.

### Put your own copy online

1. **Database.** Create a free Postgres database at [Neon](https://neon.tech) and copy its connection string (it starts with `postgresql://`).
2. **Hosting.** Import this repository into [Vercel](https://vercel.com) as a new project. On our team one person does the deploys.
3. **Environment variables.** In the Vercel project's settings, add:
   - `ENCRYPTION_KEY`: the output of `npm run gen-key`. Use a new one, not the one from your laptop.
   - `DATABASE_URL`: the Neon connection string.
   - `ANTHROPIC_API_KEY` and `GOOGLE_PLACES_API_KEY`, if you want Claude and real restaurants.
4. **Deploy.** The tables are created automatically on the first request. Sign up on the deployed site to check it. If you add or change a variable later, redeploy: Vercel does not apply it to a deployment that already exists. If sign-up fails with "Something went wrong", the usual cause is that `DATABASE_URL` is missing, is not enabled for Production, or does not start with `postgresql://`.

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

[TECHNICAL.md](TECHNICAL.md) is the plain-language overview. This section is the module-by-module reference.

```
 private chat (per person)          server                         group view
 ─────────────────────────   ─────────────────────────────   ──────────────────────
 "Sat night only, under $40, →  extract → Constraints JSON   
  no spicy"                     (LLM or rule-based)            
                                 │ AES-GCM encrypted in DB    
                                 ▼                            
                             each member → opaque Assistant   
                             (p) => yes | meh | no + reason   
                                 │                            
                             negotiate(): propose → ask all   →  "Everyone's in ✓"
                             → adapt from verdicts → repeat      + anonymous round counts
```

- **Elicitation** (`src/lib/assistant.ts`, `assistant-prompt.ts`, `member-state.ts`): the private chat. Claude, via tool use, lets the person say what they want in their own words, follows up once on anything vague, and asks about what was not mentioned (time, budget, travel, anything they cannot eat, cuisine), each at most once and never more than 8 replies in all. Which questions are still allowed, and when they stop, is decided by code, not by the prompt. What it records is the format the optimizer reads (`src/lib/optimizer-input.ts`): limits versus wishes, how much each matters (`must`, `strong`, `mild`), an ideal and a maximum for budget and travel, restaurants named by the person (matched to candidates by code), and private notes such as allergies that no restaurant data can confirm. Every block the model returns is validated on its own; one that does not fit is dropped and the reply says so. Without `ANTHROPIC_API_KEY`, or when a call fails or the plan's daily model budget is spent, a rule-based reader (`extract-rules.ts`) answers instead: a safety net that understands times, budgets, distances and a few diets, and none of the rest. Until the optimizer lands, `legacy-adapter.ts` converts what is stored into the older `Constraints` the negotiation engine reads. `npm run sim:extract` measures the safety net; with `-- --llm` it also measures the assistant on its own cases (`docs/evaluation.md`).
- **Preferences** (`src/lib/preferences.ts`): compiles constraints into the negotiation contract: `hard` rules (violate one → reject), weighted `soft` rules (0..1 satisfaction, weighted mean = utility) and a `concession_order`.
- **Evaluation** (`src/lib/evaluate.ts`): the code agent, deterministic. utility ≥ 0.7 → accept, ≥ 0.4 → reluctant, else reject; hard violation → reject. Returns only the verdict plus at most one dimension name. `bucket()` gives a 1–5 utility bucket for the final fairness step.
- **Mediator + protocol** (`src/lib/mediator.ts`, `negotiate.ts`): the mediator sees only the public candidate pool and anonymised tallies. The result is a shortlist, not one plan: after the first agreement it keeps looking until six different places are options nobody rejects, ranked for the group, best first. 5 proposals per round, up to 6 rounds; from round 4 every assistant concedes one more step of its own order (soft tolerances ×1.5, hard never moves) and the nearest earlier misses are asked again. Final choice among the best feasible options by Nash product of everyone's 1 to 5 bucket, compared through a pairwise-masked sum so the mediator never receives a bucket (`masked-sum.ts`). An optional LLM may re-rank the shortlist, never widen it. `exploreRounds` (off by default) keeps going for more rounds after the first unanimous accept and picks among every unanimous candidate seen; `docs/evaluation.md` measures what that buys and costs.
- **Isolation** (`src/lib/vault.ts`, `tests/isolation.test.ts`): only the vault decrypts preferences, and it only hands out opaque agents; a test walks the import graph of the negotiation modules and fails if any can reach storage, crypto or the vault.
- **LLM negotiation** (`src/lib/agent-llm.ts`, `mediator-llm.ts`; on whenever `ANTHROPIC_API_KEY` is set, `SETTLE_LLM_NEGOTIATION=0` switches back to code): each person's agent is one LLM call per round that sees only that person's own summary (their words, avoid-notes, priorities) and the public facts of the round's options. The LLM mediator proposes each round from the code's shortlist and writes one sentence for the group about the final plan. The final pick itself stays in code (highest Nash product among the finalists, from the masked sum), so it is fair by construction, reproducible given the verdicts, and still what `docs/evaluation.md` measures. Code keeps the LLM parts honest: a hard rule always wins over the model, proposals can only come from the shortlist, the sentence sees only the chosen plan's public facts and is dropped if it mentions votes or individuals, and any failure, timeout or exhausted daily LLM budget falls back to code for that step. A fallback is never more permissive than the model: an option the model already judged keeps that verdict, and for someone whose own words the code can't check (`avoidNotes`, e.g. an allergy) a code fallback never says "accept", so such an option can't become "everyone's in" without the model. New LLM calls stop 30 s into a negotiation so it fits the route's 60 s limit. Limitation: with no key or `SETTLE_LLM_NEGOTIATION=0`, the code agents cannot read `avoidNotes` at all; only the four diet flags are enforced, and the chat says so when it records such a note. Verdicts are no longer reproducible run to run; `npm run sim` still measures the code agents.
- **Candidates** (`src/lib/places.ts`, `pool.ts`): with `GOOGLE_PLACES_API_KEY`, real restaurants near the plan's location (opening hours → the start times a place can take on the plan's date, price level → $/person, distance → minutes); otherwise a seeded set. Nearby Search returns at most 20 places per call, so the pool is gathered from one general query plus one query per cuisine, merged and de-duplicated by place id. Places that are closed, or rated under 3.5 by 20 or more reviewers, are left out, and the mediator tries better-rated places first among otherwise similar ones: up to 60 restaurants from at most 6 Nearby Search calls per plan. For free local development, `YELP_DATASET_DIR` can point at the Yelp Open Dataset instead (`yelp-pool.ts`; it only works under `npm run dev` and is ignored in production builds, see `sim/yelp/README.md`).
- **Per-person travel** (`src/lib/geo.ts`, `start-point.ts`, `agent.ts`): on a plan with real places, each assistant asks (optionally) where its person is coming from. The place is geocoded once, stored encrypted with their constraints, and handed by the vault to that person's agent only, which judges every candidate on their own trip. The mediator and the group result never see a start point or a per-person travel time; the result omits travel time for these plans. Without a start point, or on the seed pool, travel is measured from the plan's location.
- **Evaluation harness** (`sim/`, `npm run sim`): 200 synthetic groups, brute-force no-privacy oracle, naive baseline, Nash / max-min ratios, leaked dimension names. See `sim/README.md` and `docs/evaluation.md`.
- **Evaluation on real reviewers** (`sim/yelp/`, `npm run sim:yelp`): the same comparison with restaurants, personas and friend groups from the Yelp Open Dataset. The dataset is not in this repository: it is for educational, non-commercial use under Yelp's Dataset User Agreement and may not be redistributed. See `sim/yelp/README.md`.
- **Privacy:** private chat messages, constraints and emails are encrypted at rest (AES-256-GCM). Emails are looked up through an HMAC blind index. Passwords use bcrypt (salted, cost 12). Session cookies are random tokens, and only their SHA-256 hashes are stored.
- **Small groups** (`forGroupSize` in `src/lib/events.ts`): with two people every "anonymous" count would be the other person's answer, so a plan with fewer than three members stores and shows only the outcome and the number of rounds. See "Privacy budget" in `docs/evaluation.md` for what still shows at each size.
- **Abuse limits** (`src/lib/ratelimit.ts`): fixed-window counters in the database, so they hold across serverless instances. 30 chat messages per person per 10 minutes; 300 LLM calls per plan per day, after which replies come from the rule-based extractor; 10 sign-in attempts per email and 50 per IP per 15 minutes; 10 new accounts per IP per hour. Emails and IPs are stored only as HMACs.

## Project layout

```
src/
  app/                 Next.js App Router pages + server actions (actions.ts)
    e/[code]/page.tsx  plan page: private chat + group panel
  components/          client components (chat, auth form, buttons)
  lib/
    scenario.ts        what a group is deciding (today: a meal); the one place a new scenario plugs in
    constraints.ts     what the private chat collects (+ weights, concession order, pending question)
    extract*.ts        chat → constraints (LLM or rules; probes for weights and concessions)
    preferences.ts     hard / soft / concession_order contract; compile(), relax()
    evaluate.ts        utility, verdict + one dim, buckets (pure)
    agent.ts           opaque per-person assistant (judge / masked compare); maskGroup() is what the mediator gets
    masked-sum.ts      pairwise masks: the mediator learns a group sum, never one person's value
    mediator.ts        proposer from tallies alone; the LLM proposer and the plan's sentence are in mediator-llm.ts
    agent-llm.ts       a person's LLM agent: one call per round, guarded by the hard rules
    negotiate.ts       rounds, concessions, final pick by Nash product from a masked sum
    vault.ts           the only module that decrypts preferences → agents
    places.ts, pool.ts Google Places adapter and the per-plan candidate pool
    restaurants.ts     seed pool (used when Places is off)
    crypto.ts          AES-GCM, blind index, tokens
    auth.ts, session.ts
    db.ts, events.ts   Postgres schema + data access with membership checks
sim/                   synthetic-group evaluation (oracle, baselines, report + chart)
docs/evaluation.md     the evaluation chapter of the report
tests/                 vitest suites
```

## Ideas for next steps

- Run each assistant on its owner's device, with keys agreed between devices, so the masked final pick also holds against the server
- More kinds of plan: trips, roommate chores, splitting rent
