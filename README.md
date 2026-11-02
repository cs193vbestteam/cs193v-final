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

- **Extraction** (`src/lib/extract.ts`, `extract-rules.ts`): turns chat into a typed `Constraints` object (`src/lib/constraints.ts`). Uses Claude via tool use if `ANTHROPIC_API_KEY` is set, otherwise a tested rule-based extractor.
- **Evaluation** (`src/lib/evaluate.ts`): deterministic, no LLM. Judges one proposal against one person's constraints and returns only `yes / meh / no` plus a coarse reason.
- **Negotiation** (`src/lib/negotiate.ts`): never receives constraints, only one opaque assistant function per person. It proposes options in rounds and learns from the verdicts.
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

```bash
npm test          # vitest: crypto, extraction, evaluation, negotiation, auth, data access + privacy
npm run typecheck
```

CI runs both on every PR (`.github/workflows/ci.yml`).

## Deploy

- **Database:** create a free [Turso](https://turso.tech) database and set `DATABASE_URL=libsql://...` and `DATABASE_AUTH_TOKEN`. The schema is created automatically on first request.
- **Host:** Vercel (one person deploys; see the course note about commit authors) or another Node host. Set `ENCRYPTION_KEY`, the database variables and, optionally, `ANTHROPIC_API_KEY`.
- ⚠️ Never change `ENCRYPTION_KEY` after launch, or existing data can no longer be decrypted.

## Project layout

```
src/
  app/                 Next.js App Router pages + server actions (actions.ts)
    e/[code]/page.tsx  plan page: private chat + group panel
  components/          client components (chat, auth form, buttons)
  lib/
    constraints.ts     the Constraints schema (contract between extractor and negotiator)
    extract*.ts        chat → constraints
    evaluate.ts        one person's verdict on one proposal
    negotiate.ts       multi-round search using only verdicts
    restaurants.ts     fictional seed data (TODO: real places API)
    crypto.ts          AES-GCM, blind index, tokens
    auth.ts, session.ts
    db.ts, events.ts   libSQL schema + data access with membership checks
tests/                 vitest suites
```

## Ideas for next steps

- Real restaurant data (Google Places / Yelp) and real travel times per person
- Let the LLM rank candidate restaurants by soft preferences
- A "why not?" nudge: privately ask the blocking person whether they'd loosen one constraint
- More scenarios: trips, roommate chores, splitting rent
