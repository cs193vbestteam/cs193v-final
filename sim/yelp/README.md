# sim/yelp: the evaluation on real reviewers

Runs the same comparison as the synthetic harness (`sim/README.md`), but with people and restaurants taken from the [Yelp Open Dataset](https://business.yelp.com/data/resources/open-dataset/): real restaurants in one city, personas derived from real review histories, and groups that are actual friends.

## Getting the data

The dataset is not in this repository and must not be added to it.

1. Download "Yelp-JSON" from the page above (about 4.4 GB compressed, 8.7 GB unpacked) and unpack it.
2. Put these three files in one folder, for example `data/yelp/` (git-ignored):
   - `yelp_academic_dataset_business.json`
   - `yelp_academic_dataset_review.json`
   - `yelp_academic_dataset_user.json`

**Licence.** Yelp describes the dataset as intended for educational use, and the download includes its Dataset User Agreement as a PDF. Read it before using the data. As we understand it, the data may be used for academic and personal purposes, may not be used commercially, and may not be redistributed, which is why only our code and the aggregate numbers it produces are committed, never the records themselves.

## How to run

```
npm run sim:yelp -- --data data/yelp --city Philadelphia --groups 200 --seed 1 --out sim/out/yelp
```

Writes `sim/out/yelp/report.json` and `report.md` and prints the summary. `--city` must match the dataset's `city` field. `--restaurants` (default 30) sets the pool size per group. The same data, city and seed always give the same report. Tests: `npx vitest run tests/yelp.test.ts` (they use made-up records, not the dataset).

## What it does

1. **Restaurants** (`businesses.ts`). A business is kept when it is a restaurant with coordinates, a price band and one of the ten cuisines the app models. Categories give the cuisine, the price band gives dollars per person (the same figures `places.ts` uses), opening hours give the weekend slots, and category keywords give the dietary flags.
2. **Personas** (`personas.ts`). A reviewer needs 20 or more reviews of those restaurants. From the earlier 80% of their reviews:
   - liked cuisines: ones they return to (3+ reviews) and rate at least as well as their own average; disliked: tried twice or more and rated 2.5 or lower
   - budget: the 75th percentile price of places they rated 3 or more; the gap to the 95th percentile is "a stretch"
   - travel: the 75th percentile distance from the centre of where they eat, in minutes
   - weights: how selective they are on budget, distance and cuisine, relative to each other; the least important is conceded first
   - diet: vegetarian or halal only when 60% or more of where they eat is categorised that way
3. **Validation**. The latest 20% of each reviewer's reviews are held out. The report says how often the persona's hard rules allow a place they later went to, how often such a place scores above a random one, and how often a later 4-5 star place scores above a later 1-2 star one.
4. **Groups** (`groups.ts`). Grown along the friends graph among reviewers who have a persona, 3 to 6 people.
5. **Pool**. For each group, restaurants still in business within 12 km of the middle of the group, sampled down to the pool size.
6. **Comparison** (`pipeline.ts`). Oracle, protocol and naive baseline on those groups, next to the synthetic harness on the same number of groups, seed, pool size and protocol settings.

## What is still synthetic, and other limits

- **Availability.** Reviews do not say when someone is free, so weekend slots are drawn from the same distribution as the synthetic people.
- **Travel is measured from the middle of the group** for everyone, as the app does for a plan without start points. Per-person start points (#8) are not used here, because the oracle scores a candidate once per group.
- **Dislikes are sparse.** People rarely go back to a cuisine they dislike, so few personas carry a disliked cuisine.
- **Dietary flags are keyword guesses** from categories, as they are for live Google results.
- **Reviewers are not everyone.** People with 20+ reviews in one city are heavier and more opinionated users than a typical group of friends.
