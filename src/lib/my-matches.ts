import { labelOf, matchCuisine } from "./cuisine-table";
import type { LatLng } from "./geo";
import { FEATURE_WORDS, MODE_WORDS } from "./member-state";
import { personTravelMin } from "./optimizer-handoff";
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

/**
 * How long the trip to the chosen place is for this person: from their own start point by their
 * own way of travelling, the same figure the optimizer used. Said only when they told us
 * something about travel and the place can be measured to. Unlike the list above, it is said
 * even when it is over what they asked: a limit is weighed, not guaranteed, and a person who
 * gave one should see what they got rather than find out on the way there.
 */
export function myTrip(
  prefs: PersonPreferences,
  startPoint: (LatLng & { label: string }) | null,
  place: Pick<Place, "location" | "travelMin">,
  center: LatLng | null,
): string | null {
  if (!prefs.travel && !startPoint) return null;
  if (!place.location || !(startPoint ?? center)) return null;
  const minutes = personTravelMin(prefs, startPoint, place, center);
  const limit = prefs.travel?.maxMin ?? prefs.travel?.idealMin;
  const how = MODE_WORDS[prefs.travel?.mode ?? "drive"];
  const over = limit !== undefined && minutes > limit ? ` (over the ${limit} you asked for)` : "";
  return `about ${minutes} min ${how} from ${startPoint ? startPoint.label : "the plan's location"}${over}`;
}
