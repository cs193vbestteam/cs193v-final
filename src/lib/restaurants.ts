import type { Cuisine, Slot } from "./constraints";
import { LEGACY_CUISINE_TYPE, stylesOf } from "./cuisine-table";
import type { LatLng } from "./geo";
import { dailyHours, openStartTimes, type WeeklyHours } from "./opening-hours";
import type { Style } from "./optimizer-input";

/**
 * Hard-coded, fictional restaurant data: the seed pool, used when a plan has no
 * location or Google Places is off (see places.ts and pool.ts).
 */
export type Restaurant = {
  id: string;
  name: string;
  /** One of the ten cuisines the current negotiation engine knows. Goes away with that engine. */
  cuisine: Cuisine;
  /**
   * The place's Google Places types (`ramen_restaurant`, `japanese_restaurant`, …): what the
   * optimizer matches a person's cuisine wishes against (`matchCuisine` in cuisine-table.ts).
   * Present for Places results and the seed; absent for the Yelp sample data.
   */
  types?: string[];
  /** The kind of place, worked out from `types` (`stylesOf`). Present whenever `types` is. */
  style?: Style[];
  /** Typical spend per person, in dollars. */
  pricePerPerson: number;
  /**
   * What a meal costs per person, in dollars, as Google gives it; null when Google gives no
   * price at all (then `pricePerPerson` is only a default). Absent for the seed and Yelp data.
   */
  price?: { low: number; high: number } | null;
  /** One-way travel time from the plan's location (campus, for the seed), in minutes. */
  travelMin: number;
  /** Where the place is. Public. Present for Places results, absent for the seed. */
  location?: LatLng;
  /** Most of the menu is spicy. */
  spicy: boolean;
  vegetarianFriendly: boolean;
  /** Google's own answer to "serves vegetarian food"; null when it does not say. Places results only. */
  servesVegetarian?: boolean | null;
  /** Menu is mostly seafood. */
  seafoodHeavy: boolean;
  halal: boolean;
  /**
   * The start times the restaurant can take on the plan's date: worked out from `hours`
   * when the plan's pool is built (see `openOn` in opening-hours.ts). Empty when the place
   * is closed that day or its hours are unknown, and then it is never proposed.
   */
  open: Slot[];
  /** Opening hours through the week. Absent when unknown, which is not the same as open. */
  hours?: WeeklyHours;
  /** Google's public rating, 1 to 5, and how many reviews it rests on. Places results only. */
  rating?: number;
  ratingCount?: number;
  /** Street address and a Google Maps link, shown to the group for the chosen place. Places results only. */
  address?: string;
  mapsUrl?: string;
};

/** Made-up hours for the seed places, the same every day, so `open` does not depend on the date. */
const hoursAndOpen = (hours: WeeklyHours) => ({ hours, open: openStartTimes(hours, "2026-01-01") ?? [] });
const LUNCH_AND_DINNER = hoursAndOpen(dailyHours([11, 15], [17, 22]));
const DINNER_ONLY = hoursAndOpen(dailyHours([17, 23]));
const LUNCH_ONLY = hoursAndOpen(dailyHours([10, 16]));

const SEED: Restaurant[] = [
  {
    id: "sakura-table",
    name: "Sakura Table",
    cuisine: "japanese",
    pricePerPerson: 45,
    travelMin: 10,
    spicy: false,
    vegetarianFriendly: false,
    seafoodHeavy: true,
    halal: false,
    ...LUNCH_AND_DINNER,
  },
  {
    id: "noodle-lab",
    name: "Noodle Lab",
    cuisine: "japanese",
    pricePerPerson: 22,
    travelMin: 8,
    spicy: false,
    vegetarianFriendly: true,
    seafoodHeavy: false,
    halal: false,
    ...LUNCH_AND_DINNER,
  },
  {
    id: "red-lantern",
    name: "Red Lantern Hotpot",
    cuisine: "chinese",
    pricePerPerson: 38,
    travelMin: 18,
    spicy: true,
    vegetarianFriendly: true,
    seafoodHeavy: false,
    halal: false,
    ...DINNER_ONLY,
  },
  {
    id: "jade-garden",
    name: "Jade Garden Dim Sum",
    cuisine: "chinese",
    pricePerPerson: 28,
    travelMin: 15,
    spicy: false,
    vegetarianFriendly: true,
    seafoodHeavy: false,
    halal: false,
    ...LUNCH_ONLY,
  },
  {
    id: "seoul-grill",
    name: "Seoul Grill House",
    cuisine: "korean",
    pricePerPerson: 42,
    travelMin: 20,
    spicy: true,
    vegetarianFriendly: false,
    seafoodHeavy: false,
    halal: false,
    ...LUNCH_AND_DINNER,
  },
  {
    id: "bibim-bowl",
    name: "Bibim Bowl",
    cuisine: "korean",
    pricePerPerson: 18,
    travelMin: 6,
    spicy: false,
    vegetarianFriendly: true,
    seafoodHeavy: false,
    halal: false,
    ...LUNCH_AND_DINNER,
  },
  {
    id: "lemongrass",
    name: "Lemongrass Kitchen",
    cuisine: "thai",
    pricePerPerson: 26,
    travelMin: 12,
    spicy: true,
    vegetarianFriendly: true,
    seafoodHeavy: false,
    halal: false,
    ...LUNCH_AND_DINNER,
  },
  {
    id: "pho-corner",
    name: "Pho Corner",
    cuisine: "vietnamese",
    pricePerPerson: 17,
    travelMin: 9,
    spicy: false,
    vegetarianFriendly: true,
    seafoodHeavy: false,
    halal: false,
    ...LUNCH_AND_DINNER,
  },
  {
    id: "saffron",
    name: "Saffron & Spice",
    cuisine: "indian",
    pricePerPerson: 30,
    travelMin: 14,
    spicy: true,
    vegetarianFriendly: true,
    seafoodHeavy: false,
    halal: true,
    ...LUNCH_AND_DINNER,
  },
  {
    id: "taqueria-sol",
    name: "Taqueria Sol",
    cuisine: "mexican",
    pricePerPerson: 15,
    travelMin: 5,
    spicy: false,
    vegetarianFriendly: true,
    seafoodHeavy: false,
    halal: false,
    ...LUNCH_AND_DINNER,
  },
  {
    id: "trattoria-luce",
    name: "Trattoria Luce",
    cuisine: "italian",
    pricePerPerson: 55,
    travelMin: 22,
    spicy: false,
    vegetarianFriendly: true,
    seafoodHeavy: false,
    halal: false,
    ...DINNER_ONLY,
  },
  {
    id: "slice-society",
    name: "Slice Society",
    cuisine: "italian",
    pricePerPerson: 20,
    travelMin: 7,
    spicy: false,
    vegetarianFriendly: true,
    seafoodHeavy: false,
    halal: false,
    ...LUNCH_AND_DINNER,
  },
  {
    id: "patty-shack",
    name: "Patty Shack",
    cuisine: "american",
    pricePerPerson: 19,
    travelMin: 6,
    spicy: false,
    vegetarianFriendly: false,
    seafoodHeavy: false,
    halal: false,
    ...LUNCH_AND_DINNER,
  },
  {
    id: "harbor-oyster",
    name: "Harbor Oyster Bar",
    cuisine: "american",
    pricePerPerson: 60,
    travelMin: 30,
    spicy: false,
    vegetarianFriendly: false,
    seafoodHeavy: true,
    halal: false,
    ...DINNER_ONLY,
  },
  {
    id: "olive-tree",
    name: "Olive Tree Mezze",
    cuisine: "mediterranean",
    pricePerPerson: 27,
    travelMin: 11,
    spicy: false,
    vegetarianFriendly: true,
    seafoodHeavy: false,
    halal: true,
    ...LUNCH_AND_DINNER,
  },
  {
    id: "kebab-house",
    name: "Anatolia Kebab House",
    cuisine: "mediterranean",
    pricePerPerson: 24,
    travelMin: 16,
    spicy: false,
    vegetarianFriendly: true,
    seafoodHeavy: false,
    halal: true,
    ...LUNCH_AND_DINNER,
  },
];

/** The seed places are ordinary sit-down restaurants of one cuisine each, so that is what their types say. */
export const RESTAURANTS: Restaurant[] = SEED.map((r) => {
  const types = [LEGACY_CUISINE_TYPE[r.cuisine], "restaurant"];
  return { ...r, types, style: stylesOf(types, types[0]) };
});

export function getRestaurant(id: string): Restaurant | undefined {
  return RESTAURANTS.find((r) => r.id === id);
}
