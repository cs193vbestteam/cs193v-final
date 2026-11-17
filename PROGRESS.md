# Progress

Where Settle stands, how it got here, what is in the way, and what comes next. `README.md` says how to run it and `TECHNICAL.md` how it is put together.

Settle is a web app, live at https://cs193v-final.vercel.app, in which a group picks a restaurant and a time for a meal without anyone stating their budget and personal preferences to the others.

## Overview

| | At Checkpoint 1 (November 10) | Now (November 17) |
|---|---|---|
| Who decides the plan | A negotiation among one LLM assistant per person and a LLM mediator | An optimizer: code that scores every place and time. No language model |
| Where a Language model is used | The private chat and the negotiation | The private chat only |
| Restaurants | 16 made-up places | Real places from Google Places, searched again for based on the group asked for |
| Tried by people outside the team | No | One user test, two people |


## Since Checkpoint 1 (November 14 to 17)

### 1. Frontend Progress

- We tested the main flows with real Claude and Google Places. Plans took about 5–10 seconds, and groups with no matching options got a clear message.
- We fixed bugs where Claude missed "no restrictions," showed internal names, or made sample restaurants look real, and lost invites during signup and chat overflow on phones (PRs #92, #94, #95).
- We checked 17 screens on desktop and mobile, and added clearer labels, keyboard navigation, focus rings and better text contrast (PR #96).
- The plan is found automatically when everyone finishes, with a message for inviting or reminding the group (PR #93).
- The creator can remove members, replace the invite link and cap the group size. A plan is marked out of date when someone changes an answer, and can be re-run at most six times a day.
- The pages now describe how plans are decided, and what is private from whom, in plain words.

**Security and cost.** Encryption with a key per user and per field; caps on plans per day and on model spending per person and in total; security headers on every response; a security audit (`SECURITY-AUDIT.md`).

**One user test** (`docs/user-tests/2026-11-16`). Two students outside the team made a plan with no guidance. They finished the flow and opened the recommended restaurant in Google Maps. Fourteen issues came out of it, among them having to register before trying anything.

### 2. Backend Progress

#### 1. Progress So Far
- Added per-user, per-field encryption.
- Added cost caps (e.g. $10 per person per month).
- Completed security audit, identified 9 issues.
- Added documentation: `SECRET.md`, `ENCRYPTION.md`, `COST-CONTROLS.md`.
- Found that per-plan budgets couldn't effectively limit total spending because of how the product works. Changed to per-person budgets instead.

#### 2. Next Steps
- Improve authentication security.
- Delete expired sessions and plans.
- Require PostgreSQL and TLS in production.

### 3. AI Chat Assistant Progress

#### 1. Changed how the chat works
- Old version used fixed questions + keyword matching. Didn't handle things like "around $30 but $50 is okay" very well.
- Switched to Claude Haiku for more natural conversations.
- Important because the optimizer only uses what's collected from the chat. No chance to ask again later.

#### 2. LLM extracts, code checks
- Claude gives a reply + structured preferences.
- Code checks each field, drops invalid ones, keeps the rest.
- Max 8 turns, must collect time and diet before finishing.
- Realized prompt instructions alone aren't reliable enough. Need code to enforce rules.

#### 3. Preferences vs restrictions
- Mild / strong / must (default mild).
- Found that Claude sometimes treated "I prefer dinner" as "I can only do dinner."
- Need to separate what people want from what they absolutely cannot do.
- Budget/travel are still soft limits, so changed wording to avoid promising a strict maximum.

#### 4. Cuisine mapping
- Claude extracts food words, code maps them to categories.
- E.g. Asian, hot pot, 火锅.
- Previously same word could be interpreted differently across runs.
- Unknown terms kept as notes instead of making up a category.

#### 5. Restaurant search
- Before: up to 11 searches, even for cuisines nobody requested.
- Now: 1 general search + up to 7 based on actual preferences.
- Should reduce unnecessary API calls and get more relevant options.

#### 6. Testing / mistakes
- "At least $50" interpreted as max $50.
- "Does halal count?" saved as a real preference.
- Changing preferences halfway through didn't always update properly.
- One prompt fix caused Claude to follow an unrelated pirate-style instruction.
- Some privacy wording kept appearing in wrong places. Had to enforce it in code.





### 4. Optimizer Progress

#### 1. Why switch from LLM negotiation?
- LLM only tried a few dozen options, results not always optimal or consistent.
- Already have a manageable restaurant shortlist. Why not just score every option?
- More predictable, easier to debug.

#### 2. Shortlist → Optimize
- Google Places: search nearby popular restaurants, then additional searches based on group preferences.
- Filter + deduplicate, max 160 restaurants.
- 14 time slots → max 2,240 combinations.
- Exhaustive search (~30 ms). No need for OR-Tools.

#### 3. Scoring
- Hard constraints: unavailable time, diet, exclusions.
- Utility starts at 1, subtract penalties for unmet wishes.
  - Mild = 0.5, strong = 1, must = 3.
  - Budget/travel fit decreases as cost/distance increases.
- First minimize people excluded, then maximize Nash product of satisfaction.

#### 4. Tie-breakers
- Earlier submission → primary cuisine match → dinner hours (17–20) → shorter travel → closer to 18:00 → cheaper → restaurant ID.

#### 5. Next step for Optimizer [Further user tests]

##### 1. Do our utility scores make sense?
- Current weights (mild 0.5, strong 1, must 3) are numbers we picked ourselves. Not tested with real users.
- Ask 2 groups of 3–4 test users to enter their actual preferences and observe. Understand how would they rank them?

##### 2. How should "must" work?
- Currently must = 3× strong, still a soft preference.
- E.g. someone says max $20, but optimizer might pick a $45 restaurant. Would they accept that?
- Ask users what they actually mean by "must".
- Maybe change ranking to: fewest excluded → fewest violated musts → highest group satisfaction.

## Team contributions and next steps

**Contributions** (from merged pull requests). Before Checkpoint 1, then since.

- **Tyler** (`tylerhuangzy04`). _Before:_ interface redesign; the rebuilt negotiation core; the first Google Places integration and simulation harness; mobile and contrast fixes; browser tests; deletion screens; most of the issues that organised the work. _Since:_ automatic planning, share and nudge; the accessibility pass; creator controls and re-run limits; the wording of the pages; security headers; the user test and its notes.
- **Jackson** (`jacksonfang0205`). _Before:_ the Postgres layer; lint, CI, secret scanning and the contributing guide; deletion in the data layer; rate limits; free-text diet and budget in the chat; the Claude-driven negotiation. _Since:_ per-user, per-field encryption; cost caps; the security audit; the secrets, encryption and cost documents.
- **Yuxuan** (`yuxuanx-rain`). _Before:_ the larger restaurant pool; per-person travel; the ten-seed evaluation and Claude baseline; exploring after agreement; found the two-person leak. _Since:_ the optimizer's input format; the conversational chat that fills it; the cuisine table; plan dates and opening hours; the searches after the chats, including for diets; the real-model evaluation of the assistant; removal of the negotiation's model calls; the three AI documents.
- **Mark** (`yangmar-yyc`). _Before:_ the database port into this repository; the scenario seam; the Yelp evaluation; the two-person privacy fix; the extractor evaluation and value limits; the masked final pick; the three documents; the review that found the fallback bug. _Since:_ the optimizer and its tie-breaks; the recorded groups on real restaurants and the adversarial tests; the optimizer in the real plan flow; the demo page.

**Next priorities.** Owners are proposed and to be confirmed.

| # | Priority | Owner | Done when |
|---|---|---|---|
| 1 | Check the weights against people | Mark | Two groups of 3–4 have ranked their own options, and where their ranking and their score disagree is written down |
| 2 | Decide how a broken must behaves | Mark | A scenario survey has answers from the class, and the rule is kept or changed |
| 3 | Measure the optimizer on the 200 synthetic groups | Yuxuan | It sits beside the negotiation's numbers in `docs/evaluation.md` |
| 4 | Clean the restaurant list | Yuxuan | Juice bars are out and a chain appears once |
| 5 | Act on the user test | Tyler | The issues it filed are closed or declined with a reason |
| 6 | Remove the negotiation code | Yuxuan | The modules nothing calls are gone |
| 7 | Harden sign-in | Jackson | Repeated wrong passwords lock an account for a while, sign-up and log-in do not reveal whether an email is registered, and a test shows both |
| 8 | Delete expired sessions and old plans | Jackson | A stated retention period is in the docs, a scheduled job removes what is past it, and a test shows an expired session and an old plan are gone |
| 9 | Require Postgres and TLS in production | Jackson | A production start without a Postgres URL or without TLS fails with a clear error instead of falling back to the local database |


<!-- # Archive -->

<!-- 
## Before Checkpoint 1 (through November 10)

**What we built.**

- Accounts, plans with invite links, and deletion of plans and accounts.
- A private chat per person. Claude turns what they type into structured constraints, with a rule-based extractor as the fallback.
- A negotiation between one assistant per person and a mediator that never sees anyone's constraints. In the last week before the checkpoint both were driven by Claude, with the hard rules and the final pick kept in code.
- Privacy measures: private data encrypted in the database, a final pick computed from a masked sum, and two-person plans that show only the outcome.
- Limits on chat messages, model calls and log-in attempts.
- An evaluation harness (`sim/`), written up in `docs/evaluation.md`.

**What worked.** The whole flow from sign-up to a plan, on the live site, with Claude and the 16 made-up restaurants. Google Places was coded and tested against sample responses, but not switched on.

**What we measured.**

- _The negotiation against a planner that reads everything:_ over ten seeds of 200 synthetic groups, it agreed in 98.8% of the groups where a plan exists and kept 94% of the best possible group welfare. A "most votes in round one" baseline kept 44%. It reached the best plan itself in fewer than 60% of solvable groups.
- _Claude as a planner with no privacy,_ on 40 groups: a valid plan in 45% of the solvable ones, against 100% for the negotiation.
- _Personas from real reviewers:_ built from the Yelp Open Dataset in three cities.
- _The extractors on 54 scripted chats,_ 16 of them adversarial: on ordinary chats the rules got 84% of fields right and Claude 96%; neither committed a violation.

**What we learned.**

- **Anonymous counts are not anonymous for two people.** Each knows their own answer, so every count was the other person's. Two-person plans show only the outcome.
- **A product of scores gives the scores away,** because it factors back. We masked the comparison between finalists instead.
- **Our "real" groups were easier for the wrong reason.** Personas built from Yelp reviews have almost no price or dietary limits, so they agreed almost at once.
- **A fallback can be worse than a failure.** When a call to Claude failed, the code assistant answered, and it could not read notes like "allergic to peanuts". One failed call could turn "no plan" into "everyone's in". Found in review and fixed before merging.
- **The rule-based extractor only understands English:** 30% of fields right in other languages. -->

<!-- **What happened to the Week 9 priorities.**

| # | Priority set at Checkpoint 1 | Status |
|---|---|---|
| 1 | Run a two-person and a four-person plan on the live site with Claude | Main flows run with real Claude and Google Places; cost per plan not yet written up |
| 2 | Run the adversarial chat suite against Claude | Done (`AI-EVALS.md`) |
| 3 | Compare the Claude-driven negotiation with the code one | Overtaken: neither decides plans now |
| 4 | Decide on real restaurants | Done: on |
| 5 | Limit how often a plan can be re-run | Done |
| 6 | Try it with one real group of friends | Partly: two people outside the team, not three |
| 7 | Settle who pays for the API keys | Partly: caps set, Places key billed; the Claude key is still personal | -->