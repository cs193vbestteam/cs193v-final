import { describe, expect, it } from "vitest";
import { emptyConstraints, mergeConstraints } from "@/lib/constraints";
import { NO_SPICY_NOTE, SEAFOOD_TYPE, applyLegacyUpdate, toLegacyConstraints, toRulesView } from "@/lib/legacy-adapter";
import { LEGACY_CUISINE_TYPE } from "@/lib/cuisine-table";
import {
  MAX_ASSISTANT_TURNS,
  MemberStateSchema,
  allowedToAsk,
  availableTimes,
  describeState,
  emptyMemberState,
  missingRequired,
  parseMemberState,
  preferencesChanged,
  timesIn,
  toRanges,
  type MemberState,
} from "@/lib/member-state";
import { START_TIMES, type PersonPreferences } from "@/lib/optimizer-input";
import { compile } from "@/lib/preferences";

const withPrefs = (prefs: Omit<PersonPreferences, "version">, chat: Partial<MemberState["chat"]> = {}): MemberState => {
  const empty = emptyMemberState();
  return { ...empty, prefs: { version: 1, ...prefs }, chat: { ...empty.chat, ...chat } };
};

describe("what is stored for a member", () => {
  it("starts with no preferences and nothing asked", () => {
    const s = emptyMemberState();
    expect(s.prefs).toEqual({ version: 1 });
    expect(s.chat).toMatchObject({ asked: [], answered: [], turns: 0, lastAsked: null });
    expect(MemberStateSchema.parse(s)).toEqual(s);
  });

  it("refuses the older stored format instead of guessing at it", () => {
    expect(() => parseMemberState(emptyConstraints())).toThrow();
    expect(() =>
      parseMemberState({ ...emptyMemberState(), prefs: { version: 1, budget: { ideal: 50, max: 30 } } }),
    ).toThrow();
  });

  it("turns start times into the fewest ranges and back", () => {
    expect(toRanges(["10:00", "11:00", "14:00", "22:00", "23:00"])).toEqual([
      { from: "10:00", to: "11:00" },
      { from: "14:00", to: "14:00" },
      { from: "22:00", to: "23:00" },
    ]);
    expect(timesIn(toRanges(["12:00", "13:00", "19:00"]))).toEqual(["12:00", "13:00", "19:00"]);
    expect(toRanges([])).toEqual([]);
  });

  it("only counts a change in what the person wants as a change", () => {
    const a = withPrefs({ budget: { max: 40, strength: "must" } });
    const asked: MemberState = { ...a, chat: { ...a.chat, turns: 3, asked: ["time"], lastAsked: "time" } };
    expect(preferencesChanged(a, asked)).toBe(false);
    expect(preferencesChanged(a, withPrefs({ budget: { max: 45, strength: "must" } }))).toBe(true);
    expect(preferencesChanged(a, { ...a, startPoint: { label: "Home", lat: 37.4, lng: -122.1 } })).toBe(true);
  });
});

describe('what "I\'m done" needs', () => {
  it("is the time and the cannot-eat answer, and nothing else", () => {
    expect(missingRequired(emptyMemberState())).toEqual(["time", "diet"]);
    expect(missingRequired(withPrefs({}, { answered: ["time"] }))).toEqual(["diet"]);
    // Budget, travel and cuisine can all stay empty.
    expect(missingRequired(withPrefs({}, { answered: ["diet", "time"] }))).toEqual([]);
    // Saying a lot about everything else does not stand in for the two that are needed.
    const chatty = withPrefs(
      { budget: { max: 40, strength: "must" }, travel: { maxMin: 20, strength: "mild" } },
      { answered: ["budget", "travel", "cuisine"] },
    );
    expect(missingRequired(chatty)).toEqual(["time", "diet"]);
  });
});

describe("which variables the assistant may still ask about", () => {
  it("is everything at the start", () => {
    expect(allowedToAsk(emptyMemberState())).toEqual(["time", "budget", "travel", "diet", "cuisine"]);
  });

  it("drops a variable once it is answered or declined", () => {
    expect(allowedToAsk(withPrefs({}, { answered: ["budget", "cuisine"] }))).toEqual(["time", "travel", "diet"]);
  });

  it("asks about budget, travel and cuisine at most once, answered or not", () => {
    const s = withPrefs({}, { asked: ["budget", "travel", "cuisine"] });
    expect(allowedToAsk(s)).toEqual(["time", "diet"]);
  });

  it("keeps the two required questions open until they are answered, because nobody can finish without them", () => {
    const s = withPrefs({}, { asked: ["time", "diet"] });
    expect(allowedToAsk(s)).toEqual(["time", "budget", "travel", "diet", "cuisine"]);
    expect(allowedToAsk(withPrefs({}, { asked: ["time", "diet"], answered: ["time", "diet"] }))).toEqual([
      "budget",
      "travel",
      "cuisine",
    ]);
  });

  it(`is nothing after ${MAX_ASSISTANT_TURNS} replies, whatever is still open`, () => {
    expect(allowedToAsk(withPrefs({}, { turns: MAX_ASSISTANT_TURNS - 1 })).length).toBeGreaterThan(0);
    expect(allowedToAsk(withPrefs({}, { turns: MAX_ASSISTANT_TURNS }))).toEqual([]);
    expect(allowedToAsk(withPrefs({}, { turns: MAX_ASSISTANT_TURNS + 5 }))).toEqual([]);
  });
});

describe("the summary shown to its owner", () => {
  it("says nothing when nothing is recorded", () => {
    expect(describeState(emptyMemberState())).toEqual([]);
  });

  it("puts everything in plain words: clock times, both budget numbers, places and notes", () => {
    const s = withPrefs(
      {
        time: {
          unavailable: [{ from: "10:00", to: "17:00" }],
          preferred: [{ from: "18:00", to: "19:00" }],
          strength: "strong",
        },
        budget: { ideal: 30, max: 50, strength: "must" },
        travel: { idealMin: 15, maxMin: 30, strength: "mild" },
        dietary: ["vegetarian"],
        cuisine: { scores: { hot_pot_restaurant: 1 }, excluded: ["indian_restaurant"], strength: "mild" },
        style: { wanted: ["fine_dining"], excluded: ["fast_food"], strength: "mild" },
        priority: ["budget", "cuisine"],
        wantedRestaurants: [{ name: "Ramen Nagi", id: "place-1" }],
        excludedRestaurants: [{ name: "Sizzler", id: null }],
        notes: [{ type: "allergy", text: "peanuts" }],
      },
      { answered: ["time", "budget", "travel", "diet", "cuisine"] },
    );
    const lines = describeState({ ...s, startPoint: { label: "Mountain View", lat: 37.39, lng: -122.08 } });
    expect(lines).toEqual([
      "Free: 6:00 PM to 11:00 PM",
      "Would like: 6:00 PM to 7:00 PM (matters a lot)",
      "Budget: ideally $30, up to $50/person (a must)",
      "Travel: ideally 15 min, up to 30 min",
      "Coming from: Mountain View",
      "Diet: vegetarian",
      "Would like to eat: hot pot",
      "Not for them: Indian",
      "Kind of place: fine dining",
      "Not this kind of place: fast food",
      "Would like to go to: Ramen Nagi",
      "Would rather not go to: Sizzler",
      "Matters most: the budget, then the food",
      "Allergy note (only you see this): peanuts",
    ]);
    // Nothing the person would not recognise: no field names, no 24-hour values.
    expect(lines.join(" ")).not.toMatch(/\d{2}:\d{2}(?! [AP]M)|_restaurant|maxMin|unavailable/);
  });

  it('says what "I don\'t mind" settled', () => {
    const s = withPrefs({}, { answered: ["time", "budget", "travel", "diet", "cuisine"] });
    expect(describeState(s)).toEqual([
      "Free: any time",
      "Budget: no limit",
      "Travel: any distance",
      "Diet: no restrictions",
      "Cuisine: no preference",
    ]);
  });

  it("does not claim there are no restrictions when the diet answer was an allergy", () => {
    const s = withPrefs({ notes: [{ type: "allergy", text: "shellfish" }] }, { answered: ["diet"] });
    expect(describeState(s)).toEqual(["Diet: see the note below", "Allergy note (only you see this): shellfish"]);
  });
});

/**
 * TRANSITIONAL: these go when the adapter and the old negotiation engine go.
 */
describe("the adapter to the older format the negotiation engine reads", () => {
  it("reads someone with no preferences as someone with no limits", () => {
    const c = toLegacyConstraints(emptyMemberState());
    expect(c.availableSlots).toEqual([...START_TIMES]);
    expect(c).toMatchObject({ budgetMax: null, budgetNoLimit: true, maxTravelMin: null, travelNoLimit: true });
    expect(c.dietaryConfirmed).toBe(true);
    // The engine can compile it as it is.
    expect(() => compile(c)).not.toThrow();
  });

  it("takes away the times they cannot make, and keeps only the named ones when that is a must", () => {
    const soft = withPrefs({
      time: {
        unavailable: [{ from: "10:00", to: "16:00" }],
        preferred: [{ from: "19:00", to: "20:00" }],
        strength: "mild",
      },
    });
    expect(availableTimes(soft.prefs)).toEqual(["17:00", "18:00", "19:00", "20:00", "21:00", "22:00", "23:00"]);
    const hard = withPrefs({ time: { preferred: [{ from: "19:00", to: "20:00" }], strength: "must" } });
    expect(toLegacyConstraints(hard).availableSlots).toEqual(["19:00", "20:00"]);
  });

  it("maps an ideal and a max onto the old ceiling and stretch", () => {
    const both = toLegacyConstraints(withPrefs({ budget: { ideal: 30, max: 50, strength: "must" } }));
    expect(both).toMatchObject({ budgetMax: 30, budgetFlex: 20, budgetNoLimit: false });
    const maxOnly = toLegacyConstraints(withPrefs({ budget: { max: 40, strength: "must" } }));
    expect(maxOnly).toMatchObject({ budgetMax: 40, budgetFlex: 0 });
    // An ideal with no ceiling: aim for it, allow half as much again.
    const idealOnly = toLegacyConstraints(withPrefs({ budget: { ideal: 30, strength: "mild" } }));
    expect(idealOnly).toMatchObject({ budgetMax: 30, budgetFlex: 15 });
    expect(
      toLegacyConstraints(withPrefs({ travel: { idealMin: 10, maxMin: 25, strength: "mild" } })).maxTravelMin,
    ).toBe(25);
    expect(toLegacyConstraints(withPrefs({ travel: { idealMin: 10, strength: "mild" } })).maxTravelMin).toBe(10);
  });

  it("maps diets the engine can filter on, and drops what it cannot use", () => {
    const c = toLegacyConstraints(
      withPrefs({
        dietary: ["vegan", "halal"],
        cuisine: {
          scores: { [LEGACY_CUISINE_TYPE.korean]: 1, hot_pot_restaurant: 1 },
          excluded: [LEGACY_CUISINE_TYPE.indian, SEAFOOD_TYPE],
          strength: "strong",
        },
        style: { excluded: ["fast_food"], strength: "mild" },
        wantedRestaurants: [{ name: "Ramen Nagi", id: "place-1" }],
        notes: [{ type: "allergy", text: "peanuts" }],
      }),
    );
    expect(c.dietary.sort()).toEqual(["halal", "no_seafood", "vegetarian"]);
    // Hot pot is Chinese food to the old engine, which has no dishes.
    expect(c.likedCuisines).toEqual(["chinese", "korean"]);
    expect(c.dislikedCuisines).toEqual(["indian"]);
    expect(c.avoidNotes).toEqual([]);
  });

  it("turns a stated order of importance into the engine's weights, and concedes the least important first", () => {
    const c = toLegacyConstraints(withPrefs({ priority: ["budget", "cuisine"] }));
    expect(c.weights.budget).toBeGreaterThan(c.weights.cuisine);
    expect(c.weights.cuisine).toBeGreaterThanOrEqual(c.weights.travel);
    expect(c.weights.budget + c.weights.travel + c.weights.cuisine).toBeCloseTo(1);
    expect(c.concessionOrder).toEqual(["travel", "cuisine", "budget"]);
    // No order given: the engine's own defaults.
    expect(toLegacyConstraints(emptyMemberState()).weights).toEqual(emptyConstraints().weights);
  });

  it("shows the rule-based reader an unanswered question as unanswered", () => {
    const view = toRulesView(emptyMemberState());
    expect(view).toMatchObject({
      availableSlots: null,
      budgetMax: null,
      budgetNoLimit: false,
      travelNoLimit: false,
      dietaryConfirmed: false,
    });
    const declined = toRulesView(withPrefs({}, { answered: ["time", "budget", "travel", "diet"] }));
    expect(declined).toMatchObject({ budgetNoLimit: true, travelNoLimit: true, dietaryConfirmed: true });
    expect(declined.availableSlots).toEqual([...START_TIMES]);
  });
});

describe("the adapter from the rule-based reader's updates (the safety net)", () => {
  it("stores what the old reader understood in the new format", () => {
    const s = applyLegacyUpdate(emptyMemberState(), {
      availableSlots: ["17:00", "18:00", "19:00", "20:00"],
      budgetMax: 40,
      budgetFlex: 10,
      maxTravelMin: 20,
      dietary: ["vegetarian", "no_seafood", "no_spicy"],
      likedCuisines: ["thai"],
      dislikedCuisines: ["indian"],
    });
    expect(s.prefs).toEqual({
      version: 1,
      time: {
        unavailable: [
          { from: "10:00", to: "16:00" },
          { from: "21:00", to: "23:00" },
        ],
        strength: "mild",
      },
      budget: { ideal: 40, max: 50, strength: "must" },
      travel: { maxMin: 20, strength: "must" },
      dietary: ["vegetarian"],
      cuisine: {
        scores: { thai_restaurant: 1 },
        excluded: [SEAFOOD_TYPE, "indian_restaurant"],
        strength: "mild",
      },
      notes: [{ type: "other", text: NO_SPICY_NOTE }],
    });
    expect(s.chat.answered.sort()).toEqual(["budget", "cuisine", "diet", "time", "travel"]);
  });

  it("round-trips what both formats can say", () => {
    const update = {
      availableSlots: ["12:00" as const, "13:00" as const],
      budgetMax: 35,
      budgetFlex: 5,
      maxTravelMin: 15,
      dietary: ["halal" as const, "no_seafood" as const],
      likedCuisines: ["japanese" as const],
      dislikedCuisines: ["mexican" as const],
      dietaryConfirmed: true,
    };
    const back = toLegacyConstraints(applyLegacyUpdate(emptyMemberState(), update));
    const direct = mergeConstraints(emptyConstraints(), update);
    for (const field of [
      "availableSlots",
      "budgetMax",
      "budgetFlex",
      "maxTravelMin",
      "likedCuisines",
      "dislikedCuisines",
    ] as const)
      expect(back[field], field).toEqual(direct[field]);
    expect(back.dietary.sort()).toEqual(direct.dietary.sort());
  });

  it('keeps "no limit" as an answer with nothing recorded', () => {
    const s = applyLegacyUpdate(emptyMemberState(), { budgetNoLimit: true, travelNoLimit: true });
    expect(s.prefs).toEqual({ version: 1 });
    expect(s.chat.answered.sort()).toEqual(["budget", "travel"]);
  });

  it("keeps a minimum spend as a note, since the new format has no floor", () => {
    const s = applyLegacyUpdate(emptyMemberState(), { budgetMin: 50 });
    expect(s.prefs.budget).toBeUndefined();
    expect(s.prefs.notes).toEqual([{ type: "other", text: "Would rather spend at least $50 a person" }]);
    expect(s.chat.answered).toContain("budget");
  });

  it("leaves alone what the assistant recorded that the old reader cannot speak for", () => {
    const before = withPrefs({
      style: { wanted: ["cafe"], strength: "strong" },
      wantedRestaurants: [{ name: "Ramen Nagi", id: "place-1" }],
      notes: [{ type: "allergy", text: "peanuts" }],
      cuisine: { scores: { hot_pot_restaurant: 1 }, strength: "strong" },
    });
    const after = applyLegacyUpdate(before, { budgetMax: 30, likedCuisines: ["korean"] });
    expect(after.prefs.style).toEqual(before.prefs.style);
    expect(after.prefs.wantedRestaurants).toEqual(before.prefs.wantedRestaurants);
    expect(after.prefs.notes).toEqual(before.prefs.notes);
    expect(after.prefs.cuisine).toEqual({
      scores: { hot_pot_restaurant: 1, korean_restaurant: 1 },
      strength: "strong",
    });
  });

  it("carries the old reader's own bookkeeping, and a start point", () => {
    const start = { label: "Mountain View", lat: 37.39, lng: -122.08 };
    const s = applyLegacyUpdate(emptyMemberState(), {
      pending: "cuisine",
      probesAsked: ["cuisine"],
      startPoint: start,
    });
    expect(s.chat.rules).toEqual({ pending: "cuisine", probesAsked: ["cuisine"] });
    expect(s.startPoint).toEqual(start);
    expect(toRulesView(s)).toMatchObject({ pending: "cuisine", probesAsked: ["cuisine"], startPoint: start });
    // The question was asked and is still waiting: cuisine is not settled yet.
    expect(s.chat.answered).not.toContain("cuisine");
    const answered = applyLegacyUpdate(s, { pending: null });
    expect(answered.chat.answered).toContain("cuisine");
  });

  it("ignores an update that does not fit, rather than breaking the chat", () => {
    const before = withPrefs({ budget: { max: 40, strength: "must" } });
    const bad = { budgetMax: -5 } as never;
    expect(applyLegacyUpdate(before, bad)).toBe(before);
  });
});
