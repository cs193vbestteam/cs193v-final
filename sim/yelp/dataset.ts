import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

/**
 * The Yelp Open Dataset on disk: one JSON object per line, one file per kind
 * of record. Only the fields the evaluation reads are typed here.
 *
 * The data is never committed (see sim/yelp/README.md for where to get it and
 * its licence). Everything downstream takes plain arrays, so the tests run on
 * small hand-written records instead of the real files.
 */

export const FILES = {
  business: "yelp_academic_dataset_business.json",
  review: "yelp_academic_dataset_review.json",
  user: "yelp_academic_dataset_user.json",
} as const;

export type YelpBusiness = {
  business_id: string;
  name: string;
  city: string;
  state: string;
  latitude: number | null;
  longitude: number | null;
  is_open: number;
  /** e.g. `{ RestaurantsPriceRange2: "2" }`; values are strings, sometimes the string "None". */
  attributes: Record<string, unknown> | null;
  /** Comma-separated, e.g. "Mexican, Burgers, Restaurants". */
  categories: string | null;
  /** e.g. `{ Friday: "11:0-22:0" }`. */
  hours: Record<string, string> | null;
};

export type YelpReview = {
  user_id: string;
  business_id: string;
  stars: number;
  /** "2016-03-09 05:07:51" */
  date: string;
};

export type YelpUser = {
  user_id: string;
  /** Comma-separated user ids, or the string "None". */
  friends: string | null;
};

/** Stream a JSON-lines file without loading it: the review file is several gigabytes. */
export async function* readLines(file: string): AsyncGenerator<string> {
  const rl = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of rl) if (line.trim()) yield line;
}

/**
 * The value of a top-level string field, read without parsing the line.
 * Used to skip the (large) majority of review and user lines we do not need.
 */
export function stringField(line: string, field: string): string | null {
  const marker = `"${field}":"`;
  const start = line.indexOf(marker);
  if (start < 0) return null;
  const from = start + marker.length;
  const end = line.indexOf('"', from);
  return end < 0 ? null : line.slice(from, end);
}

export function parseFriends(friends: string | null | undefined): string[] {
  if (!friends || friends === "None") return [];
  return friends
    .split(",")
    .map((f) => f.trim())
    .filter(Boolean);
}
