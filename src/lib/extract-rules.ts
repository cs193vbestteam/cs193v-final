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
 * Rule-based extractor (English + Chinese). Used when no LLM key is configured,
 * and as the fallback if the LLM call fails. Deliberately simple and well-tested.
 */

const NEGATIVE = /\b(busy|not free|can'?t|cannot|unavailable|no time|working)\b|有事|没空|不行|不能|忙/i;
const DISLIKE = /\b(not|don'?t|no|hate|avoid|rather not|tired of)\b|不想|不要|不吃|别|讨厌|吃腻/i;

const DAY_PATTERNS: [RegExp, ("fri" | "sat" | "sun")][] = [
  [/\bfri(day)?\b|周五|星期五|礼拜五/i, "fri"],
  [/\bsat(urday)?\b|周六|星期六|礼拜六/i, "sat"],
  [/\bsun(day)?\b|周日|周天|星期日|星期天|礼拜天/i, "sun"],
];
const LUNCH = /\b(lunch|noon|midday|afternoon)\b|中午|午饭|午餐|下午/i;
const DINNER = /\b(dinner|evening|night|tonight)\b|晚上|晚饭|晚餐|傍晚/i;
const WEEKEND = /\bweekend\b|周末/i;
const ANY_TIME = /\b(any ?time|whenever|all weekend|totally free)\b|随时|都有空|都可以的时间/i;

const CUISINE_WORDS: Record<Cuisine, RegExp> = {
  japanese: /\b(japanese|sushi|ramen|izakaya)\b|日料|日本|寿司|拉面/i,
  chinese: /\b(chinese|dim sum|hot ?pot|dumplings?)\b|中餐|中国菜|火锅|川菜|粤菜|饺子|早茶/i,
  korean: /\b(korean|kbbq|bibimbap)\b|韩国|韩餐|烤肉/i,
  thai: /\b(thai)\b|泰国|泰餐/i,
  vietnamese: /\b(vietnamese|pho)\b|越南|河粉/i,
  indian: /\b(indian|curry)\b|印度|咖喱/i,
  mexican: /\b(mexican|tacos?|burritos?)\b|墨西哥/i,
  italian: /\b(italian|pizza|pasta)\b|意大利|披萨|意面/i,
  american: /\b(american|burgers?|bbq)\b|美式|汉堡/i,
  mediterranean: /\b(mediterranean|greek|kebab|falafel|mezze)\b|地中海|希腊|烤串/i,
};

function splitClauses(text: string): string[] {
  return text
    .split(/[,.;!?\n，。；！？]|\bbut\b|但是|不过|而且/i)
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
  const NOT_TIME = String.raw`(?!\d|\s*(?:min|分钟|hour|小时))`;
  const patterns = [
    new RegExp(String.raw`(?:budget|under|max|less than|below|within|up to|no more than)\s*(?:of|is|:)?\s*\$?\s*(\d{1,4})` + NOT_TIME, "i"),
    /\$\s?(\d{1,4})/,
    /(\d{1,4})\s*(?:dollars|bucks|usd|块|元|刀)/i,
    new RegExp(String.raw`(?:预算|人均|不超过|最多)\s*(\d{1,4})` + NOT_TIME),
    /(\d{1,4})\s*(?:以内|以下|之内)/,
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
  if (/\b(stretch|flexible|a bit more|little more|can go over)\b|可以多|稍微超|超一点|弹性/i.test(text)) {
    out.budgetFlex = Math.max(5, Math.round((out.budgetMax ?? 30) * 0.2));
  } else if (/\b(strict|hard limit|firm|tight)\b|严格|不能超|绝对/i.test(text)) {
    out.budgetFlex = 0;
  }
  if (/\b(money('s| is)? no (object|issue)|don'?t care about (price|money|budget))\b|不在乎钱|多少都行|价格无所谓/i.test(text)) {
    out.budgetMax = 200;
  }
  return out;
}

export function extractDistance(text: string): number | undefined {
  const m = text.match(/(\d{1,3})\s*(?:min|mins|minutes|分钟)/i);
  if (m) return parseInt(m[1], 10);
  if (/\b(don'?t care (about )?(distance|how far)|anywhere|far is fine)\b|距离无所谓|远点也行|多远都行/i.test(text)) return 60;
  if (/\b(walking distance|walkable|very close|on campus)\b|走路|步行|学校里/i.test(text)) return 10;
  if (/\b(not too far|nearby|close by|close)\b|别太远|近一点|不要太远|附近/i.test(text)) return 20;
  return undefined;
}

export function extractDietary(text: string): { dietary?: Dietary[]; dietaryConfirmed?: boolean } {
  const found: Dietary[] = [];
  if (/\b(no spicy|not spicy|can'?t (eat|do|handle) spicy|no spice|mild)\b|不吃辣|不能吃辣|吃不了辣|不要辣/i.test(text)) found.push("no_spicy");
  if (/\b(vegetarian|vegan|veggie|no meat)\b|素食|吃素|不吃肉/i.test(text)) found.push("vegetarian");
  if (/\b(no seafood|seafood allerg\w*|allergic to (seafood|shellfish|fish)|no fish|no shellfish)\b|海鲜过敏|不吃海鲜|不能吃海鲜/i.test(text)) found.push("no_seafood");
  if (/\bhalal\b|清真/i.test(text)) found.push("halal");
  if (found.length) return { dietary: found };
  if (/\b(no (dietary )?restrictions?|no allergies|eat anything|anything('s| is)? fine|nothing special)\b|没有忌口|没忌口|都能吃|什么都吃|不挑/i.test(text)) {
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
