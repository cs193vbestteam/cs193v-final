import { labelOf, matchCuisine } from "./cuisine-table";
import { FEATURE_WORDS } from "./member-state";
import { startTimesIn, type PersonPreferences, type StartTime } from "./optimizer-input";
import type { Place } from "./restaurants";

/**
 * What one person asked for that the chosen plan gives them, in plain words, for a line only
 * they see. It reads that person's own preferences and the place's public facts, nothing else,
 * and is worked out again on each page load: it is never stored with the group's result.
 *
 * Only what was met is listed. What was not met is left unsaid: the plan is the group's, and a
 * list of misses would read as a complaint about other people's wishes.
 */

/** The most things listed, so the line stays one line. */
export const MAX_MATCHES = 4;

export function myMatches(prefs: PersonPreferences, place: Place, startTime: StartTime): string[] {
  const out: string[] = [];
  if ((prefs.wantedRestaurants ?? []).some((r) => r.id === place.id)) out.push("the place you named");

  const types = place.types ?? [];
  if (prefs.cuisine && matchCuisine(types, prefs.cuisine).score === 1) {
    // Name the food by the type that matched, so "you asked for ramen" is not answered with "Japanese".
    const asked = types.find((t) => prefs.cuisine!.scores?.[t] === 1) ?? place.primaryType ?? types[0];
    if (asked) out.push(`${labelOf(asked)} food`);
  }

  const wantedFeatures = [...(prefs.features?.needed ?? []), ...(prefs.features?.wanted ?? [])];
  for (const f of wantedFeatures) if (place.features?.[f] === true) out.push(FEATURE_WORDS[f]);

  if ((prefs.style?.wanted ?? []).some((s) => place.style?.includes(s)))
    out.push(prefs.style!.wanted!.find((s) => place.style?.includes(s))!.replaceAll("_", " "));

  if ((prefs.time?.preferred ?? []).flatMap(startTimesIn).includes(startTime)) out.push("a time you prefer");

  const limit = prefs.budget?.max ?? prefs.budget?.ideal;
  const price = place.price ? (place.price.low + place.price.high) / 2 : null;
  if (limit !== undefined && price !== null && price <= limit) out.push("within your budget");

  return out.slice(0, MAX_MATCHES);
}
