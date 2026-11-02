# Evaluation

Tacit's claim is that a group can settle on a restaurant and a time without anyone's budget, availability or dietary rules leaving their own assistant: the mediator only hears *accept / reluctant / reject* plus at most one dimension name per answer. This chapter measures what that costs: how often the protocol finds a plan, how good it is against a planner that may read everything, and how many dimension names it collects on the way. All numbers come from `sim/out/report.md` and `report.json` (200 synthetic groups, seed 1), produced by the harness in `sim/`.

## Setup

**Synthetic people.** Each person is drawn by `sim/synth.ts` from a seeded PRNG (`sim/rng.ts`, mulberry32). Availability is all five weekend slots with probability 0.45, otherwise 2 to 4 of them; budget ceiling uniform in $18–65 with a $0–15 stretch; maximum travel 8–35 minutes; 18% carry one dietary rule (no spicy, vegetarian, no seafood, halal). Each person likes 0–2 cuisines, dislikes 0–2 others, has random normalised weights over budget / travel / cuisine and a random concession order. These `Constraints` go through the production `compile()` into the same `Preferences` contract the app uses: hard rules for time, diet, price (budget + flex) and distance (travel + 10 min grace); soft rules for price, distance and cuisine.

**Restaurant pools.** Every group gets a fresh pool of 30 restaurants with random cuisine, price ($12–70, skewed cheap), travel (4–35 min), the four dietary flags, and opening slots (60% all five, 25% dinners only, 15% lunches only). A candidate is a (restaurant, open slot) pair; groups in this run had 105–140 candidates each (mean 121.9).

**Groups.** 200 groups of 3 to 6 people (51 / 46 / 44 / 59 groups of size 3 / 4 / 5 / 6). Everything is a pure function of the seed; `runSim` is tested to be byte-for-byte deterministic.

**Protocol parameters.** The defaults from `negotiate()`: at most 6 rounds of 5 candidates; from round 4 every assistant is asked to concede one more step (level = round − 3), which loosens soft rules only; when a round contains unanimously accepted candidates, the top 3 become finalists, each assistant returns a 1–5 utility bucket for them, and the plan with the highest Nash product of buckets wins (ties: best worst-off bucket, then more accepts).

## Baselines

**Oracle** (`sim/oracle.ts`). The no-privacy upper bound: enumerate every candidate, score it with every member's true level-0 `utility()`, drop hard-rule violations, keep the best Nash product and the best max-min.

**Naive** (`naivePick` in `sim/metrics.ts`). The round-1 candidate with the most accepts (ties: fewest reluctant), taken as-is; if anyone rejected it, it counts as no plan. This stands in for "post five options in the chat and go with the most thumbs-up".

**LLM, no privacy** (`sim/llm-baseline.ts`). Claude is given every member's preference JSON verbatim plus the full candidate list (price, travel, cuisine, flags, slot), together with the exact scoring semantics, and asked for one plan through a forced `pick_plan` tool call (`{restaurantId, slot}`). The pick is validated against the candidate pool and scored with the true utilities like the other methods; an invalid pick or a hard-rule violation counts as no plan. It runs with `--llm-baseline` on the first `--llm-groups` groups (default 40) when `ANTHROPIC_API_KEY` is set. It is key-gated and **was not run for this report**, so no LLM numbers are reported here; when it has run, `report.md` gains an "LLM baseline" section that compares all methods on exactly the groups that had the call.

## Metrics

Per group (`sim/metrics.ts`):

- **Convergence**: status `agreed` (everyone accepted), `compromise` (nobody rejects but not everyone accepts), or `no_deal`.
- **Rounds to agreement**: the round in which unanimous acceptance happened.
- **Nash ratio**: product of true utilities of the chosen plan divided by the oracle's best product. **Max-min ratio**: the same for the worst-off member. Both are `undefined` when the oracle itself found nothing (nothing to compare against) and 0 when the oracle found a plan but the method did not.
- **Hits optimum**: the chosen plan's Nash product equals the oracle's (ratio ≥ 1 − 10⁻¹²).
- **Leaked dimension names**: `leakedDims`, the total number of dimension names the mediator saw, and `leakedDims / (size × rounds)` per person per round. A second counter, `observedDims`, wraps every agent and counts what it actually returned, independently of what `negotiate()` reports.

Regret is computable here only because we generated the people: in the real system the utilities never leave the assistants, but in the harness we hold every `Preferences` file and can call `utility()` ourselves. The oracle is that ability applied to every candidate, and 1 − Nash ratio is normalised regret.

## Results

Table 1, from `sim/out/report.md` (ratios are mean / median over the groups where the oracle found a feasible plan):

| group | n | agreed | any plan | oracle feasible | agreed given feasible | plan given feasible | Nash ratio protocol | Nash ratio naive | max-min ratio protocol | max-min ratio naive | hits optimum | leaked dims (mean) | leaked / person / round |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| all | 200 | 74% | 75% | 75% | 99% | 100% | 0.930 / 0.999 | 0.455 / 0.566 | 0.959 / 1.000 | 0.477 / 0.742 | 50% | 36.9 | 2.15 |
| size 3 | 51 | 92% | 92% | 92% | 100% | 100% | 0.931 / 0.976 | 0.615 / 0.846 | 0.960 / 1.000 | 0.645 / 0.894 | 47% | 13.9 | 2.10 |
| size 4 | 46 | 87% | 87% | 87% | 100% | 100% | 0.912 / 0.951 | 0.361 / 0.000 | 0.946 / 0.999 | 0.385 / 0.000 | 35% | 23.0 | 1.97 |
| size 5 | 44 | 61% | 66% | 66% | 93% | 100% | 0.948 / 1.000 | 0.517 / 0.765 | 0.965 / 1.000 | 0.530 / 0.779 | 62% | 45.8 | 2.27 |
| size 6 | 59 | 58% | 58% | 58% | 100% | 100% | 0.933 / 1.000 | 0.293 / 0.000 | 0.967 / 1.000 | 0.310 / 0.000 | 62% | 61.1 | 2.26 |

Figure 1 (`sim/out/report.svg`) plots the mean Nash ratio per group size for naive and protocol against the oracle line at 1.0 (panel a), and the rounds-to-agreement histogram (panel b).

**Feasibility.** The oracle found a plan in 150 of 200 groups, and the 50 `no_deal` outcomes are exactly the 50 infeasible groups: the protocol never gave up on a solvable one. Feasibility falls with size (92% at 3 people, 58% at 6), a property of the generator, so the columns conditioned on oracle feasibility are the ones to read.

**Quality.** Given a feasible group, the protocol produced a plan 100% of the time and unanimous acceptance 99% of the time (148 of 150; the other two are compromises). Its plans keep 93% of the oracle's Nash welfare on average, the median group loses almost nothing (0.999), and the worst-off member keeps 96% of what the oracle could give them. Exactly half the feasible groups (75 of 150) end on the optimum; only 5 fall below a 0.7 Nash ratio (lowest 0.53). Naive finds a feasible plan in only 77 of 150 groups and hits the optimum in 25; its median Nash ratio is 0 at sizes 4 and 6 because the most-voted round-1 option is usually rejected by someone.

**Rounds.** Of the 148 agreements, 75 came in round 1 and 60 in round 2 (135 of 148, 91.2%); rounds 3–6 account for 1, 3, 3 and 6. Both compromises ran all 6 rounds at concession level 3. Mean rounds run is 2.87 (median 2), from 1.78 at 3 people to 3.86 at 6, the latter inflated by infeasible groups running the full 6 rounds.

## Privacy budget

Per candidate it proposes, the mediator sees from each member a verdict and at most one dimension name (`time`, `price`, `diet`, `distance`, `cuisine`), and for at most 3 finalists a 1–5 bucket, sorted so buckets do not map back to members. Never a number, a weight, a concession order or a preference file. `tests/isolation.test.ts` checks this structurally: it walks the static import graph from `negotiate`, `mediator`, `evaluate`, `preferences` and `agent` and asserts it never reaches `db`, `crypto`, `vault`, `events`, `auth`, `session` or the extractors, and that the vault exports agents only.

What a dimension name reveals, and all it reveals: a `time` reject says someone cannot make that slot (the pool only holds slots the restaurant is open for). A `price` reject on a $38 restaurant says some member's hard ceiling is below $38, an ordinal bound that tightens to the cheapest rejected price over the run, not whose ceiling or what it is. `distance` works the same way; `diet` says a flag of that restaurant conflicts with someone's rule; `cuisine` says someone is lukewarm about it. `learn()` in `src/lib/mediator.ts` is the complete list of inferences the proposer draws, from counts alone.

The budget spent: 36.9 dimension names per group on average (median 15, range 0–164), 2.15 per person per round; of the 5 candidates in a round a typical person names a dimension on about two. The cost grows with size and rounds, so 6-person groups spend 61 names on average against 14 for 3-person groups. `observedDims` (what the wrapped agents returned) equals `leakedDims` (what the protocol reports) in every size bucket, 36.90 = 36.90 overall.

## Discussion: what the harness revealed

**Bug 1: concession rounds proposed only untried candidates.** A concession loosens soft rules, so it can turn *reluctant* into *accept* but never *reject* into anything else; the candidates it can rescue are the earlier near-misses, and a concession round made of fresh long shots almost never helps, which is what the harness showed. The fix in `negotiate.ts`: from the first concession round, re-ask up to ⌈perRound/2⌉ of the nearest misses (rejected by at most half the group) before filling the round with new candidates, and re-check everything ever tried at the final level before declaring a compromise or no deal. In this run 12 groups agreed in rounds 4–6, 8 of them on the exact optimum.

**Bug 2: `leakedDims` undercounted.** The final re-check calls `judge()` again on every tried candidate, and those answers carry dimension names too, but the counter skipped them. The `observedDims` column exposed the gap; `tests/sim.test.ts` now asserts per group that `leakedDims` equals the number of names the agents returned, in-round and in the re-check alike.

**First acceptable, not best.** The protocol stops at the first round with a unanimous candidate and chooses only among that round's unanimous candidates. That is why 91% of agreements happen in rounds 1–2 while only 50% hit the optimum: round-1 agreements are optimal in 27 of 75 cases (36%), round-2 agreements in 39 of 60 (65%), because the second round has learned from the first. The knob that trades leak for optimality is how many candidates are asked before stopping, `perRound` in `NegotiateOptions`: each extra candidate costs up to one dimension name per person (2.15 per person per round at 5 candidates) and buys a larger set of unanimous candidates for the finalist step. We did not sweep it for this report.

## Threats to validity

- **Synthetic preferences.** The distributions in `synth.ts` are our guesses; real friends are more correlated (shared budgets and neighbourhoods) and less tidy (a "hard" ceiling that bends).
- **Fixed pools.** The app ships 16 fictional restaurants; the simulation draws 30 synthetic ones per group. Real pools have per-person travel times and more skewed prices.
- **The utility model is ours.** Oracle, agents and the LLM prompt all share `utility()` (weighted mean, linear ramps, accept at 0.7, reluctant at 0.4). The ratios measure how well the protocol recovers that model's optimum, not how satisfied people would be.
- **One seed, one configuration.** No parameter sweep, no confidence intervals.
- **No real users.** Elicitation (chat to `Constraints`) is not evaluated; the harness starts from compiled preferences.
- **LLM baseline not run.** Implemented and tested against a stubbed API; no numbers yet.

## How to reproduce

```
npm run sim -- --groups 200 --seed 1
```

writes `sim/out/report.json`, `report.md` and `report.svg` and prints the summary. With a key, add the LLM baseline on the first 40 groups:

```
ANTHROPIC_API_KEY=... npm run sim -- --groups 200 --seed 1 --llm-baseline --llm-groups 40
```

Without a key the flag prints a note and the run is the deterministic one above. `npx vitest run tests/sim.test.ts` runs the harness tests, including the fake-API tests for the baseline.
