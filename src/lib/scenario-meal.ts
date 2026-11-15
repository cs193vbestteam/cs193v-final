import {
  ConstraintsSchema,
  describeConstraints,
  emptyConstraints,
  mergeConstraints,
  missingFields,
} from "./constraints";
import { extract } from "./extract";
import { OPENING_MESSAGE } from "./extract-rules";
import { openOn } from "./opening-hours";
import { resolvePool } from "./places";
import { compile } from "./preferences";
import { RESTAURANTS } from "./restaurants";
import type { Scenario } from "./scenario";
import { canLocate, resolveStart } from "./start-point";
import { resolveYelpPool } from "./yelp-pool";

/** Picking a restaurant and a start time on the plan's date. The original scenario; see scenario.ts. */
export const meal: Scenario = {
  id: "meal",
  label: "A meal",

  openingMessage: OPENING_MESSAGE,
  emptyConstraints,
  parseConstraints: (raw) => ConstraintsSchema.parse(raw),
  missingFields,
  describeConstraints,

  async chatTurn(history, current, pool, { allowLLM = true } = {}) {
    // A start point is only asked for, and only resolved, when this plan's pool has coordinates.
    const extracted = await extract(history, current, { askStart: canLocate(pool) }, allowLLM);
    const { reply, update } = await resolveStart(extracted.update, extracted.reply, pool);
    let constraints = current;
    try {
      constraints = mergeConstraints(current, update);
    } catch {
      // Ignore an invalid update rather than breaking the chat.
    }
    return { reply, constraints };
  },

  seedPool: RESTAURANTS,
  // The local Yelp dataset, when configured, comes first: it is free and offline (yelp-pool.ts).
  async resolvePool(location, date) {
    const pool = (await resolveYelpPool(location)) ?? (await resolvePool(location));
    if (pool.source === "seed") return pool;
    // A place that cannot take any start time on the plan's date is not a candidate for this plan.
    const restaurants = pool.restaurants.map((r) => openOn(r, date)).filter((r) => r.open.length > 0);
    if (restaurants.length < 5)
      return { source: "seed", location: pool.location, reason: `only ${restaurants.length} places open on ${date}` };
    return { ...pool, restaurants };
  },

  compile,
};
