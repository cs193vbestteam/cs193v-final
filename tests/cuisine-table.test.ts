import { describe, expect, it } from "vitest";
import { CUISINES } from "@/lib/constraints";
import {
  FAR_SCORE,
  GROUPS,
  LEGACY_CUISINE_TYPE,
  NEAR_SCORE,
  PLACE_FOOD_TYPES,
  REGIONS,
  describeMatch,
  excludedFor,
  findCuisine,
  findStyle,
  isMealCandidate,
  knownCuisineWords,
  labelOf,
  legacyCuisineOf,
  matchCuisine,
  mergeScores,
  parentCuisine,
  scoresFor,
  stylesOf,
  tableTypes,
  LEANINGS,
  leaningOf,
} from "@/lib/cuisine-table";
import { LIMITS, PersonPreferencesSchema } from "@/lib/optimizer-input";

const find = (word: string) => {
  const m = findCuisine(word);
  if (!m) throw new Error(`"${word}" did not resolve`);
  return m;
};
const wish = (word: string) => scoresFor(find(word));

describe("the table", () => {
  it("only uses Google Places type names", () => {
    expect(PLACE_FOOD_TYPES).toHaveLength(166);
    expect(new Set(PLACE_FOOD_TYPES).size).toBe(166);
    const valid = new Set<string>(PLACE_FOOD_TYPES);
    for (const type of tableTypes()) expect(valid.has(type), type).toBe(true);
  });

  it("places every type once", () => {
    const types = tableTypes();
    const twice = types.filter((t, i) => types.indexOf(t) !== i);
    expect(twice).toEqual([]);
  });

  it("gives every cuisine one region and every dish one cuisine", () => {
    const regionsOfCuisine = new Map<string, string[]>();
    const cuisinesOfDish = new Map<string, string[]>();
    for (const region of REGIONS) {
      for (const cuisine of region.cuisines) {
        regionsOfCuisine.set(cuisine.type, [...(regionsOfCuisine.get(cuisine.type) ?? []), region.id]);
        for (const dish of cuisine.dishes) {
          cuisinesOfDish.set(dish.type, [...(cuisinesOfDish.get(dish.type) ?? []), cuisine.type]);
        }
      }
    }
    for (const [type, regions] of regionsOfCuisine) expect(regions, type).toHaveLength(1);
    for (const [type, cuisines] of cuisinesOfDish) {
      expect(cuisines, type).toHaveLength(1);
      expect(parentCuisine(type)).toBe(cuisines[0]);
    }
    // A type is a cuisine or a dish, never both.
    for (const type of cuisinesOfDish.keys()) expect(regionsOfCuisine.has(type), type).toBe(false);
  });

  it("covers every national or regional cuisine Google lists", () => {
    const placed = new Set(tableTypes());
    // Food-and-drink types that are a kind of place or a service, not a cuisine: handled by style or the candidate filter.
    const notCuisines = new Set([
      "acai_shop",
      "bagel_shop",
      "bakery",
      "bar",
      "bar_and_grill",
      "beer_garden",
      "bistro",
      "brewery",
      "brewpub",
      "cafe",
      "cafeteria",
      "cake_shop",
      "candy_store",
      "cat_cafe",
      "chocolate_factory",
      "chocolate_shop",
      "cocktail_bar",
      "coffee_roastery",
      "coffee_shop",
      "coffee_stand",
      "confectionery",
      "deli",
      "dessert_restaurant",
      "dessert_shop",
      "dog_cafe",
      "donut_shop",
      "family_restaurant",
      "fast_food_restaurant",
      "fine_dining_restaurant",
      "food_court",
      "gastropub",
      "halal_restaurant",
      "hookah_bar",
      "ice_cream_shop",
      "irish_pub",
      "juice_shop",
      "lounge_bar",
      "meal_delivery",
      "meal_takeaway",
      "pastry_shop",
      "pizza_delivery",
      "pub",
      "restaurant",
      "snack_bar",
      "sports_bar",
      "tea_house",
      "vegan_restaurant",
      "vegetarian_restaurant",
      "wine_bar",
      "winery",
    ]);
    const unplaced = PLACE_FOOD_TYPES.filter((t) => !placed.has(t) && !notCuisines.has(t));
    expect(unplaced).toEqual([]);
    // And nothing is in both lists.
    expect([...notCuisines].filter((t) => placed.has(t))).toEqual([]);
  });

  it("has the regions people name, and two broader groups over them", () => {
    expect(REGIONS.filter((r) => r.label).map((r) => r.label)).toEqual([
      "East Asian",
      "Southeast Asian",
      "South Asian",
      "Middle Eastern and Mediterranean",
      "European",
      "North American",
      "Latin American",
      "African",
    ]);
    const regionIds = new Set(REGIONS.map((r) => r.id));
    for (const group of GROUPS) for (const id of group.regions) expect(regionIds.has(id), id).toBe(true);
  });

  it("has a label for every type, and a readable one for a type it does not know", () => {
    for (const type of tableTypes()) expect(labelOf(type).length, type).toBeGreaterThan(0);
    expect(labelOf("korean_restaurant")).toBe("Korean");
    expect(labelOf("hot_pot_restaurant")).toBe("hot pot");
    expect(labelOf("korean_barbecue_restaurant")).toBe("Korean barbecue");
    expect(labelOf("some_new_restaurant")).toBe("some new");
  });
});

describe("words people say", () => {
  it("every word in the index resolves to an entry in the table", () => {
    const words = knownCuisineWords();
    expect(words.length).toBeGreaterThan(250);
    const types = new Set(tableTypes());
    const broad = new Set([...GROUPS.map((g) => g.id), ...REGIONS.map((r) => r.id), ...LEANINGS.map((l) => l.id)]);
    for (const word of words) {
      const m = find(word);
      expect(types.has(m.id) || broad.has(m.id), word).toBe(true);
    }
  });

  it.each([
    ["Asian", "group", "asian"],
    ["east asian", "region", "east_asian"],
    ["Western", "group", "western"],
    ["European", "region", "european"],
    ["Latin", "region", "latin_american"],
    ["Middle Eastern", "region", "middle_eastern_mediterranean"],
    ["Mediterranean", "region", "middle_eastern_mediterranean"],
    ["Chinese", "cuisine", "chinese_restaurant"],
    ["chinese food", "cuisine", "chinese_restaurant"],
    ["hot pot", "dish", "hot_pot_restaurant"],
    ["hotpot", "dish", "hot_pot_restaurant"],
    ["sushi", "dish", "sushi_restaurant"],
    ["BBQ", "dish", "barbecue_restaurant"],
    ["burgers", "dish", "hamburger_restaurant"],
    ["pizza", "dish", "pizza_restaurant"],
    ["ramen", "dish", "ramen_restaurant"],
    ["Korean BBQ", "dish", "korean_barbecue_restaurant"],
    ["dim sum", "dish", "dim_sum_restaurant"],
    ["tacos", "dish", "taco_restaurant"],
    ["pho", "cuisine", "vietnamese_restaurant"],
    ["curry", "cuisine", "indian_restaurant"],
    ["Eastern European", "cuisine", "eastern_european_restaurant"],
    ["Polish", "dish", "polish_restaurant"],
    ["seafood", "cuisine", "seafood_restaurant"],
  ])("%s is the %s %s", (word, level, id) => {
    expect(find(word)).toMatchObject({ level, id });
  });

  it("does not care about case, plurals, hyphens, spaces or a trailing word", () => {
    const hotPot = find("hot pot").id;
    for (const w of ["HOT POT", "hot-pot", "Hot Pot restaurant", "a hot pot place", "hotpot restaurants"]) {
      expect(find(w).id, w).toBe(hotPot);
    }
    expect(find("Korean restaurants").id).toBe("korean_restaurant");
    expect(find("some Thai food").id).toBe("thai_restaurant");
    expect(find("Japanese cuisine").id).toBe("japanese_restaurant");
    expect(find("sandwiches").id).toBe("sandwich_shop");
    expect(find("Tex-Mex").id).toBe("tex_mex_restaurant");
    expect(find("steakhouse").id).toBe("steak_house");
  });

  it.each([
    ["中餐", "chinese_restaurant"],
    ["日料", "japanese_restaurant"],
    ["韩餐", "korean_restaurant"],
    ["火锅", "hot_pot_restaurant"],
    ["寿司", "sushi_restaurant"],
    ["拉面", "ramen_restaurant"],
    ["烧烤", "barbecue_restaurant"],
    ["西餐", "western"],
    ["亚洲菜", "asian"],
    ["泰国菜", "thai_restaurant"],
    ["越南菜", "vietnamese_restaurant"],
    ["印度菜", "indian_restaurant"],
    ["墨西哥菜", "mexican_restaurant"],
    ["意大利菜", "italian_restaurant"],
    ["法餐", "french_restaurant"],
    ["火锅店", "hot_pot_restaurant"],
    ["日料餐厅", "japanese_restaurant"],
  ])("understands %s", (word, id) => {
    expect(find(word).id).toBe(id);
  });

  it("returns null for what is not in the table, and for diets", () => {
    for (const w of ["something tasty", "Martian", "nepalese", "", "vegetarian", "vegan", "halal"]) {
      expect(findCuisine(w), w).toBeNull();
    }
  });

  it("says back what a broad word was taken to mean", () => {
    expect(describeMatch(find("East Asian"))).toBe("Chinese, Japanese, Korean, Mongolian barbecue");
    const asian = describeMatch(find("Asian"));
    for (const name of ["Japanese", "Chinese", "Korean", "Thai", "Vietnamese", "Indian"]) expect(asian).toContain(name);
    // Google's catch-all types are not cuisines to read out.
    expect(describeMatch(find("European"))).not.toMatch(/(^|, )European(,|$)/);
    expect(describeMatch(find("Korean"))).toBe("Korean (including Korean barbecue)");
    expect(describeMatch(find("ramen"))).toBe("ramen");
  });
});

describe("scores for a wish", () => {
  it("a region scores everything in it 1", () => {
    const s = wish("East Asian");
    for (const t of ["chinese_restaurant", "japanese_restaurant", "korean_restaurant", "hot_pot_restaurant"]) {
      expect(s[t], t).toBe(1);
    }
    expect(s.thai_restaurant).toBeUndefined();
    expect(wish("European").european_restaurant).toBe(1);
  });

  it("a group scores its regions' cuisines and its own Google types 1", () => {
    const s = wish("Asian");
    for (const t of [
      "asian_restaurant",
      "asian_fusion_restaurant",
      "chinese_restaurant",
      "thai_restaurant",
      "indian_restaurant",
    ]) {
      expect(s[t], t).toBe(1);
    }
    expect(s.italian_restaurant).toBeUndefined();
    expect(wish("Western").western_restaurant).toBe(1);
    expect(wish("Western").american_restaurant).toBe(1);
  });

  it("a cuisine scores itself and its dishes 1, its neighbours less", () => {
    const s = wish("Korean");
    expect(s.korean_restaurant).toBe(1);
    expect(s.korean_barbecue_restaurant).toBe(1);
    expect(s.chinese_restaurant).toBe(NEAR_SCORE);
    expect(s.japanese_restaurant).toBe(NEAR_SCORE);
    expect(s.ramen_restaurant).toBe(NEAR_SCORE);
    expect(s.thai_restaurant).toBeUndefined();
  });

  it("a dish scores itself 1, its cuisine less, the cuisine's other dishes less again", () => {
    const s = wish("hot pot");
    expect(s.hot_pot_restaurant).toBe(1);
    expect(s.chinese_restaurant).toBe(NEAR_SCORE);
    expect(s.dim_sum_restaurant).toBe(FAR_SCORE);
    expect(s.japanese_restaurant).toBeUndefined();
    expect(FAR_SCORE).toBeLessThan(NEAR_SCORE);
    expect(NEAR_SCORE).toBeLessThan(1);
  });

  it("food with no region has no neighbours", () => {
    expect(wish("seafood")).toEqual({ seafood_restaurant: 1, oyster_bar_restaurant: 1 });
  });

  it("several wishes keep the best score for each type", () => {
    const merged = mergeScores(wish("Korean"), wish("hot pot"));
    expect(merged.korean_restaurant).toBe(1);
    expect(merged.hot_pot_restaurant).toBe(1);
    expect(merged.chinese_restaurant).toBe(NEAR_SCORE);
    expect(merged.dim_sum_restaurant).toBe(NEAR_SCORE);
  });

  it("every wish fits the format the optimizer reads", () => {
    for (const word of knownCuisineWords()) {
      const m = find(word);
      const scores = scoresFor(m);
      const excluded = excludedFor(m);
      expect(Object.keys(scores).length, word).toBeLessThanOrEqual(LIMITS.cuisines);
      expect(excluded.length, word).toBeLessThanOrEqual(LIMITS.cuisines);
      expect(PersonPreferencesSchema.safeParse({ version: 1, cuisine: { scores } }).success, word).toBe(true);
      expect(PersonPreferencesSchema.safeParse({ version: 1, cuisine: { excluded } }).success, word).toBe(true);
    }
  });
});

describe("ruling something out", () => {
  it("a dish rules out itself, a cuisine its dishes too, a region everything in it", () => {
    expect(excludedFor(find("hot pot"))).toEqual(["hot_pot_restaurant"]);
    expect(excludedFor(find("Korean"))).toEqual(["korean_restaurant", "korean_barbecue_restaurant"]);
    const region = excludedFor(find("Southeast Asian"));
    expect(region).toContain("thai_restaurant");
    expect(region).toContain("vietnamese_restaurant");
    expect(region).not.toContain("chinese_restaurant");
  });

  it('"no seafood" is seafood and oyster bars, not sushi', () => {
    const excluded = excludedFor(find("seafood"));
    expect(excluded).toEqual(["seafood_restaurant", "oyster_bar_restaurant"]);
    expect(matchCuisine(["seafood_restaurant"], { excluded }).excluded).toBe(true);
    expect(matchCuisine(["sushi_restaurant", "japanese_restaurant"], { excluded }).excluded).toBe(false);
  });
});

describe("matching a restaurant", () => {
  it("matches if any of its types matches, at the best score", () => {
    const scores = wish("Korean");
    expect(matchCuisine(["korean_restaurant", "barbecue_restaurant"], { scores }).score).toBe(1);
    expect(matchCuisine(["sushi_restaurant", "japanese_restaurant"], { scores }).score).toBe(NEAR_SCORE);
    expect(matchCuisine(["italian_restaurant"], { scores }).score).toBe(0);
    expect(matchCuisine([], { scores })).toEqual({ excluded: false, avoided: false, score: 0 });
  });

  it("a place tagged only with a dish counts for its cuisine", () => {
    // A group wish lists cuisines, not dishes; the dish is supplied here.
    expect(matchCuisine(["hot_pot_restaurant"], { scores: wish("Asian") }).score).toBe(1);
    expect(matchCuisine(["hot_pot_restaurant"], { excluded: ["chinese_restaurant"] }).excluded).toBe(true);
    // Not the other way round: a ban on hot pot does not ban Chinese food.
    expect(matchCuisine(["chinese_restaurant"], { excluded: ["hot_pot_restaurant"] }).excluded).toBe(false);
  });

  it("an excluded type excludes the place whatever else it serves", () => {
    const r = matchCuisine(["indian_restaurant", "vegetarian_restaurant"], {
      scores: { vegetarian_restaurant: 1 },
      excluded: ["indian_restaurant"],
    });
    expect(r.excluded).toBe(true);
  });
});

describe("real results from a search near Palo Alto", () => {
  it("a ramen place is Japanese", () => {
    const types = ["ramen_restaurant", "japanese_restaurant"];
    expect(matchCuisine(types, { scores: wish("ramen") }).score).toBe(1);
    expect(matchCuisine(types, { scores: wish("Japanese") }).score).toBe(1);
    expect(legacyCuisineOf("ramen_restaurant")).toBe("japanese");
  });

  it("a Pakistani place also tagged Indian matches Indian and South Asian", () => {
    const types = ["pakistani_restaurant", "brunch_restaurant", "halal_restaurant", "indian_restaurant"];
    expect(matchCuisine(types, { scores: wish("Indian") }).score).toBe(1);
    expect(matchCuisine(types, { scores: wish("South Asian") }).score).toBe(1);
  });

  it("a hot pot place matches a hot pot wish in full", () => {
    const types = ["hot_pot_restaurant", "japanese_restaurant", "chinese_restaurant"];
    expect(matchCuisine(types, { scores: wish("hot pot") }).score).toBe(1);
  });

  it("reads the kind of place", () => {
    expect(stylesOf(["indian_restaurant", "fine_dining_restaurant"])).toEqual(["fine_dining"]);
    expect(stylesOf(["hamburger_restaurant", "diner", "fast_food_restaurant", "american_restaurant"])).toEqual([
      "fast_food",
    ]);
    expect(stylesOf(["coffee_shop", "cafe"])).toEqual(["cafe"]);
    expect(stylesOf(["vietnamese_restaurant"])).toEqual(["casual"]);
  });

  it("a supermarket with a cafe inside is not somewhere to eat", () => {
    const types = ["grocery_store", "asian_grocery_store", "supermarket", "cafe", "deli", "bakery"];
    expect(isMealCandidate({ primaryType: "grocery_store", types })).toBe(false);
    expect(isMealCandidate({ types })).toBe(false);
  });
});

describe("kind of place", () => {
  it("can be more than one", () => {
    expect(stylesOf(["wine_bar", "coffee_shop", "cafe", "bar"])).toEqual(["cafe", "bar"]);
    expect(stylesOf(["fine_dining_restaurant", "cocktail_bar"])).toEqual(["fine_dining", "bar"]);
  });

  it("ignores a bar or cafe side tag on what Google calls a restaurant", () => {
    const tapas = ["spanish_restaurant", "cocktail_bar", "wine_bar", "tapas_restaurant"];
    expect(stylesOf(tapas, "spanish_restaurant")).toEqual(["casual"]);
    const brunch = ["brunch_restaurant", "californian_restaurant", "diner", "breakfast_restaurant", "cafe"];
    expect(stylesOf(brunch, "brunch_restaurant")).toEqual(["casual"]);
    // But a bar is still a bar, and a dessert place still a cafe.
    expect(stylesOf(["sports_bar", "bar_and_grill", "bar"], "sports_bar")).toEqual(["bar"]);
    expect(stylesOf(["dessert_restaurant", "cafe"], "dessert_restaurant")).toEqual(["cafe"]);
    // Fine dining and fast food are never side tags.
    expect(stylesOf(["indian_restaurant", "fine_dining_restaurant", "bar"], "indian_restaurant")).toEqual([
      "fine_dining",
    ]);
  });

  it.each([
    ["fast food", "fast_food"],
    ["fine dining", "fine_dining"],
    ["fancy", "fine_dining"],
    ["café", "cafe"],
    ["coffee", "cafe"],
    ["bar", "bar"],
    ["casual", "casual"],
    ["下午茶", "cafe"],
    ["快餐", "fast_food"],
    ["高级餐厅", "fine_dining"],
    ["a casual place", "casual"],
    ["Fast-Food restaurants", "fast_food"],
  ])("%s is %s", (word, style) => {
    expect(findStyle(word)).toBe(style);
  });

  it("returns null for a word that is not a kind of place", () => {
    expect(findStyle("korean")).toBeNull();
    expect(findStyle("")).toBeNull();
  });
});

describe("places to eat", () => {
  it("accepts restaurants, cafes and bars", () => {
    expect(
      isMealCandidate({ primaryType: "ramen_restaurant", types: ["ramen_restaurant", "japanese_restaurant"] }),
    ).toBe(true);
    expect(isMealCandidate({ primaryType: "restaurant", types: ["noodle_shop", "catering_service"] })).toBe(true);
    expect(isMealCandidate({ primaryType: "cafe", types: ["cafe"] })).toBe(true);
    expect(isMealCandidate({ primaryType: "tea_house", types: ["tea_house", "tea_store", "cafe"] })).toBe(true);
    expect(isMealCandidate({ types: ["korean_restaurant", "meal_takeaway"] })).toBe(true);
    // A cuisine type Google adds later still counts.
    expect(isMealCandidate({ primaryType: "nepalese_restaurant" })).toBe(true);
  });

  it("refuses shops, factories and delivery-only kitchens", () => {
    for (const primaryType of [
      "candy_store",
      "chocolate_factory",
      "winery",
      "coffee_roastery",
      "meal_delivery",
      "pizza_delivery",
      "supermarket",
      "catering_service",
    ]) {
      expect(isMealCandidate({ primaryType, types: [primaryType, "cafe"] }), primaryType).toBe(false);
    }
    expect(isMealCandidate({ types: [] })).toBe(false);
    expect(isMealCandidate({})).toBe(false);
  });
});

describe("the ten cuisines the app knew before", () => {
  it("each has an entry in the table, and maps back to itself", () => {
    const types = new Set(tableTypes());
    for (const legacy of CUISINES) {
      const type = LEGACY_CUISINE_TYPE[legacy];
      expect(types.has(type), legacy).toBe(true);
      expect(legacyCuisineOf(type)).toBe(legacy);
    }
  });

  it("dishes fall under their cuisine, and the old mediterranean keeps its reach", () => {
    expect(legacyCuisineOf("sushi_restaurant")).toBe("japanese");
    expect(legacyCuisineOf("pizza_restaurant")).toBe("italian");
    expect(legacyCuisineOf("hamburger_restaurant")).toBe("american");
    expect(legacyCuisineOf("taco_restaurant")).toBe("mexican");
    for (const t of [
      "greek_restaurant",
      "turkish_restaurant",
      "lebanese_restaurant",
      "middle_eastern_restaurant",
      "falafel_restaurant",
    ]) {
      expect(legacyCuisineOf(t), t).toBe("mediterranean");
    }
    expect(legacyCuisineOf("french_restaurant")).toBeNull();
    expect(legacyCuisineOf("cafe")).toBeNull();
  });
});

describe("wishes about what the food is like (#158)", () => {
  it.each([
    ["spicy", "spicy"],
    ["I like spicy food".replace("I like ", ""), "spicy"],
    ["辣", "spicy"],
    ["healthy", "light"],
    ["something light", "light"],
    ["trying to lose weight", "light"],
    ["减肥", "light"],
    ["lots of meat", "hearty"],
    ["something warm", "warm"],
  ])("%s is understood as a leaning, not turned away", (word, id) => {
    const m = find(word);
    expect(m).toMatchObject({ level: "leaning", id });
    expect(leaningOf(m)).toBeTruthy();
  });

  it("leans toward the kinds of food known for it, at full score", () => {
    expect(scoresFor(find("spicy"))).toEqual({
      thai_restaurant: 1,
      indian_restaurant: 1,
      korean_restaurant: 1,
      mexican_restaurant: 1,
      hot_pot_restaurant: 1,
    });
    expect(Object.keys(scoresFor(find("healthy")))).toEqual(expect.arrayContaining(["salad_shop", "vegan_restaurant"]));
  });

  it("names those kinds of food in plain words", () => {
    expect(describeMatch(find("spicy"))).toBe("Thai, Indian, Korean, Mexican, hot pot");
    expect(describeMatch(find("healthy"))).toBe("salad, vegetarian, vegan, Mediterranean, sushi, Vietnamese");
  });

  it("never rules a kind of food out: 'nothing spicy' must not ban every Thai and Indian place", () => {
    for (const l of LEANINGS) expect(excludedFor(find(l.label))).toEqual([]);
  });

  it("only uses types the table knows, and leaves ordinary words alone", () => {
    // Vegetarian and vegan places are Google types without a place in the cuisine tree, so the
    // check is against every food type Google has, and that a place of that type really matches.
    const types = new Set<string>(PLACE_FOOD_TYPES);
    for (const l of LEANINGS)
      for (const t of l.types) {
        expect(types.has(t), `${l.id}: ${t}`).toBe(true);
        expect(matchCuisine([t, "restaurant"], { scores: scoresFor(find(l.label)) }).score, t).toBe(1);
      }
    expect(find("soup")).toMatchObject({ level: "cuisine" });
    expect(find("Asian")).toMatchObject({ level: "group" });
    expect(leaningOf(find("Thai"))).toBeNull();
  });
});
