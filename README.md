# Settle

**Live site:** https://miniproject-europium.vercel.app

Group plans without the group-chat drama. Everyone tells **their own private assistant** their real constraints (budget, when they're free, what they won't eat, how far they'll travel). The assistants then negotiate a plan without leaking anyone's numbers. The group only sees the final answer: *"Sat dinner · Olive Tree Mezze · ~$27/person · everyone's in."*

v1 covers one scenario: picking a restaurant and time for a weekend meal.

## How it works

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

- **Elicitation** (`src/lib/extract.ts`, `extract-rules.ts`): turns the private chat into a typed `Constraints` object (`src/lib/constraints.ts`). Refuses "whatever" with an either/or, then asks two trade-offs (weights) and a concession-order question. Uses Claude via tool use if `ANTHROPIC_API_KEY` is set, otherwise a tested rule-based path. Whatever either one records must be in a plausible range (`UPDATE_LIMITS`: a budget of $1 to $500, travel of 1 to 180 minutes); out-of-range numbers are dropped and the reply says so. `npm run sim:extract` scores both on a transcript suite that includes prompt injection (`docs/evaluation.md`).
- **Preferences** (`src/lib/preferences.ts`): compiles constraints into the negotiation contract: `hard` rules (violate one → reject), weighted `soft` rules (0..1 satisfaction, weighted mean = utility) and a `concession_order`.
- **Evaluation** (`src/lib/evaluate.ts`): deterministic, no LLM. utility ≥ 0.7 → accept, ≥ 0.4 → reluctant, else reject; hard violation → reject. Returns only the verdict plus at most one dimension name. `bucket()` gives a 1–5 utility bucket for the final fairness step.
- **Mediator + protocol** (`src/lib/mediator.ts`, `negotiate.ts`): the mediator sees only the public candidate pool and anonymised tallies. 5 proposals per round, up to 6 rounds; from round 4 every assistant concedes one more step of its own order (soft tolerances ×1.5, hard never moves) and the nearest earlier misses are asked again. Final choice among the best feasible options by Nash product of everyone's 1 to 5 bucket, compared through a pairwise-masked sum so the mediator never receives a bucket (`masked-sum.ts`). An optional LLM may re-rank the shortlist, never widen it. `exploreRounds` (off by default) keeps going for more rounds after the first unanimous accept and picks among every unanimous candidate seen; `docs/evaluation.md` measures what that buys and costs.
- **Isolation** (`src/lib/vault.ts`, `tests/isolation.test.ts`): only the vault decrypts preferences, and it only hands out opaque agents; a test walks the import graph of the negotiation modules and fails if any can reach storage, crypto or the vault.
- **Candidates** (`src/lib/places.ts`, `pool.ts`): with `GOOGLE_PLACES_API_KEY`, real restaurants near the plan's location (hours → weekend slots, price level → $/person, distance → minutes); otherwise a seeded set. Nearby Search returns at most 20 places per call, so the pool is gathered from one general query plus one query per under-represented cuisine, merged and de-duplicated by place id: up to 60 restaurants from at most 6 Nearby Search calls per plan. For free local development, `YELP_DATASET_DIR` can point at the Yelp Open Dataset instead (`yelp-pool.ts`; it only works under `npm run dev` and is ignored in production builds, see `sim/yelp/README.md`).
- **Per-person travel** (`src/lib/geo.ts`, `start-point.ts`, `agent.ts`): on a plan with real places, each assistant asks (optionally) where its person is coming from. The place is geocoded once, stored encrypted with their constraints, and handed by the vault to that person's agent only, which judges every candidate on their own trip. The mediator and the group result never see a start point or a per-person travel time; the result omits travel time for these plans. Without a start point, or on the seed pool, travel is measured from the plan's location.
- **Evaluation harness** (`sim/`, `npm run sim`): 200 synthetic groups, brute-force no-privacy oracle, naive baseline, Nash / max-min ratios, leaked dimension names. See `sim/README.md` and `docs/evaluation.md`.
- **Evaluation on real reviewers** (`sim/yelp/`, `npm run sim:yelp`): the same comparison with restaurants, personas and friend groups from the Yelp Open Dataset. The dataset is not in this repository: it is for educational, non-commercial use under Yelp's Dataset User Agreement and may not be redistributed. See `sim/yelp/README.md`.
- **Privacy:** private chat messages, constraints and emails are encrypted at rest (AES-256-GCM). Emails are looked up through an HMAC blind index. Passwords use bcrypt (salted, cost 12). Session cookies are random tokens, and only their SHA-256 hashes are stored.
- **Small groups** (`forGroupSize` in `src/lib/events.ts`): with two people every "anonymous" count would be the other person's answer, so a plan with fewer than three members stores and shows only the outcome and the number of rounds. See "Privacy budget" in `docs/evaluation.md` for what still shows at each size.
- **Abuse limits** (`src/lib/ratelimit.ts`): fixed-window counters in the database, so they hold across serverless instances. 30 chat messages per person per 10 minutes; 300 LLM calls per plan per day, after which replies come from the rule-based extractor; 10 sign-in attempts per email and 50 per IP per 15 minutes; 10 new accounts per IP per hour. Emails and IPs are stored only as HMACs.

## Run locally

```bash
npm install
cp .env.example .env.local
npm run gen-key            # paste the output into ENCRYPTION_KEY in .env.local
npm run dev                # http://localhost:3000
```

To try the full flow alone, sign up in a normal window and an incognito window, create a plan in one, and open the invite link in the other.

## Tests

```bash
npm test          # vitest: crypto, extraction, evaluation, negotiation, auth, data access + privacy
npm run test:e2e  # Playwright: two users go from signup to a plan in a real browser
npm run typecheck
```

CI runs both on every PR (`.github/workflows/ci.yml`).

## Deploy

- **Database:** any Postgres (Neon, Supabase, Vercel Postgres...). Set `DATABASE_URL=postgresql://...`. The tables are created automatically on the first request. Locally, no database server is needed: without a Postgres URL the app uses [PGlite](https://pglite.dev) (Postgres in WebAssembly) and stores data in `./.pglite`.
- **Host:** Vercel (one person deploys; see the course note about commit authors) or another Node host. Set `ENCRYPTION_KEY`, the database variables and, optionally, `ANTHROPIC_API_KEY` (LLM elicitation), `GOOGLE_PLACES_API_KEY` (real restaurants near the plan's location) and `SETTLE_LLM_MEDIATOR=1` (LLM re-ranking of the mediator's shortlist).
- ⚠️ Never change `ENCRYPTION_KEY` after launch, or existing data can no longer be decrypted.

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
    mediator.ts        proposer from tallies alone; optional LLM re-ranker in mediator-llm.ts
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

- Per-person travel times (each member's own start point) instead of one centre per plan
- Run each assistant on its owner's device, with keys agreed between devices, so the masked final pick also holds against the server
- Keep exploring one round after the first unanimous accept; the harness shows ~50% exact-optimum today
- More scenarios: trips, roommate chores, splitting rent
