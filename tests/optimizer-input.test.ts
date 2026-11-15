import { describe, expect, it } from "vitest";
import {
  CandidateRestaurantSchema,
  DEFAULT_START_TIME,
  LIMITS,
  MEALS,
  PersonPreferencesSchema,
  PlanSchema,
  START_TIMES,
  isSelectable,
  mealStartTimes,
  priorityWeights,
  startTimesIn,
} from "@/lib/optimizer-input";

const ok = (input: unknown) => PersonPreferencesSchema.safeParse(input).success;
const person = (extra: Record<string, unknown>) => ({ version: 1, ...extra });

/** The examples written in issue #82. If these stop parsing, the issue and the code disagree. */
const ISSUE_PLAN = {
  date: "2026-11-21",
  startTimes: [...START_TIMES],
  anchor: { label: "Palo Alto", lat: 37.4419, lng: -122.143 },
};
const ISSUE_PERSON = {
  version: 1,
  time: {
    unavailable: [{ from: "10:00", to: "17:00" }],
    preferred: [{ from: "18:00", to: "20:00" }],
    strength: "mild",
  },
  budget: { ideal: 30, max: 50, strength: "strong" },
  travel: { idealMin: 15, maxMin: 30, strength: "mild" },
  dietary: ["vegetarian"],
  cuisine: {
    scores: { hot_pot_restaurant: 1, chinese_restaurant: 0.5 },
    excluded: ["indian_restaurant"],
    strength: "mild",
  },
  style: { wanted: ["fine_dining"], excluded: ["fast_food"], strength: "mild" },
  priority: ["budget", "cuisine", "travel"],
  wantedRestaurants: [{ name: "Ramen Nagi", id: "place_1" }],
  excludedRestaurants: [],
  notes: [{ type: "allergy", text: "peanuts" }],
};
const ISSUE_RESTAURANT = {
  id: "place_1",
  name: "Ramen Nagi",
  types: ["ramen_restaurant", "japanese_restaurant"],
  style: ["casual"],
  price: { low: 20, high: 30 },
  servesVegetarian: true,
  openAt: ["11:00", "12:00", "13:00", "17:00", "18:00", "19:00", "20:00"],
  travelMin: { person_a: 12 },
};

describe("the examples in issue #82", () => {
  it("parse unchanged", () => {
    expect(PlanSchema.parse(ISSUE_PLAN)).toEqual(ISSUE_PLAN);
    expect(PersonPreferencesSchema.parse(ISSUE_PERSON)).toEqual(ISSUE_PERSON);
    expect(CandidateRestaurantSchema.parse(ISSUE_RESTAURANT)).toEqual(ISSUE_RESTAURANT);
  });
});

describe("start times", () => {
  it("are on the hour from 10:00 to 23:00", () => {
    expect(START_TIMES).toHaveLength(14);
    expect(START_TIMES[0]).toBe("10:00");
    expect(START_TIMES.at(-1)).toBe("23:00");
    expect(START_TIMES).toContain(DEFAULT_START_TIME);
  });

  it("a range includes both ends", () => {
    expect(startTimesIn({ from: "18:00", to: "20:00" })).toEqual(["18:00", "19:00", "20:00"]);
    expect(startTimesIn({ from: "12:00", to: "12:00" })).toEqual(["12:00"]);
  });

  it("every meal word maps to start times, decided by code", () => {
    for (const meal of MEALS) expect(mealStartTimes(meal).length).toBeGreaterThan(0);
    expect(mealStartTimes("brunch")).toEqual(["10:00", "11:00"]);
    expect(mealStartTimes("dinner")).toEqual(["17:00", "18:00", "19:00", "20:00"]);
    expect(mealStartTimes("late_night")).toEqual(["21:00", "22:00", "23:00"]);
  });
});

describe("priorityWeights", () => {
  it("is equal when the person gave no order", () => {
    const w = priorityWeights();
    expect(new Set(Object.values(w)).size).toBe(1);
    expect(w.budget).toBeCloseTo(0.2);
  });

  it("scores a three-item order 3, 2, 1 and gives the rest the lowest score", () => {
    const w = priorityWeights(["budget", "cuisine", "travel"]);
    expect(w.budget / w.travel).toBeCloseTo(3);
    expect(w.cuisine / w.travel).toBeCloseTo(2);
    expect(w.time).toBeCloseTo(w.travel);
    expect(w.style).toBeCloseTo(w.travel);
  });

  it("always sums to 1", () => {
    for (const order of [[], ["time"], ["style", "time", "budget", "travel", "cuisine"]] as const) {
      const total = Object.values(priorityWeights(order)).reduce((a, b) => a + b, 0);
      expect(total).toBeCloseTo(1);
    }
  });
});

describe("a person's preferences", () => {
  it("accepts someone with no constraints at all", () => {
    expect(PersonPreferencesSchema.parse({ version: 1 })).toEqual({ version: 1 });
  });

  it("rejects an unknown version and unknown fields", () => {
    expect(ok({ version: 2 })).toBe(false);
    expect(ok(person({ availableSlots: ["sat_dinner"] }))).toBe(false);
  });

  it("treats a missing strength as mild, and rejects a made-up one", () => {
    const p = PersonPreferencesSchema.parse(person({ budget: { ideal: 30 } }));
    expect(p.budget?.strength).toBe("mild");
    expect(ok(person({ budget: { ideal: 30, strength: "very" } }))).toBe(false);
  });

  describe("time", () => {
    it("accepts only start times on the hour inside the day", () => {
      expect(ok(person({ time: { unavailable: [{ from: "10:00", to: "12:00" }] } }))).toBe(true);
      expect(ok(person({ time: { unavailable: [{ from: "18:30", to: "20:00" }] } }))).toBe(false);
      expect(ok(person({ time: { unavailable: [{ from: "08:00", to: "12:00" }] } }))).toBe(false);
    });

    it("rejects a range that ends before it starts", () => {
      expect(ok(person({ time: { preferred: [{ from: "20:00", to: "18:00" }] } }))).toBe(false);
    });

    it("rejects a time that is both preferred and unavailable", () => {
      const time = { unavailable: [{ from: "10:00", to: "18:00" }], preferred: [{ from: "18:00", to: "20:00" }] };
      expect(ok(person({ time }))).toBe(false);
    });
  });

  describe("budget and travel", () => {
    it("accept an ideal, a max, or both", () => {
      expect(ok(person({ budget: { ideal: 30 } }))).toBe(true);
      expect(ok(person({ budget: { max: 50 } }))).toBe(true);
      expect(ok(person({ travel: { idealMin: 15, maxMin: 30 } }))).toBe(true);
    });

    it("reject an ideal above the max", () => {
      expect(ok(person({ budget: { ideal: 50, max: 30 } }))).toBe(false);
      expect(ok(person({ travel: { idealMin: 40, maxMin: 20 } }))).toBe(false);
    });

    it("reject an empty block: leaving the field out is how to say no constraint", () => {
      expect(ok(person({ budget: {} }))).toBe(false);
      expect(ok(person({ travel: { strength: "strong" } }))).toBe(false);
    });

    it("need a max before the limit can be a must", () => {
      expect(ok(person({ budget: { ideal: 30, strength: "must" } }))).toBe(false);
      expect(ok(person({ budget: { max: 50, strength: "must" } }))).toBe(true);
      expect(ok(person({ travel: { idealMin: 10, strength: "must" } }))).toBe(false);
    });

    it("reject values that are not sensible amounts", () => {
      expect(ok(person({ budget: { max: 0 } }))).toBe(false);
      expect(ok(person({ budget: { max: LIMITS.maxBudget + 1 } }))).toBe(false);
      expect(ok(person({ travel: { maxMin: 12.5 } }))).toBe(false);
    });
  });

  describe("dietary", () => {
    it("is limited to what Google Places lets us check", () => {
      expect(ok(person({ dietary: ["vegetarian", "vegan", "halal"] }))).toBe(true);
      expect(ok(person({ dietary: ["no_spicy"] }))).toBe(false);
      expect(ok(person({ dietary: ["halal", "halal"] }))).toBe(false);
    });
  });

  describe("cuisine", () => {
    it("uses Google Places type names with scores above 0 and up to 1", () => {
      expect(ok(person({ cuisine: { scores: { korean_restaurant: 1, hot_pot_restaurant: 0.5 } } }))).toBe(true);
      expect(ok(person({ cuisine: { scores: { "Korean food": 1 } } }))).toBe(false);
      expect(ok(person({ cuisine: { scores: { korean_restaurant: 1.5 } } }))).toBe(false);
      expect(ok(person({ cuisine: { scores: { korean_restaurant: 0 } } }))).toBe(false);
    });

    it("rejects a cuisine that is both wanted and excluded", () => {
      const cuisine = { scores: { indian_restaurant: 1 }, excluded: ["indian_restaurant"] };
      expect(ok(person({ cuisine }))).toBe(false);
    });
  });

  describe("style", () => {
    it("is one of the fixed kinds of place", () => {
      expect(ok(person({ style: { wanted: ["cafe"], excluded: ["bar"] } }))).toBe(true);
      expect(ok(person({ style: { wanted: ["rooftop"] } }))).toBe(false);
      expect(ok(person({ style: { wanted: ["cafe"], excluded: ["cafe"] } }))).toBe(false);
    });
  });

  describe("priority", () => {
    it("lists known dimensions without repeats", () => {
      expect(ok(person({ priority: ["budget", "time"] }))).toBe(true);
      expect(ok(person({ priority: ["budget", "budget"] }))).toBe(false);
      expect(ok(person({ priority: ["vibes"] }))).toBe(false);
    });
  });

  describe("named restaurants", () => {
    it("keep the typed name when no candidate matched", () => {
      const p = PersonPreferencesSchema.parse(person({ wantedRestaurants: [{ name: "  Some Place ", id: null }] }));
      expect(p.wantedRestaurants).toEqual([{ name: "Some Place", id: null }]);
    });

    it("need a name, and are capped", () => {
      expect(ok(person({ wantedRestaurants: [{ name: "", id: "place_1" }] }))).toBe(false);
      expect(ok(person({ wantedRestaurants: [{ id: "place_1" }] }))).toBe(false);
      const many = Array.from({ length: LIMITS.namedRestaurants + 1 }, (_, i) => ({ name: `R${i}`, id: null }));
      expect(ok(person({ excludedRestaurants: many }))).toBe(false);
    });

    it("cannot be both wanted and excluded, by id or by name", () => {
      const byId = {
        wantedRestaurants: [{ name: "Ramen Nagi", id: "place_1" }],
        excludedRestaurants: [{ name: "Nagi", id: "place_1" }],
      };
      const byName = {
        wantedRestaurants: [{ name: "Ramen Nagi", id: null }],
        excludedRestaurants: [{ name: "ramen nagi", id: null }],
      };
      expect(ok(person(byId))).toBe(false);
      expect(ok(person(byName))).toBe(false);
    });
  });

  describe("notes", () => {
    it("are short, typed, and capped", () => {
      expect(ok(person({ notes: [{ type: "allergy", text: "peanuts" }] }))).toBe(true);
      expect(ok(person({ notes: [{ type: "secret", text: "x" }] }))).toBe(false);
      expect(ok(person({ notes: [{ type: "other", text: "x".repeat(LIMITS.noteChars + 1) }] }))).toBe(false);
      const many = Array.from({ length: LIMITS.notes + 1 }, () => ({ type: "other", text: "x" }));
      expect(ok(person({ notes: many }))).toBe(false);
    });
  });
});

describe("a plan", () => {
  const plan = (extra: Record<string, unknown>) => ({ ...ISSUE_PLAN, ...extra });

  it("needs a real date", () => {
    expect(PlanSchema.safeParse(plan({ date: "2026-02-30" })).success).toBe(false);
    expect(PlanSchema.safeParse(plan({ date: "next Saturday" })).success).toBe(false);
  });

  it("needs at least one start time, none repeated", () => {
    expect(PlanSchema.safeParse(plan({ startTimes: [] })).success).toBe(false);
    expect(PlanSchema.safeParse(plan({ startTimes: ["18:00", "18:00"] })).success).toBe(false);
    expect(PlanSchema.safeParse(plan({ startTimes: ["18:00"] })).success).toBe(true);
  });

  it("needs an anchor on the globe", () => {
    expect(PlanSchema.safeParse(plan({ anchor: { label: "Nowhere", lat: 120, lng: 0 } })).success).toBe(false);
  });
});

describe("a candidate restaurant", () => {
  const restaurant = (extra: Record<string, unknown>) => ({ ...ISSUE_RESTAURANT, ...extra });

  it("may be missing what Google does not say", () => {
    const sparse = restaurant({ types: [], style: [], price: null, servesVegetarian: null, openAt: null });
    expect(CandidateRestaurantSchema.safeParse(sparse).success).toBe(true);
  });

  it("is not selectable without opening hours", () => {
    expect(isSelectable(CandidateRestaurantSchema.parse(ISSUE_RESTAURANT))).toBe(true);
    expect(isSelectable(CandidateRestaurantSchema.parse(restaurant({ openAt: null })))).toBe(false);
    expect(isSelectable(CandidateRestaurantSchema.parse(restaurant({ openAt: [] })))).toBe(false);
  });

  it("rejects a price range upside down", () => {
    expect(CandidateRestaurantSchema.safeParse(restaurant({ price: { low: 40, high: 20 } })).success).toBe(false);
  });

  it("carries travel minutes, never an address", () => {
    expect(CandidateRestaurantSchema.safeParse(restaurant({ startPoint: "123 Main St" })).success).toBe(false);
    expect(CandidateRestaurantSchema.safeParse(restaurant({ travelMin: { person_a: -1 } })).success).toBe(false);
  });
});
