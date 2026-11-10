# Tacit

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

- **Elicitation** (`src/lib/extract.ts`, `extract-rules.ts`): turns the private chat into a typed `Constraints` object (`src/lib/constraints.ts`). Refuses "whatever" with an either/or, then asks two trade-offs (weights) and a concession-order question. Uses Claude via tool use if `ANTHROPIC_API_KEY` is set, otherwise a tested rule-based path.
- **Preferences** (`src/lib/preferences.ts`): compiles constraints into the negotiation contract: `hard` rules (violate one → reject), weighted `soft` rules (0..1 satisfaction, weighted mean = utility) and a `concession_order`.
- **Evaluation** (`src/lib/evaluate.ts`): deterministic, no LLM. utility ≥ 0.7 → accept, ≥ 0.4 → reluctant, else reject; hard violation → reject. Returns only the verdict plus at most one dimension name. `bucket()` gives a 1–5 utility bucket for the final fairness step.
- **Mediator + protocol** (`src/lib/mediator.ts`, `negotiate.ts`): the mediator sees only the public candidate pool and anonymised tallies. 5 proposals per round, up to 6 rounds; from round 4 every assistant concedes one more step of its own order (soft tolerances ×1.5, hard never moves) and the nearest earlier misses are asked again. Final choice among the best feasible options by Nash product of sorted buckets. An optional LLM may re-rank the shortlist, never widen it.
- **Isolation** (`src/lib/vault.ts`, `tests/isolation.test.ts`): only the vault decrypts preferences, and it only hands out opaque agents; a test walks the import graph of the negotiation modules and fails if any can reach storage, crypto or the vault.
- **Candidates** (`src/lib/places.ts`, `pool.ts`): with `GOOGLE_PLACES_API_KEY`, real restaurants near the plan's location (hours → weekend slots, price level → $/person, distance → minutes); otherwise a seeded set.
- **Evaluation harness** (`sim/`, `npm run sim`): 200 synthetic groups, brute-force no-privacy oracle, naive baseline, Nash / max-min ratios, leaked dimension names. See `sim/README.md` and `docs/evaluation.md`.
- **Privacy:** private chat messages, constraints and emails are encrypted at rest (AES-256-GCM). Emails are looked up through an HMAC blind index. Passwords use bcrypt (salted, cost 12). Session cookies are random tokens, and only their SHA-256 hashes are stored.

## Run locally

```bash
npm install
cp .env.example .env.local
npm run gen-key            # paste the output into ENCRYPTION_KEY in .env.local
npm run dev                # http://localhost:3000
```

To try the full flow alone, sign up in a normal window and an incognito window, create a plan in one, and open the invite link in the other.

## Tests

See [CONTRIBUTING.md](CONTRIBUTING.md) for the team workflow (issues, branches, PRs, review), the style guide and how we handle secrets.

```bash
npm test          # vitest: crypto, extraction, evaluation, negotiation, auth, data access + privacy
npm run typecheck
```

CI runs both on every PR (`.github/workflows/ci.yml`).

## Deploy

- **Database:** create a free [Turso](https://turso.tech) database and set `DATABASE_URL=libsql://...` and `DATABASE_AUTH_TOKEN`. The schema is created automatically on first request.
- **Host:** Vercel (one person deploys; see the course note about commit authors) or another Node host. Set `ENCRYPTION_KEY`, the database variables and, optionally, `ANTHROPIC_API_KEY` (LLM elicitation), `GOOGLE_PLACES_API_KEY` (real restaurants near the plan's location) and `TACIT_LLM_MEDIATOR=1` (LLM re-ranking of the mediator's shortlist).
- ⚠️ Never change `ENCRYPTION_KEY` after launch, or existing data can no longer be decrypted.

## Project layout

```
src/
  app/                 Next.js App Router pages + server actions (actions.ts)
    e/[code]/page.tsx  plan page: private chat + group panel
  components/          client components (chat, auth form, buttons)
  lib/
    constraints.ts     what the private chat collects (+ weights, concession order, pending question)
    extract*.ts        chat → constraints (LLM or rules; probes for weights and concessions)
    preferences.ts     hard / soft / concession_order contract; compile(), relax()
    evaluate.ts        utility, verdict + one dim, buckets (pure)
    agent.ts           opaque per-person assistant (judge / bucket)
    mediator.ts        proposer from tallies alone; optional LLM re-ranker in mediator-llm.ts
    negotiate.ts       rounds, concessions, Nash-on-buckets final pick
    vault.ts           the only module that decrypts preferences → agents
    places.ts, pool.ts Google Places adapter and the per-plan candidate pool
    restaurants.ts     seed pool (used when Places is off)
    crypto.ts          AES-GCM, blind index, tokens
    auth.ts, session.ts
    db.ts, events.ts   libSQL schema + data access with membership checks
sim/                   synthetic-group evaluation (oracle, baselines, report + chart)
docs/evaluation.md     the evaluation chapter of the report
tests/                 vitest suites
```

## Ideas for next steps

- Per-person travel times (each member's own start point) instead of one centre per plan
- Secure aggregation for the final buckets (masked sums), so even bucket values stay private
- Keep exploring one round after the first unanimous accept; the harness shows ~50% exact-optimum today
- More scenarios: trips, roommate chores, splitting rent
