import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CUISINES } from "@/lib/constraints";
import {
  LEGACY_CUISINE_TYPE,
  NEAR_SCORE,
  compactExcluded,
  compactScores,
  describeTypes,
  findCuisine,
  lowerBroadWish,
  matchCuisine,
  mergeScores,
  scoresFor,
  tableTypes,
} from "@/lib/cuisine-table";
import { applyLegacyUpdate, toLegacyConstraints } from "@/lib/legacy-adapter";
import { emptyMemberState, type MemberState } from "@/lib/member-state";
import { LIMITS, STYLES, type PersonPreferences } from "@/lib/optimizer-input";
import { toRestaurant, type PlaceResult } from "@/lib/places";
import { RESTAURANTS } from "@/lib/restaurants";

/**
 * The cuisine table where it meets the rest of the app (#100): the stored form of a wish,
 * what a person is shown, what the old negotiation engine is handed, and what a restaurant
 * carries. How the assistant uses the table turn by turn is in assistant.test.ts.
 */

const wish = (word: string) => scoresFor(findCuisine(word)!);
const withCuisine = (cuisine: PersonPreferences["cuisine"]): MemberState => ({
  ...emptyMemberState(),
  prefs: { version: 1, cuisine },
});

describe("the stored form of a wish", () => {
  it("leaves out a dish that only repeats its cuisine's score, and loses nothing by it", () => {
    const full = wish("Chinese");
    const stored = compactScores(full);
    expect(full.hot_pot_restaurant).toBe(1);
    expect(stored.hot_pot_restaurant).toBeUndefined();
    expect(stored.chinese_restaurant).toBe(1);
    // Every type scores the same against the stored form as against the full one.
    for (const type of tableTypes()) {
      expect(matchCuisine([type], { scores: stored }).score, type).toBe(matchCuisine([type], { scores: full }).score);
    }
  });

  it("keeps a dish whose score differs from its cuisine's", () => {
    const stored = compactScores(wish("hot pot"));
    expect(stored).toMatchObject({ hot_pot_restaurant: 1, chinese_restaurant: NEAR_SCORE });
    expect(stored.dim_sum_restaurant).toBeLessThan(NEAR_SCORE);
  });

  it("holds every cuisine in the table at once, so no real wish is cut", () => {
    const everything = compactScores(mergeScores(wish("Asian"), wish("Western"), wish("Latin American")));
    expect(Object.keys(everything).length).toBeLessThanOrEqual(LIMITS.cuisines);
    expect(everything.korean_restaurant).toBe(1);
    expect(everything.american_restaurant).toBe(1);
    expect(everything.mexican_restaurant).toBe(1);
  });

  it("keeps the highest scores, in table order, when a list is longer than the limit", () => {
    const scores = { thai_restaurant: 0.5, korean_restaurant: 1, japanese_restaurant: 0.5, french_restaurant: 1 };
    expect(compactScores(scores, 3)).toEqual({ korean_restaurant: 1, japanese_restaurant: 0.5, french_restaurant: 1 });
    expect(compactScores(scores, 2)).toEqual({ korean_restaurant: 1, french_restaurant: 1 });
    expect(compactScores(scores)).toEqual(scores);
  });

  it("drops an excluded dish when its cuisine is excluded too", () => {
    expect(compactExcluded(["chinese_restaurant", "hot_pot_restaurant", "sushi_restaurant"])).toEqual([
      "chinese_restaurant",
      "sushi_restaurant",
    ]);
    expect(compactExcluded(["hot_pot_restaurant", "hot_pot_restaurant"])).toEqual(["hot_pot_restaurant"]);
  });
});

describe("a favourite after a broad wish", () => {
  it("lowers the rest of a whole region, or a whole group, and nothing else", () => {
    const asian = lowerBroadWish(wish("Asian"), [findCuisine("Korean")!]);
    expect(asian.thai_restaurant).toBe(NEAR_SCORE);
    expect(asian.indian_restaurant).toBe(NEAR_SCORE);
    const eastOnly = lowerBroadWish(mergeScores(wish("East Asian"), { italian_restaurant: 1 }), [
      findCuisine("ramen")!,
    ]);
    expect(eastOnly.chinese_restaurant).toBe(NEAR_SCORE);
    expect(eastOnly.italian_restaurant).toBe(1);
  });

  it("leaves separate wishes alone: two cuisines someone named are not a broad wish", () => {
    const two = { korean_restaurant: 1, thai_restaurant: 1 };
    expect(lowerBroadWish(two, [findCuisine("Korean")!])).toEqual(two);
    expect(lowerBroadWish(wish("Asian"), [findCuisine("Italian")!])).toEqual(wish("Asian"));
  });
});

describe("what a person is shown", () => {
  it("says a whole group or region in one word, and a cuisine without its dishes", () => {
    expect(describeTypes(Object.keys(wish("Asian")))).toEqual(["Asian"]);
    expect(describeTypes(Object.keys(wish("East Asian")))).toEqual(["East Asian"]);
    expect(describeTypes(["chinese_restaurant", "hot_pot_restaurant", "korean_restaurant"])).toEqual([
      "Chinese",
      "Korean",
    ]);
    expect(describeTypes(["hot_pot_restaurant"])).toEqual(["hot pot"]);
  });

  it("never shows a raw type name, even for one the table does not place", () => {
    for (const label of describeTypes([...tableTypes(), "nepalese_restaurant"])) expect(label).not.toMatch(/_/);
  });
});

describe("what the old negotiation engine is handed (transitional)", () => {
  const legacy = (cuisine: PersonPreferences["cuisine"]) => {
    const c = toLegacyConstraints(withCuisine(cuisine));
    return { liked: c.likedCuisines, disliked: c.dislikedCuisines };
  };

  it('"hot pot" becomes liking Chinese food', () => {
    expect(legacy({ scores: compactScores(wish("hot pot")), strength: "mild" }).liked).toEqual(["chinese"]);
  });

  it('"Asian" becomes liking every Asian cuisine the old list has', () => {
    expect(legacy({ scores: compactScores(wish("Asian")), strength: "mild" }).liked).toEqual([
      "japanese",
      "chinese",
      "korean",
      "thai",
      "vietnamese",
      "indian",
    ]);
  });

  it("a cuisine the old list has nothing for is not passed on, and stays stored", () => {
    const state = withCuisine({ scores: compactScores(wish("French")), strength: "mild" });
    expect(toLegacyConstraints(state).likedCuisines).toEqual([]);
    expect(state.prefs.cuisine?.scores?.french_restaurant).toBe(1);
  });

  it("the next best things around a wish are not passed on as likes", () => {
    // Korean at 1 puts Japanese and Chinese at the lower score; the old engine only hears Korean.
    expect(legacy({ scores: compactScores(wish("Korean")), strength: "mild" }).liked).toEqual(["korean"]);
  });

  it("ruling out a cuisine is passed on; ruling out one dish is not", () => {
    expect(legacy({ excluded: ["indian_restaurant"], strength: "mild" }).disliked).toEqual(["indian"]);
    expect(legacy({ excluded: ["hot_pot_restaurant"], strength: "mild" }).disliked).toEqual([]);
    expect(legacy({ excluded: compactExcluded(["italian_restaurant", "pizza_restaurant"]), strength: "mild" })).toEqual(
      { liked: [], disliked: ["italian"] },
    );
  });

  it("every old cuisine still goes there and back", () => {
    for (const c of CUISINES) {
      expect(legacy({ scores: { [LEGACY_CUISINE_TYPE[c]]: 1 }, strength: "mild" }).liked, c).toEqual([c]);
    }
  });

  it("the safety net's own cuisine answers leave the assistant's finer record alone", () => {
    const before = withCuisine({ scores: compactScores(wish("hot pot")), strength: "strong" });
    const after = applyLegacyUpdate(before, { likedCuisines: ["korean"] });
    expect(after.prefs.cuisine?.scores).toMatchObject({ hot_pot_restaurant: 1, korean_restaurant: 1 });
    // Chinese food stays the next best thing; the old reader's view of it as "liked" is not written back.
    expect(after.prefs.cuisine?.scores?.chinese_restaurant).toBe(NEAR_SCORE);
    const ruledOut = applyLegacyUpdate(after, { dislikedCuisines: ["korean"] });
    expect(ruledOut.prefs.cuisine?.excluded).toEqual(["korean_restaurant"]);
    expect(ruledOut.prefs.cuisine?.scores?.korean_restaurant).toBeUndefined();
    expect(ruledOut.prefs.cuisine?.scores?.hot_pot_restaurant).toBe(1);
  });
});

describe("what a restaurant carries", () => {
  const fixture = JSON.parse(readFileSync(path.join(__dirname, "fixtures/places-nearby.json"), "utf8")) as {
    places: PlaceResult[];
  };
  const CENTER = { lat: 37.4443, lng: -122.1598 };
  const sushi = fixture.places.find((p) => p.id === "ChIJ_sushi")!;

  it("a Places result keeps Google's types, and gets its kind of place from them", () => {
    const r = toRestaurant(sushi, CENTER)!;
    expect(r.types).toEqual(["sushi_restaurant", "japanese_restaurant", "restaurant", "food"]);
    expect(r.style).toEqual(["casual"]);
    // The legacy single cuisine is still there for the old engine.
    expect(r.cuisine).toBe("japanese");
    const fancy = toRestaurant(
      { ...sushi, primaryType: "japanese_restaurant", types: ["japanese_restaurant", "fine_dining_restaurant"] },
      CENTER,
    )!;
    expect(fancy.style).toEqual(["fine_dining"]);
    expect(matchCuisine(r.types!, { scores: compactScores(wish("ramen")) }).score).toBe(NEAR_SCORE);
    expect(matchCuisine(r.types!, { scores: compactScores(wish("sushi")) }).score).toBe(1);
  });

  it("the primary type is kept even when Google leaves it out of the list", () => {
    const r = toRestaurant({ ...sushi, primaryType: "ramen_restaurant", types: ["japanese_restaurant"] }, CENTER)!;
    expect(r.types).toEqual(["ramen_restaurant", "japanese_restaurant"]);
  });

  it("a shop that happens to serve food is not a candidate", () => {
    const market = {
      ...sushi,
      primaryType: "grocery_store",
      types: ["grocery_store", "asian_grocery_store", "supermarket", "cafe", "japanese_restaurant"],
    };
    expect(toRestaurant(market, CENTER)).toBeNull();
    expect(
      toRestaurant({ ...sushi, primaryType: "meal_delivery", types: ["meal_delivery", "sushi_restaurant"] }, CENTER),
    ).toBeNull();
  });

  it("a place with no cuisine the old engine knows is still left out of the pool, for now", () => {
    // Widening the pool beyond the old ten cuisines is issue #101.
    expect(
      toRestaurant(
        {
          ...sushi,
          displayName: { text: "Chez Nous" },
          primaryType: "french_restaurant",
          types: ["french_restaurant", "restaurant"],
        },
        CENTER,
      ),
    ).toBeNull();
  });

  it("every seed restaurant has types that say its cuisine, and a kind of place", () => {
    for (const r of RESTAURANTS) {
      expect(r.types, r.name).toEqual([LEGACY_CUISINE_TYPE[r.cuisine], "restaurant"]);
      expect(r.style, r.name).toEqual(["casual"]);
      for (const s of r.style!) expect(STYLES).toContain(s);
      expect(matchCuisine(r.types!, { scores: { [LEGACY_CUISINE_TYPE[r.cuisine]]: 1 } }).score).toBe(1);
    }
  });
});
