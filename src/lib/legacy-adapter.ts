import {
  CUISINES,
  ConstraintsSchema,
  DEFAULT_WEIGHTS,
  SLOTS,
  SOFT_DIMS,
  UPDATE_LIMITS,
  emptyConstraints,
  mergeConstraints,
  type Constraints,
  type ConstraintsUpdate,
  type Cuisine,
  type Dietary,
  type Slot,
  type SoftDim,
} from "./constraints";
import { LEGACY_CUISINE_TYPE, legacyCuisineOf, matchCuisine } from "./cuisine-table";
import { availableTimes, toRanges, type MemberState, type Variable } from "./member-state";
import {
  LIMITS,
  PersonPreferencesSchema,
  START_TIMES,
  priorityWeights,
  type DietaryNeed,
  type PersonPreferences,
  type PriorityDim,
} from "./optimizer-input";

/**
 * TRANSITIONAL. Delete this file together with the negotiation engine it serves
 * (negotiate.ts, mediator.ts, agent.ts, evaluate.ts, preferences.ts) and the rule-based
 * extractor's legacy types when the optimizer reads `PersonPreferences` directly.
 *
 * Two conversions, both lossy on purpose:
 *
 *   toLegacyConstraints   what a person wants → the older `Constraints` the engine reads.
 *                         Strength levels below "must", the kind of place, named restaurants
 *                         and notes have no place in the old format and are left out here.
 *                         They stay stored for the optimizer.
 *   applyLegacyUpdate     an update written by the rule-based extractor (which still speaks
 *                         the old format) → the stored preferences.
 */

/** "No seafood" is a kind of restaurant to leave out, not a diet Google lets us check. */
export const SEAFOOD_TYPE = "seafood_restaurant";
/** What the old "no_spicy" flag becomes: a note, because no restaurant data says how spicy a place is. */
export const NO_SPICY_NOTE = "No spicy food";

const uniq = <T>(xs: readonly T[]) => Array.from(new Set(xs));

/**
 * The stored cuisine block as the old engine's two lists of its ten cuisines (cuisine-table.ts
 * has the mapping). Liked: an old cuisine the person's scores put at 1, or the cuisine of a
 * dish they asked for ("hot pot" is liking Chinese). Disliked: an old cuisine that is itself
 * excluded; ruling out one dish does not rule out its cuisine. A cuisine the old list has
 * nothing for (French) is not passed on: it stays stored for the optimizer.
 */
function legacyCuisines(cuisine: PersonPreferences["cuisine"]): { liked: Cuisine[]; disliked: Cuisine[] } {
  if (!cuisine) return { liked: [], disliked: [] };
  const asked = Object.entries(cuisine.scores ?? {})
    .filter(([, score]) => score === 1)
    .flatMap(([type]) => legacyCuisineOf(type) ?? []);
  const liked = CUISINES.filter(
    (c) => asked.includes(c) || matchCuisine([LEGACY_CUISINE_TYPE[c]], cuisine).score === 1,
  );
  const disliked = CUISINES.filter((c) => {
    const m = matchCuisine([LEGACY_CUISINE_TYPE[c]], cuisine);
    // The older format has one list for both: food ruled out and food they would rather not have.
    return !liked.includes(c) && (m.excluded || m.avoided);
  });
  return { liked, disliked };
}

/**
 * `forRules: false` (the engine): a question nobody answered is no constraint at all.
 * `forRules: true` (the rule-based extractor's view of "what is recorded so far"): an
 * unanswered question stays unanswered, so that extractor knows what it still has to ask.
 */
function legacyView(state: MemberState, forRules: boolean): Constraints {
  const { prefs, chat } = state;
  const settled = (v: Variable) => !forRules || chat.answered.includes(v);
  const c = emptyConstraints();

  if (prefs.time || settled("time")) c.availableSlots = availableTimes(prefs) as Slot[];

  if (prefs.budget) {
    const { ideal, max } = prefs.budget;
    if (max !== undefined) {
      // The old format has a ceiling and a stretch above it: the ideal is the ceiling, the max the stretch.
      c.budgetMax = Math.round(ideal ?? max);
      c.budgetFlex = Math.round(max) - c.budgetMax;
    } else {
      // An ideal with no ceiling: aim for it and allow half as much again.
      c.budgetMax = Math.round(ideal!);
      c.budgetFlex = Math.min(UPDATE_LIMITS.budgetFlex.max, Math.round(ideal! / 2));
    }
    c.budgetMax = Math.max(1, c.budgetMax);
  } else if (settled("budget")) c.budgetNoLimit = true;

  if (prefs.travel) c.maxTravelMin = prefs.travel.maxMin ?? prefs.travel.idealMin ?? null;
  else if (settled("travel")) c.travelNoLimit = true;

  const diet: Dietary[] = [];
  // The old engine has no vegan flag; vegetarian is the nearest thing it can filter on.
  if (prefs.dietary?.some((d) => d === "vegetarian" || d === "vegan")) diet.push("vegetarian");
  if (prefs.dietary?.includes("halal")) diet.push("halal");
  if (prefs.cuisine?.excluded?.includes(SEAFOOD_TYPE)) diet.push("no_seafood");
  c.dietary = diet;
  c.dietaryConfirmed = settled("diet");

  const { liked, disliked } = legacyCuisines(prefs.cuisine);
  c.likedCuisines = liked;
  c.dislikedCuisines = disliked;

  const ranked = (prefs.priority ?? []).filter((d): d is SoftDim => (SOFT_DIMS as readonly string[]).includes(d));
  if (ranked.length) {
    const all = priorityWeights(prefs.priority);
    const total = SOFT_DIMS.reduce((n, d) => n + all[d], 0);
    c.weights = Object.fromEntries(SOFT_DIMS.map((d) => [d, all[d] / total])) as Record<SoftDim, number>;
    // What matters least gives way first.
    c.concessionOrder = [...SOFT_DIMS.filter((d) => !ranked.includes(d)), ...[...ranked].reverse()];
  } else c.weights = { ...DEFAULT_WEIGHTS };

  c.startPoint = state.startPoint;
  if (forRules) {
    c.pending = chat.rules.pending;
    c.probesAsked = chat.rules.probesAsked;
  }
  return ConstraintsSchema.parse(c);
}

/** One person's preferences as the current negotiation engine reads them. */
export function toLegacyConstraints(state: MemberState): Constraints {
  return legacyView(state, false);
}

/** What the rule-based extractor is told has been recorded so far. */
export function toRulesView(state: MemberState): Constraints {
  return legacyView(state, true);
}

const BUDGET_KEYS = ["budgetMax", "budgetFlex", "budgetNoLimit", "budgetMin"] as const;
const touches = (update: ConstraintsUpdate, keys: readonly (keyof ConstraintsUpdate)[]) =>
  keys.some((k) => update[k] !== undefined);

function addNote(prefs: PersonPreferences, type: "allergy" | "other", text: string): PersonPreferences {
  const trimmed = text.trim().slice(0, LIMITS.noteChars);
  const notes = prefs.notes ?? [];
  if (!trimmed || notes.some((n) => n.text.toLowerCase() === trimmed.toLowerCase())) return prefs;
  return { ...prefs, notes: [...notes, { type, text: trimmed }].slice(-LIMITS.notes) };
}

/**
 * Apply an update from the rule-based extractor to the stored state. Only the parts the update
 * is about are rewritten; everything the model path recorded elsewhere is left alone.
 */
export function applyLegacyUpdate(state: MemberState, update: ConstraintsUpdate): MemberState {
  const before = toRulesView(state);
  let after: Constraints;
  try {
    after = mergeConstraints(before, update);
  } catch {
    return state; // an update that does not fit is ignored rather than breaking the chat
  }
  let prefs: PersonPreferences = { ...state.prefs };
  const answered = new Set<Variable>(state.chat.answered);

  if (update.availableSlots !== undefined && after.availableSlots !== null) {
    const blocked = START_TIMES.filter((t) => !after.availableSlots!.includes(t));
    // The old reader only knows "can" and "cannot": what they named is all they can make.
    if (blocked.length === 0 || blocked.length === SLOTS.length) delete prefs.time;
    else prefs.time = { unavailable: toRanges(blocked), strength: "mild" };
    if (blocked.length !== SLOTS.length) answered.add("time");
  }

  if (touches(update, BUDGET_KEYS)) {
    if (after.budgetMax !== null) {
      prefs.budget = after.budgetFlex
        ? { ideal: after.budgetMax, max: after.budgetMax + after.budgetFlex, strength: "must" }
        : { max: after.budgetMax, strength: "must" };
      answered.add("budget");
    } else if (after.budgetNoLimit || after.budgetMin !== null) {
      delete prefs.budget;
      answered.add("budget");
      // The new format has no floor; keep what they said where they can see it.
      if (after.budgetMin !== null)
        prefs = addNote(prefs, "other", `Would rather spend at least $${after.budgetMin} a person`);
    }
  }

  if (touches(update, ["maxTravelMin", "travelNoLimit"])) {
    // The rule reader knows minutes only. How they said they travel, recorded earlier by the
    // model, is kept: without it a walk would be worked out as a drive.
    const mode = prefs.travel?.mode ?? state.travelMode ?? undefined;
    if (after.maxTravelMin !== null)
      prefs.travel = { maxMin: after.maxTravelMin, ...(mode ? { mode } : {}), strength: "must" };
    else delete prefs.travel;
    if (after.maxTravelMin !== null || after.travelNoLimit) answered.add("travel");
  }

  let excluded = prefs.cuisine?.excluded ?? [];
  const scores = { ...(prefs.cuisine?.scores ?? {}) };
  if (touches(update, ["dietary", "dietaryConfirmed", "avoidNotes"])) {
    const needs = new Set<DietaryNeed>(prefs.dietary ?? []);
    if (after.dietary.includes("vegetarian")) needs.add("vegetarian");
    if (after.dietary.includes("halal")) needs.add("halal");
    if (needs.size) prefs.dietary = [...needs];
    if (after.dietary.includes("no_seafood")) excluded = uniq([...excluded, SEAFOOD_TYPE]);
    if (after.dietary.includes("no_spicy")) prefs = addNote(prefs, "other", NO_SPICY_NOTE);
    for (const words of update.avoidNotes ?? []) prefs = addNote(prefs, "other", `Avoids: ${words}`);
    if (after.dietaryConfirmed) answered.add("diet");
  }

  if (touches(update, ["likedCuisines", "dislikedCuisines"])) {
    // Write only what the old reader changed. What the assistant recorded (a dish, a cuisine
    // outside the old ten, the lower scores around a wish) is left as it is.
    const was = legacyCuisines(prefs.cuisine);
    for (const c of was.liked) if (!after.likedCuisines.includes(c)) delete scores[LEGACY_CUISINE_TYPE[c]];
    for (const c of after.likedCuisines) if (!was.liked.includes(c)) scores[LEGACY_CUISINE_TYPE[c]] = 1;
    const taken: string[] = was.disliked
      .filter((c) => !after.dislikedCuisines.includes(c))
      .map((c) => LEGACY_CUISINE_TYPE[c]);
    const added: string[] = after.dislikedCuisines
      .filter((c) => !was.disliked.includes(c))
      .map((c) => LEGACY_CUISINE_TYPE[c]);
    excluded = uniq([...excluded.filter((type) => !taken.includes(type)), ...added]);
    for (const type of excluded) delete scores[type];
  }
  const askedCuisine = after.probesAsked.includes("cuisine") && after.pending !== "cuisine";
  if (after.likedCuisines.length || after.dislikedCuisines.length || askedCuisine) answered.add("cuisine");
  if (Object.keys(scores).length || excluded.length)
    prefs.cuisine = {
      ...(Object.keys(scores).length ? { scores } : {}),
      ...(excluded.length ? { excluded } : {}),
      strength: prefs.cuisine?.strength ?? "mild",
    };
  else delete prefs.cuisine;

  if (update.concessionOrder) {
    // They said what gives way first; what matters most is the other end of that list.
    prefs.priority = [...after.concessionOrder!].reverse() as PriorityDim[];
  } else if (update.weights) {
    const top = [...SOFT_DIMS].sort((a, b) => after.weights[b] - after.weights[a])[0];
    if (after.weights[top] > DEFAULT_WEIGHTS[top])
      prefs.priority = [top, ...(prefs.priority ?? []).filter((d) => d !== top)];
  }

  const checked = PersonPreferencesSchema.safeParse(prefs);
  return {
    ...state,
    prefs: checked.success ? checked.data : state.prefs,
    startPoint: update.startPoint !== undefined || update.startText === null ? after.startPoint : state.startPoint,
    chat: {
      ...state.chat,
      answered: [...answered],
      rules: { pending: after.pending, probesAsked: after.probesAsked },
    },
  };
}
