# Progress

Where Settle stands, how that compares with our plan, what is in the way, and what comes next. `README.md` says how to run it and `TECHNICAL.md` how it is put together.

## Progress so far

**What we built.** A working web app, live at https://cs193v-final.vercel.app, in which a group picks a restaurant and a time for a weekend meal without anyone stating their budget to the others.

- Accounts, plans with invite links, and deletion of plans and accounts.
- A private chat per person. Claude turns what they type into structured constraints, with a rule-based extractor as the fallback.
- A negotiation between one assistant per person and a mediator that never sees anyone's constraints. Since this week both are driven by Claude, with the hard rules and the final pick kept in code.
- Privacy measures: private data encrypted in the database, a final pick computed from a masked sum, and two-person plans that show only the outcome.
- Limits on chat messages, model calls and log-in attempts.
- An evaluation harness (`sim/`), written up in `docs/evaluation.md`.
- 537 unit tests, browser tests, lint and a secret scan on every pull request.

**What works.** The whole flow from sign-up to a plan, on the live site, with Claude and a built-in list of 16 fictional restaurants. Real restaurants from Google Places are coded and tested against sample responses, but not switched on.

**What we measured.**

- _Protocol against a planner that reads everything:_ over ten seeds of 200 synthetic groups, it agrees in 98.8% of the groups where a plan exists and keeps 94% of the best possible group welfare. A "most votes in round one" baseline keeps 44%.
- _Claude as a planner with no privacy,_ on 40 groups: a valid plan in 45% of the solvable ones, against 100% for the protocol.
- _Personas from real reviewers:_ built from the Yelp Open Dataset in three cities.
- _The extractors on 54 scripted chats,_ 16 of them adversarial: on ordinary chats the rules get 84% of fields right and Claude 96%; neither committed a violation.

**What we learned.**

- **Anonymous counts are not anonymous for two people.** Each knows their own answer, so every count was the other person's. Two-person plans now show only the outcome.
- **A product of scores gives the scores away,** because it factors back. We mask the comparison between finalists instead.
- **Our "real" groups were easier for the wrong reason.** The Yelp groups agreed almost at once, mostly because personas built from reviews have almost no price or dietary limits. A review corrected our first reading.
- **A fallback can be worse than a failure.** When a call to Claude failed, the code assistant answered, and it cannot read notes like "allergic to peanuts". One failed call could turn "no plan" into "everyone's in". Found in review and fixed before merging.
- **The rule-based extractor only understands English:** 30% of fields right in other languages.

### Since Checkpoint 1: frontend requirements 1–3

**What we built.**

- We tested the main flows with real Claude and Google Places. Plans took about 5–10 seconds, and groups with no matching options got a clear message. Each person's chat stayed private.
- We fixed bugs where Claude missed "no restrictions," showed internal names, or made sample restaurants look real. We also fixed lost invites during signup and chat overflow on phones. These fixes are merged in PRs #92, #94, and #95.
- We checked 17 screens on desktop and mobile. Added clearer labels, keyboard navigation, focus rings, and better text contrast. These changes are merged in PR #96.
- We added automatic planning when everyone finishes and a message for inviting or reminding the group. This is merged in PR #93.

**What we learned.** Testing with the real model caught bugs that fake-model tests missed. We also learned that a prompt fix can affect other results: one eval dropped from 160/165 to 159/165. We still need to rerun it to see if that was just normal variation.

## Changes from our proposal

We did not keep the Week 8 goals in the repository, so this uses the fifteen issues we opened at the start as the record of our plan.

| Planned | Outcome |
|---|---|
| Clean up the code; move the database to Postgres | Done |
| Mobile layout and contrast fixes | Done |
| Rate limits; deleting plans and accounts | Done |
| More real restaurants; travel from each person's start | Built, not switched on |
| Evaluation over several seeds, with a Claude baseline | Done |
| Keep exploring after the first agreement | Done, off by default |
| Evaluate the extractor, including prompt injection | Done for both; Claude run once |
| Browser tests in CI | Done |
| Evaluate on real preferences (Yelp) | Done, with the caveat above |
| Hide individual scores in the final step (stretch) | Done |
| A second kind of plan | Dropped |

How the scope changed:

- **One kind of plan, not two.** We considered movie night, then hotel picking, and dropped both. Hotels had no free source of prices.
- **The negotiation now uses Claude.** The original design used plain code, with Claude only reading the chat. Claude-driven assistants can act on what people say in their own words, such as an allergy. Code still enforces the hard rules and makes the final pick.
- **Real restaurants are postponed** until we decide who pays for Google Places.
- **More evaluation than planned:** the ten-seed study, the Yelp personas, the extractor suite and the masked final pick.

## Problems and questions

**1. The cost of paid services.**

- _What slows us:_ Claude on the live site runs on one member's personal API key, and Google Places needs a billing account nobody has set up.
- _What we tried:_ the app runs with no keys at all; each plan is capped at 300 model calls a day; we used the free Yelp dataset for development; and we read Google's pricing (about 160 new plans a month are free, then roughly 27 cents each).
- _Where we need help:_ is there course credit or a shared key for the Anthropic API, and may we use a personal billing account for Google Places?

**2. The Claude-driven parts are not verified against the real model.**

- _What slows us:_ the Claude-driven negotiation and the adversarial chat suite have only been tested against a fake API. We do not know how often real calls fail, what a negotiation costs, or how Claude behaves under manipulation. Our protocol numbers were measured with the code assistants, which no longer run on the live site.
- _What we tried:_ dozens of tests with a scripted fake model, a review that reproduced the fallback bug, and one real run of Claude as a planner.
- _Where we need help:_ budget, as above, and advice on evaluating a system whose answers change from run to run.

## Team contributions and next steps

**Contributions so far** (from merged pull requests):

- **Tyler** (`tylerhuangzy04`): interface redesign; the rebuilt negotiation core; the first Google Places integration and simulation harness; mobile and contrast fixes; browser tests; deletion screens; most of the issues that organised the work.
- **Jackson** (`jacksonfang0205`): the Postgres layer; lint, CI, secret scanning and the contributing guide; deletion in the data layer; rate limits; free-text diet and budget in the chat; the Claude-driven negotiation; per-user, per-field encryption; cost caps; the security audit.
- **Yuxuan** (`yuxuanx-rain`): the larger restaurant pool; per-person travel; the ten-seed evaluation and Claude baseline; exploring after agreement; found the two-person leak; reviewed the Yelp evaluation and the technical overview.
- **Yichang** (`yangmar-yyc`): the database port into this repository; the scenario seam; the Yelp evaluation; the two-person privacy fix; the extractor evaluation and value limits; the masked final pick; the three documents; the review that found the fallback bug.

**Week 9 priorities.** Owners are proposed and to be confirmed.

| # | Priority | Owner | Done when |
|---|---|---|---|
| 1 | Run a two-person and a four-person plan on the live site with Claude | Jackson | Both reach a result with no server errors; calls and cost per plan are in `docs/evaluation.md` |
| 2 | Run the adversarial chat suite against Claude | Yichang | Its table is in `docs/evaluation.md` and each violation has an issue |
| 3 | Compare the Claude-driven negotiation with the code one | Yuxuan | The same 40 groups run both ways, side by side in `docs/evaluation.md` |
| 4 | Decide on real restaurants | Yuxuan | A key with a daily quota is set and one real plan has run, or the docs say it is dropped |
| 5 | Limit how often a plan can be re-run | Jackson | A test shows the limit and its issue is closed |
| 6 | Try it with one real group of friends | Tyler | Three people outside the team made a plan, and their feedback is written down |
| 7 | Settle who pays for the API keys | Everyone | A spending limit is set on the Claude key and problem 1 is answered here |

Each task is done when its pull request is reviewed and CI is green.
