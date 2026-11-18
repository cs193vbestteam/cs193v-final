import { assistantTurn } from "./assistant";
import { OPENING_MESSAGE } from "./extract-rules";
import { toLegacyConstraints } from "./legacy-adapter";
import { answerProgress, describeState, emptyMemberState, missingRequired, parseMemberState } from "./member-state";
import { openOn } from "./opening-hours";
import { MIN_POOL, resolvePool } from "./places";
import { compile } from "./preferences";
import { RESTAURANTS, hasLegacyCuisine } from "./restaurants";
import type { Scenario } from "./scenario";
import { resolveYelpPool } from "./yelp-pool";

/** Picking a restaurant and a start time on the plan's date. The original scenario; see scenario.ts. */
export const meal: Scenario = {
  id: "meal",
  label: "A meal",

  openingMessage: OPENING_MESSAGE,
  emptyConstraints: emptyMemberState,
  parseConstraints: parseMemberState,
  missingFields: missingRequired,
  describeConstraints: describeState,
  answerProgress,

  async chatTurn(history, current, pool, options = {}) {
    const turn = await assistantTurn(history, current, pool, options);
    return { reply: turn.reply, constraints: turn.state, changed: turn.changed };
  },

  seedPool: RESTAURANTS,
  // The local Yelp dataset, when configured, comes first: it is free and offline (yelp-pool.ts).
  async resolvePool(location, date) {
    const pool = (await resolveYelpPool(location)) ?? (await resolvePool(location));
    if (pool.source === "seed") return pool;
    // A place that cannot take any start time on the plan's date is not a candidate for this plan.
    const restaurants = pool.restaurants.map((r) => openOn(r, date)).filter((r) => r.open.length > 0);
    const usable = restaurants.filter(hasLegacyCuisine).length;
    if (usable < MIN_POOL)
      return { source: "seed", location: pool.location, reason: `only ${usable} places open on ${date}` };
    return { ...pool, restaurants };
  },

  // Transitional: the negotiation engine still reads the older format (legacy-adapter.ts).
  compile: (state) => compile(toLegacyConstraints(state)),
};
