import {
  CUISINES,
  SLOTS,
  type Constraints,
  type ConstraintsUpdate,
  type Cuisine,
  type Dietary,
  type Slot,
  mergeConstraints,
  missingFields,
} from "./constraints";

/**
 * Rule-based extractor (English). Used when no LLM key is configured,
 * and as the fallback if the LLM call fails. Deliberately simple and well-tested.
 */

const NEGATIVE = /\b(busy|not free|can'?t|cannot|unavailable|no time|working)\b/i;
const DISLIKE = /\b(not|don'?t|no|hate|avoid|rather not|tired of)\b/i;

const DAY_PATTERNS: [RegExp, ("fri" | "sat" | "sun")][] = [
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
  for (const d of days) for (const m of ms) {
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

export function extractBudget(text: string): { budgetMax?: number; budgetFlex?: number } {
  // `NOT_TIME` stops "up to 30 minutes" from being read as a $30 budget.
  const NOT_TIME = String.raw`(?!\d|\s*(?:min|hour))`;
  const patterns = [
    new RegExp(String.raw`(?:budget|under|max|less than|below|within|up to|no more than)\s*(?:of|is|:)?\s*\$?\s*(\d{1,4})` + NOT_TIME, "i"),
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

export function extractDietary(text: string): { dietary?: Dietary[]; dietaryConfirmed?: boolean } {
  const found: Dietary[] = [];
  if (/\b(no spicy|not spicy|can'?t (eat|do|handle) spicy|no spice|mild)\b/i.test(text)) found.push("no_spicy");
  if (/\b(vegetarian|vegan|veggie|no meat)\b/i.test(text)) found.push("vegetarian");
  if (/\b(no seafood|seafood allerg\w*|allergic to (seafood|shellfish|fish)|no fish|no shellfish)\b/i.test(text)) found.push("no_seafood");
  if (/\bhalal\b/i.test(text)) found.push("halal");
  if (found.length) return { dietary: found };
  if (/\b(no (dietary )?restrictions?|no allergies|eat anything|anything('s| is)? fine|nothing special)\b/i.test(text)) {
    return { dietaryConfirmed: true };
  }
  return {};
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

export function extractRules(text: string): ConstraintsUpdate {
  const update: ConstraintsUpdate = {};
  const slots = extractTime(text);
  if (slots) update.availableSlots = slots;
  Object.assign(update, extractBudget(text));
  const dist = extractDistance(text);
  if (dist !== undefined) update.maxTravelMin = dist;
  Object.assign(update, extractDietary(text));
  Object.assign(update, extractCuisines(text));
  return update;
}

const QUESTIONS: Record<ReturnType<typeof missingFields>[number], string> = {
  time: "When are you actually free this weekend? (e.g. \"Saturday evening only\", \"busy Sunday\")",
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
