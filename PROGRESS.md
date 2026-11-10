# Progress

Where Settle stands, how that compares with our plan, what is in the way, and what comes next. `README.md` says how to run it and `TECHNICAL.md` how it is put together.

## Progress so far

**What we built.** A working web app, live at https://cs193v-final.vercel.app, in which a group picks a restaurant and a time for a weekend meal without anyone stating their budget to the others.

- Accounts, plans with invite links, and deletion of plans and accounts.
- A private chat per person. Claude turns what they type into structured constraints, with a rule-based extractor as the fallback.
- A negotiation between one assistant per person and a mediator that never sees anyone's constraints. Both are now driven by Claude, with the hard rules and the ranking kept in code.
- Privacy measures: private data encrypted in the database, a final pick computed from a masked sum, and two-person plans that show places only, no counts.
- Limits on chat messages, model calls and log-in attempts.
- An evaluation harness (`sim/`), written up in `docs/evaluation.md`.
- 566 unit tests, browser tests, lint and a secret scan on every pull request.

**What works.** The whole flow from sign-up to a shortlist of up to six options on the live site, with Claude and a built-in list of 16 fictional restaurants. Real restaurants from Google Places are coded and have run on a developer's machine, but are not switched on.

**What we measured.**

- _Protocol against a planner that reads everything:_ over ten seeds of 200 synthetic groups, it agrees in 98.7% of the groups where a plan exists and keeps 94% of the best possible group welfare. A "most votes in round one" baseline keeps 60%.
- _Claude as a planner with no privacy,_ on 40 groups: a valid plan in 45% of the solvable ones, against 100% for the protocol.
- _The extractors on 54 scripted chats,_ 16 of them adversarial: on ordinary chats the rules get 84% of fields right and Claude 96%; neither committed a violation.

**What we learned.**

- **Anonymous counts are not anonymous for two people.** Each knows their own answer, so every count was the other person's. Two-person plans now show no counts.
- **A product of scores gives the scores away,** because it factors back. We mask the comparison between finalists instead.
- **Our "real" groups were easier for the wrong reason.** The Yelp groups agreed almost at once, mostly because personas built from reviews have almost no price or dietary limits.
- **A fallback can be worse than a failure.** When a Claude call failed, the code assistant answered, and it cannot read notes like "allergic to peanuts", so one failed call could turn "no plan" into "everyone's in". Fixed before merging.
- **The rule-based extractor only understands English:** 30% of fields right elsewhere; Claude 100%.

## Changes from our proposal

We did not keep the Week 8 goals in the repository, so this uses the fifteen issues we opened at the start as the record of our plan.

| Planned | Outcome |
|---|---|
| Clean up the code; move the database to Postgres | Done |
| Mobile layout and contrast fixes | Done |
| Rate limits; deleting plans and accounts | Done |
| More real restaurants; travel from each person's start | Built; goes live next week |
| Evaluation over several seeds, with a Claude baseline | Done |
| Keep exploring after the first agreement | Done: the app ends with a shortlist of six |
| Evaluate the extractor, including prompt injection | Done for both; Claude run once |
| Browser tests in CI | Done |
| Evaluate on real preferences (Yelp) | Done, with the caveat above |
| Hide individual scores in the final step (stretch) | Done |
| A second kind of plan | Dropped |

How the scope changed:

- **One kind of plan, not two.** We considered movie night, then hotel picking, and dropped both. Hotels had no free source of prices.
- **The negotiation now uses Claude.** The original design used plain code. Claude-driven assistants can act on what people say in their own words, such as an allergy; code still enforces the hard rules and ranks the options.
- **Real restaurants go live a week late,** on one member's Google billing account.
- **More evaluation than planned:** the ten-seed study, the Yelp personas, the extractor suite and the masked final pick.

## Problems and questions

**1. The cost of paid services.**

- _What slows us:_ Claude on the live site runs on one member's personal API key, and so does our Google Places key.
- _What we tried:_ the app runs with no keys; each plan is capped at 300 model calls a day; we developed on the free Yelp dataset; and we read Google's pricing (up to 12 searches per new plan; roughly 90 plans a month free, then about 45 cents each).
- _Where we need help:_ is there course credit or a shared key for the Anthropic API, and is a personal billing account acceptable for Google?

**2. The Claude-driven negotiation is only lightly verified against the real model.**

- _What slows us:_ real runs cost money and differ each time. We ran the chat suite against Claude twice (96% of fields right, all 16 adversarial chats passed) and six scripted negotiations (164 calls, none failed), nothing at scale. Claude's assistants were more cautious than the code ones: an easy group took six rounds. Our protocol numbers come from the code assistants.
- _What we tried:_ a scripted fake model, and the real runs above.
- _Where we need help:_ budget, as above, and advice on evaluating a system whose answers change from run to run.

## Team contributions and next steps

**Contributions so far** (from merged pull requests):

- **Tyler** (`tylerhuangzy04`): interface redesign; the rebuilt negotiation core; the first Google Places integration and simulation harness; mobile and contrast fixes; browser tests; deletion screens; most of the issues that organised the work.
- **Jackson** (`jacksonfang0205`): the Postgres layer; lint, CI, secret scanning and the contributing guide; deletion in the data layer; rate limits; free-text diet and budget in the chat; the Claude-driven negotiation.
- **Yuxuan** (`yuxuanx-rain`): the larger restaurant pool; per-person travel; the ten-seed evaluation and Claude baseline; exploring after agreement; found the two-person leak; reviewed the Yelp evaluation and the technical overview.
- **Yichang** (`yangmar-yyc`): the database port into this repository; the scenario seam; the Yelp evaluation; the two-person privacy fix; the extractor evaluation and value limits; the masked final pick; the assistant's rubric prompt; the mediator's time check; Google ratings; the shortlist; the three documents; the review that found the fallback bug.

**Week 9 priorities.** Owners are proposed and to be confirmed.

| # | Priority | Owner | Done when |
|---|---|---|---|
| 1 | Run a two-person and a four-person plan on the live site with Claude | Jackson | Both reach a result; calls and cost per plan are recorded |
| 2 | Make Claude's assistants no more cautious than the code ones | Yichang | The easy three-person scenario agrees within three rounds on real Claude |
| 3 | Compare the Claude-driven negotiation with the code one | Yuxuan | The same 40 groups run both ways, side by side in `docs/evaluation.md` |
| 4 | Limit how often a plan can be re-run | Jackson | A test shows the limit and its issue is closed |
| 5 | Try it with one real group of friends | Tyler | Three people outside the team made a plan, and their feedback is written down |
| 6 | Settle who pays for the API keys | Everyone | A spending limit is set on the Claude key and problem 1 is answered here |

**Pathways for the next two weeks,** beyond the table:

1. _Real restaurants on the live site_ (next week): add the Google key with a quota, then tell each private assistant what is nearby, so it asks better questions.
2. _Shorter negotiations with Claude:_ find why its assistants say "reluctant" where code accepts, so an easy group settles in two rounds, not six.
3. _From shortlist to decision:_ try an in-app vote on the six options, and check that it leaks nobody's limits.
