import { existsSync } from "node:fs";
import { join } from "node:path";
import { restaurantsInCity, type YelpRestaurant } from "./businesses";
import {
  FILES,
  parseFriends,
  readLines,
  stringField,
  type YelpBusiness,
  type YelpReview,
  type YelpUser,
} from "./dataset";
import { MIN_REVIEWS, type Visit } from "./personas";
import type { YelpInput } from "./pipeline";

/**
 * Reads the three dataset files for one city. Each file is streamed once:
 * businesses in full, then only the reviews of that city's restaurants, then
 * only the users who wrote enough of those reviews.
 */

export function missingFiles(dir: string): string[] {
  return Object.values(FILES).filter((f) => !existsSync(join(dir, f)));
}

async function* parsed<T>(file: string): AsyncGenerator<T> {
  for await (const line of readLines(file)) yield JSON.parse(line) as T;
}

export async function loadCity(
  dir: string,
  city: string,
  onProgress: (message: string) => void = () => {},
): Promise<YelpInput> {
  const businesses: YelpBusiness[] = [];
  for await (const b of parsed<YelpBusiness>(join(dir, FILES.business))) businesses.push(b);
  const restaurants: Map<string, YelpRestaurant> = restaurantsInCity(businesses, city);
  onProgress(`${restaurants.size} mappable restaurants in ${city} (of ${businesses.length} businesses in the dataset)`);

  const visitsByUser = new Map<string, Visit[]>();
  let reviews = 0;
  for await (const line of readLines(join(dir, FILES.review))) {
    // Most reviews are for other cities or other kinds of business: skip those without parsing.
    const businessId = stringField(line, "business_id");
    if (businessId !== null && !restaurants.has(businessId)) continue;
    const r = JSON.parse(line) as YelpReview;
    const restaurant = restaurants.get(r.business_id);
    if (!restaurant) continue;
    reviews++;
    const visits = visitsByUser.get(r.user_id) ?? [];
    visits.push({ restaurant, stars: r.stars, date: r.date });
    visitsByUser.set(r.user_id, visits);
  }
  for (const [id, visits] of visitsByUser) if (visits.length < MIN_REVIEWS) visitsByUser.delete(id);
  onProgress(`${reviews} reviews of those restaurants; ${visitsByUser.size} reviewers with ${MIN_REVIEWS}+ of them`);

  const friendsOf = new Map<string, string[]>();
  for await (const line of readLines(join(dir, FILES.user))) {
    const userId = stringField(line, "user_id");
    if (userId !== null && !visitsByUser.has(userId)) continue;
    const u = JSON.parse(line) as YelpUser;
    if (visitsByUser.has(u.user_id)) friendsOf.set(u.user_id, parseFriends(u.friends));
  }
  onProgress(`friend lists read for ${friendsOf.size} of them`);

  return { city, restaurants, visitsByUser, friendsOf };
}
