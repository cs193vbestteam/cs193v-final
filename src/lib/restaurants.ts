import type { Cuisine, Slot } from "./constraints";
import type { LatLng } from "./geo";

/**
 * Hard-coded, fictional restaurant data: the seed pool, used when a plan has no
 * location or Google Places is off (see places.ts and pool.ts).
 */
export type Restaurant = {
  id: string;
  name: string;
  cuisine: Cuisine;
  /** Typical spend per person, in dollars. */
  pricePerPerson: number;
  /** One-way travel time from the plan's location (campus, for the seed), in minutes. */
  travelMin: number;
  /** Where the place is. Public. Present for Places results, absent for the seed. */
  location?: LatLng;
  /** Most of the menu is spicy. */
  spicy: boolean;
  vegetarianFriendly: boolean;
  /** Menu is mostly seafood. */
  seafoodHeavy: boolean;
  halal: boolean;
  /** Slots the restaurant is open for. */
  open: Slot[];
  /** Google's public rating, 1 to 5, and how many reviews it rests on. Places results only. */
  rating?: number;
  ratingCount?: number;
  /** Street address and a Google Maps link, shown to the group for the chosen place. Places results only. */
  address?: string;
  mapsUrl?: string;
};

const ALL: Slot[] = ["fri_dinner", "sat_lunch", "sat_dinner", "sun_lunch", "sun_dinner"];
const DINNER_ONLY: Slot[] = ["fri_dinner", "sat_dinner", "sun_dinner"];

export const RESTAURANTS: Restaurant[] = [
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
    open: ALL,
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
    open: ALL,
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
    open: DINNER_ONLY,
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
    open: ["sat_lunch", "sun_lunch"],
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
    open: ALL,
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
    open: ALL,
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
    open: ALL,
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
    open: ALL,
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
    open: ALL,
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
    open: ALL,
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
    open: DINNER_ONLY,
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
    open: ALL,
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
    open: ALL,
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
    open: DINNER_ONLY,
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
    open: ALL,
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
    open: ALL,
  },
];

export function getRestaurant(id: string): Restaurant | undefined {
  return RESTAURANTS.find((r) => r.id === id);
}
