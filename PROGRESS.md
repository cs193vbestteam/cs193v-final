# Progress

Where Settle stands, how that compares with what we set out to do, what is in the way, and what comes next. `README.md` says how to run it and `TECHNICAL.md` how it is put together.

## Progress so far

**What we built.** A working web app, live at https://cs193v-final.vercel.app, in which a group picks a restaurant and a time for a weekend meal without anyone stating their budget to the others.

- Sign-up and log-in, plans with invite links, and deletion of plans and accounts.
- A private chat per person. Claude turns what they type into structured constraints, with a rule-based extractor as the fallback.
- A negotiation between one assistant per person and a mediator that never sees anyone's constraints. Since this week the assistants and the mediator are driven by Claude, with the hard rules and the final pick kept in code.
- Privacy measures: private data encrypted in the database, a final pick computed from a masked sum so no individual score is seen, and two-person plans that show only the outcome.
- Abuse limits on chat messages, model calls and log-in attempts.
- An evaluation harness (`sim/`) and its write-up (`docs/evaluation.md`).
- Engineering basics: 537 unit tests, browser tests of the two-person flow, lint, formatting and a secret scan on every pull request.

**What works.** The whole flow, from sign-up to a plan, on the live site with Claude and a built-in list of 16 fictional restaurants. The code for real restaurants from Google Places is written and tested against sample responses, but it is not switched on.

**What we tried and measured.**

- _Our protocol against a planner that reads everything._ Over ten seeds of 200 synthetic groups, the protocol reaches agreement in 98.8% of the groups where a plan exists and keeps 94% of the best possible group welfare. A simple "most votes in round one" baseline keeps 44%.
- _Claude as a planner with no privacy._ We gave Claude every member's preferences and asked for a plan, on 40 groups. It found a valid plan in 45% of the solvable ones, against 100% for the protocol. In 16 of 29 its pick broke someone's hard rule or was not one of the candidates.
- _Personas from real reviewers._ Using the Yelp Open Dataset we built personas from reviewers' histories and groups from their friends lists, in three cities.
- _The extractors on scripted chats._ 48 short chats, 16 of them adversarial. The rule-based extractor gets 78% of fields right on ordinary chats and never recorded an out-of-range or unmentioned value.

**What we learned.**

- **Anonymous counts are not anonymous in a group of two.** Each person knows their own answer, so every count was the other person's. A teammate spotted it; two-person plans now show only the outcome.
- **A product of scores gives the scores away.** Hiding individual 1-to-5 scores behind their product does nothing, because the product factors back. We mask the comparison between finalists instead.
- **Our synthetic groups are harder than our "real" ones, for the wrong reason.** The Yelp groups agreed almost at once, but mostly because personas built from reviews have almost no price or dietary limits. We had first written that real friends are easier to please; a review corrected it.
- **A fallback can be worse than a failure.** When a call to Claude failed, the code assistant answered instead. It cannot read free-text notes such as "allergic to peanuts", so one failed call could turn "no plan" into "everyone's in". Found in review and fixed before the change was merged.
- **The rule-based extractor only understands English:** 30% of fields right on chats in other languages.
- **A missing setting can fail quietly.** Our first deployment could not reach its database and every sign-up returned "Something went wrong". The README now says what to check.

## Changes from our proposal

We did not keep a copy of the Week 8 goals in the repository, so this comparison uses the fifteen issues we opened at the start as the record of what we planned.

| Planned | Outcome |
|---|---|
| Clean up the code and move the database to Postgres | Done |
| Fix mobile layout and text contrast | Done |
| Rate limits; deletion of plans and accounts | Done |
| A larger pool of real restaurants; travel measured from each person's start | Built and tested against sample responses; not switched on |
| Evaluation over several seeds, with a Claude baseline | Done |
| Keep exploring after the first agreement | Done, as an option that is off by default |
| Evaluate the extractor, including prompt injection | Done for the rule-based extractor; Claude not yet run on it |
| Browser tests in CI | Done |
| Evaluate on real preferences (Yelp) | Done, with the caveat above |
| Hide individual scores in the final step (a stretch goal) | Done |
| A second kind of plan | Dropped |

How the idea and scope changed:

- **One kind of plan, not two.** We considered movie night and then hotel picking as a second scenario and dropped both. Hotels had no free source of prices, and one scenario done carefully was worth more to us than two done thinly. The code has a place for a second scenario if we return to it.
- **The negotiation now uses Claude.** The original design used plain code for the assistants and the mediator, with Claude only reading the chat. Assistants driven by Claude can act on things people say in their own words, such as an allergy, that our structured fields cannot hold. Code still enforces the hard rules and makes the final pick.
- **Real restaurants are postponed.** The live site uses fictional ones until we have decided who pays for Google Places.
- **More evaluation than planned.** The ten-seed study, the Yelp personas, the extractor suite and the masked final pick all went beyond the original list.

## Problems and questions

**1. The cost of paid services.**

- _What is slowing us:_ Claude on the live site runs on one team member's personal API key, and Google Places needs a billing account that none of us has set up for the project.
- _What we tried:_ The app runs with no keys at all, on the rule-based extractor and the built-in restaurants. Every plan is capped at 300 model calls a day. For development we used the free Yelp dataset in place of Google Places. We read Google's pricing: about 160 new plans a month fit in its free allowance, and each one after that costs roughly 27 cents.
- _Where we need help:_ Is there course credit or a shared key for the Anthropic API, and may we put a personal billing account behind Google Places for a class project?

**2. The Claude-driven parts are not verified against the real model.**

- _What is slowing us:_ The negotiation driven by Claude, and the adversarial chat suite, have been tested only against a fake API. We do not know how often real calls fail, what a negotiation costs, or how Claude behaves when someone tries to manipulate it. Every protocol number in `docs/evaluation.md` was measured with the code assistants, which are no longer what runs on the live site.
- _What we tried:_ Dozens of tests with a scripted fake model, including replies a manipulated model might give. A review that reproduced the fallback bug above. One real run of Claude as a planner on 40 groups.
- _Where we need help:_ Mostly budget, as in problem 1. We would also welcome advice on how to evaluate a system whose answers change from run to run.

## Team contributions and next steps

**What each person contributed** (from merged pull requests):

- **Tyler** (`tylerhuangzy04`): the redesign of the interface; the rebuilt negotiation core (preferences, utilities, concessions); the first Google Places integration and the simulation harness; mobile and contrast fixes; browser tests in CI; the deletion screens; wrote most of the issues that organised the work.
- **Jackson** (`jacksonfang0205`): the Postgres database layer; lint, formatting, CI, secret scanning and the contributing guide; deletion in the data layer; rate limits; free-text diet and budget in the chat; the Claude-driven negotiation.
- **Yuxuan** (`yuxuanx-rain`): the larger restaurant pool from several Google queries; travel measured from each person's own start; the ten-seed evaluation with confidence intervals and the Claude baseline; exploring after the first agreement; found the two-person privacy leak; reviewed the Yelp evaluation and the technical overview.
- **Yichang** (`yangmar-yyc`): porting the database change into this repository; the scenario seam; the Yelp evaluation and local restaurant source; the two-person privacy fix; the extractor evaluation and value limits; the masked final pick; `README.md`, `TECHNICAL.md` and this file; the review that found the fallback bug.

**Priorities for Week 9.** Owners are proposed and still to be confirmed by the team.

| # | Priority | Owner | Done when |
|---|---|---|---|
| 1 | Run full plans on the live site with Claude: one with two people, one with four | Jackson | Both plans reach a result, the server logs show no errors, and the number of model calls and the cost of each are written into `docs/evaluation.md` |
| 2 | Run the adversarial chat suite against Claude | Yichang | `npm run sim:extract -- --llm` has been run, its table is in `docs/evaluation.md`, and every violation it reports has an issue |
| 3 | Measure the Claude-driven negotiation against the code one | Yuxuan | The same 40 groups run both ways, with agreement rate, welfare and cost side by side in `docs/evaluation.md` |
| 4 | Decide on real restaurants | Yuxuan | Either a Google key with a daily quota is set and one plan with real restaurants has been run on the live site, or the docs say the feature is dropped |
| 5 | Limit how often a plan can be re-run | Jackson | A test shows the limit, and the issue for it is closed |
| 6 | Try it with one real group of friends | Tyler | At least three people who are not on the team have made a plan, and what they said is written down next to the plan they got |
| 7 | Settle who pays for the API keys | Whole team | A spending limit is set on the Claude key and the answer to problem 1 is recorded here |

We check each task the way we have checked the rest: an issue, a pull request that closes it, a teammate's review, and green CI before merging.
