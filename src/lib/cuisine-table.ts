import type { Cuisine } from "./constraints";
import { LIMITS, type Style } from "./optimizer-input";

/**
 * Cuisines and kinds of place, in Google Places' own vocabulary (issue #100).
 *
 * A restaurant from Google Places arrives with a list of types such as
 * `["ramen_restaurant", "japanese_restaurant"]`. This file is the table that says how
 * those types relate, so that code, never the model, decides what "Asian", "Chinese" or
 * "hot pot" covers:
 *
 *   group   → region        → cuisine             → dish
 *   Asian   → East Asian    → chinese_restaurant  → hot_pot_restaurant
 *
 * The fourth level is "something narrower under a cuisine". Usually that is a kind of
 * dish (ramen under Japanese); under the generic "Eastern European", "Scandinavian" and
 * "South American" nodes it is a national cuisine (Polish under Eastern European).
 *
 * What is here: the table, the words people use for its entries, the scores a wish turns
 * into (the #82 `cuisine.scores` format), the kind of place a restaurant is (`style`), and
 * which search results are places to eat. The private assistant (assistant.ts) uses it to
 * turn the words a person said into scores; the model never does that itself.
 *
 * FOR WHOEVER WRITES THE OPTIMIZER
 * - A person's `cuisine.scores` holds three values: 1 for what they asked for, NEAR_SCORE
 *   (0.5) for the next best thing, FAR_SCORE (0.25) for a more distant relative. They are
 *   starting values; how much a partial match is worth is yours to retune.
 * - Score a restaurant with `matchCuisine(restaurant.types, person.cuisine)`, not with a
 *   plain key lookup. A dish inherits from its cuisine: a place tagged only
 *   `hot_pot_restaurant` matches a wish for, or a ban on, `chinese_restaurant`. The stored
 *   map relies on this and leaves out a dish whose score equals its cuisine's
 *   (`compactScores`), so a key lookup would miss it.
 * - `matchCuisine` returns the best score over the restaurant's types and whether any of
 *   them is excluded. Exclusion always filters, whatever the strength.
 */

/** Google Places (New) Table A, "Food and Drink", as published in 2026. Used to catch typos in the table. */
export const PLACE_FOOD_TYPES = [
  "acai_shop",
  "afghani_restaurant",
  "african_restaurant",
  "american_restaurant",
  "argentinian_restaurant",
  "asian_fusion_restaurant",
  "asian_restaurant",
  "australian_restaurant",
  "austrian_restaurant",
  "bagel_shop",
  "bakery",
  "bangladeshi_restaurant",
  "bar",
  "bar_and_grill",
  "barbecue_restaurant",
  "basque_restaurant",
  "bavarian_restaurant",
  "beer_garden",
  "belgian_restaurant",
  "bistro",
  "brazilian_restaurant",
  "breakfast_restaurant",
  "brewery",
  "brewpub",
  "british_restaurant",
  "brunch_restaurant",
  "buffet_restaurant",
  "burmese_restaurant",
  "burrito_restaurant",
  "cafe",
  "cafeteria",
  "cajun_restaurant",
  "cake_shop",
  "californian_restaurant",
  "cambodian_restaurant",
  "candy_store",
  "cantonese_restaurant",
  "caribbean_restaurant",
  "cat_cafe",
  "chicken_restaurant",
  "chicken_wings_restaurant",
  "chilean_restaurant",
  "chinese_noodle_restaurant",
  "chinese_restaurant",
  "chocolate_factory",
  "chocolate_shop",
  "cocktail_bar",
  "coffee_roastery",
  "coffee_shop",
  "coffee_stand",
  "colombian_restaurant",
  "confectionery",
  "croatian_restaurant",
  "cuban_restaurant",
  "czech_restaurant",
  "danish_restaurant",
  "deli",
  "dessert_restaurant",
  "dessert_shop",
  "dim_sum_restaurant",
  "diner",
  "dog_cafe",
  "donut_shop",
  "dumpling_restaurant",
  "dutch_restaurant",
  "eastern_european_restaurant",
  "ethiopian_restaurant",
  "european_restaurant",
  "falafel_restaurant",
  "family_restaurant",
  "fast_food_restaurant",
  "filipino_restaurant",
  "fine_dining_restaurant",
  "fish_and_chips_restaurant",
  "fondue_restaurant",
  "food_court",
  "french_restaurant",
  "fusion_restaurant",
  "gastropub",
  "german_restaurant",
  "greek_restaurant",
  "gyro_restaurant",
  "halal_restaurant",
  "hamburger_restaurant",
  "hawaiian_restaurant",
  "hookah_bar",
  "hot_dog_restaurant",
  "hot_dog_stand",
  "hot_pot_restaurant",
  "hungarian_restaurant",
  "ice_cream_shop",
  "indian_restaurant",
  "indonesian_restaurant",
  "irish_pub",
  "irish_restaurant",
  "israeli_restaurant",
  "italian_restaurant",
  "japanese_curry_restaurant",
  "japanese_izakaya_restaurant",
  "japanese_restaurant",
  "juice_shop",
  "kebab_shop",
  "korean_barbecue_restaurant",
  "korean_restaurant",
  "latin_american_restaurant",
  "lebanese_restaurant",
  "lounge_bar",
  "malaysian_restaurant",
  "meal_delivery",
  "meal_takeaway",
  "mediterranean_restaurant",
  "mexican_restaurant",
  "middle_eastern_restaurant",
  "mongolian_barbecue_restaurant",
  "moroccan_restaurant",
  "noodle_shop",
  "north_indian_restaurant",
  "oyster_bar_restaurant",
  "pakistani_restaurant",
  "pastry_shop",
  "persian_restaurant",
  "peruvian_restaurant",
  "pizza_delivery",
  "pizza_restaurant",
  "polish_restaurant",
  "portuguese_restaurant",
  "pub",
  "ramen_restaurant",
  "restaurant",
  "romanian_restaurant",
  "russian_restaurant",
  "salad_shop",
  "sandwich_shop",
  "scandinavian_restaurant",
  "seafood_restaurant",
  "shawarma_restaurant",
  "snack_bar",
  "soul_food_restaurant",
  "soup_restaurant",
  "south_american_restaurant",
  "south_indian_restaurant",
  "southwestern_us_restaurant",
  "spanish_restaurant",
  "sports_bar",
  "sri_lankan_restaurant",
  "steak_house",
  "sushi_restaurant",
  "swiss_restaurant",
  "taco_restaurant",
  "taiwanese_restaurant",
  "tapas_restaurant",
  "tea_house",
  "tex_mex_restaurant",
  "thai_restaurant",
  "tibetan_restaurant",
  "tonkatsu_restaurant",
  "turkish_restaurant",
  "ukrainian_restaurant",
  "vegan_restaurant",
  "vegetarian_restaurant",
  "vietnamese_restaurant",
  "western_restaurant",
  "wine_bar",
  "winery",
  "yakiniku_restaurant",
  "yakitori_restaurant",
] as const;
export type PlaceFoodType = (typeof PLACE_FOOD_TYPES)[number];

// ---------------------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------------------

export type DishDef = { type: PlaceFoodType; label: string };
export type CuisineDef = {
  type: PlaceFoodType;
  label: string;
  /** Google's catch-all for the whole region ("european_restaurant"), not one cuisine. */
  generic?: true;
  dishes: DishDef[];
};
export type RegionDef = {
  id: string;
  label: string;
  /** False for the last bucket: its entries have nothing in common, so they are not each other's "next best". */
  related: boolean;
  cuisines: CuisineDef[];
};
export type GroupDef = { id: string; label: string; types: PlaceFoodType[]; regions: string[] };

const c = (type: PlaceFoodType, label: string, dishes: [PlaceFoodType, string][] = []): CuisineDef => ({
  type,
  label,
  dishes: dishes.map(([t, l]) => ({ type: t, label: l })),
});
const generic = (type: PlaceFoodType, label: string, dishes: [PlaceFoodType, string][] = []): CuisineDef => ({
  ...c(type, label, dishes),
  generic: true,
});

/**
 * Where each type sits. Every type appears once. Choices that could have gone another way:
 * - Greek is with the Middle East and Mediterranean, not Europe (that is how people order it
 *   and how the old "mediterranean" cuisine was built); Moroccan is African.
 * - Pizza is under Italian; burgers, hot dogs, wings, barbecue, steak and diners are under
 *   American, as Google itself co-tags them. Tex-Mex, tacos and burritos are under Mexican.
 * - Afghan and Tibetan food are with South Asia.
 * - Falafel, shawarma and kebab belong to no single country, so they hang off the generic
 *   "Middle Eastern" node.
 * - Food that belongs to no region (seafood, noodles, sandwiches, brunch…) is in the last,
 *   unrelated bucket.
 */
export const REGIONS: RegionDef[] = [
  {
    id: "east_asian",
    label: "East Asian",
    related: true,
    cuisines: [
      c("chinese_restaurant", "Chinese", [
        ["cantonese_restaurant", "Cantonese"],
        ["dim_sum_restaurant", "dim sum"],
        ["hot_pot_restaurant", "hot pot"],
        ["dumpling_restaurant", "dumplings"],
        ["chinese_noodle_restaurant", "Chinese noodles"],
        ["taiwanese_restaurant", "Taiwanese"],
      ]),
      c("japanese_restaurant", "Japanese", [
        ["sushi_restaurant", "sushi"],
        ["ramen_restaurant", "ramen"],
        ["japanese_izakaya_restaurant", "izakaya"],
        ["japanese_curry_restaurant", "Japanese curry"],
        ["tonkatsu_restaurant", "tonkatsu"],
        ["yakiniku_restaurant", "yakiniku"],
        ["yakitori_restaurant", "yakitori"],
      ]),
      c("korean_restaurant", "Korean", [["korean_barbecue_restaurant", "Korean barbecue"]]),
      c("mongolian_barbecue_restaurant", "Mongolian barbecue"),
    ],
  },
  {
    id: "southeast_asian",
    label: "Southeast Asian",
    related: true,
    cuisines: [
      c("thai_restaurant", "Thai"),
      c("vietnamese_restaurant", "Vietnamese"),
      c("indonesian_restaurant", "Indonesian"),
      c("malaysian_restaurant", "Malaysian"),
      c("filipino_restaurant", "Filipino"),
      c("burmese_restaurant", "Burmese"),
      c("cambodian_restaurant", "Cambodian"),
    ],
  },
  {
    id: "south_asian",
    label: "South Asian",
    related: true,
    cuisines: [
      c("indian_restaurant", "Indian", [
        ["north_indian_restaurant", "North Indian"],
        ["south_indian_restaurant", "South Indian"],
      ]),
      c("pakistani_restaurant", "Pakistani"),
      c("bangladeshi_restaurant", "Bangladeshi"),
      c("sri_lankan_restaurant", "Sri Lankan"),
      c("afghani_restaurant", "Afghan"),
      c("tibetan_restaurant", "Tibetan"),
    ],
  },
  {
    id: "middle_eastern_mediterranean",
    label: "Middle Eastern and Mediterranean",
    related: true,
    cuisines: [
      generic("middle_eastern_restaurant", "Middle Eastern", [
        ["falafel_restaurant", "falafel"],
        ["shawarma_restaurant", "shawarma"],
        ["kebab_shop", "kebab"],
      ]),
      generic("mediterranean_restaurant", "Mediterranean"),
      c("lebanese_restaurant", "Lebanese"),
      c("turkish_restaurant", "Turkish"),
      c("persian_restaurant", "Persian"),
      c("israeli_restaurant", "Israeli"),
      c("greek_restaurant", "Greek", [["gyro_restaurant", "gyros"]]),
    ],
  },
  {
    id: "european",
    label: "European",
    related: true,
    cuisines: [
      generic("european_restaurant", "European"),
      c("italian_restaurant", "Italian", [["pizza_restaurant", "pizza"]]),
      c("french_restaurant", "French"),
      c("spanish_restaurant", "Spanish", [
        ["tapas_restaurant", "tapas"],
        ["basque_restaurant", "Basque"],
      ]),
      c("german_restaurant", "German", [["bavarian_restaurant", "Bavarian"]]),
      c("british_restaurant", "British", [["fish_and_chips_restaurant", "fish and chips"]]),
      c("irish_restaurant", "Irish"),
      c("portuguese_restaurant", "Portuguese"),
      c("belgian_restaurant", "Belgian"),
      c("dutch_restaurant", "Dutch"),
      c("swiss_restaurant", "Swiss", [["fondue_restaurant", "fondue"]]),
      c("austrian_restaurant", "Austrian"),
      c("eastern_european_restaurant", "Eastern European", [
        ["polish_restaurant", "Polish"],
        ["russian_restaurant", "Russian"],
        ["ukrainian_restaurant", "Ukrainian"],
        ["czech_restaurant", "Czech"],
        ["hungarian_restaurant", "Hungarian"],
        ["romanian_restaurant", "Romanian"],
        ["croatian_restaurant", "Croatian"],
      ]),
      c("scandinavian_restaurant", "Scandinavian", [["danish_restaurant", "Danish"]]),
    ],
  },
  {
    id: "north_american",
    label: "North American",
    related: true,
    cuisines: [
      c("american_restaurant", "American", [
        ["hamburger_restaurant", "burgers"],
        ["hot_dog_restaurant", "hot dogs"],
        ["hot_dog_stand", "hot dog stand"],
        ["barbecue_restaurant", "barbecue"],
        ["steak_house", "steak"],
        ["diner", "diner"],
        ["chicken_wings_restaurant", "chicken wings"],
        ["cajun_restaurant", "Cajun"],
        ["californian_restaurant", "Californian"],
        ["hawaiian_restaurant", "Hawaiian"],
        ["soul_food_restaurant", "soul food"],
        ["southwestern_us_restaurant", "Southwestern"],
      ]),
    ],
  },
  {
    id: "latin_american",
    label: "Latin American",
    related: true,
    cuisines: [
      generic("latin_american_restaurant", "Latin American"),
      c("mexican_restaurant", "Mexican", [
        ["taco_restaurant", "tacos"],
        ["burrito_restaurant", "burritos"],
        ["tex_mex_restaurant", "Tex-Mex"],
      ]),
      c("south_american_restaurant", "South American", [
        ["brazilian_restaurant", "Brazilian"],
        ["argentinian_restaurant", "Argentinian"],
        ["peruvian_restaurant", "Peruvian"],
        ["colombian_restaurant", "Colombian"],
        ["chilean_restaurant", "Chilean"],
      ]),
      c("cuban_restaurant", "Cuban"),
      c("caribbean_restaurant", "Caribbean"),
    ],
  },
  {
    id: "african",
    label: "African",
    related: true,
    cuisines: [
      generic("african_restaurant", "African"),
      c("ethiopian_restaurant", "Ethiopian"),
      c("moroccan_restaurant", "Moroccan"),
    ],
  },
  {
    id: "no_region",
    label: "",
    related: false,
    cuisines: [
      c("seafood_restaurant", "seafood", [["oyster_bar_restaurant", "oysters"]]),
      c("noodle_shop", "noodles"),
      c("sandwich_shop", "sandwiches"),
      c("chicken_restaurant", "chicken"),
      c("salad_shop", "salad"),
      c("soup_restaurant", "soup"),
      c("brunch_restaurant", "brunch"),
      c("breakfast_restaurant", "breakfast"),
      c("buffet_restaurant", "buffet"),
      c("fusion_restaurant", "fusion"),
      c("australian_restaurant", "Australian"),
    ],
  },
];

/** Words broader than one region. Their own Google types match the whole group. */
export const GROUPS: GroupDef[] = [
  {
    id: "asian",
    label: "Asian",
    types: ["asian_restaurant", "asian_fusion_restaurant"],
    regions: ["east_asian", "southeast_asian", "south_asian"],
  },
  { id: "western", label: "Western", types: ["western_restaurant"], regions: ["european", "north_american"] },
];

/** A wish for one cuisine is worth this much at its neighbours; a wish for one dish, this much at its cuisine. */
export const NEAR_SCORE = 0.5;
/** A wish for one dish is worth this much at the other dishes of the same cuisine. */
export const FAR_SCORE = 0.25;
// Both are starting values. The optimizer owns how much a partial match is worth and may retune them.

// ---------------------------------------------------------------------------------------
// Lookups built from the table
// ---------------------------------------------------------------------------------------

type CuisineEntry = { def: CuisineDef; region: RegionDef };
type DishEntry = { def: DishDef; cuisine: CuisineDef; region: RegionDef };

const CUISINE_BY_TYPE = new Map<string, CuisineEntry>();
const DISH_BY_TYPE = new Map<string, DishEntry>();
const REGION_BY_ID = new Map<string, RegionDef>();
const GROUP_BY_ID = new Map<string, GroupDef>();
for (const region of REGIONS) {
  REGION_BY_ID.set(region.id, region);
  for (const def of region.cuisines) {
    CUISINE_BY_TYPE.set(def.type, { def, region });
    for (const dish of def.dishes) DISH_BY_TYPE.set(dish.type, { def: dish, cuisine: def, region });
  }
}
for (const group of GROUPS) GROUP_BY_ID.set(group.id, group);

/** Every type the cuisine table places, in table order. */
export function tableTypes(): string[] {
  return [
    ...GROUPS.flatMap((g) => g.types),
    ...REGIONS.flatMap((r) => r.cuisines.flatMap((cu) => [cu.type, ...cu.dishes.map((d) => d.type)])),
  ];
}

/** The cuisine a dish belongs to, or undefined for anything that is not a dish. */
export function parentCuisine(type: string): string | undefined {
  return DISH_BY_TYPE.get(type)?.cuisine.type;
}

/** How to say a type to a person: "Korean", "hot pot", "Korean barbecue". Unknown types are tidied up, not hidden. */
export function labelOf(type: string): string {
  const known = CUISINE_BY_TYPE.get(type)?.def.label ?? DISH_BY_TYPE.get(type)?.def.label;
  if (known) return known;
  const group = GROUPS.find((g) => g.types.includes(type as PlaceFoodType));
  if (group) return group.label;
  return type.replace(/_(restaurant|shop|house)$/, "").replace(/_/g, " ");
}

// ---------------------------------------------------------------------------------------
// Words people say
// ---------------------------------------------------------------------------------------

export type CuisineMatch = {
  level: "group" | "region" | "cuisine" | "dish";
  /** A group or region id, or a Google type name for a cuisine or dish. */
  id: string;
  label: string;
};

/** Extra words for groups and regions, beyond their labels. */
const BROAD_WORDS: Record<string, string[]> = {
  asian: ["asia", "亚洲菜", "亚洲", "亚洲料理", "亚洲餐"],
  western: ["西餐", "西式", "西方菜"],
  east_asian: ["east asia", "东亚", "东亚菜"],
  southeast_asian: ["south east asian", "southeast asia", "东南亚", "东南亚菜"],
  south_asian: ["south asia", "南亚", "南亚菜"],
  middle_eastern_mediterranean: [
    "middle eastern",
    "middle east",
    "mideast",
    "mediterranean",
    "中东",
    "中东菜",
    "地中海",
    "地中海菜",
  ],
  european: ["europe", "欧洲菜", "欧洲", "欧式"],
  north_american: ["north america", "北美", "北美菜"],
  latin_american: ["latin", "latino", "latin america", "拉美", "拉美菜", "拉丁美洲菜"],
  african: ["africa", "非洲菜", "非洲"],
};

/** Extra words for cuisines and dishes, beyond their labels and type names. */
const TYPE_WORDS: Partial<Record<PlaceFoodType, string[]>> = {
  chinese_restaurant: [
    "china",
    "sichuan",
    "szechuan",
    "hunan",
    "shanghainese",
    "中餐",
    "中国菜",
    "中式",
    "中菜",
    "川菜",
  ],
  cantonese_restaurant: ["canto", "粤菜", "广东菜"],
  dim_sum_restaurant: ["dimsum", "yum cha", "点心", "早茶", "饮茶"],
  hot_pot_restaurant: ["hotpot", "火锅"],
  dumpling_restaurant: ["dumpling", "饺子", "小笼包"],
  chinese_noodle_restaurant: ["chinese noodle", "面条", "中式面"],
  taiwanese_restaurant: ["taiwan", "台湾菜", "台菜"],
  japanese_restaurant: ["japan", "日料", "日本菜", "日本料理", "日式"],
  sushi_restaurant: ["寿司"],
  ramen_restaurant: ["拉面"],
  japanese_izakaya_restaurant: ["居酒屋"],
  yakiniku_restaurant: ["japanese bbq", "japanese barbecue", "烧肉", "日式烤肉"],
  yakitori_restaurant: ["烧鸟"],
  tonkatsu_restaurant: ["katsu", "炸猪排"],
  korean_restaurant: ["korea", "韩餐", "韩国菜", "韩料", "韩式"],
  korean_barbecue_restaurant: ["korean bbq", "kbbq", "k bbq", "韩国烤肉", "韩式烤肉"],
  thai_restaurant: ["thailand", "泰国菜", "泰餐", "泰式"],
  vietnamese_restaurant: ["viet", "vietnam", "pho", "banh mi", "越南菜", "越南粉"],
  filipino_restaurant: ["philippine", "菲律宾菜"],
  burmese_restaurant: ["myanmar", "缅甸菜"],
  indonesian_restaurant: ["印尼菜"],
  malaysian_restaurant: ["马来西亚菜", "马来菜"],
  indian_restaurant: ["india", "curry", "印度菜", "咖喱"],
  persian_restaurant: ["iranian"],
  greek_restaurant: ["希腊菜"],
  gyro_restaurant: ["gyro"],
  turkish_restaurant: ["土耳其菜"],
  kebab_shop: ["kebabs", "kabob"],
  italian_restaurant: ["italy", "pasta", "意大利菜", "意餐", "意面"],
  pizza_restaurant: ["披萨", "比萨"],
  french_restaurant: ["france", "法餐", "法国菜"],
  spanish_restaurant: ["spain", "西班牙菜"],
  german_restaurant: ["germany", "德国菜"],
  british_restaurant: ["english", "uk", "英国菜"],
  american_restaurant: ["usa", "美式", "美国菜"],
  hamburger_restaurant: ["burger", "hamburger", "汉堡"],
  hot_dog_restaurant: ["hot dog", "热狗"],
  barbecue_restaurant: ["bbq", "烧烤", "烤肉"],
  steak_house: ["steakhouse", "steak house", "牛排"],
  chicken_wings_restaurant: ["wings", "鸡翅"],
  mexican_restaurant: ["mexico", "墨西哥菜"],
  taco_restaurant: ["taco", "taqueria"],
  burrito_restaurant: ["burrito"],
  tex_mex_restaurant: ["tex mex", "texmex"],
  brazilian_restaurant: ["巴西菜", "巴西烤肉"],
  ethiopian_restaurant: ["埃塞俄比亚菜"],
  seafood_restaurant: ["sea food", "海鲜"],
  oyster_bar_restaurant: ["oyster", "oyster bar", "生蚝"],
  noodle_shop: ["noodle", "面"],
  sandwich_shop: ["sandwich", "三明治"],
  chicken_restaurant: ["fried chicken", "炸鸡"],
  salad_shop: ["salads", "沙拉"],
  brunch_restaurant: ["早午餐"],
  breakfast_restaurant: ["早餐"],
  buffet_restaurant: ["自助餐", "自助"],
};

const WORD_INDEX = new Map<string, CuisineMatch>();

/** Lower case, accents dropped, anything but letters, digits and Chinese characters turned into a space. */
function tidy(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9一-鿿]+/g, " ")
    .trim();
}
const squash = (text: string) => tidy(text).replace(/ /g, "");

const LEADING = /^(?:some|a|an|the|any|good|nice|really good)\s+/;
const TRAILING =
  /\s+(?:food|foods|cuisine|cuisines|restaurant|restaurants|place|places|joint|joints|spot|spots|dish|dishes)$/;
const TRAILING_ZH = /(?:餐厅|餐馆|馆子|料理店|店)$/;

/** The forms of a phrase worth looking up, most literal first. Spaces never matter: "hot pot" is "hotpot". */
function lookupKeys(text: string): string[] {
  let phrase = tidy(text);
  while (LEADING.test(phrase)) phrase = phrase.replace(LEADING, "");
  const phrases = [phrase];
  while (TRAILING.test(phrase)) phrases.push((phrase = phrase.replace(TRAILING, "")));
  if (TRAILING_ZH.test(phrase)) phrases.push(phrase.replace(TRAILING_ZH, ""));
  const keys: string[] = [];
  for (const p of phrases) {
    const key = p.replace(/ /g, "");
    keys.push(key);
    if (key.endsWith("es")) keys.push(key.slice(0, -2));
    if (key.endsWith("s")) keys.push(key.slice(0, -1));
  }
  return keys.filter(Boolean);
}

function register(word: string, match: CuisineMatch, chosen: boolean) {
  const key = squash(word);
  if (!key) return;
  const existing = WORD_INDEX.get(key);
  if (!existing) {
    WORD_INDEX.set(key, match);
    return;
  }
  // A word somebody chose for two different entries is a mistake in this file; a clash with a
  // word derived from a label is not, and the first entry keeps it.
  if (chosen && existing.id !== match.id)
    throw new Error(`"${word}" is listed for both ${existing.id} and ${match.id}`);
}

const stem = (type: string) => type.replace(/_(restaurant|shop|house|stand)$/, "");

// Chosen words first, so "Mediterranean" means the region and not Google's catch-all type of the same name.
for (const group of GROUPS) {
  const match: CuisineMatch = { level: "group", id: group.id, label: group.label };
  for (const w of [group.label, ...(BROAD_WORDS[group.id] ?? [])]) register(w, match, true);
}
for (const region of REGIONS) {
  if (!region.label) continue;
  const match: CuisineMatch = { level: "region", id: region.id, label: region.label };
  for (const w of [region.label, ...(BROAD_WORDS[region.id] ?? [])]) register(w, match, true);
}
const NODES: { type: PlaceFoodType; label: string; level: "cuisine" | "dish" }[] = REGIONS.flatMap((r) =>
  r.cuisines.flatMap((cu) => [
    { type: cu.type, label: cu.label, level: "cuisine" as const },
    ...cu.dishes.map((d) => ({ type: d.type, label: d.label, level: "dish" as const })),
  ]),
);
for (const node of NODES) {
  const match: CuisineMatch = { level: node.level, id: node.type, label: node.label };
  for (const w of TYPE_WORDS[node.type] ?? []) register(w, match, true);
}
for (const node of NODES) {
  const match: CuisineMatch = { level: node.level, id: node.type, label: node.label };
  register(node.label, match, false);
  register(stem(node.type), match, false);
}

/** Every word this file knows, for tests and for telling a person what can be looked for. */
export function knownCuisineWords(): string[] {
  return [...WORD_INDEX.keys()];
}

/**
 * What a word or short phrase means in the table, or null when it is not there. Case, plurals,
 * hyphens, spaces and a trailing "food" / "cuisine" / "restaurant" / "place" do not matter.
 * Dietary words (vegetarian, vegan, halal) are deliberately not cuisines here: they are
 * `dietary` in the #82 format.
 */
export function findCuisine(text: string): CuisineMatch | null {
  for (const key of lookupKeys(text)) {
    const hit = WORD_INDEX.get(key);
    if (hit) return hit;
  }
  return null;
}

// ---------------------------------------------------------------------------------------
// Scores and exclusions (the #82 `cuisine` block)
// ---------------------------------------------------------------------------------------

const cuisineTypes = (def: CuisineDef) => [def.type, ...def.dishes.map((d) => d.type)];
const regionTypes = (region: RegionDef) => region.cuisines.flatMap(cuisineTypes);

/** Dishes are implied by their cuisine (see `matchCuisine`), so they are the first thing to go when a list is too long. */
function fit(types: string[]): string[] {
  if (types.length <= LIMITS.cuisines) return types;
  return types.filter((t) => !DISH_BY_TYPE.has(t));
}

function regionsOf(match: CuisineMatch): RegionDef[] {
  if (match.level === "group") return (GROUP_BY_ID.get(match.id)?.regions ?? []).map((id) => REGION_BY_ID.get(id)!);
  if (match.level === "region") return [REGION_BY_ID.get(match.id)!];
  return [];
}

/**
 * The scores one wish turns into, keyed by Google type, each above 0 and at most 1.
 * - A group or region: everything in it scores 1.
 * - A cuisine: it and its dishes score 1 (a hot pot place is Chinese food); the other cuisines of
 *   the region, and their dishes, score NEAR_SCORE.
 * - A dish: it scores 1, its cuisine NEAR_SCORE, the cuisine's other dishes FAR_SCORE.
 * A group is longer than the format allows with dishes spelled out, so there only cuisines are
 * listed and `matchCuisine` supplies the dishes.
 */
export function scoresFor(match: CuisineMatch): Record<string, number> {
  const scores: Record<string, number> = {};
  const set = (types: string[], score: number) => {
    for (const t of types) scores[t] = Math.max(scores[t] ?? 0, score);
  };
  if (match.level === "group" || match.level === "region") {
    const own = match.level === "group" ? (GROUP_BY_ID.get(match.id)?.types ?? []) : [];
    set(fit([...own, ...regionsOf(match).flatMap(regionTypes)]), 1);
  } else if (match.level === "cuisine") {
    const entry = CUISINE_BY_TYPE.get(match.id);
    if (!entry) return scores;
    if (entry.region.related) set(regionTypes(entry.region), NEAR_SCORE);
    set(cuisineTypes(entry.def), 1);
  } else {
    const entry = DISH_BY_TYPE.get(match.id);
    if (!entry) return scores;
    set(
      entry.cuisine.dishes.map((d) => d.type),
      FAR_SCORE,
    );
    set([entry.cuisine.type], NEAR_SCORE);
    set([entry.def.type], 1);
  }
  return scores;
}

/** Several wishes together: each type keeps its best score. */
export function mergeScores(...maps: Record<string, number>[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const map of maps) for (const [type, score] of Object.entries(map)) out[type] = Math.max(out[type] ?? 0, score);
  return out;
}

/**
 * The types "no X" rules out. A dish rules out itself; a cuisine, itself and its dishes; a region
 * or group, everything in it. Nothing wider: "no seafood" is seafood and oyster bars, not sushi,
 * because plenty of people who say it still eat at Japanese places.
 */
export function excludedFor(match: CuisineMatch): string[] {
  if (match.level === "dish") return [match.id];
  if (match.level === "cuisine") {
    const entry = CUISINE_BY_TYPE.get(match.id);
    return entry ? cuisineTypes(entry.def) : [];
  }
  const own = match.level === "group" ? (GROUP_BY_ID.get(match.id)?.types ?? []) : [];
  return fit([...own, ...regionsOf(match).flatMap(regionTypes)]);
}

/**
 * How a restaurant stands against one person's cuisine block. A restaurant matches a type if any
 * of its own types is that type, or is a dish of it: a place tagged only `hot_pot_restaurant`
 * matches a wish for, or a ban on, `chinese_restaurant`. The score is the best match found.
 */
export function matchCuisine(
  types: readonly string[],
  cuisine: { scores?: Record<string, number>; excluded?: readonly string[] },
): { excluded: boolean; score: number } {
  const scores = cuisine.scores ?? {};
  const banned = new Set(cuisine.excluded ?? []);
  let excluded = false;
  let score = 0;
  for (const type of types) {
    const parent = parentCuisine(type);
    if (banned.has(type) || (parent !== undefined && banned.has(parent))) excluded = true;
    score = Math.max(score, scores[type] ?? (parent !== undefined ? (scores[parent] ?? 0) : 0));
  }
  return { excluded, score };
}

/** What a word was taken to mean, to say back: "Japanese, Chinese, Korean, …". */
export function describeMatch(match: CuisineMatch): string {
  if (match.level === "group" || match.level === "region") {
    return regionsOf(match)
      .flatMap((r) => r.cuisines.filter((cu) => !cu.generic).map((cu) => cu.label))
      .join(", ");
  }
  if (match.level === "cuisine") {
    const dishes = CUISINE_BY_TYPE.get(match.id)?.def.dishes ?? [];
    return dishes.length ? `${match.label} (including ${dishes.map((d) => d.label).join(", ")})` : match.label;
  }
  return match.label;
}

/**
 * A scores map with nothing redundant in it, short enough for the #82 format. A dish whose
 * score equals its cuisine's is left out, because `matchCuisine` gives a dish its cuisine's
 * score anyway. If the map is still too long, the highest scores are kept, in table order
 * within one score.
 */
export function compactScores(scores: Record<string, number>, limit: number = LIMITS.cuisines): Record<string, number> {
  const entries = Object.entries(scores).filter(([type, score]) => {
    const parent = parentCuisine(type);
    return parent === undefined || scores[parent] !== score;
  });
  if (entries.length <= limit) return Object.fromEntries(entries);
  const order = new Map(tableTypes().map((t, i) => [t, i]));
  const kept = entries
    .map(([type, score], i) => ({ type, score, at: order.get(type) ?? order.size + i }))
    .sort((a, b) => b.score - a.score || a.at - b.at)
    .slice(0, limit)
    .sort((a, b) => a.at - b.at);
  return Object.fromEntries(kept.map((k) => [k.type, k.score]));
}

/**
 * A favourite named after a broad wish: "Asian", then "Korean most of all". The rest of the
 * broad wish stays wanted but drops to NEAR_SCORE, so the favourite stands out once its own
 * scores are merged in. Only a whole region (or a whole group) at score 1 counts as a broad
 * wish; scores that are not part of one are returned unchanged.
 */
export function lowerBroadWish(
  scores: Record<string, number>,
  favourites: readonly CuisineMatch[],
): Record<string, number> {
  const whole = (region: RegionDef) => region.related && region.cuisines.every((cu) => scores[cu.type] === 1);
  const lowered = new Set<string>();
  for (const favourite of favourites) {
    const region =
      favourite.level === "cuisine"
        ? CUISINE_BY_TYPE.get(favourite.id)?.region
        : favourite.level === "dish"
          ? DISH_BY_TYPE.get(favourite.id)?.region
          : undefined;
    if (!region || !whole(region)) continue;
    const group = GROUPS.find(
      (g) => g.regions.includes(region.id) && g.regions.every((id) => whole(REGION_BY_ID.get(id)!)),
    );
    const regions = group ? group.regions.map((id) => REGION_BY_ID.get(id)!) : [region];
    for (const t of group?.types ?? []) lowered.add(t);
    for (const r of regions) for (const t of regionTypes(r)) lowered.add(t);
  }
  if (lowered.size === 0) return scores;
  return Object.fromEntries(
    Object.entries(scores).map(([type, score]) => [type, lowered.has(type) && score === 1 ? NEAR_SCORE : score]),
  );
}

/** An excluded list with nothing redundant in it: a dish is left out when its cuisine is excluded too. */
export function compactExcluded(types: readonly string[], limit: number = LIMITS.cuisines): string[] {
  const all = new Set(types);
  const kept = [...all].filter((t) => {
    const parent = parentCuisine(t);
    return parent === undefined || !all.has(parent);
  });
  return kept.slice(-limit);
}

/**
 * How to say a set of types to a person, without spelling out what a broader word already
 * says: every Asian cuisine is "Asian", a whole region is its name, a cuisine stands for its
 * dishes. A type the table does not place is tidied up, never shown raw.
 */
export function describeTypes(types: readonly string[]): string[] {
  const set = new Set(types);
  const whole = (region: RegionDef) => region.related && region.cuisines.every((cu) => set.has(cu.type));
  const labels: string[] = [];
  const said = new Set<string>();
  const covered = new Set<string>();
  for (const group of GROUPS) {
    const regions = group.regions.map((id) => REGION_BY_ID.get(id)!);
    const ownOnly = group.types.some((t) => set.has(t));
    if (!regions.every(whole) && !ownOnly) continue;
    labels.push(group.label);
    group.types.forEach((t) => said.add(t));
    if (regions.every(whole)) regions.forEach((r) => covered.add(r.id));
  }
  for (const region of REGIONS) {
    if (covered.has(region.id)) continue;
    if (whole(region)) {
      labels.push(region.label);
      covered.add(region.id);
      continue;
    }
    for (const cu of region.cuisines) {
      if (set.has(cu.type)) labels.push(cu.label);
      else for (const dish of cu.dishes) if (set.has(dish.type)) labels.push(dish.label);
    }
  }
  for (const t of types) {
    if (CUISINE_BY_TYPE.has(t) || DISH_BY_TYPE.has(t) || said.has(t)) continue;
    labels.push(labelOf(t));
  }
  return [...new Set(labels)];
}

// ---------------------------------------------------------------------------------------
// Kind of place
// ---------------------------------------------------------------------------------------

const STYLE_OF: Partial<Record<PlaceFoodType, Style>> = {
  fine_dining_restaurant: "fine_dining",
  fast_food_restaurant: "fast_food",
  hot_dog_stand: "fast_food",
  food_court: "fast_food",
  cafeteria: "fast_food",
  snack_bar: "fast_food",
  cafe: "cafe",
  coffee_shop: "cafe",
  coffee_stand: "cafe",
  tea_house: "cafe",
  bakery: "cafe",
  pastry_shop: "cafe",
  cake_shop: "cafe",
  dessert_restaurant: "cafe",
  dessert_shop: "cafe",
  ice_cream_shop: "cafe",
  donut_shop: "cafe",
  bagel_shop: "cafe",
  juice_shop: "cafe",
  acai_shop: "cafe",
  cat_cafe: "cafe",
  dog_cafe: "cafe",
  chocolate_shop: "cafe",
  bar: "bar",
  pub: "bar",
  wine_bar: "bar",
  cocktail_bar: "bar",
  brewery: "bar",
  brewpub: "bar",
  beer_garden: "bar",
  gastropub: "bar",
  irish_pub: "bar",
  lounge_bar: "bar",
  sports_bar: "bar",
  hookah_bar: "bar",
  bar_and_grill: "bar",
};

const STYLE_ORDER: Style[] = ["fine_dining", "fast_food", "casual", "cafe", "bar"];

/** A sit-down-for-a-meal type: "restaurant", anything ending in `_restaurant`, or a cuisine or dish in the table. */
function isRestaurantType(type: string): boolean {
  return type === "restaurant" || type.endsWith("_restaurant") || CUISINE_BY_TYPE.has(type) || DISH_BY_TYPE.has(type);
}

/**
 * The kind of place a restaurant is, from its Google types. A place can be more than one.
 * An ordinary restaurant that is none of the special kinds is `casual`.
 *
 * Many restaurants carry `bar` or `cafe` as a side tag (a Spanish restaurant with a wine list).
 * When Google's `primaryType` says the place is a restaurant, those side tags are ignored, so
 * that somebody who rules out bars does not lose every restaurant that serves drinks.
 */
export function stylesOf(types: readonly string[], primaryType?: string): Style[] {
  const found = new Set<Style>();
  for (const t of types) {
    const style = STYLE_OF[t as PlaceFoodType];
    if (style) found.add(style);
  }
  if (primaryType && isRestaurantType(primaryType)) {
    const own = STYLE_OF[primaryType as PlaceFoodType];
    if (own !== "bar") found.delete("bar");
    if (own !== "cafe") found.delete("cafe");
  }
  if (found.size === 0) found.add("casual");
  return STYLE_ORDER.filter((s) => found.has(s));
}

const STYLE_WORDS: Record<Style, string[]> = {
  fast_food: ["fast food", "quick bite", "something quick", "快餐"],
  casual: ["casual", "laid back", "nothing fancy", "休闲", "随便吃"],
  fine_dining: [
    "fine dining",
    "fancy",
    "upscale",
    "high end",
    "somewhere nice",
    "高级餐厅",
    "高档餐厅",
    "高档",
    "高级",
  ],
  cafe: [
    "cafe",
    "coffee",
    "coffee shop",
    "tea",
    "afternoon tea",
    "dessert",
    "bakery",
    "下午茶",
    "咖啡",
    "咖啡馆",
    "咖啡店",
    "甜品",
    "甜点",
  ],
  bar: ["bar", "pub", "drinks", "酒吧"],
};
const STYLE_INDEX = new Map<string, Style>();
for (const [style, words] of Object.entries(STYLE_WORDS) as [Style, string[]][]) {
  for (const w of words) STYLE_INDEX.set(squash(w), style);
}

/** The kind of place a word names ("fancy" is fine dining, "下午茶" is a cafe), or null. */
export function findStyle(text: string): Style | null {
  for (const key of lookupKeys(text)) {
    const hit = STYLE_INDEX.get(key);
    if (hit) return hit;
  }
  return null;
}

// ---------------------------------------------------------------------------------------
// Is this search result somewhere to eat?
// ---------------------------------------------------------------------------------------

/** Food-and-drink types that are not somewhere a group sits down to eat. */
const NOT_A_MEAL = new Set<string>([
  "candy_store",
  "chocolate_factory",
  "confectionery",
  "coffee_roastery",
  "winery",
  "meal_delivery",
  "pizza_delivery",
]);
/** Shops that sell food and sometimes carry a `cafe` or `deli` tag. */
const SHOPS = new Set<string>([
  "grocery_store",
  "asian_grocery_store",
  "supermarket",
  "convenience_store",
  "liquor_store",
  "gas_station",
  "warehouse_store",
  "department_store",
]);
const FOOD_TYPES = new Set<string>(PLACE_FOOD_TYPES);
const isMealType = (type: string) => (FOOD_TYPES.has(type) || type.endsWith("_restaurant")) && !NOT_A_MEAL.has(type);

/**
 * Whether a Places result is a candidate for a meal. Google's `primaryType` decides when it is
 * there: a supermarket with a cafe inside is a supermarket. Without it, the place needs a
 * food-and-drink type and must not be a shop.
 */
export function isMealCandidate(place: { primaryType?: string; types?: readonly string[] }): boolean {
  if (place.primaryType) return isMealType(place.primaryType);
  const types = place.types ?? [];
  return types.some(isMealType) && !types.some((t) => SHOPS.has(t));
}

// ---------------------------------------------------------------------------------------
// The ten cuisines the app knew before, for the transition
// ---------------------------------------------------------------------------------------

/** The table entry each old cuisine becomes. */
export const LEGACY_CUISINE_TYPE: Record<Cuisine, PlaceFoodType> = {
  japanese: "japanese_restaurant",
  chinese: "chinese_restaurant",
  korean: "korean_restaurant",
  thai: "thai_restaurant",
  vietnamese: "vietnamese_restaurant",
  indian: "indian_restaurant",
  mexican: "mexican_restaurant",
  italian: "italian_restaurant",
  american: "american_restaurant",
  mediterranean: "mediterranean_restaurant",
};

/** The old "mediterranean" was wider than one type: it took in these cuisines too. */
const LEGACY_MEDITERRANEAN = new Set<string>([
  "mediterranean_restaurant",
  "middle_eastern_restaurant",
  "greek_restaurant",
  "turkish_restaurant",
  "lebanese_restaurant",
]);
const LEGACY_BY_TYPE = new Map<string, Cuisine>(
  (Object.entries(LEGACY_CUISINE_TYPE) as [Cuisine, string][]).map(([legacy, type]) => [type, legacy]),
);

/** The old cuisine a Google type falls under, or null if the old list had nothing for it. */
export function legacyCuisineOf(type: string): Cuisine | null {
  const cuisine = parentCuisine(type) ?? type;
  if (LEGACY_MEDITERRANEAN.has(cuisine)) return "mediterranean";
  return LEGACY_BY_TYPE.get(cuisine) ?? null;
}
