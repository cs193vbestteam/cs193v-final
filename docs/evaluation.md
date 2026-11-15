# Evaluation

Settle's claim is that a group can settle on a restaurant and a time without anyone's budget, availability or dietary rules leaving their own assistant: the mediator only hears *accept / reluctant / reject* plus at most one dimension name per answer. This chapter measures what that costs: how often the protocol finds a plan, how good it is against a planner that may read everything, and how many dimension names it collects on the way. All numbers come from `sim/out/report.md` and `report.json` (200 synthetic groups, seed 1), produced by the harness in `sim/`.

## Setup

**Synthetic people.** Each person is drawn by `sim/synth.ts` from a seeded PRNG (`sim/rng.ts`, mulberry32). Availability is all five of the simulation's start times with probability 0.45, otherwise 2 to 4 of them; budget ceiling uniform in $18–65 with a $0–15 stretch; maximum travel 8–35 minutes; 18% carry one dietary rule (no spicy, vegetarian, no seafood, halal). Each person likes 0–2 cuisines, dislikes 0–2 others, has random normalised weights over budget / travel / cuisine and a random concession order. These `Constraints` go through the production `compile()` into the same `Preferences` contract the app uses: hard rules for time, diet, price (budget + flex) and distance (travel + 10 min grace); soft rules for price, distance and cuisine.

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
| all | 200 | 74% | 75% | 75% | 99% | 100% | 0.938 / 1.000 | 0.567 / 0.767 | 0.963 / 1.000 | 0.593 / 0.805 | 51% | 20.9 | 2.11 |
| size 3 | 51 | 92% | 92% | 92% | 100% | 100% | 0.928 / 0.975 | 0.727 / 0.889 | 0.958 / 1.000 | 0.757 / 0.934 | 43% | 12.0 | 2.65 |
| size 4 | 46 | 87% | 87% | 87% | 100% | 100% | 0.921 / 0.958 | 0.583 / 0.771 | 0.950 / 0.999 | 0.607 / 0.798 | 38% | 18.0 | 2.46 |
| size 5 | 44 | 61% | 66% | 66% | 93% | 100% | 0.958 / 1.000 | 0.599 / 0.825 | 0.968 / 1.000 | 0.608 / 0.858 | 59% | 19.6 | 1.79 |
| size 6 | 59 | 58% | 58% | 58% | 100% | 100% | 0.958 / 1.000 | 0.299 / 0.000 | 0.982 / 1.000 | 0.337 / 0.000 | 71% | 31.6 | 1.62 |

Figure 1 (`sim/out/report.svg`) plots the mean Nash ratio per group size for naive and protocol against the oracle line at 1.0 (panel a), and the rounds-to-agreement histogram (panel b).

**Feasibility.** The oracle found a plan in 150 of 200 groups, and the 50 `no_deal` outcomes are exactly the 50 infeasible groups: the protocol never gave up on a solvable one. Feasibility falls with size (92% at 3 people, 58% at 6), a property of the generator, so the columns conditioned on oracle feasibility are the ones to read.

**Quality.** Given a feasible group, the protocol produced a plan 100% of the time and unanimous acceptance 99% of the time (148 of 150; the other two are compromises). Its plans keep 94% of the oracle's Nash welfare on average, the median group loses nothing (1.000), and the worst-off member keeps 96% of what the oracle could give them. Half the feasible groups (76 of 150) end on the optimum; only 5 fall below a 0.7 Nash ratio (lowest 0.53). Naive finds a feasible plan in 98 of 150 groups and hits the optimum in 29; its median Nash ratio is 0 at size 6 because the most-voted round-1 option is usually rejected by someone.

**Rounds.** Of the 148 agreements, 87 came in round 1 and 49 in round 2 (136 of 148, 91.9%); rounds 3 to 6 account for 0, 3, 1 and 8. Both compromises ran all 6 rounds at concession level 3. Mean rounds run is 1.46 (median 1), from 1.31 at 3 people to 1.78 at 6.

**What issue #64 changed, and what it cost.** Every number in this document up to here was regenerated after two changes to the protocol:

- *Times first.* Before round 1 the mediator asks each assistant, for each time the pool offers, whether its person can make it, and then proposes only at times everyone can make. Round 1 used to spread its five candidates over all five times, so a group free on one evening spent four of them learning the calendar. If no time suits everyone the negotiation ends there with `no_deal: time` and nobody is asked about a restaurant. Each "cannot make it" is counted as a leaked dimension name, like the time reject it replaces.
- *No pointless re-asks.* A near-miss whose tally did not move when it was asked again after a concession step is not asked a third time; its place goes to a fresh candidate. The re-check at the final concession level still looks at it once more. On the LLM path an assistant also reuses its own earlier verdict, without a model call, unless the thing it objected to has been loosened since.

Ten seeds, before and after (protocol as shipped):

| metric | before #64 | after #64 |
|---|---:|---:|
| rounds run | 2.77 | 1.44 |
| leaked dimension names per group | 34.25 | 21.27 |
| agreement rate, feasible groups | 98.8% | 98.7% |
| Nash ratio, protocol | 0.944 | 0.944 |
| max-min ratio, protocol | 0.969 | 0.968 |
| hits the optimum | 55.2% | 55.3% |
| Nash ratio, naive | 0.438 | 0.603 |

Negotiations take about half the rounds and the mediator hears about 40% fewer dimension names, with no measurable change in welfare. The naive baseline improves because it takes its answer from round 1, and round 1 is now made of candidates at times everyone can make. Leaked names per person per round go up slightly (2.14 to 2.24): the time check is counted, and the rounds it removed were the cheap ones. The Yelp section below was measured before this change and has not been rerun.

## Across seeds and candidates per round

Table 1 is one draw of 200 groups. The tables below repeat it over ten seeds and over four values of `perRound`. They are generated by `npm run sim:study` (`sim/study.ts`); do not edit them by hand.

<!-- prettier-ignore-start -->
<!-- generated:study:start -->

10 seeds (1 to 10), 200 synthetic groups per seed, 30 restaurants per group. Each seed gives one value per metric; the table reports the mean across seeds and a 95% Student-t interval (9 degrees of freedom).

**Across seeds** (protocol as shipped, 5 candidates per round)

| metric | mean [95% interval] | range across seeds |
|---|---:|---:|
| agreement rate | 75.7% [73.9%, 77.4%] | 70.0% to 78.5% |
| agreement rate, feasible groups | 98.7% [98.1%, 99.3%] | 96.8% to 99.4% |
| Nash ratio, protocol | 0.944 [0.938, 0.951] | 0.930 to 0.958 |
| max-min ratio, protocol | 0.968 [0.963, 0.973] | 0.960 to 0.981 |
| hits the optimum | 55.3% [51.9%, 58.8%] | 46.8% to 60.0% |
| Nash ratio, naive | 0.603 [0.575, 0.630] | 0.534 to 0.672 |
| leaked dimension names per group | 21.27 [19.23, 23.32] | 16.58 to 26.30 |
| leaked names per person per round | 2.24 [2.17, 2.32] | 2.11 to 2.43 |
| finalists bucketed per group | 1.27 [1.22, 1.32] | 1.17 to 1.36 |
| rounds run | 1.44 [1.31, 1.56] | 1.11 to 1.74 |

**Candidates per round** (`perRound`), mean [95% interval] across the same seeds

| perRound | agreement rate, feasible groups | Nash ratio, protocol | max-min ratio, protocol | hits the optimum | leaked dimension names per group | leaked names per person per round | rounds run |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 3 | 98.8% [98.3%, 99.3%] | 0.939 [0.934, 0.944] | 0.964 [0.959, 0.970] | 53.9% [51.2%, 56.7%] | 14.45 [13.42, 15.48] | 1.41 [1.37, 1.46] | 1.63 [1.51, 1.75] |
| 5 (shipped) | 98.7% [98.1%, 99.3%] | 0.944 [0.938, 0.951] | 0.968 [0.963, 0.973] | 55.3% [51.9%, 58.8%] | 21.27 [19.23, 23.32] | 2.24 [2.17, 2.32] | 1.44 [1.31, 1.56] |
| 8 | 98.8% [98.3%, 99.3%] | 0.944 [0.939, 0.950] | 0.970 [0.966, 0.973] | 56.1% [52.6%, 59.5%] | 31.64 [28.70, 34.58] | 3.74 [3.63, 3.85] | 1.35 [1.23, 1.46] |
| 10 | 98.3% [97.7%, 99.0%] | 0.948 [0.943, 0.953] | 0.972 [0.968, 0.976] | 56.5% [53.4%, 59.7%] | 37.11 [33.60, 40.63] | 4.74 [4.61, 4.87] | 1.27 [1.17, 1.37] |

**Difference from the shipped 5**, paired by seed (each seed's value minus the same seed at 5); an interval that excludes 0 is a difference every draw of the population supports

| perRound | Nash ratio, protocol | hits the optimum | leaked dimension names per group |
|---:|---:|---:|---:|
| 3 | -0.005 [-0.010, -0.001] | -1.4 pts [-4.0 pts, +1.1 pts] | -6.83 [-7.86, -5.79] |
| 8 | -0.000 [-0.004, +0.004] | +0.7 pts [-0.9 pts, +2.4 pts] | +10.37 [+9.25, +11.48] |
| 10 | +0.004 [-0.002, +0.009] | +1.2 pts [-0.7 pts, +3.1 pts] | +15.84 [+13.87, +17.81] |

**After the first unanimous accept** (`exploreRounds`), mean [95% interval] across the same seeds; the shipped protocol stops at once

| protocol | agreement rate, feasible groups | Nash ratio, protocol | max-min ratio, protocol | hits the optimum | leaked dimension names per group | finalists bucketed per group | rounds run |
|---|---:|---:|---:|---:|---:|---:|---:|
| stop at the first agreement (shipped) | 98.7% [98.1%, 99.3%] | 0.944 [0.938, 0.951] | 0.968 [0.963, 0.973] | 55.3% [51.9%, 58.8%] | 21.27 [19.23, 23.32] | 1.27 [1.22, 1.32] | 1.44 [1.31, 1.56] |
| one more round | 98.7% [98.1%, 99.3%] | 0.954 [0.949, 0.959] | 0.976 [0.972, 0.979] | 57.0% [53.6%, 60.3%] | 25.24 [23.14, 27.35] | 1.96 [1.90, 2.01] | 2.17 [2.05, 2.29] |
| one more round, 6 finalists | 98.7% [98.1%, 99.3%] | 0.958 [0.954, 0.961] | 0.979 [0.976, 0.981] | 58.4% [55.6%, 61.2%] | 25.24 [23.14, 27.35] | 2.79 [2.69, 2.89] | 2.17 [2.05, 2.29] |
| 3 per round, one more round, 6 finalists | 98.8% [98.3%, 99.3%] | 0.954 [0.948, 0.959] | 0.975 [0.972, 0.979] | 56.9% [53.3%, 60.5%] | 16.35 [15.30, 17.40] | 2.24 [2.17, 2.30] | 2.36 [2.24, 2.48] |

**Difference from the shipped protocol**, paired by seed

| protocol | Nash ratio, protocol | max-min ratio, protocol | hits the optimum | leaked dimension names per group | rounds run |
|---|---:|---:|---:|---:|---:|
| one more round | +0.009 [+0.002, +0.016] | +0.007 [+0.003, +0.012] | +1.6 pts [-2.1 pts, +5.4 pts] | +3.97 [+3.77, +4.17] | +0.73 [+0.71, +0.75] |
| one more round, 6 finalists | +0.013 [+0.007, +0.020] | +0.010 [+0.006, +0.015] | +3.1 pts [-0.4 pts, +6.5 pts] | +3.97 [+3.77, +4.17] | +0.73 [+0.71, +0.75] |
| 3 per round, one more round, 6 finalists | +0.009 [+0.002, +0.016] | +0.007 [+0.003, +0.011] | +1.6 pts [-1.9 pts, +5.1 pts] | -4.92 [-5.96, -3.89] | +0.92 [+0.88, +0.96] |

<!-- generated:study:end -->
<!-- prettier-ignore-end -->

![Welfare against leaked dimension names, one point per perRound](evaluation-sweep.svg)

Figure 2 (`docs/evaluation-sweep.svg`) plots the sweep: the Nash ratio (panel a) and the share of feasible groups that end on the optimum (panel b) against the leaked dimension names per group.

**Seed 1 is close to the average.** Table 1 and the Results section report seed 1 alone. Against the ten-seed means it is slightly low on welfare (Nash ratio 0.938 against 0.944, max-min ratio 0.963 against 0.968, optimum rate 51% against 55%) and about average on leak (20.9 names against 21.3). The intervals are narrow: redrawing the population moves the Nash ratio by about ±0.007 and the agreement rate on feasible groups by about half a percentage point. The share of groups that end exactly on the optimum is the noisy one (47% to 60% across seeds), so read it as "about half".

**More candidates per round cost privacy and buy almost nothing.** Going from 3 to 10 candidates per round multiplies what the mediator hears by about two and a half (14 to 37 dimension names per group), while the Nash ratio moves from 0.939 to 0.948. Paired by seed, 8 and 10 do not differ from the shipped 5 on welfare or on the optimum rate by more than their own intervals; `perRound` 3 loses 0.005 of Nash ratio, with an interval that just excludes 0. The differences in leaked names, by contrast, are large and unambiguous. On this evidence `perRound` 3 gives nearly the same plans for about a third fewer leaked names than the shipped 5, at the price of a fifth of a round more on average (1.63 against 1.44 rounds). We have not changed the default in this report.

This also corrects the Discussion below, which guessed that `perRound` was the knob that trades leak for optimality. It trades leak for very little.

**One more round after the first agreement is a small, real gain.** `negotiate()` now takes `exploreRounds`: after the first unanimous round the mediator runs that many more rounds of fresh candidates, at the same concession level, and the plan is picked among every unanimous candidate seen. With one exploring round the Nash ratio rises from 0.944 to 0.954 and the worst-off member's ratio from 0.968 to 0.976; paired by seed both intervals exclude 0. The cost is about 4 more dimension names per group (+19%) and three quarters of a round. The optimum rate moves less than hoped: +1.6 points, with an interval that includes 0.

**The finalist cap was holding it back.** An exploring round usually adds unanimous candidates, but only `finalists` of them (3 as shipped) get the 1 to 5 bucket question that tells them apart, and among fully accepted candidates the cut is arbitrary. With 6 finalists the same round gives a Nash ratio of 0.958 and an optimum rate of 58.4% (+3.1 points, with an interval that only just includes 0), for the same number of leaked names. The price is in the other thing the mediator hears: bucket answers for 2.8 candidates per group instead of 1.3.

**Combined with fewer candidates per round, it is better on both axes.** Three candidates per round, one exploring round and 6 finalists give a Nash ratio of 0.954 against the shipped 0.944 (+0.009, interval excluding 0) while the mediator hears 16 dimension names per group instead of 21 (-23%). It costs about one more round on average (2.36 against 1.44). This is the configuration the numbers favour. It is not the default yet: `exploreRounds` ships as 0, and changing the protocol's defaults is a decision for the team, not for an evaluation PR.

Why the optimum rate stays under 60% in every variant: the final choice is made on 1 to 5 buckets, not on utilities, so candidates the oracle can tell apart often tie for the protocol. That coarseness is deliberate (a bucket leaks less than a number), and it bounds how often the exact optimum can be found no matter how many candidates are explored.

## Ending with a shortlist

The app no longer ends with one plan. `negotiate()` takes `shortlist`, and the app asks for 6: after the first agreement the mediator keeps proposing fresh candidates, at the same concession level, until six different restaurants are options nobody rejects, or rounds or candidates run out. The list is ranked for the group with the same masked comparison as the final pick, fully accepted options above ones that are a stretch for someone, and the first entry is the plan. The tables above are for the protocol's default (`shortlist` 1), which is what they have always measured; the shipped setting costs more, as measured here.

Five seeds of 200 synthetic groups (`shortlist` 1 against 6, everything else as shipped):

| | one plan | shortlist of 6 |
|---|---:|---:|
| rounds run | 1.47 | 3.31 |
| leaked dimension names per group | 21.5 | 37.8 |
| groups with a plan | 778 of 1000 | 778 of 1000 |
| of those, list has all 6 | n/a | 402 (52%) |
| of those, list has 3 to 5 | n/a | 229 (29%) |
| of those, list has 1 or 2 | n/a | 147 (19%) |

Whether a group gets a plan does not change. The price of offering a choice is about two more rounds and three quarters more dimension names heard by the mediator, which puts both back near where they were before issue #64. About half the groups that have a plan get a full list of six; one in five has only one or two workable places to offer, and the list says so by being short. In a group of two the list is shown as places only, with no counts and no mark for which options are a stretch, because either would be the other person's answer. It still tells each of the two that the other does not reject those places, which the single plan did for one place only.

This was measured with a one-off script over the same generator as the study, not by `npm run sim:study`; adding the shortlist as a study variant is left to do.

## LLM baseline

<!-- prettier-ignore-start -->
<!-- generated:llm:start -->

Model `claude-haiku-5-5`, groups 0 to 39 of seed 1 (40 calls, 29 on groups the oracle could solve, 0 failed calls counted as no plan). All three methods are scored on these same groups; ratios are mean / median over the feasible ones.

| method | reads preferences | feasible plan found | Nash ratio | max-min ratio | hits the optimum |
|---|---|---:|---:|---:|---:|
| LLM, no privacy | all of them, verbatim | 44.8% | 0.348 / 0.000 | 0.369 / 0.000 | 10.3% |
| protocol | none | 100.0% | 0.924 / 1.000 | 0.961 / 1.000 | 51.7% |
| naive | none | 58.6% | 0.523 / 0.760 | 0.547 / 0.779 | 20.7% |

Of the 29 solvable groups, the model's pick broke someone's hard rule or was not a real candidate in 16; those count as no plan, like a failed call.

<!-- generated:llm:end -->
<!-- prettier-ignore-end -->

The model was given everything the protocol hides (every member's preference file, the full candidate list and the exact scoring rules) and asked for one plan. It did much worse than the protocol on the same groups, and worse than the naive baseline: in more than half of the solvable groups its pick violated someone's hard rule.

What this does and does not show:

- It is **one run of one small model** (`claude-haiku-5-5`), one call per group with a forced tool call and no room to reason, on 29 solvable groups. A larger model, or the same model allowed to work through the candidates, would very likely do better. The claim is not that language models cannot do this.
- It does show that **handing a model everyone's private data is not, by itself, a better planner** than a deterministic procedure that sees none of it. The task is a constraint check over 100+ candidates and 3 to 6 people, which code does exactly and a single model call does unreliably.
- The numbers are not reproducible to the digit: the model's output can differ between runs. `npm run sim:study -- --llm-baseline` regenerates the table; the multi-seed tables above never depend on it.

## Privacy budget

Per candidate it proposes, the mediator sees from each member a verdict and at most one dimension name (`time`, `price`, `diet`, `distance`, `cuisine`), and, for the finalists, one masked message each whose sum over the group says how the finalists' Nash products compare (below). Never a number, a weight, a concession order, a preference file or anyone's 1 to 5 bucket. `tests/isolation.test.ts` checks this structurally: it walks the static import graph from `negotiate`, `mediator`, `evaluate`, `preferences` and `agent` and asserts it never reaches `db`, `crypto`, `vault`, `events`, `auth`, `session` or the extractors, and that the vault exports agents only.

What a dimension name reveals, and all it reveals: a `time` reject says someone cannot make that slot (the pool only holds slots the restaurant is open for). A `price` reject on a $38 restaurant says some member's hard ceiling is below $38, an ordinal bound that tightens to the cheapest rejected price over the run, not whose ceiling or what it is. `distance` works the same way; `diet` says a flag of that restaurant conflicts with someone's rule; `cuisine` says someone is lukewarm about it. `learn()` in `src/lib/mediator.ts` is the complete list of inferences the proposer draws, from counts alone.

Before round 1 the mediator also asks each assistant whether its person can make each time the pool offers (issue #64). A "no" there is the same statement a `time` reject makes, about a time instead of a candidate, and it is counted in the budget in the same way.

The budget spent: 20.9 dimension names per group on average (median 12, range 1–157), 2.11 per person per round, the time check included. The cost grows with size and rounds, so 6-person groups spend 32 names on average against 12 for 3-person groups. `observedDims` (what the wrapped agents returned) equals `leakedDims` (what the protocol reports) in every size bucket, 20.86 = 20.86 overall.

**The final pick: a masked sum instead of buckets.** The last step compares up to three (or `finalists`) candidates nobody rejects on the Nash product of everyone's 1 to 5 utility bucket. The mediator used to receive those buckets, sorted so they did not map back to people, and multiply them. It now receives none of them (`src/lib/masked-sum.ts`, `maskGroup` in `agent.ts`, `finalistsFor` in `negotiate.ts`).

- *What each assistant sends.* A bucket from 1 to 5 is a product of 2s, 3s and 5s, so it is written as three exponents (4 is two 2s). For every finalist after the first, an assistant takes its exponents for that finalist minus its exponents for the first, adds a pairwise mask shared with each other member (plus towards higher-numbered members, minus towards lower), and sends the result modulo 2^32. On its own that message is uniformly random.
- *What the mediator can compute.* Adding everyone's messages cancels every mask and leaves the sum of the exponent differences: exactly log(Nash product of finalist k / Nash product of the first). The highest wins.
- *What the Nash step needs, and what it gets.* It needs to know which finalist has the largest product. It gets the ratios between products, which is slightly more than it needs and much less than before: not the buckets, not how many people were at 5 or at 3, not even either product. Two finalists everyone scores 5 and two everyone scores 3 look the same.
- *What is approximated.* One thing. Ties in the Nash product used to go to the finalist whose worst-off member had the higher bucket; that needs individual buckets, so a tie now goes to the candidate that was ahead on verdicts (more accepts, fewer reluctant). For buckets of 3 or more, which is what a candidate nobody rejects has, equal products mean the same buckets, so the old tie-break could not have chosen differently. Regenerating every table in this document with the change produces no difference: quality is unchanged.
- *What it still reveals.* The ratio between two finalists says how the group's scores differ between them in aggregate, for example "one more person at 5 for this one than for that one". With two members each knows their own bucket, so the ratio gives them the other's difference; that is the two-person problem again and is why such plans show no finalists at all. With one member the sum is their own answer.
- *What this does not protect against.* Every assistant runs in the same server process as the mediator, and the pairwise keys are made in that process. The masking keeps individual buckets out of the mediator's code, out of the negotiation result and out of the database, in the same structural sense as the import-graph test above. It does not protect against the server itself, which holds the encrypted preferences and the key to them. For that the assistants would have to run on their owners' devices and agree keys between themselves; the protocol here is written so the mediator's side would not change.

`tests/masked-sum.test.ts` checks that the masks cancel and hide each message, that the agents the mediator holds have no way to state a bucket, that a recorded negotiation contains only verdicts and masked messages, and that the pick is the true Nash optimum among the finalists.

**What the group sees, and why two people see less.** The paragraphs above are about the mediator. The result page is a second audience: every member of the plan. For a group of three or more it shows the round log: each option tried, how many accepted, were reluctant or rejected, the dimension names that came with those answers, how each finalist's group score compares with the pick's, and, for the chosen plan, who still has a reservation and about which dimension.

A count is only anonymous if it could be about more than one other person. In a plan of two it cannot: each member knows their own answer, so "1× reject · price" next to a $38 restaurant is the other person's answer, and a few rounds bracket their ceiling. The rule (`forGroupSize` in `src/lib/events.ts`, threshold `MIN_GROUP_FOR_DETAIL = 3`): a plan with fewer than three members stores and shows only the outcome (the chosen plan, or that there is none) and the number of rounds. Tallies, dimension names, conflicts, named reservations, buckets and every place other than the chosen one are removed on the server before the result is written, and again when one is read, so results stored before the rule are covered. `tests/two-person-privacy.test.ts` checks the database row and the rendered card.

What remains visible in a plan of two, because the outcome itself carries it: that the chosen plan is acceptable to the other person, so their ceiling is at least its price and their radius at least its distance; whether it was unanimous or "a stretch for some", which, if it was not a stretch for me, was one for them; the number of rounds, which says whether the first proposals worked for both; and "no plan", which says the other person's limits are incompatible with mine without saying on what. "Re-run with latest info" has no limit, so a member can change their own answers and watch the outcome move; that is a slower version of the same inference and is not addressed here.

What a group of three or more still reveals to its members: a count of one is one of the other two (or more) people, not a named one, so "someone's ceiling is under $38" is known but not whose; in a group of three that is a coin flip between two friends, which is weaker than certainty and well short of anonymity. Two members who compare notes can attribute every count in a group of three. A unanimous count (everyone rejected on price) is about everybody, whatever the size. And the reservation line names a person and a dimension on purpose, at every size from three up. Anonymity in the result page grows with the group; it is not a property the protocol has at any fixed size.

## Discussion: what the harness revealed

**Bug 1: concession rounds proposed only untried candidates.** A concession loosens soft rules, so it can turn *reluctant* into *accept* but never *reject* into anything else; the candidates it can rescue are the earlier near-misses, and a concession round made of fresh long shots almost never helps, which is what the harness showed. The fix in `negotiate.ts`: from the first concession round, re-ask up to ⌈perRound/2⌉ of the nearest misses (rejected by at most half the group) before filling the round with new candidates, and re-check everything ever tried at the final level before declaring a compromise or no deal. In this run 12 groups agreed in rounds 4–6, 8 of them on the exact optimum.

**Bug 2: `leakedDims` undercounted.** The final re-check calls `judge()` again on every tried candidate, and those answers carry dimension names too, but the counter skipped them. The `observedDims` column exposed the gap; `tests/sim.test.ts` now asserts per group that `leakedDims` equals the number of names the agents returned, in-round and in the re-check alike.

**First acceptable, not best.** The protocol stops at the first round with a unanimous candidate and chooses only among that round's unanimous candidates. That is why 91% of agreements happen in rounds 1–2 while only 50% hit the optimum: round-1 agreements are optimal in 27 of 75 cases (36%), round-2 agreements in 39 of 60 (65%), because the second round has learned from the first. That description is of the shipped default. The study above measures the two ways out that were proposed here: more candidates per round (`perRound`) does not help, while one more round after the first agreement (`exploreRounds`) does, modestly.

## Real reviewers: the Yelp Open Dataset

The synthetic people above are our guesses. To see whether the picture holds for real ones, `sim/yelp/` runs the same comparison on the [Yelp Open Dataset](https://business.yelp.com/data/resources/open-dataset/): real restaurants in one city, personas derived from real review histories, and groups that are actual friends. `sim/yelp/README.md` has the method in full; in short, a reviewer with 20 or more restaurant reviews in the city becomes a persona (liked and disliked cuisines, budget, travel radius and weights, all from the earlier 80% of their reviews), groups of 3 to 6 are grown along the friends graph, and each group gets 30 restaurants still in business near its middle. Availability is the one ingredient reviews cannot supply, so weekend slots are drawn as for the synthetic people.

**Do the personas mean anything?** Each persona is checked against the latest 20% of that reviewer's reviews, which it never saw (Table Y1).

| city | restaurants (open) | personas | held-out reviews | hard rules allow a place they later went to (a random place) | later place scores above a random one | later 4-5 star place scores above a later 1-2 star one |
|---|---:|---:|---:|---:|---:|---:|
| Philadelphia | 3807 (2191) | 3557 | 33,234 | 91% (73%) | 63% | 48% |
| Tampa | 1938 (1260) | 1336 | 11,657 | 87% (70%) | 62% | 48% |
| New Orleans | 1283 (785) | 881 | 7,433 | 95% (90%) | 54% | 46% |

The personas capture where someone will go: their budget and travel limits admit about nine in ten of the places they later visited, clearly more than a random place in the city, and a later visit outscores a random place 54 to 63% of the time against a 50% coin flip. They do not capture how much someone will like it once there: a later 4-5 star place outscores a later 1-2 star one 46 to 48% of the time, which is chance. Price band, distance and cuisine say what is acceptable; they do not say what will be good. That is the limit of what these personas can stand in for.

**Protocol results.** This section was measured before issue #64 (times first, no pointless re-asks) and has not been rerun, so its synthetic row is the old Table 1, not the one above; the comparison is like for like. Table Y2 puts 200 friend groups per city next to the synthetic "all" row of Table 1 (seed 1), with the same seed, pool size and protocol settings (ratios are mean / median over groups where the oracle found a feasible plan).

| groups | n | agreed | oracle feasible | agreed given feasible | Nash ratio protocol | Nash ratio naive | max-min ratio protocol | hits optimum | agreed in round 1 | rounds (mean) | leaked dims (mean) | leaked / person / round |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| synthetic (before #64) | 200 | 74% | 75% | 99% | 0.930 / 0.999 | 0.455 / 0.566 | 0.959 | 50% | 75 of 148 | 2.87 | 36.9 | 2.15 |
| Yelp, Philadelphia | 200 | 78% | 78% | 100% | 0.936 / 0.948 | 0.854 / 0.936 | 0.984 | 21% | 143 of 156 | 2.17 | 19.6 | 1.29 |
| Yelp, Tampa | 200 | 83% | 83% | 100% | 0.910 / 0.932 | 0.761 / 0.903 | 0.964 | 33% | 138 of 166 | 2.02 | 17.7 | 1.29 |
| Yelp, New Orleans | 200 | 78% | 78% | 100% | 0.961 / 1.000 | 0.795 / 0.965 | 0.995 | 52% | 129 of 155 | 2.27 | 21.5 | 1.37 |

**What carries over.** In every city the protocol reached unanimous agreement in every group where the oracle found a plan, and the `no_deal` groups are exactly the infeasible ones, as in the synthetic run. Mean Nash ratio is 0.91 to 0.96 against 0.93, and the worst-off member keeps 96 to 99% of what the oracle could give them.

**What is different.** The Yelp groups are easier than the synthetic ones, and it shows in three places. The data cannot say how much of that is the people and how much is the way the personas are built; "Why the Yelp groups are easier" below gives the evidence for each.

- *They agree at once.* 83 to 92% of agreements come in round 1, against 51% for synthetic groups. Fewer rounds means fewer answers, so the mediator sees about half as many dimension names (18 to 22 per group against 37).
- *The naive baseline is no longer weak.* Taking the most-voted round-1 candidate keeps 76 to 85% of the oracle's Nash welfare here, against 46% on synthetic groups. On Philadelphia the protocol's advantage over naive is 0.08, not 0.48. How much the protocol adds over naive therefore depends heavily on how constrained the group is, and the two rows disagree about that by a wide margin.
- *It stops too early.* In Philadelphia only 21% of feasible groups end on the oracle's optimum, against 50% for synthetic groups, although the Nash ratio is the same. With an average of 31 feasible candidates out of 120, something acceptable to everyone usually turns up in the first five proposals, and the protocol takes it. This is the "first acceptable, not best" behaviour from the discussion above, and it bites harder on these groups. The `exploreRounds` option studied above targets exactly this; it was not run on the Yelp groups, and loosely constrained groups like these are where it should matter most.

**Why the Yelp groups are easier: the personas are less constrained, by construction.** A Yelp persona is looser than a synthetic person on most of what can make an assistant say no, and that alone would produce more round-1 agreements, fewer leaked names and a stronger naive baseline. Measured on the 3557 Philadelphia personas against the same number of synthetic people (seed 1):

| | Yelp personas | synthetic people |
|---|---:|---:|
| carry a dietary rule | 0.0% | 17.5% |
| share of the city's open restaurants their hard price ceiling allows (mean) | 97.9% | n/a (prices are drawn from $12 to $70 against ceilings of $18 to $80) |
| have at least one disliked cuisine | 16.1% | 65.4% |
| travel limit (mean) | 10 min | 22 min |

- *Price barely constrains anyone.* Yelp prices take four values ($15, $30, $55, $90), and 95.6% of Philadelphia's open restaurants are at $15 or $30. A persona's budget is the 75th percentile of what they already paid, plus a stretch up to the 95th, so nearly every persona accepts nearly every restaurant on price.
- *Dietary rules never fire.* A persona is vegetarian or halal only when 60% or more of the places they reviewed are categorised that way. No Philadelphia persona meets that bar.
- *Dislikes are rare.* People seldom return to a cuisine they dislike, so few personas carry one.
- *Travel uses two frames.* The limit comes from each person's own centre, but every candidate is measured from the middle of the group. The limit is tighter than a synthetic person's, so travel is the one dimension where personas are not looser, and it is measured inconsistently.

So the comparison in Table Y2 is between tightly constrained synthetic people and loosely constrained Yelp personas. Friends may well also agree more than independent strangers, but this data cannot separate that from the construction, and we do not claim it.

**Other caveats specific to this section.** Availability is synthetic, and the share of feasible groups (78 to 83%) depends on it. One seed per city, with no intervals, unlike the ten-seed study above. Reviewers with 20 or more reviews in one city are heavier users than a typical friend group. And, as Table Y1 shows, the personas describe what people accept, not what they enjoy.

## Elicitation: the extractors on a transcript suite

Everything above starts from compiled preferences. This section is about the step before that: turning what a person types into `Constraints`. There are two extractors, a rule-based one and an LLM one (`src/lib/extract.ts`), and `sim/extract-eval.ts` replays the same short chats through either and compares what was recorded with what a careful person would have recorded.

**The suite** (`tests/fixtures/extract-cases.json`): 38 ordinary chats in five groups (clear answers, vague answers, corrections, other languages, multi-turn) and 16 adversarial ones (instruction overrides, requests for the system prompt or for other members' data, off-topic tasks, out-of-range values, fake system turns, markup and SQL). Each case lists the fields it is about; adversarial cases also list the only fields their messages legitimately talk about.

**Two kinds of result.** Accuracy is a measurement: a wrong field is a miss. A violation is a failure: a final value outside the plausible range, a field changing in an adversarial case although the messages never mention it, or a reply matching a forbidden pattern (the system prompt, another member's number, a long off-topic answer).

**Both extractors** (`npm run sim:extract -- --llm`; the rule-based column is deterministic, the LLM column is one run of `claude-haiku-5-5` on 2026-11-10):

| category | cases | rules: fields right | rules: cases fully right | LLM: fields right | LLM: cases fully right |
|---|---:|---:|---:|---:|---:|
| clear answers | 14 | 94% (67 of 71) | 11 of 14 | 96% (68 of 71) | 11 of 14 |
| vague answers | 7 | 96% (24 of 25) | 6 of 7 | 96% (24 of 25) | 6 of 7 |
| corrections | 6 | 100% (14 of 14) | 6 of 6 | 86% (12 of 14) | 5 of 6 |
| other languages | 6 | 30% (9 of 30) | 0 of 6 | 100% (30 of 30) | 6 of 6 |
| multi-turn | 5 | 96% (24 of 25) | 4 of 5 | 100% (25 of 25) | 5 of 5 |
| **all except adversarial** | 38 | 84% (138 of 165) | 27 of 38 | 96% (159 of 165) | 33 of 38 |
| adversarial | 16 | 92% (12 of 13) | 15 of 16 | 100% (13 of 13) | 16 of 16 |

Violations: 0 for either extractor across all 81 turns. What the rule-based misses are:

- *It is English-only.* Spanish, Chinese, French, German and Korean messages lose their time slots and dietary rules entirely; the 30% is digits it could still read next to "$" or "min". This is most of the gap to 100%.
- *It still turns one vague phrase into a number.* "Not too far" records 20 minutes, where the product says to ask. ("I don't care about price" and "anywhere is fine" used to become $200 and 60 minutes; since #63 they are recorded as what the person said, no limit.)
- *Number words and partial refinements.* "twenty-five minutes" is not read.
- *It does not know regions or styles.* "Asian food" and "anything but Western food" record no cuisine. This is deliberate: translating a region into cuisines is left to the model (see below), not to a table in code.
- *A negative number loses its sign.* "Set my budget to -50 dollars" records $50. The value is in range and the field is the one the message is about, so this is a miss, not a violation.

**Guardrails, and what they do and do not cover.** These hold for both extractors and are tested in CI with a stubbed model (`tests/extract-eval.test.ts`):

- *Structure.* The model's output must parse against the update schema: unknown slots or dietary rules, text where a number belongs, a missing update or an empty reply all discard the model's answer, and the rule-based extractor answers instead. Fields that do not exist (`ready`, `isAdmin`) and coordinates are stripped; a start point can only come from geocoding.
- *Range* (new with this evaluation; `UPDATE_LIMITS` in `src/lib/constraints.ts`). Before it, any positive integer was a valid budget or travel time. Now a budget must be $1 to $500 a person, its stretch at most $200, travel 1 to 180 minutes and a weight 0 to 1. An out-of-range number is dropped, the rest of the update is kept, and the reply says the value was not recorded.
- *Other people's data.* The request to the model contains this person's constraints and chat and nothing about anyone else, so there is nothing for an injection to reveal. That is structural, not a property of the prompt.
- *Not covered: an invented but plausible value.* If the model answers "tell me a joke" by setting a budget of $25, the value is valid and in range, and nothing in the app can tell it from a real answer. The harness flags it as a violation (a field changed that the messages never mention), which is why the real-model run matters; the stub test shows the harness catches it.

**LLM extractor.** All 81 turns were answered by the model: 0 fell back to the rule-based extractor and 0 updates were discarded as invalid, so the column is the model's. It is one run, and the model is not deterministic: a second run of the same suite also scored 96% overall but missed different time slots. What it shows:

- *Other languages are where the model earns its place:* 100% against 30%.
- *Adversarial cases:* 16 of 16 with no violations. The suite is ours and small; it shows the obvious attacks fail, not that none can succeed.
- *Regions and styles (issue #62).* The prompt tells the model to translate a region, style or dish into cuisines from the list ("Asian" is japanese, chinese, korean, thai and vietnamese, not indian) and to say which ones it noted. A cuisine word that is still not on the list is dropped on its own with a note in the reply, and the rest of the update is kept.
- *Bare answers (issue #63).* The prompt is now a fixed rubric (the goal, what to learn, how to handle one message) followed by a short state block that names the question asked last and what is still to ask (`src/lib/extract-prompt.ts`). Before it, "20" in answer to the distance question was recorded as a $20 budget; the multi-turn chat "Friday", "40", "20", "nothing" now ends with all four essentials. As a net, a bare number the model files under the wrong question is handed to the rule-based reader, which is exact for that case.
- *"I don't mind" and "at least $50" (issue #63).* Not caring is an answer: it is recorded as no budget limit, any distance, or no cuisine preference, and the question is not asked again. A minimum spend is recorded as a preference, never a hard rule, so it cannot make a plan impossible on its own. The first version of this wording made the model reset an already recorded time to "any time" when someone said "whatever is fine" about the budget; the suite caught it and the rubric now says a shrug answers only the question just asked.
- *Its misses:* "actually not Mexican" leaves Mexican liked instead of moving it to disliked; two clear cases get a time slot wrong; "no restrictions" next to a minimum spend was not marked as confirmed; and after "not sure, it depends" the model no longer infers $30 from "the $45 one would bother me" (the rule-based either/or does).

## Threats to validity

- **Synthetic preferences.** The distributions in `synth.ts` are our guesses; real friends are more correlated (shared budgets and neighbourhoods) and less tidy (a "hard" ceiling that bends). The Yelp section above replaces the guesses with personas derived from real reviewers for cuisine, budget and travel. Those groups come out easier than the synthetic ones, but the personas are also less constrained by construction (almost no price or dietary limits), so that result does not show that real friends disagree less; availability is still synthetic there, and the personas predict where people go but not how much they like it.
- **Fixed pools.** The app ships 16 fictional restaurants; the simulation draws 30 synthetic ones per group. Real pools have per-person travel times and more skewed prices.
- **The utility model is ours.** Oracle, agents and the LLM prompt all share `utility()` (weighted mean, linear ramps, accept at 0.7, reluctant at 0.4). The ratios measure how well the protocol recovers that model's optimum, not how satisfied people would be.
- **Seeds vary the people, not the generator.** The intervals above cover redrawing the population from the same distributions. They say nothing about whether those distributions resemble real groups. Only `perRound` was swept; `maxRounds`, the concession schedule and the accept thresholds were not.
- **No real users.** The simulations start from compiled preferences. Elicitation (chat to `Constraints`) is evaluated separately on 54 scripted chats, with two runs of the LLM extractor, and scripted chats are not real conversations.
- **LLM baseline: one model, one run, 40 groups.** No repeat runs, no second model, no interval; see the caveats under the table.

## How to reproduce

One command regenerates every number in this document except the Yelp section, which needs a separate download (below):

```
npm run sim:study
```

It runs the seed-1 report behind Table 1 and Figure 1 (`sim/out/report.{json,md,svg}`, the same output as `npm run sim -- --groups 200 --seed 1`), then the ten-seed study and the `perRound` sweep, and rewrites the generated tables above and `docs/evaluation-sweep.svg`. All of that is deterministic and takes a few seconds; `tests/study.test.ts` fails if the tables in this file differ from what the command produces, and `npm run sim:study -- --check` does the same check from the command line.

The LLM baseline is the one part that needs a key and costs money. Put `ANTHROPIC_API_KEY` in `.env.local` (the command reads it) or in the environment, then:

```
npm run sim:study -- --llm-baseline --llm-groups 40
```

That adds 40 model calls on the first 40 groups of seed 1 and rewrites the "LLM baseline" table. Without the flag, or without a key, that table is left exactly as it is. `npx vitest run tests/sim.test.ts tests/study.test.ts` runs the harness tests, including the fake-API tests for the baseline and the multi-seed aggregation.

For the Yelp section, download the dataset (see `sim/yelp/README.md`; it is not in this repository) and run, once per city:

```
npm run sim:yelp -- --data data/yelp --city Philadelphia --groups 200 --seed 1 --out sim/out/yelp
```

which writes `report.json` and `report.md` into `--out`. `npx vitest run tests/yelp.test.ts` runs its tests on made-up records.

For the extractor section:

```
npm run sim:extract
```

replays the transcript suite through the rule-based extractor, prints the table and writes `sim/out/extract/report.{json,md}`; it exits 1 on any violation. With `ANTHROPIC_API_KEY` in `.env.local` or the environment, `npm run sim:extract -- --llm` adds the LLM column. `npx vitest run tests/extract-eval.test.ts` runs the deterministic part, with a stubbed model.
