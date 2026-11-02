# sim: the evaluation harness

Measures how much the privacy-preserving protocol in `src/lib/negotiate.ts` gives up compared with a planner that is allowed to read everyone's preferences, on synthetic groups.

## What it measures

For each synthetic group (3..6 people, each with a fresh pool of 30 synthetic restaurants):

- **oracle** (`sim/oracle.ts`): enumerates every (restaurant, open slot), scores it with each person's true level-0 `utility()`, keeps the ones nobody's hard rule rejects, and takes the best Nash product and the best max-min. This is the no-privacy upper bound.
- **protocol**: `negotiate()` with the default settings (6 rounds x 5 candidates, concessions from round 4). It only ever sees accept / reluctant / reject plus at most one dimension name per answer.
- **naive**: the round-1 candidate with the most accepts (ties: fewest reluctant), taken as the plan. If anyone rejected it, it counts as no plan.

Per group (`sim/metrics.ts`): status, rounds run, `nashRatio` = Nash of the chosen plan / oracle best Nash, `maxMinRatio` likewise, `leakedDims` (what `negotiate()` reports) and `observedDims` (dimension names the agents actually returned, counted by wrapping them). Ratios are `undefined` when the oracle itself found nothing feasible and `0` when the oracle found a plan but the method did not.

Everything is driven by a seeded PRNG (`sim/rng.ts`), so `--seed` fully determines the scenarios and the report.

## How to run

```
npm run sim -- --groups 200 --seed 1 --out sim/out
```

Writes `sim/out/report.json` (everything, per group), `sim/out/report.md` (tables) and `sim/out/report.svg` (chart), and prints the summary table. `sim/out/` is git-ignored. Tests: `npx vitest run tests/sim.test.ts`.

## How to read the chart

- **Panel (a)**: mean Nash ratio per group size, naive (grey) vs protocol (blue). The dashed line at 1.0 is the oracle; a bar at 1.0 means the method picked the same plan a mind-reading planner would. Higher is better.
- **Panel (b)**: for groups that reached unanimous acceptance, the round in which it happened. The two bars on the right are groups that ended in a compromise (a plan nobody rejects but not everyone accepts) and groups with no plan at all. Groups with no plan are almost always ones where the oracle also found nothing, so compare `no deal` with the `oracle feasible` rate in the table.

The table columns `agreed given feasible` and `plan given feasible` are the ones to watch: they condition on the oracle having found something, so they say how often the protocol finds it rather than how often the synthetic generator produced a solvable group.
