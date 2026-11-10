import {
  CUISINES,
  SLOTS,
  type Constraints,
  type ConstraintsUpdate,
  type Cuisine,
  DIETARY_LABELS,
  type Dietary,
  type MissingField,
  type Pending,
  type Probe,
  type ProbeContext,
  type Slot,
  type SoftDim,
  mergeConstraints,
  missingFields,
  nextProbe,
} from "./constraints";

/**
 * Rule-based extractor (English). Used when no LLM key is configured,
 * and as the fallback if the LLM call fails. Deliberately simple and well-tested.
 */

const NEGATIVE = /\b(busy|not free|can'?t|cannot|unavailable|no time|working)\b/i;
const DISLIKE = /\b(not|don'?t|no|hate|avoid|rather not|tired of)\b/i;

const DAY_PATTERNS: [RegExp, "fri" | "sat" | "sun"][] = [
  [/\bfri(day)?\b/i, "fri"],
  [/\bsat(urday)?\b/i, "sat"],
  [/\bsun(day)?\b/i, "sun"],
];
const LUNCH = /\b(lunch|noon|midday|afternoon)\b/i;
const DINNER = /\b(dinner|evening|night|tonight)\b/i;
const WEEKEND = /\bweekend\b/i;
const ANY_TIME = /\b(any ?time|whenever|all weekend|totally free)\b/i;

const CUISINE_WORDS: Record<Cuisine, RegExp> = {
  japanese: /\b(japanese|sushi|ramen|izakaya)\b/i,
  chinese: /\b(chinese|dim sum|hot ?pot|dumplings?)\b/i,
  korean: /\b(korean|kbbq|bibimbap)\b/i,
  thai: /\b(thai)\b/i,
  vietnamese: /\b(vietnamese|pho)\b/i,
  indian: /\b(indian|curry)\b/i,
  mexican: /\b(mexican|tacos?|burritos?)\b/i,
  italian: /\b(italian|pizza|pasta)\b/i,
  american: /\b(american|burgers?|bbq)\b/i,
  mediterranean: /\b(mediterranean|greek|kebab|falafel|mezze)\b/i,
};

function splitClauses(text: string): string[] {
  return text
    .split(/[,.;!?\n]|\bbut\b/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

type Day = "fri" | "sat" | "sun";

function mealsIn(text: string): ("lunch" | "dinner")[] {
  return [...(LUNCH.test(text) ? (["lunch"] as const) : []), ...(DINNER.test(text) ? (["dinner"] as const) : [])];
}

function toSlots(days: readonly Day[], meals: ("lunch" | "dinner")[]): Slot[] {
  const ms = meals.length ? meals : (["lunch", "dinner"] as const);
  const out: Slot[] = [];
  for (const d of days)
    for (const m of ms) {
      const s = `${d}_${m}` as Slot;
      if ((SLOTS as readonly string[]).includes(s)) out.push(s);
    }
  return out;
}

/**
 * Pair each day with the meals mentioned right after it, so
 * "sat lunch or sun dinner" -> sat_lunch, sun_dinner (not all four combinations).
 */
function slotsIn(clause: string): Slot[] {
  if (ANY_TIME.test(clause)) return [...SLOTS];
  const hits: { day: Day; index: number; end: number }[] = [];
  for (const [re, day] of DAY_PATTERNS) {
    const g = new RegExp(re.source, "gi");
    for (const m of clause.matchAll(g)) hits.push({ day, index: m.index!, end: m.index! + m[0].length });
  }
  hits.sort((a, b) => a.index - b.index);

  if (hits.length === 0) {
    const meals = mealsIn(clause);
    if (!WEEKEND.test(clause) && meals.length === 0) return [];
    return toSlots(["fri", "sat", "sun"], meals);
  }

  const prefixMeals = mealsIn(clause.slice(0, hits[0].index)); // "lunch on saturday"
  const out: Slot[] = [];
  hits.forEach((h, i) => {
    let meals = mealsIn(clause.slice(h.end, hits[i + 1]?.index ?? clause.length));
    if (i === 0 && meals.length === 0) meals = prefixMeals;
    out.push(...toSlots([h.day], meals));
  });
  return out;
}

export function extractTime(text: string): Slot[] | undefined {
  const available = new Set<Slot>();
  const unavailable = new Set<Slot>();
  for (const clause of splitClauses(text)) {
    const slots = slotsIn(clause);
    if (slots.length === 0) continue;
    const target = NEGATIVE.test(clause) ? unavailable : available;
    slots.forEach((s) => target.add(s));
  }
  if (available.size === 0 && unavailable.size === 0) return undefined;
  const base = available.size ? [...available] : [...SLOTS];
  return base.filter((s) => !unavailable.has(s));
}

/** "$$" style price levels, as on restaurant listings. */
const PRICE_LEVEL: Record<number, number> = { 1: 20, 2: 40, 3: 70, 4: 120 };
const MONEY_CONTEXT = /\$|\b(budget|spend|spending|per person|a head|each|dollars?|bucks|usd|price|pay)\b/i;
const RANGE = /\$?\s*(\d{1,4})\s*(?:-|–|—|to|and|~)\s*\$?\s*(\d{1,4})(?!\d|\s*(?:min|hour))/i;

/**
 * A range "50-100": the low end is what they'd like to spend, the high end the most they'll go to.
 * That is exactly budgetMax + budgetFlex (the stretch that is still OK).
 */
function budgetRange(a: number, b: number): { budgetMax: number; budgetFlex: number } {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return { budgetMax: lo, budgetFlex: hi - lo };
}

export function extractBudget(text: string): { budgetMax?: number; budgetFlex?: number } {
  const range = MONEY_CONTEXT.test(text) ? text.match(RANGE) : null;
  if (range && parseInt(range[1], 10) > 0 && parseInt(range[2], 10) > 0) {
    return budgetRange(parseInt(range[1], 10), parseInt(range[2], 10));
  }
  // `NOT_TIME` stops "up to 30 minutes" from being read as a $30 budget.
  const NOT_TIME = String.raw`(?!\d|\s*(?:min|hour))`;
  const patterns = [
    new RegExp(
      String.raw`(?:budget|under|max|less than|below|within|up to|no more than)\s*(?:of|is|:)?\s*\$?\s*(\d{1,4})` +
        NOT_TIME,
      "i",
    ),
    /\$\s?(\d{1,4})/,
    /(\d{1,4})\s*(?:dollars|bucks|usd)/i,
  ];
  let budgetMax: number | undefined;
  for (const re of patterns) {
    const m = text.match(re);
    if (m) {
      budgetMax = parseInt(m[1], 10);
      break;
    }
  }
  const out: { budgetMax?: number; budgetFlex?: number } = {};
  if (budgetMax !== undefined && budgetMax > 0) out.budgetMax = budgetMax;
  if (/\b(stretch|flexible|a bit more|little more|can go over)\b/i.test(text)) {
    out.budgetFlex = Math.max(5, Math.round((out.budgetMax ?? 30) * 0.2));
  } else if (/\b(strict|hard limit|firm|tight)\b/i.test(text)) {
    out.budgetFlex = 0;
  }
  if (/\b(money('s| is)? no (object|issue)|don'?t care about (price|money|budget))\b/i.test(text)) {
    out.budgetMax = 200;
  }
  return out;
}

export function extractDistance(text: string): number | undefined {
  const m = text.match(/(\d{1,3})\s*(?:min|mins|minutes)/i);
  if (m) return parseInt(m[1], 10);
  if (/\b(don'?t care (about )?(distance|how far)|anywhere|far is fine)\b/i.test(text)) return 60;
  if (/\b(walking distance|walkable|very close|on campus)\b/i.test(text)) return 10;
  if (/\b(not too far|nearby|close by|close)\b/i.test(text)) return 20;
  return undefined;
}

/** Anything from the sea, shellfish included: "clams", "crabs", "anything with shells", "sushi". */
export const SEAFOOD =
  /\b(sea ?food|from the sea|sea creatures?|fish|shell ?fish|shells?|shelled|shrimps?|prawns?|crabs?|lobsters?|clams?|oysters?|mussels?|scallops?|squid|calamari|octop(us|i)|crustaceans?|mollus[ck]s?|anchov(y|ies)|tuna|salmon|sushi|sashimi|crawfish|crayfish)\b/i;
const SPICY = /\b(spicy|spice|spices|hot sauce|chil(i|li|e)s?|heat|jalape[nñ]os?|sriracha)\b/i;
const VEGETARIAN = /\b(vegetarian|vegan|veggie|no meat|plant[- ]based|don'?t eat meat)\b/i;
const HALAL = /\b(halal|no pork|pork)\b/i;
/** "I'm allergic to peanuts", "I can't eat gluten", "I don't eat clams": a restriction in their own words. */
const AVOID_PHRASE =
  /\b(?:allergic to|allerg(?:y|ies) to|intoleran(?:t|ce) to|can'?t (?:eat|have)|cannot (?:eat|have)|won'?t eat|don'?t eat|do not eat|stay away from)\s+([^.;!?\n]{2,80})/i;

/** Restriction flags named in `text`, read as things to avoid. */
function dietFlags(text: string): Dietary[] {
  const found: Dietary[] = [];
  if (SPICY.test(text)) found.push("no_spicy");
  if (VEGETARIAN.test(text)) found.push("vegetarian");
  if (SEAFOOD.test(text)) found.push("no_seafood");
  if (HALAL.test(text)) found.push("halal");
  return found;
}

const note = (text: string) => text.trim().replace(/\s+/g, " ").slice(0, 160);

export function extractDietary(text: string): {
  dietary?: Dietary[];
  dietaryConfirmed?: boolean;
  avoidNotes?: string[];
} {
  const found: Dietary[] = [];
  if (/\b(no spicy|not spicy|can'?t (eat|do|handle) spicy|no spice|mild)\b/i.test(text)) found.push("no_spicy");
  if (/\b(vegetarian|vegan|veggie|no meat)\b/i.test(text)) found.push("vegetarian");
  if (/\b(no seafood|seafood allerg\w*|allergic to (seafood|shellfish|fish)|no fish|no shellfish)\b/i.test(text))
    found.push("no_seafood");
  if (/\bhalal\b/i.test(text)) found.push("halal");
  // "I'm allergic to shrimp", "I don't eat peanuts": map what we can, keep the rest in their words.
  const avoid = text.match(AVOID_PHRASE);
  if (avoid) {
    const flags = Array.from(new Set([...found, ...dietFlags(avoid[1])]));
    return { ...(flags.length ? { dietary: flags } : {}), avoidNotes: [note(avoid[0])], dietaryConfirmed: true };
  }
  if (found.length) return { dietary: found };
  if (
    /\b(no (dietary )?restrictions?|no allergies|eat anything|anything('s| is)? fine|nothing special|not picky|no preferences?|all good|i'?m (easy|good|fine))\b/i.test(
      text,
    )
  ) {
    return { dietaryConfirmed: true };
  }
  return {};
}

/** Words a person types when answering the diet question with a bare list ("spicy, seafood"). */
const DIET_TOKENS: [RegExp, Dietary | "none"][] = [
  [/^(spicy|spice|hot|heat|chili|chilli)$/, "no_spicy"],
  [
    /^(seafood|sea food|fish|shellfish|shrimps?|crabs?|clams?|lobsters?|oysters?|mussels?|scallops?|prawns?)$/,
    "no_seafood",
  ],
  [/^(vegetarian|vegan|veggie|veg)$/, "vegetarian"],
  [/^halal$/, "halal"],
  [/^(nothing|none|no|nope|nah|neither|na|n\/a|zero|nil)$/, "none"],
];
const POSITIVE = /\b(love|like|want|prefer|enjoy|into|fan of|crave|craving)\b/i;

/**
 * A short reply that only makes sense as an answer to the question we just asked.
 * Context-free parsing can't tell "40" (budget) from "40" (minutes), or "spicy"
 * (a restriction) from "spicy" (a craving), so the pending question decides.
 */
export function extractBareAnswer(text: string, pending: MissingField | undefined): ConstraintsUpdate {
  if (!pending) return {};
  const FILLER =
    /^(ok(ay)?|sure|fine|well|hmm+|umm*|uh|yeah|yes|so|let'?s say|i guess|i'?d say|i think|about|around|roughly|maybe|like|say|probably|approx\.?|~)[\s,:-]+/i;
  let bare = text
    .trim()
    .toLowerCase()
    .replace(/[.!?]+$/g, "")
    .trim();
  for (let i = 0; i < 4 && FILLER.test(bare); i++) bare = bare.replace(FILLER, "").trim();
  if (!bare) return {};

  if (pending === "budget") {
    // Any number they give in answer is the budget: "50-100", "50 to 100", "60ish", "100 max", "$$".
    if (/\b(min|mins|minutes?|hours?|hrs?)\b/.test(bare)) return {};
    const level = bare.match(/^(\${1,4})$/);
    if (level) return { budgetMax: PRICE_LEVEL[level[1].length] };
    const numbers = [...bare.matchAll(/\d{1,4}/g)].map((m) => parseInt(m[0], 10)).filter((x) => x > 0);
    if (numbers.length >= 2) return budgetRange(numbers[0], numbers[1]);
    if (numbers.length === 1) return { budgetMax: numbers[0] };
    return {};
  }
  if (pending === "distance") {
    const m = bare.match(/^(\d{1,3})\s*(?:min|mins|minutes|m)?\s*(?:max|tops|away)?$/);
    if (m && parseInt(m[1], 10) > 0) return { maxTravelMin: parseInt(m[1], 10) };
    return {};
  }
  if (pending === "diet") {
    if (POSITIVE.test(bare)) return {};
    // A question back, or "not sure", is not an answer to keep.
    if (/\?\s*$/.test(text) || /^(idk|i don'?t know|not sure|dunno|maybe|hmm+|what|huh)$/.test(bare)) return {};
    const listed = bareDietList(bare);
    if (listed) return listed;
    // A free-text answer to "anything you can't eat?" is an answer: map what we can, keep their words.
    const flags = dietFlags(bare);
    return { ...(flags.length ? { dietary: flags } : {}), avoidNotes: [note(text)], dietaryConfirmed: true };
  }
  return {};
}

/** "spicy, seafood" / "none": a bare list of known words. Undefined if any word is unknown. */
function bareDietList(bare: string): ConstraintsUpdate | undefined {
  const tokens = bare
    .replace(/\b(no|not|and|or|please|pls|thanks|thx|for me|i'?m|i am|just)\b/g, " ")
    .split(/[\s,/&+]+/)
    .filter(Boolean);
  if (tokens.length === 0) {
    // "no" / "none" alone were stripped above; treat the original as the answer.
    return /^(no|nope|nah|none|nothing)$/.test(bare) ? { dietaryConfirmed: true } : undefined;
  }
  const found: Dietary[] = [];
  let none = false;
  for (const t of tokens) {
    const hit = DIET_TOKENS.find(([re]) => re.test(t));
    if (!hit) return undefined; // an unknown word: not a bare list, read it as free text
    if (hit[1] === "none") none = true;
    else found.push(hit[1]);
  }
  if (found.length) return { dietary: Array.from(new Set(found)) };
  if (none) return { dietaryConfirmed: true };
  return undefined;
}

export function extractCuisines(text: string): { likedCuisines?: Cuisine[]; dislikedCuisines?: Cuisine[] } {
  const liked: Cuisine[] = [];
  const disliked: Cuisine[] = [];
  for (const clause of splitClauses(text)) {
    for (const c of CUISINES) {
      if (!CUISINE_WORDS[c].test(clause)) continue;
      (DISLIKE.test(clause) ? disliked : liked).push(c);
    }
  }
  const out: { likedCuisines?: Cuisine[]; dislikedCuisines?: Cuisine[] } = {};
  if (liked.length) out.likedCuisines = liked;
  if (disliked.length) out.dislikedCuisines = disliked;
  return out;
}

const START_PHRASE =
  /\b(?:(?:coming|travell?ing|driving|biking|cycling|walking|leaving|starting|commuting)\s+(?:in\s+)?from|i(?:'ll| will)\s+(?:be\s+)?(?:start|leave|starting|leaving)\s+(?:from|at)|i\s+live\s+(?:in|at|near|on|by)|i(?:'m| am)\s+based\s+(?:in|at|near))\s+([^.,;!?\n]{2,120})/i;

/** Tidy a place as typed: no lead-in words, no trailing clause. Undefined if nothing usable is left. */
function cleanPlace(raw: string): string | undefined {
  const place = raw
    .split(/\s+(?:and|but|so|then|because)\s+/i)[0]
    .replace(/^\s*(?:from|near|around|in|at)\s+/i, "")
    .replace(/[\s.,;!?]+$/, "")
    .trim();
  return place.length >= 2 && place.length <= 120 ? place : undefined;
}

/** "I'm coming from Mountain View" → "Mountain View". Only explicit phrasings, so "20 minutes from campus" is not one. */
export function extractStart(text: string): string | undefined {
  const m = text.match(START_PHRASE);
  return m ? cleanPlace(m[1]) : undefined;
}

const PRIORITY_WORDS: [RegExp, SoftDim][] = [
  [/\b(price|budget|cost|money|cheap|spend(ing)?)\b/i, "budget"],
  [/\b(distance|travel(ling)?|location|close|nearby|commute|how far)\b/i, "travel"],
  [/\b(cuisine|food|taste|menu|what we eat)\b/i, "cuisine"],
];
const PRIORITY =
  /\b(matters? (the )?most|most important|(is|are) (my )?(top |main |biggest )?priority|care (the )?most about|cares? most|is key|is what matters)\b/i;

/**
 * "Price matters most to me": a priority they volunteer replaces the trade-off questions we used to ask.
 * That dimension gets half the weight; the other two share the rest.
 */
export function extractPriority(text: string): { weights?: Record<SoftDim, number> } {
  for (const clause of splitClauses(text)) {
    if (!PRIORITY.test(clause)) continue;
    const dims = PRIORITY_WORDS.filter(([re]) => re.test(clause)).map(([, d]) => d);
    if (dims.length !== 1) continue; // none named, or ambiguous
    const top = dims[0];
    return { weights: { budget: 0.25, travel: 0.25, cuisine: 0.25, [top]: 0.5 } };
  }
  return {};
}

export function extractRules(text: string, pending?: MissingField): ConstraintsUpdate {
  const update: ConstraintsUpdate = {};
  const start = extractStart(text);
  if (start) update.startText = start;
  const slots = extractTime(text);
  if (slots) update.availableSlots = slots;
  Object.assign(update, extractBudget(text));
  const dist = extractDistance(text);
  if (dist !== undefined) update.maxTravelMin = dist;
  Object.assign(update, extractDietary(text));
  Object.assign(update, extractCuisines(text));
  Object.assign(update, extractPriority(text));
  if (Object.keys(update).length === 0) Object.assign(update, extractBareAnswer(text, pending));
  return update;
}

const QUESTIONS: Record<ReturnType<typeof missingFields>[number], string> = {
  time: 'When are you actually free this weekend? (e.g. "Saturday evening only", "busy Sunday")',
  budget: "What's the most you'd want to spend per person? Nobody else will see the number.",
  distance: "How far are you willing to travel, roughly in minutes?",
  diet: "Anything you can't or won't eat? (spicy, vegetarian, seafood, halal... or \"nothing\")",
};

/** The assistant's reply for the rule-based path: confirm what changed, then ask about the next gap. */
export function ruleReply(before: Constraints, update: ConstraintsUpdate): string {
  const after = mergeConstraints(before, update);
  const gotSomething = Object.keys(update).length > 0;
  const missing = missingFields(after);
  const ack = gotSomething ? "Got it, noted privately." : "Sorry, I didn't catch anything specific there.";
  if (missing.length === 0) {
    return `${ack} I have everything I need. Anything else you care about, like cuisines you love or want to avoid? Otherwise hit "I'm done".`;
  }
  return `${ack} ${QUESTIONS[missing[0]]}`;
}

export const OPENING_MESSAGE =
  "Hi! I'm your private assistant for this plan. Only you can see this chat, and I'll never share your numbers with the group. I'll only ever answer \"works / a stretch / doesn't work\" on your behalf. " +
  QUESTIONS.time;

/* ── Follow-up questions ────────────────────────────────────────────────
   "Whatever" is not an answer. A vague reply to a numeric question becomes an
   either/or; once the essentials are in, one last question sets the concession
   order. Weights start at the defaults and move only when the person volunteers
   a priority ("price matters most"). The trade-off questions are no longer asked
   (#48) but are still understood if a chat saved before that is waiting on one. */

const VAGUE =
  /\b(whatever|anything|any|don'?t (really )?(care|mind)|no (real )?(limit|preference)|idk|dunno|not sure|up to you|flexible|depends|easy|随便|都行|无所谓)\b/i;

export const PENDING_QUESTIONS: Record<Pending, string> = {
  start_point:
    'One optional thing: roughly where will you be coming from? A neighbourhood or cross street is enough. Only I use it, to measure your own trip, and it is never shown to the group. Say "skip" to measure from the plan\'s location instead.',
  vague_budget:
    'Fair enough, but "whatever" is how groups end up somewhere nobody wanted. Which would bother you more: paying about $45 a head, or $25 a head somewhere less exciting?',
  vague_distance: "No problem. Which would bother you more: 30 minutes of travel, or a so-so place 5 minutes away?",
  tradeoff_budget_travel:
    "Two quick trade-offs so I negotiate the way you would. Which is worse: paying $10 over your budget, or travelling 10 minutes further than you'd like?",
  tradeoff_cuisine_travel: "And which is worse: a cuisine you're lukewarm on, or an extra 10 minutes of travel?",
  concession:
    "Last one. If something has to give, what goes first: the cuisine, the distance, or the budget? List them in order if you like.",
};

const FIRST = /\b(first|former|a|1|one|the first one)\b/i;
const SECOND = /\b(second|latter|b|2|two|the second one)\b/i;
const NEITHER = /\b(neither|both fine|either|same|no difference|don'?t care)\b/i;

/** The two options each either/or offers, so an answer that echoes one (typos included) is understood. */
const OPTIONS: Record<Exclude<Pending, "concession" | "start_point">, [string, string]> = {
  vague_budget: ["paying about $45 a head", "$25 a head somewhere less exciting"],
  vague_distance: ["30 minutes of travel", "a so-so place 5 minutes away"],
  tradeoff_budget_travel: ["paying $10 over your budget", "travelling 10 minutes further than you'd like"],
  tradeoff_cuisine_travel: ["a cuisine you're lukewarm on", "an extra 10 minutes of travel"],
};
const STOP = new Set([
  "a",
  "an",
  "the",
  "of",
  "on",
  "or",
  "you",
  "your",
  "you're",
  "youre",
  "than",
  "you'd",
  "youd",
  "like",
  "is",
  "it",
  "to",
  "and",
  "that",
  "one",
  "i",
  "me",
  "my",
  "d",
  "s",
]);

const tokens = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter((t) => t && !STOP.has(t));

/** Levenshtein distance, capped: we only care whether two words are within one typo of each other. */
function closeEnough(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length < 4 || b.length < 4 || Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else {
      i++;
      j++;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

/** Which option the answer echoes more, by word overlap with one typo allowed. Ties and empties are null. */
function pickByEcho(answer: string, [optA, optB]: [string, string]): "a" | "b" | null {
  const ans = tokens(answer);
  if (ans.length === 0) return null;
  const score = (opt: string) => {
    const words = tokens(opt);
    return ans.filter((t) => words.some((w) => closeEnough(t, w))).length;
  };
  // Words both options share (e.g. "10") carry no information.
  const shared = new Set(tokens(optA).filter((w) => tokens(optB).some((x) => closeEnough(w, x))));
  const distinct = (opt: string) =>
    tokens(opt)
      .filter((w) => !shared.has(w))
      .join(" ");
  const a = score(distinct(optA));
  const b = score(distinct(optB));
  if (a === b) return null;
  return a > b ? "a" : "b";
}

const round2 = (x: number) => Math.round(x * 100) / 100;
function bump(weights: Record<SoftDim, number>, up: SoftDim, down: SoftDim): Record<SoftDim, number> {
  return {
    ...weights,
    [up]: round2(Math.min(0.7, weights[up] + 0.15)),
    [down]: round2(Math.max(0.1, weights[down] - 0.1)),
  };
}

const SKIP_START =
  /^\W*(skip|pass|no|nope|nah|none|rather not|i'?d rather not|prefer not( to( say)?)?|not saying|n\/?a)\W*$/i;
/** Fields a place name can set by accident ("Koreatown", "Little Italy") without meaning it is not a place. */
const START_COMPATIBLE = new Set(["startText", "likedCuisines", "dislikedCuisines"]);

/** Read the answer to a pending question. Returns null if the message doesn't answer it. */
export function answerPending(
  text: string,
  pending: Pending,
  weights: Record<SoftDim, number>,
): ConstraintsUpdate | null {
  const t = text.toLowerCase();
  const pick = (aRe: RegExp, bRe: RegExp): "a" | "b" | "neither" | null => {
    if (NEITHER.test(t)) return "neither";
    const a = aRe.test(t) || FIRST.test(t);
    const b = bRe.test(t) || SECOND.test(t);
    if (a && !b) return "a";
    if (b && !a) return "b";
    // Keywords were ambiguous or absent (typos, paraphrase): compare against the two options as offered.
    return pending === "concession" || pending === "start_point" ? null : pickByEcho(text, OPTIONS[pending]);
  };
  switch (pending) {
    case "start_point": {
      if (SKIP_START.test(t)) return { pending: null };
      // A message that states another constraint is not a place: read it normally and ask again.
      const other = Object.keys(extractRules(text)).filter((k) => !START_COMPATIBLE.has(k));
      if (other.length) return null;
      const place = extractStart(text) ?? cleanPlace(text);
      return place ? { startText: place, pending: null } : null;
    }
    case "vague_budget": {
      const ans = pick(/\b(45|pay(ing)?|expensive|pricey|money|cost)\b/, /\b(25|less exciting|boring|cheap|so-?so)\b/);
      if (ans === "a") return { budgetMax: 30, budgetFlex: 10, pending: null };
      if (ans === "b" || ans === "neither") return { budgetMax: 60, budgetFlex: 15, pending: null };
      return null;
    }
    case "vague_distance": {
      const ans = pick(/\b(30|travel(ling)?|far|drive|driving|commute)\b/, /\b(5|so-?so|close|nearby|boring)\b/);
      if (ans === "a") return { maxTravelMin: 15, pending: null };
      if (ans === "b" || ans === "neither") return { maxTravelMin: 40, pending: null };
      return null;
    }
    case "tradeoff_budget_travel": {
      const ans = pick(
        /\b(pay(ing)?|over|budget|money|price|cost|\$)\b/,
        /\b(travel(ling)?|further|farther|distance|drive|driving|minutes?)\b/,
      );
      if (ans === null) return null;
      const w =
        ans === "a" ? bump(weights, "budget", "travel") : ans === "b" ? bump(weights, "travel", "budget") : weights;
      return { weights: w, pending: null };
    }
    case "tradeoff_cuisine_travel": {
      const ans = pick(
        /\b(cuisine|food|lukewarm|menu|eat)\b/,
        /\b(travel(ling)?|further|farther|distance|drive|driving|minutes?)\b/,
      );
      if (ans === null) return null;
      const w =
        ans === "a" ? bump(weights, "cuisine", "travel") : ans === "b" ? bump(weights, "travel", "cuisine") : weights;
      return { weights: w, pending: null };
    }
    case "concession": {
      const hits: { dim: SoftDim; at: number }[] = [];
      const find = (re: RegExp, dim: SoftDim) => {
        const m = t.match(re);
        if (m && m.index !== undefined) hits.push({ dim, at: m.index });
      };
      find(/\b(cuisine|food|type of food|menu)\b/, "cuisine");
      find(/\b(distance|travel|far|drive|driving|location)\b/, "travel");
      find(/\b(budget|price|money|cost|spend)\b/, "budget");
      if (hits.length === 0)
        return /^\W*(neither|none|nothing|no|nope|nah|not sure|idk)\W*$/.test(t) ? { pending: null } : null;
      hits.sort((x, y) => x.at - y.at);
      return { concessionOrder: hits.map((h) => h.dim), pending: null };
    }
  }
}

export type RuleTurn = { update: ConstraintsUpdate; reply: string };

/** Be honest about what a restriction in their own words can and can't do. */
function avoidAck(update: ConstraintsUpdate): string {
  const flags = update.dietary ?? [];
  if (flags.length) {
    const what = flags.map((d) => DIETARY_LABELS[d].toLowerCase()).join(", ");
    return `Got it, noted privately: I'll only say yes to places that suit "${what}".`;
  }
  return "Noted privately. I can only check restaurants for spicy, vegetarian, seafood and halal, so I'll keep that in mind but can't promise every menu avoids it.";
}

/** One assistant turn on the rule-based path: read the message in context, decide what to ask next. */
export function ruleTurn(text: string, current: Constraints, context: ProbeContext = {}): RuleTurn {
  let update: ConstraintsUpdate | null = current.pending ? answerPending(text, current.pending, current.weights) : null;
  let answeredProbe = update !== null;
  if (!update) {
    const missing = missingFields(current);
    update = extractRules(text, missing[0]);
    const gotNumeric = (f: MissingField) =>
      f === "budget" ? update!.budgetMax !== undefined : update!.maxTravelMin !== undefined;
    if (
      Object.keys(update).length === 0 &&
      (missing[0] === "budget" || missing[0] === "distance") &&
      VAGUE.test(text)
    ) {
      update = { pending: missing[0] === "budget" ? "vague_budget" : "vague_distance" };
    } else if (
      current.pending?.startsWith("vague_") &&
      gotNumeric(current.pending === "vague_budget" ? "budget" : "distance")
    ) {
      // They gave a real number after all: the either/or is moot. A pending probe, by contrast, is asked again.
      update.pending = null;
    }
    answeredProbe = false;
  }

  const after = mergeConstraints(current, update);
  const gotSomething = Object.keys(update).some((k) => k !== "pending" && k !== "probesAsked");
  const ack = answeredProbe
    ? "Noted."
    : update.avoidNotes?.length
      ? avoidAck(update)
      : gotSomething
        ? "Got it, noted privately."
        : "Sorry, I didn't catch anything specific there.";

  if (after.pending && after.pending.startsWith("vague_"))
    return { update, reply: `${PENDING_QUESTIONS[after.pending]}` };
  const missing = missingFields(after);
  if (missing.length) return { update, reply: `${ack} ${QUESTIONS[missing[0]]}` };
  if (after.pending) return { update, reply: `${ack} ${PENDING_QUESTIONS[after.pending]}` };

  const probe: Probe | null = nextProbe(after, context);
  if (probe) {
    update = { ...update, pending: probe, probesAsked: [probe] };
    return { update, reply: `${ack} ${PENDING_QUESTIONS[probe]}` };
  }
  return {
    update,
    reply: `${ack} That's everything I need. Anything else you care about, like cuisines you love or want to avoid? Otherwise hit "I'm done".`,
  };
}
