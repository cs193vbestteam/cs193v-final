# sim: the evaluation harness

Measures how much the privacy-preserving protocol in `src/lib/negotiate.ts` gives up compared with a planner that is allowed to read everyone's preferences, on synthetic groups.

## What it measures

For each synthetic group (3..6 people, each with a fresh pool of 30 synthetic restaurants):

- **oracle** (`sim/oracle.ts`): enumerates every (restaurant, open slot), scores it with each person's true level-0 `utility()`, keeps the ones nobody's hard rule rejects, and takes the best Nash product and the best max-min. This is the no-privacy upper bound.
- **protocol**: `negotiate()` with the default settings (6 rounds x 5 candidates, concessions from round 4). It only ever sees accept / reluctant / reject plus at most one dimension name per answer.
- **naive**: the round-1 candidate with the most accepts (ties: fewest reluctant), taken as the plan. If anyone rejected it, it counts as no plan.
- **LLM (no privacy)**, optional (`sim/llm-baseline.ts`): Claude is handed every member's preference JSON plus the full candidate list and asked for one plan through a forced tool call. The pick is scored with the true utilities like everything else; a pick that is not a real candidate, or that violates someone's hard rule, counts as no plan. Key-gated, see below.

Per group (`sim/metrics.ts`): status, rounds run, `nashRatio` = Nash of the chosen plan / oracle best Nash, `maxMinRatio` likewise, `leakedDims` (what `negotiate()` reports) and `observedDims` (dimension names the agents actually returned, counted by wrapping them). Ratios are `undefined` when the oracle itself found nothing feasible and `0` when the oracle found a plan but the method did not.

Everything is driven by a seeded PRNG (`sim/rng.ts`), so `--seed` fully determines the scenarios and the report.

## How to run

```
npm run sim -- --groups 200 --seed 1 --out sim/out
```

Writes `sim/out/report.json` (everything, per group), `sim/out/report.md` (tables) and `sim/out/report.svg` (chart), and prints the summary table. `sim/out/` is git-ignored. Tests: `npx vitest run tests/sim.test.ts`.

### LLM baseline

```
ANTHROPIC_API_KEY=... npm run sim -- --groups 200 --seed 1 --llm-baseline --llm-groups 40
```

`--llm-baseline` only does anything when `ANTHROPIC_API_KEY` is set; otherwise it prints a one-line note and the run is the normal deterministic one. The model comes from `ANTHROPIC_MODEL` (default `claude-haiku-5-5`). `--llm-groups N` (default 40) caps the calls to groups `0..N-1`, so a run stays cheap; requests go two at a time with a 30 s timeout each, and a failed call is recorded as an error and counted as no plan. The report says exactly which groups had the call (`meta.llm.groupIds`, and the "LLM baseline" section of `report.md`), and that section compares protocol, naive and LLM on those same groups. The protocol's numbers never depend on the baseline: it runs after the deterministic pass.

## How to read the chart

- **Panel (a)**: mean Nash ratio per group size, naive (grey) vs protocol (blue), plus LLM (purple) when the baseline ran. The dashed line at 1.0 is the oracle; a bar at 1.0 means the method picked the same plan a mind-reading planner would. Higher is better.
- **Panel (b)**: for groups that reached unanimous acceptance, the round in which it happened. The two bars on the right are groups that ended in a compromise (a plan nobody rejects but not everyone accepts) and groups with no plan at all. Groups with no plan are almost always ones where the oracle also found nothing, so compare `no deal` with the `oracle feasible` rate in the table.

The table columns `agreed given feasible` and `plan given feasible` are the ones to watch: they condition on the oracle having found something, so they say how often the protocol finds it rather than how often the synthetic generator produced a solvable group.

## Persona simulation

```
npm run personas -- --people 5 --seed sim/seeds/friends.md
```

`sim/personas.ts` has an LLM play a group of people who chat with the real private assistant, then runs the real negotiation and records how each persona reacts to the plan. It writes its report to `sim/out/` and uses an in-memory database, so local data is untouched. It needs an LLM key: `ANTHROPIC_API_KEY` by default, or `OPENROUTER_API_KEY`, or `LLM_API_KEY` with `LLM_BASE_URL`. `PERSONA_MODEL` (or `LLM_MODEL_NAME`) overrides the model. `--llm-assistant` also puts the assistant on the LLM path.
