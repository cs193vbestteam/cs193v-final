import { z } from "zod";
import { RUBRIC, TOOL, stateBlock, type PlanContext } from "./assistant-prompt";
import { MAX_OUTPUT_TOKENS, MAX_REPLY_CHARS } from "./chat-limits";
import { missingFields, type Pending, type MissingField } from "./constraints";
import {
  compactExcluded,
  compactScores,
  describeMatch,
  NEAR_SCORE,
  avoidedFor,
  excludedFor,
  findCuisine,
  leaningOf,
  findStyle,
  lowerBroadWish,
  matchCuisine,
  mergeScores,
  parentCuisine,
  scoresFor,
  type CuisineMatch,
} from "./cuisine-table";
import { enforceLimits, type ChatTurn } from "./extract";
import { ruleTurn } from "./extract-rules";
import { applyLegacyUpdate, toRulesView } from "./legacy-adapter";
import {
  MAX_ASSISTANT_TURNS,
  VARIABLES,
  allowedToAsk,
  missingRequired,
  preferencesChanged,
  timesIn,
  toRanges,
  type MemberState,
  type Variable,
  FEATURE_PHRASES,
} from "./member-state";
import {
  DIETARY_NEEDS,
  LIMITS,
  MEALS,
  PRIORITY_DIMS,
  PersonPreferencesSchema,
  START_TIMES,
  STRENGTHS,
  STYLES,
  mealStartTimes,
  type NamedRestaurant,
  type DietaryNeed,
  type PersonPreferences,
  type StartTime,
  type Strength,
  type Style,
  FEATURES,
  type Feature,
} from "./optimizer-input";
import type { Restaurant } from "./restaurants";
import { cleanPlaceName } from "./places";
import { TRAVEL_MODES } from "./geo";
import { canLocate, resolveStart } from "./start-point";
import { recordUsage, type Usage } from "./spend-context";

/**
 * One turn of the private chat (#83).
 *
 * With a key and budget for it, Claude reads the message and returns a tool call
 * (assistant-prompt.ts). Everything it returns is checked and expanded here before anything
 * is stored: meal words become start times, restaurant names are matched against this plan's
 * candidates, each block is validated on its own, and the conversation's bookkeeping (what
 * may be asked, how many replies are left) is updated by code.
 *
 * Without a key, when the call fails, or when the plan's daily model budget is spent, the
 * rule-based reader (extract-rules.ts) takes the turn. It is a safety net, not a second
 * assistant: it understands times, budgets, distances and a few diets, and none of the newer
 * things (strength, notes, named places). Its output goes through legacy-adapter.ts.
 */

export type AssistantTurn = {
  reply: string;
  state: MemberState;
  /** Whether what the person wants changed, as opposed to only the chat's bookkeeping. */
  changed: boolean;
  source: "llm" | "rules";
  /** The message was not about this plan: nothing was recorded and the reply is the fixed redirect. */
  offTopic?: true;
};

// ---------------------------------------------------------------------------------------
// What the model may send. Each block is parsed on its own, so one bad block never costs
// the person the rest of what they said.
// ---------------------------------------------------------------------------------------

const Clock = z.string().regex(/^\d{1,2}:\d{2}$/);
const TimeSpec = z
  .object({ meal: z.enum(MEALS).optional(), from: Clock.optional(), to: Clock.optional() })
  .refine((s) => s.meal !== undefined || s.from !== undefined || s.to !== undefined);
type TimeSpec = z.infer<typeof TimeSpec>;
const StrengthIn = z.enum(STRENGTHS).optional();
const Names = z.array(z.string().trim().min(1).max(LIMITS.nameChars));

const BLOCKS = {
  time: z.object({
    only: z.array(TimeSpec).optional(),
    unavailable: z.array(TimeSpec).optional(),
    preferred: z.array(TimeSpec).optional(),
    strength: StrengthIn,
  }),
  budget: z.object({ ideal: z.number().optional(), max: z.number().optional(), strength: StrengthIn }),
  travel: z.object({
    idealMin: z.number().optional(),
    maxMin: z.number().optional(),
    // How they get there. An unknown word is dropped rather than failing the whole block.
    mode: z.enum(TRAVEL_MODES).optional().catch(undefined),
    // The model often files the start under travel, where it belongs in its head. Taken from
    // either place: dropped here, the reply would say "measuring from the Quad" and nothing would be.
    startText: z.string().trim().min(2).max(120).optional().catch(undefined),
    strength: StrengthIn,
  }),
  startText: z.string().trim().min(2).max(120),
  dietary: z.array(z.enum(DIETARY_NEEDS)),
  nothingTheyCannotEat: z.boolean(),
  saidWhatTheyCannotEat: z.boolean(),
  cuisine: z.object({
    liked: z.array(z.string()).optional(),
    excluded: z.array(z.string()).optional(),
    // Food they would rather not have but would go along with: a wish, not a rule.
    avoided: z.array(z.string()).optional(),
    // For a wish about what the food is like ("comfort food"): the ordinary kinds of food the
    // model thinks come closest. Code keeps only the ones the table knows (see `suggested`).
    closest: z
      .array(z.object({ wish: z.string(), like: z.array(z.string()).max(6) }))
      .max(4)
      .optional(),
    strength: StrengthIn,
  }),
  // Words, like cuisine: code looks them up (cuisine-table.ts), the model does not classify them.
  style: z.object({
    wanted: z.array(z.string()).optional(),
    excluded: z.array(z.string()).optional(),
    strength: StrengthIn,
  }),
  // A closed list, so the model sorts what was said into it directly; anything else fails the
  // check and is dropped like any other bad block.
  features: z.object({
    needed: z.array(z.enum(FEATURES)).optional(),
    wanted: z.array(z.enum(FEATURES)).optional(),
    strength: StrengthIn,
  }),
  priority: z.array(z.enum(PRIORITY_DIMS)),
  wantedRestaurants: Names,
  excludedRestaurants: Names,
  notes: z.array(
    z.object({ type: z.enum(["allergy", "other"]), text: z.string().trim().min(1).max(LIMITS.noteChars) }),
  ),
} as const;
type BlockName = keyof typeof BLOCKS;
type Blocks = { [K in BlockName]?: z.infer<(typeof BLOCKS)[K]> };

function unwrapJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

const ToolOutput = z.object({
  reply: z.string().trim().min(1),
  // Required: an answer that does not say whether the message was about the plan is not used
  // at all, and the rule-based reader, which cannot run tasks, takes the turn.
  onTopic: z.boolean(),
  asks: z.string().optional(),
  // The same slip as `update` below: a list sent as a string, or one name sent bare.
  dontMind: z
    .preprocess((v) => {
      const x = unwrapJson(v);
      return typeof x === "string" ? [x] : x;
    }, z.array(z.string()))
    .optional(),
  // Now and then the model sends the whole update as a JSON string instead of an object.
  // That is the same answer in a different wrapper, so it is unwrapped, not thrown away.
  // An empty string (or "none") is the model saying there is nothing to record, which happens
  // on a question or an off-topic message: that is an empty update. Any other text still fails.
  update: z
    .preprocess(
      (raw) => {
        const value = unwrapJson(raw);
        return typeof value === "string" && /^\s*(?:none|null|nothing)?\s*$/i.test(value) ? {} : value;
      },
      z.record(z.string(), z.unknown()),
    )
    .optional(),
});
export type AssistantOutput = z.infer<typeof ToolOutput>;

/**
 * What the model recorded but put beside `update` instead of inside it ({reply, budget: …}).
 * Without this the turn would look fine and save nothing: the reply says "got it" and the
 * record stays empty. A block inside `update` wins over the same block outside it.
 */
export function liftMisplaced(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const raw = input as Record<string, unknown>;
  const stray = Object.keys(BLOCKS).filter((name) => name in raw);
  if (stray.length === 0) return input;
  const inside = unwrapJson(raw.update);
  const update =
    inside && typeof inside === "object" && !Array.isArray(inside) ? (inside as Record<string, unknown>) : {};
  return { ...raw, update: { ...Object.fromEntries(stray.map((name) => [name, raw[name]])), ...update } };
}

const uniq = <T>(xs: readonly T[]) => Array.from(new Set(xs));
const isVariable = (x: unknown): x is Variable => (VARIABLES as readonly unknown[]).includes(x);

// ---------------------------------------------------------------------------------------
// Expanding what the model sent
// ---------------------------------------------------------------------------------------

const padClock = (t: string) => t.padStart(5, "0");

/** The start times a meal word or clock range covers. Meal hours come from the table in code. */
export function expandTimes(specs: readonly TimeSpec[]): StartTime[] {
  const covered = new Set<StartTime>();
  for (const spec of specs) {
    const base: readonly StartTime[] = spec.meal ? mealStartTimes(spec.meal) : START_TIMES;
    for (const t of base)
      if ((!spec.from || t >= padClock(spec.from)) && (!spec.to || t <= padClock(spec.to))) covered.add(t);
  }
  return START_TIMES.filter((t) => covered.has(t));
}

/** The stored time block after a time update, null for "any time", or "invalid" if no time would be left. */
function timeBlock(
  existing: PersonPreferences["time"],
  given: NonNullable<Blocks["time"]>,
): PersonPreferences["time"] | null | "invalid" {
  let { only, preferred } = given;
  let strength: Strength = given.strength ?? existing?.strength ?? "mild";
  // "It has to be dinner" sent as a preference with strength must is a limit: treat it as one.
  if (strength === "must") {
    if (preferred && !only) [only, preferred] = [preferred, undefined];
    strength = "mild";
  }
  // "Only dinner" replaces what was there. Otherwise times they cannot make add up over the
  // conversation ("not lunch", then "not brunch" either), and a time they now say they would
  // like is taken back off the list ("actually lunch works").
  const blocked = new Set<StartTime>(only ? [] : timesIn(existing?.unavailable));
  if (!only && preferred) for (const t of expandTimes(preferred)) blocked.delete(t);
  // What this same message rules out wins over what it would like.
  for (const t of expandTimes(given.unavailable ?? [])) blocked.add(t);
  if (only) {
    const possible = expandTimes(only);
    for (const t of START_TIMES) if (!possible.includes(t)) blocked.add(t);
  }
  if (blocked.size === START_TIMES.length) return "invalid";
  const wanted = (preferred ? expandTimes(preferred) : timesIn(existing?.preferred)).filter((t) => !blocked.has(t));
  if (blocked.size === 0 && wanted.length === 0) return null;
  return {
    ...(blocked.size ? { unavailable: toRanges([...blocked]) } : {}),
    ...(wanted.length ? { preferred: toRanges(wanted) } : {}),
    strength,
  };
}

const DIET_WORDS: Record<string, DietaryNeed> = {
  vegetarian: "vegetarian",
  veggie: "vegetarian",
  素食: "vegetarian",
  吃素: "vegetarian",
  vegan: "vegan",
  纯素: "vegan",
  halal: "halal",
  清真: "halal",
};
/** A diet said as if it were a cuisine ("vegetarian food"): it belongs in `dietary`, where it filters. */
function dietWord(word: string): DietaryNeed | null {
  const w = word
    .trim()
    .toLowerCase()
    .replace(/\s*(food|cuisine|restaurants?|places?|菜|餐)$/, "");
  return DIET_WORDS[w] ?? null;
}

/** The words the model passed on for food and kind of place, as code understands them. */
type FoodWords = {
  liked: CuisineMatch[];
  excluded: CuisineMatch[];
  /** Food they would rather not have: lowers a place's score, never rules it out. */
  avoided: CuisineMatch[];
  styleWanted: Style[];
  styleExcluded: Style[];
  dietary: DietaryNeed[];
  /** Words the table does not have, with whether they were wanted. Kept as notes, never as scores. */
  unknown: { word: string; wanted: boolean }[];
  /**
   * A wish the table does not have, with the kinds of food the model said come closest, as far
   * as the table knows them. They count for less than food the person named (NEAR_SCORE).
   */
  suggested: { word: string; like: CuisineMatch[] }[];
};

/**
 * Look up every food and kind-of-place word in the table (cuisine-table.ts). The model only
 * passes on what the person said; what "Asian" covers, and whether "fast food" is a cuisine or
 * a kind of place, is decided here. A word filed under the wrong heading still lands in the
 * right one.
 */
function readFoodWords(cuisine: Blocks["cuisine"], style: Blocks["style"]): FoodWords {
  const out: FoodWords = {
    liked: [],
    excluded: [],
    avoided: [],
    styleWanted: [],
    styleExcluded: [],
    dietary: [],
    unknown: [],
    suggested: [],
  };
  const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
  // What the model offers as closest to a wish is only ever looked up: a name the table does not
  // have is dropped, so the model cannot add a kind of food of its own. Only plain cuisines and
  // dishes count; another broad word or leaning would say nothing.
  const closestTo = (word: string): CuisineMatch[] => {
    const entry = (cuisine?.closest ?? []).find((c) => same(c.wish, word));
    const found = (entry?.like ?? []).flatMap((name) => {
      const m = findCuisine(name);
      return m && (m.level === "cuisine" || m.level === "dish") ? [m] : [];
    });
    return found.filter((m, i) => found.findIndex((x) => x.id === m.id) === i).slice(0, MAX_SUGGESTED);
  };
  // "Somewhere fancy", "a café": the word that matters is the last part.
  const bare = (w: string) => w.replace(/^(?:somewhere|some ?place|a place that is|an?|the|any)\s+/i, "");
  const asStyle = (w: string): Style | null =>
    (STYLES as readonly string[]).includes(w.toLowerCase())
      ? (w.toLowerCase() as Style)
      : (findStyle(w) ?? findStyle(bare(w)));
  const read = (words: readonly string[] | undefined, wanted: boolean, styleFirst: boolean) => {
    for (const raw of words ?? []) {
      const word = raw.trim();
      if (!word) continue;
      const food = findCuisine(word) ?? findCuisine(bare(word));
      const kind = asStyle(word);
      if (kind && (styleFirst || !food)) (wanted ? out.styleWanted : out.styleExcluded).push(kind);
      // "No spicy food" must not rule out every Thai, Indian, Korean and Mexican place: ruling
      // out is a hard rule, and a leaning is only a guess at where such food is found. It is
      // avoided instead, which costs those places points and keeps the person in.
      else if (food && !wanted && leaningOf(food)) out.avoided.push(food);
      else if (food) (wanted ? out.liked : out.excluded).push(food);
      else if (wanted && dietWord(word)) out.dietary.push(dietWord(word)!);
      else if (wanted && closestTo(word).length) out.suggested.push({ word, like: closestTo(word) });
      else out.unknown.push({ word, wanted });
    }
  };
  // A wish given only under `closest` is still a wish.
  const extra = (cuisine?.closest ?? [])
    .map((c) => c.wish)
    .filter((w) => !(cuisine?.liked ?? []).some((l) => same(l, w)));
  read([...(cuisine?.liked ?? []), ...extra], true, false);
  read(cuisine?.excluded, false, false);
  for (const raw of cuisine?.avoided ?? []) {
    const word = raw.trim();
    if (!word) continue;
    const food = findCuisine(word) ?? findCuisine(bare(word));
    if (food) out.avoided.push(food);
    else out.unknown.push({ word, wanted: false });
  }
  read(style?.wanted, true, true);
  read(style?.excluded, false, true);
  return out;
}

const isBroad = (m: CuisineMatch) => m.level === "group" || m.level === "region" || m.level === "leaning";

/** The most kinds of food kept for one wish the table does not have. */
const MAX_SUGGESTED = 5;

const plain = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/**
 * The candidate a typed restaurant name refers to: the same name, or failing that the one
 * candidate whose name contains it (or is contained in it). Ambiguous or unknown is null.
 * The model never supplies an id.
 */
export function matchRestaurant(name: string, pool: readonly Pick<Restaurant, "id" | "name">[]): string | null {
  const q = plain(name);
  if (!q) return null;
  const exact = pool.find((r) => plain(r.name) === q);
  if (exact) return exact.id;
  if (q.length < 3) return null;
  const partial = pool.filter((r) => {
    const n = plain(r.name);
    return n.length >= 3 && (n.includes(q) || q.includes(n));
  });
  return partial.length === 1 ? partial[0].id : null;
}

const keyOf = (r: NamedRestaurant) => r.id ?? `name:${r.name.toLowerCase()}`;
const without = (list: readonly NamedRestaurant[] | undefined, keys: Set<string>) =>
  (list ?? []).filter((r) => !keys.has(keyOf(r)));

const BARE_NUMBER = /^\W*\$?\s*(\d{1,4})\s*(dollars?|bucks|usd|min|mins|minutes?|m)?\W*$/i;

/**
 * A bare number can only answer the numeric question that was asked. If the model filed "20"
 * under the budget after the travel question (it has), put it where it belongs.
 */
function fileBareNumber(latest: string, lastAsked: Variable | null, blocks: Blocks): Blocks {
  const m = latest.match(BARE_NUMBER);
  if (!m || (lastAsked !== "budget" && lastAsked !== "travel")) return blocks;
  const n = Number(m[1]);
  const { budget, travel, ...rest } = blocks;
  if (lastAsked === "travel") return travel && !budget ? blocks : { ...rest, travel: { maxMin: n } };
  return budget && !travel ? blocks : { ...rest, budget: { max: n } };
}

/** The number in a message that is nothing but a number with no unit, unless a question about one was asked. */
function unclearNumber(latest: string, lastAsked: Variable | null): number | null {
  const m = latest.match(BARE_NUMBER);
  if (!m || m[2] || latest.includes("$")) return null;
  if (lastAsked === "budget" || lastAsked === "travel") return null;
  return Number(m[1]);
}

/** What the person is asked when their number could be either. */
export const whichNumber = (n: number) => `Is that ${n} minutes of travel, or $${n} a person?`;

// ---------------------------------------------------------------------------------------
// Applying a model turn
// ---------------------------------------------------------------------------------------

const QUESTION_END = /[?？]\s*["')\]]*$/;
// Chinese and Japanese sentences are not separated by spaces.
const SENTENCE_BREAK = /(?<=[.!?])\s+|(?<=[。！？])\s*/;

/** A reply with its questions taken out, for when the assistant has none left to ask. */
export function withoutQuestions(reply: string): string {
  const kept = reply.split(SENTENCE_BREAK).filter((sentence) => sentence.trim() && !QUESTION_END.test(sentence.trim()));
  return kept.join(" ").trim() || "Got it.";
}

const REQUIRED_WORDS: Record<MissingField, string> = {
  time: "what time works for you",
  diet: "whether there is anything you can't eat",
  budget: "your budget",
  distance: "how far you'd travel",
};

function closingLine(state: MemberState): string {
  const missing = missingRequired(state);
  return missing.length
    ? `Before you can finish I still need to know ${missing.map((m) => REQUIRED_WORDS[m]).join(" and ")}: just tell me.`
    : "You can add anything else, or press \"I'm done\" when you're finished.";
}

/** Words that show a question is about a variable, in the two languages the code can tell apart. */
const TOPIC_WORDS: Record<Variable, RegExp> = {
  time: /\b(what time|when|which day|lunch or dinner|available)\b|几点|什么时候|时间/i,
  budget: /\b(budget|spend|price|per person)\b|预算|人均|价位/i,
  travel: /\b(travel|far|distance|drive|walk|minutes away|commute)\b|多远|路程|距离|车程/i,
  diet: /\b(can(?:'|’)?t eat|cannot eat|allerg\w*|dietary|diet|avoid)\b|忌口|过敏|不能吃/i,
  cuisine: /\b(cuisine|kind of food|type of food|craving|in the mood for)\b|菜系|想吃什么|口味/i,
};

/** The variables a reply's questions mention besides the one it declared, among those it may ask. */
export function alsoAskedIn(reply: string, asked: Variable | null, allowed: Variable[]): Variable[] {
  if (!asked) return [];
  const questions = reply
    .split(SENTENCE_BREAK)
    .filter((sentence) => QUESTION_END.test(sentence.trim()))
    .join(" ");
  return allowed.filter((v) => v !== asked && TOPIC_WORDS[v].test(questions));
}

/** Count the reply, remember what it asked, and stop the questions once the cap is reached. */
function finishTurn(
  before: MemberState,
  after: MemberState,
  reply: string,
  asks: Variable | null,
): { state: MemberState; reply: string } {
  const capped = before.chat.turns >= MAX_ASSISTANT_TURNS;
  const allowed = allowedToAsk(before).filter((v) => !after.chat.answered.includes(v));
  // A question about something not on the list was not sanctioned: it is not recorded as asked.
  const asked = !capped && asks && allowed.includes(asks) ? asks : null;
  const state: MemberState = {
    ...after,
    chat: {
      ...after.chat,
      asked: asked ? uniq([...after.chat.asked, asked]) : after.chat.asked,
      // A follow-up about where they start or how they travel is not one of the listed topics,
      // but a short answer to it ("walking", "20") still has to be read as about travel.
      lastAsked: asked ?? (!capped && asks === "travel" && after.prefs.travel ? "travel" : null),
      alsoAsked: alsoAskedIn(reply, asked, allowed),
      turns: before.chat.turns + 1,
    },
  };
  if (capped) return { state, reply: `${withoutQuestions(reply)} ${closingLine(state)}` };
  // Said by code, and only with a question about money: a model left to say it says it everywhere.
  const privately =
    asked === "budget" && !PRIVATE_ALREADY.test(reply)
      ? /[\u3400-\u9fff]/.test(reply)
        ? PRIVATE_NUMBER_ZH
        : PRIVATE_NUMBER
      : "";
  return { state, reply: reply + privately };
}

// ---------------------------------------------------------------------------------------
// Keeping the assistant to its one job (#84). These are enforced here, not asked of the model:
// the prompt says the same things, but a prompt is not a safeguard.
// ---------------------------------------------------------------------------------------

/** Shown in place of the model's text when a reply is too long and has no sentence to cut at. */
export const REPLY_TOO_LONG = "Got it.";

/**
 * The model's text, cut to MAX_REPLY_CHARS at a sentence boundary. An assistant that can say at
 * most a few sentences cannot be used to write an essay, whatever it was talked into.
 */
export function capReply(text: string): string {
  const reply = text.trim();
  if (reply.length <= MAX_REPLY_CHARS) return reply;
  let kept = "";
  for (const sentence of reply.split(SENTENCE_BREAK)) {
    const next = kept ? `${kept} ${sentence.trim()}` : sentence.trim();
    if (next.length > MAX_REPLY_CHARS) break;
    kept = next;
  }
  return kept || REPLY_TOO_LONG;
}

/** What the person sees instead of the model's text when their message was not about the plan. */
export const REDIRECT = "I can only help with this plan.";

/** The assistant's questions as written by code, for when the model's own words are not used. */
const QUESTION: Record<Variable, string> = {
  time: "What time on the day works for you?",
  budget: "What would you like to spend per person, and what is the most you'd go to? The number stays private.",
  travel: "How long a trip, one way, would you make?",
  diet: "Is there anything you can't eat?",
  cuisine: "What kind of food would you like?",
};

/**
 * An off-topic turn. Nothing the model returned is used: not its text, not anything it
 * recorded. The person gets the fixed redirect and the next question code allows, the reply
 * counts towards the cap like any other, and what they want is unchanged.
 */
function offTopicTurn(state: MemberState): AssistantTurn {
  const capped = state.chat.turns >= MAX_ASSISTANT_TURNS;
  const next = capped ? undefined : allowedToAsk(state)[0];
  // At the cap finishTurn adds the closing line itself.
  const reply = capped ? REDIRECT : `${REDIRECT} ${next ? QUESTION[next] : closingLine(state)}`;
  const done = finishTurn(state, state, reply, next ?? null);
  return { ...done, changed: false, source: "llm", offTopic: true };
}

/** Added to a reply that asks about budget, in the one other language the code can tell apart. */
export const PRIVATE_NUMBER = " (Your number stays private.)";
export const PRIVATE_NUMBER_ZH = "（这个数字只有你自己能看到。）";
const PRIVATE_ALREADY = /stays? private|is private|只有你|保密/i;
const CANNOT_CHECK = /can(?:no|')t (?:be )?check|cannot (?:be )?check|not (?:be )?checked|unable to check/i;

/**
 * How "there is nothing I can't eat" is confirmed (#157). Written by code: in a user test the
 * model answered a bare "No" with "You can't eat anything restricted", which reads as the opposite.
 */
export const NOTHING_OFF_LIMITS = "Got it: there's nothing you can't eat.";
/** A sentence that says, or can be read as saying, that the person cannot eat anything. */
const READS_AS_CANNOT_EAT =
  /\b(?:can(?:['’]|no)?t|can not)\s+eat\s+(?:any|every)thing\b|\b(?:any|every)thing\s+restricted\b|\bno(?:thing| food)s?\s+you\s+can\s+eat\b/i;
const CJK = /[\u3400-\u9fff]/;

/**
 * The reply for a message that said there is nothing they cannot eat. When that is all the
 * message said, the confirmation is code's sentence and only the model's question is kept.
 * Otherwise only a sentence that could be read the wrong way round is replaced.
 */
function confirmNothingOffLimits(reply: string, onlyThat: boolean): string {
  if (CJK.test(reply)) return reply;
  const sentences = reply.split(SENTENCE_BREAK).filter((x) => x.trim());
  if (onlyThat) {
    const questions = sentences.filter((x) => QUESTION_END.test(x.trim()));
    return [NOTHING_OFF_LIMITS, ...questions].join(" ");
  }
  if (!READS_AS_CANNOT_EAT.test(reply)) return reply;
  let said = false;
  const kept = sentences.flatMap((x) => {
    if (!READS_AS_CANNOT_EAT.test(x)) return [x];
    if (said) return [];
    said = true;
    return [NOTHING_OFF_LIMITS];
  });
  return kept.join(" ");
}

/**
 * Apply what the model returned to the stored state. Pure: no network, no clock. Returns the
 * new state and the reply with any sentences code had to add (a block that could not be
 * recorded, a restaurant that is not a candidate, a note that cannot be checked).
 */
export function applyAssistantOutput(
  state: MemberState,
  output: AssistantOutput,
  pool: readonly Pick<Restaurant, "id" | "name">[],
  latestMessage = "",
): { state: MemberState; reply: string; asks: Variable | null; startText?: string; dropped: string[] } {
  const dropped: string[] = [];
  let blocks: Blocks = {};
  for (const name of Object.keys(BLOCKS) as BlockName[]) {
    const raw = output.update?.[name];
    if (raw === undefined || raw === null) continue;
    const parsed = BLOCKS[name].safeParse(raw);
    if (parsed.success) (blocks as Record<string, unknown>)[name] = parsed.data;
    else dropped.push(name);
  }
  blocks = fileBareNumber(latestMessage, state.chat.lastAsked, blocks);
  // A number with no unit and no numeric question behind it could be dollars or minutes. It
  // records neither, and never replaces a figure they already gave: the person is asked.
  let unclear = unclearNumber(latestMessage, state.chat.lastAsked);
  // After a question about time the number may simply be the hour: if the model read a time
  // from it, that stands, and only a budget or distance made out of it is dropped.
  const readAsTime = state.chat.lastAsked === "time" && blocks.time !== undefined;
  if (unclear !== null) {
    blocks = { ...blocks };
    delete blocks.budget;
    delete blocks.travel;
    if (readAsTime) unclear = null;
  }

  let prefs: PersonPreferences = state.prefs;
  const answered = new Set<Variable>(state.chat.answered);
  /** Store the first candidate that keeps the whole record valid; otherwise leave it and say so. */
  let travelMode = state.travelMode;
  const put = (key: keyof PersonPreferences, ...candidates: unknown[]): boolean => {
    for (const value of candidates) {
      const next: Record<string, unknown> = { ...prefs };
      if (value === undefined) delete next[key];
      else next[key] = value;
      const checked = PersonPreferencesSchema.safeParse(next);
      if (checked.success) {
        prefs = checked.data;
        return true;
      }
    }
    dropped.push(key);
    return false;
  };

  if (blocks.time) {
    const block = timeBlock(prefs.time, blocks.time);
    if (block === "invalid") dropped.push("time");
    else if (put("time", block ?? undefined)) answered.add("time");
  }

  if (blocks.budget) {
    const given = {
      ...(blocks.budget.ideal !== undefined ? { ideal: Math.round(blocks.budget.ideal) } : {}),
      ...(blocks.budget.max !== undefined ? { max: Math.round(blocks.budget.max) } : {}),
    };
    const merged = { ...(prefs.budget ?? {}), ...given };
    // A limit needs a number to be a limit: without a max it is a strong wish.
    const strengthFor = (b: { max?: number }): Strength => {
      const s = blocks.budget!.strength ?? prefs.budget?.strength ?? "mild";
      return s === "must" && b.max === undefined ? "strong" : s;
    };
    // What they say now wins over what they said before: if the two cannot both hold, keep the new one.
    if (put("budget", { ...merged, strength: strengthFor(merged) }, { ...given, strength: strengthFor(given) }))
      answered.add("budget");
  }

  if (blocks.travel) {
    const given = {
      ...(blocks.travel.idealMin !== undefined ? { idealMin: Math.round(blocks.travel.idealMin) } : {}),
      ...(blocks.travel.maxMin !== undefined ? { maxMin: Math.round(blocks.travel.maxMin) } : {}),
    };
    // How they travel is remembered even before there is a limit to attach it to.
    travelMode = blocks.travel.mode ?? travelMode;
    const mode = travelMode ? { mode: travelMode } : {};
    const merged = { ...(prefs.travel ?? {}), ...given, ...mode };
    const strengthFor = (b: { maxMin?: number }): Strength => {
      const s = blocks.travel!.strength ?? prefs.travel?.strength ?? "mild";
      return s === "must" && b.maxMin === undefined ? "strong" : s;
    };
    // "I'll be walking" with no number yet is not a limit: only the mode is kept.
    if (merged.idealMin === undefined && merged.maxMin === undefined) {
      /* nothing to store yet */
    } else if (
      put("travel", { ...merged, strength: strengthFor(merged) }, { ...given, ...mode, strength: strengthFor(given) })
    )
      answered.add("travel");
  }

  // Food and kind-of-place words are looked up before diet, because a diet is sometimes said as
  // a cuisine ("vegetarian food") and then belongs with the diets.
  const words = readFoodWords(blocks.cuisine, blocks.style);
  const diets = uniq([...(blocks.dietary ?? []), ...words.dietary]);
  if (diets.length && put("dietary", uniq([...(prefs.dietary ?? []), ...diets]))) answered.add("diet");
  // "No pork", said in passing before the question was ever asked, still answers it.
  if (blocks.nothingTheyCannotEat || blocks.saidWhatTheyCannotEat) answered.add("diet");

  if (words.liked.length || words.excluded.length || words.suggested.length || words.avoided.length) {
    // Food the model suggested for a wish counts as a near match, never as what was asked for.
    const suggestedScores = Object.fromEntries(
      words.suggested.flatMap((s) => s.like.map((m) => [m.id, NEAR_SCORE] as const)),
    );
    const likedScores = mergeScores(...words.liked.map(scoresFor), suggestedScores);
    const top = Object.keys(likedScores).filter((t) => likedScores[t] === 1);
    // What they say they want now wins over what they ruled out before, and over a ban in the same message.
    const wantedNow = (t: string) => top.includes(t) || top.some((x) => parentCuisine(x) === t);
    const banned = compactExcluded([
      ...(prefs.cuisine?.excluded ?? []).filter((t) => !wantedNow(t)),
      ...words.excluded.flatMap(excludedFor).filter((t) => !wantedNow(t)),
    ]);
    // A favourite named after a broad wish ("Asian", then "Korean most of all") keeps the rest wanted, lower.
    const narrow = words.liked.filter((m) => !isBroad(m));
    const before =
      narrow.length && narrow.length === words.liked.length
        ? lowerBroadWish(prefs.cuisine?.scores ?? {}, narrow)
        : (prefs.cuisine?.scores ?? {});
    // Food they would rather not have. What they ask for now wins over it, a ban outranks it,
    // and it takes a kind of food off the wish list if it was only there as a near match.
    const avoided = compactExcluded([
      ...(prefs.cuisine?.avoided ?? []).filter((t) => !wantedNow(t)),
      ...words.avoided.flatMap(avoidedFor).filter((t) => !wantedNow(t)),
    ]).filter((t) => !matchCuisine([t], { excluded: banned }).excluded);
    const scores = compactScores(
      Object.fromEntries(
        Object.entries(mergeScores(before, likedScores)).filter(([type]) => {
          const m = matchCuisine([type], { excluded: banned, avoided });
          return !m.excluded && !m.avoided;
        }),
      ),
    );
    // A kind of food cannot be both: a parent they avoid with a child they asked for keeps the child.
    const avoidedKept = avoided.filter((t) => !(t in scores));
    const block = {
      ...(Object.keys(scores).length ? { scores } : {}),
      ...(banned.length ? { excluded: banned } : {}),
      ...(avoidedKept.length ? { avoided: avoidedKept } : {}),
      strength: blocks.cuisine?.strength ?? prefs.cuisine?.strength ?? "mild",
    };
    // Being told what someone will not eat does not say what they would like. And a broad wish
    // ("Asian") leaves room for one question about a favourite, if cuisine was never asked.
    const onlyBroad = words.liked.length > 0 && words.liked.every(isBroad);
    const settles =
      state.chat.lastAsked === "cuisine" ||
      words.suggested.length > 0 ||
      (words.liked.length > 0 && !(onlyBroad && !state.chat.asked.includes("cuisine")));
    if (put("cuisine", block) && settles) answered.add("cuisine");
  } else if (state.chat.lastAsked === "cuisine" && words.unknown.some((u) => u.wanted)) {
    // They answered the question, with something that cannot be looked for. It is not asked again.
    answered.add("cuisine");
  }

  if (words.styleWanted.length || words.styleExcluded.length) {
    const wanted = uniq([
      ...(prefs.style?.wanted ?? []).filter((x) => !words.styleExcluded.includes(x)),
      ...words.styleWanted,
    ]);
    const excluded = uniq([
      ...(prefs.style?.excluded ?? []).filter((x) => !words.styleWanted.includes(x)),
      ...words.styleExcluded.filter((x) => !words.styleWanted.includes(x)),
    ]);
    if (wanted.length || excluded.length)
      put("style", {
        ...(wanted.length ? { wanted } : {}),
        ...(excluded.length ? { excluded } : {}),
        strength: blocks.style?.strength ?? prefs.style?.strength ?? "mild",
      });
  }

  // What the place should offer. Needing something outranks wanting it; neither is ever taken
  // back by a later message that only adds to the list.
  let featuresAdded: Feature[] = [];
  if (blocks.features?.needed?.length || blocks.features?.wanted?.length) {
    const needed = uniq([...(prefs.features?.needed ?? []), ...(blocks.features.needed ?? [])]);
    const wanted = uniq([...(prefs.features?.wanted ?? []), ...(blocks.features.wanted ?? [])]).filter(
      (f) => !needed.includes(f),
    );
    const had = new Set([...(prefs.features?.needed ?? []), ...(prefs.features?.wanted ?? [])]);
    const ok = put("features", {
      ...(needed.length ? { needed } : {}),
      ...(wanted.length ? { wanted } : {}),
      strength: blocks.features.strength ?? prefs.features?.strength ?? "mild",
    });
    if (ok) featuresAdded = [...needed, ...wanted].filter((f) => !had.has(f));
  }

  if (blocks.priority?.length) put("priority", uniq(blocks.priority));

  // A name with no match yet is kept as it is and matched again once the plan's pool is complete
  // (pool-refresh.ts). The chat does not say "not found": at this point the pool is not final.
  const named = (names: readonly string[]) => names.map((name) => ({ name, id: matchRestaurant(name, pool) }));
  // Said by code, so a person who names a place knows it was taken as a place (#158).
  const placeNotes: string[] = [];
  for (const r of named(blocks.wantedRestaurants ?? [])) {
    const found = r.id ? pool.find((p) => p.id === r.id)?.name : undefined;
    // The model often says the name back itself; then the person already knows it was heard.
    if (output.reply.toLowerCase().includes((found ?? r.name).toLowerCase())) continue;
    placeNotes.push(
      found
        ? `("${found}" is one of this plan's places; I've marked it as somewhere you'd like to go.)`
        : `(I've noted "${r.name}" as a restaurant you'd like, and will check for it once your group's places are in.)`,
    );
  }
  if (blocks.wantedRestaurants?.length || blocks.excludedRestaurants?.length) {
    const wantedNew = named(blocks.wantedRestaurants ?? []);
    const excludedNew = named(blocks.excludedRestaurants ?? []).filter(
      (r) => !wantedNew.some((w) => keyOf(w) === keyOf(r)),
    );
    const touched = new Set([...wantedNew, ...excludedNew].map(keyOf));
    const wanted = [...without(prefs.wantedRestaurants, touched), ...wantedNew].slice(-LIMITS.namedRestaurants);
    const excluded = [...without(prefs.excludedRestaurants, touched), ...excludedNew].slice(-LIMITS.namedRestaurants);
    const next = { ...prefs, wantedRestaurants: wanted, excludedRestaurants: excluded };
    const checked = PersonPreferencesSchema.safeParse(next);
    if (checked.success) prefs = checked.data;
    else dropped.push("restaurants");
  }

  let allergyNoted = false;
  let otherNoted = false;
  // A food or kind of place the table does not have is kept in the person's own words, as a note:
  // it cannot change which places are picked, and the reply says so, but it is not thrown away.
  const unknownNotes = uniq([
    ...words.unknown.map((u) => `${u.wanted ? "Would like" : "Would rather not have"}: ${u.word}`),
    // The person's own words for a wish that was turned into kinds of food, so they can see it was heard.
    ...words.suggested.map((s) => `Would like: ${s.word}`),
  ]).map((text) => ({ type: "other" as const, text: text.slice(0, LIMITS.noteChars) }));
  if (blocks.notes?.length || unknownNotes.length) {
    const notes = [...(prefs.notes ?? [])];
    for (const note of blocks.notes ?? []) {
      if (notes.some((n) => n.text.toLowerCase() === note.text.toLowerCase())) continue;
      notes.push(note);
      if (note.type === "allergy") allergyNoted = true;
      else otherNoted = true;
    }
    for (const note of unknownNotes)
      if (!notes.some((n) => n.text.toLowerCase() === note.text.toLowerCase())) notes.push(note);
    put("notes", notes.slice(-LIMITS.notes));
  }
  // An allergy answers "anything you can't eat?". So does a note or an excluded food given in reply to it.
  const saidWhatTheyAvoid =
    otherNoted || words.excluded.length > 0 || words.avoided.length > 0 || words.unknown.some((u) => !u.wanted);
  if (allergyNoted || (state.chat.lastAsked === "diet" && saidWhatTheyAvoid)) answered.add("diet");

  // "I don't mind" settles a question and changes nothing that is already recorded.
  for (const v of output.dontMind ?? []) if (isVariable(v)) answered.add(v);

  // The cap is on the model's own text. The sentences below are written by code and are short.
  let reply = unclear !== null ? whichNumber(unclear) : capReply(output.reply);
  if (blocks.nothingTheyCannotEat) {
    const said = Object.entries(blocks).filter(
      ([, v]) => v !== undefined && v !== false && !(Array.isArray(v) && !v.length),
    );
    reply = confirmNothingOffLimits(reply, said.length === 1);
  }
  // A broad word: say what it was taken to mean, unless the model already listed it.
  const saidBroad = new Set<string>();
  // Several wishes about what the food is like share one sentence, so the reply stays short.
  const leanings: { leaning: string; meant: string }[] = [];
  for (const match of words.liked.filter(isBroad)) {
    if (saidBroad.has(match.id)) continue;
    saidBroad.add(match.id);
    const meant = describeMatch(match);
    const named = meant.split(", ").filter((label) => reply.toLowerCase().includes(label.toLowerCase())).length;
    const leaning = leaningOf(match);
    if (leaning) leanings.push({ leaning, meant });
    else if (named < 3) reply += ` (By ${match.label} I mean: ${meant}.)`;
  }
  // Not a refusal: say what the wish was turned into, so the person can correct it.
  if (leanings.length)
    reply += ` (Restaurants aren't listed by ${leanings.map((l) => l.leaning).join(" or ")}, so I'll lean toward food known for it: ${leanings.map((l) => l.meant).join("; ")}.)`;
  // "Nothing too spicy": the same guess, the other way round, and said as plainly.
  const away = uniq(words.avoided.filter((m) => leaningOf(m)).map((m) => m.id)).map((id) =>
    words.avoided.find((m) => m.id === id)!,
  );
  if (away.length)
    reply += ` (Restaurants aren't listed by ${away.map((m) => leaningOf(m)).join(" or ")}, so I'll lean away from food known for it: ${away.map(describeMatch).join("; ")}. It won't rule those places out.)`;
  for (const s of words.suggested)
    reply += ` (Restaurants aren't listed by "${s.word}", so I'll lean toward ${s.like.map((m) => m.label).join(", ")}. Tell me if that's off.)`;
  const quoted = (wanted: boolean) =>
    uniq(words.unknown.filter((u) => u.wanted === wanted).map((u) => `"${u.word}"`)).join(" or ");
  // A wish that leads nowhere is said once, with what the person can do next (#158).
  if (quoted(true))
    reply += ` (I can't look for ${quoted(true)} directly, so I've kept it as a note. Name a kind of food close to it and I'll look for that.)`;
  if (quoted(false))
    reply += ` (Restaurants aren't listed by that, so ${quoted(false)} stays a note for you and won't rule places out.)`;
  for (const line of uniq(placeNotes)) reply += ` ${line}`;
  // Said once, when something about the place itself is first recorded: Google answers this for
  // most places, not all, and the person should know what an unanswered one counts as.
  if (featuresAdded.length)
    reply += ` (I'll look for places that ${featuresAdded.map((f) => FEATURE_PHRASES[f]).join(" and ")}. Google doesn't say for every place; one it says nothing about counts as a maybe.)`;
  if ((allergyNoted || otherNoted) && !CANNOT_CHECK.test(reply))
    // Still honest that it cannot steer the choice (the tests hold that), but said as something
    // done for the person and, for an allergy, with what they should do about it (#158).
    reply += allergyNoted
      ? " (I've noted that for you. I can't check restaurants for it, so please check with the place before you order.)"
      : " (I've noted that for you. I can't check restaurants for it yet, so it won't steer which places are picked.)";
  if (dropped.length)
    reply += ` (I couldn't record what you said about ${uniq(dropped)
      .map((d) => (d === "dietary" ? "diet" : d))
      .join(" and ")}; could you say it another way?)`;

  return {
    state: { ...state, prefs, travelMode, chat: { ...state.chat, answered: [...answered] } },
    reply,
    asks: isVariable(output.asks) ? output.asks : null,
    startText: blocks.startText ?? blocks.travel?.startText,
    dropped,
  };
}

// ---------------------------------------------------------------------------------------
// The two paths
// ---------------------------------------------------------------------------------------

async function callModel(
  history: ChatTurn[],
  state: MemberState,
  apiKey: string,
  plan?: PlanContext,
): Promise<AssistantOutput> {
  const model = process.env.ANTHROPIC_MODEL || "claude-haiku-5-5";
  const messages = history.slice(-20).map((t) => ({ role: t.role, content: t.content }));
  // The API requires the first message to be from the user.
  while (messages.length && messages[0].role !== "user") messages.shift();

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: `${RUBRIC}\n\n${stateBlock(state, plan)}`,
      tools: [TOOL],
      // Forcing the tool is the most reliable way to get structured output, but not every model
      // accepts it (claude-sonnet-5-5 answers 400). ANTHROPIC_TOOL_CHOICE=auto leaves the choice
      // to the model; the prompt still tells it to always call the tool.
      tool_choice: process.env.ANTHROPIC_TOOL_CHOICE === "auto" ? { type: "auto" } : { type: "tool", name: TOOL.name },
      messages,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}`);
  const data = (await res.json()) as { content?: { type: string; input?: unknown }[]; usage?: Usage };
  await recordUsage(data.usage);
  return ToolOutput.parse(liftMisplaced(data.content?.find((b) => b.type === "tool_use")?.input));
}

/** Resolve a start point the person named. The model only ever supplies the text. */
async function withStart(
  state: MemberState,
  reply: string,
  startText: string | undefined,
  pool: readonly Restaurant[],
): Promise<{ state: MemberState; reply: string }> {
  if (startText === undefined) return { state, reply };
  const resolved = await resolveStart({ startText }, reply, pool);
  return resolved.update.startPoint
    ? { state: { ...state, startPoint: resolved.update.startPoint }, reply: resolved.reply }
    : { state, reply: resolved.reply };
}

/** A question in the reply about where the person starts from. */
const ASKS_START =
  /\b(?:where|which)\b[^.?!]*\b(?:coming from|start(?:ing)?|leav(?:e|ing) from|head(?:ing)? from|be (?:coming|walking|driving|travell?ing) from|from)\b[^.?!]*\?|从哪|出发/i;

/** What the person is told when they have a travel limit and nothing says where they start. */
export const startNote = (location: string | null) =>
  ` (I'm measuring that from ${location ? `the plan's location, ${location}` : "the plan's location"}. Tell me where you'll be coming from and I'll measure from there.)`;

/**
 * A travel limit only means something from a starting point. The prompt asks the model to find
 * out; this makes sure the person hears it once either way: if they gave a limit, no start is
 * known, this plan can measure from one, and the reply did not ask, code says what it is
 * measured from. Said once per person.
 */
function tellStart(
  turn: { state: MemberState; reply: string },
  namedStart: boolean,
  pool: readonly Restaurant[],
  plan?: PlanContext,
): { state: MemberState; reply: string } {
  const { state, reply } = turn;
  if (!state.prefs.travel || state.startPoint || state.chat.startTold || namedStart || !canLocate(pool)) return turn;
  const told = { ...state, chat: { ...state.chat, startTold: true } };
  if (ASKS_START.test(reply)) return { state: told, reply };
  const where = plan?.location ? cleanPlaceName(plan.location) : null;
  return { state: told, reply: reply + startNote(where) };
}

async function modelTurn(
  history: ChatTurn[],
  state: MemberState,
  pool: readonly Restaurant[],
  apiKey: string,
  plan?: PlanContext,
): Promise<AssistantTurn> {
  const latest = [...history].reverse().find((t) => t.role === "user")?.content ?? "";
  const output = await callModel(history, state, apiKey, plan);
  if (!output.onTopic) return offTopicTurn(state);
  const applied = applyAssistantOutput(state, output, pool, latest);
  const located = await withStart(applied.state, applied.reply, applied.startText, pool);
  const placed = tellStart(located, applied.startText !== undefined, pool, plan);
  const done = finishTurn(state, placed.state, placed.reply, applied.asks);
  return { ...done, changed: preferencesChanged(state, done.state), source: "llm" };
}

/** The variable a rule-based reply asks about, from the old reader's own bookkeeping. */
const RULE_QUESTION: Partial<Record<MissingField | Pending, Variable>> = {
  time: "time",
  budget: "budget",
  vague_budget: "budget",
  distance: "travel",
  vague_distance: "travel",
  diet: "diet",
  cuisine: "cuisine",
};

/**
 * The safety net: the rule-based reader takes the turn. It keeps its own order of questions
 * (extract-rules.ts) and its output is converted by legacy-adapter.ts. The reply cap applies
 * to it like any other reply.
 */
export async function rulesTurn(
  history: ChatTurn[],
  state: MemberState,
  pool: readonly Restaurant[],
): Promise<AssistantTurn> {
  const latest = [...history].reverse().find((t) => t.role === "user")?.content ?? "";
  const current = toRulesView(state);
  const read = ruleTurn(latest, current, { askStart: canLocate(pool) });
  const limited = enforceLimits({ reply: read.reply, update: read.update, source: "rules" });
  const { update, reply } = await resolveStart(limited.update, limited.reply, pool);
  const after = applyLegacyUpdate(state, update);
  const view = toRulesView(after);
  const next = view.pending ?? missingFields(view)[0];
  const done = finishTurn(state, after, reply, (next && RULE_QUESTION[next]) ?? null);
  return { ...done, changed: preferencesChanged(state, done.state), source: "rules" };
}

export async function assistantTurn(
  history: ChatTurn[],
  state: MemberState,
  pool: readonly Restaurant[],
  /** false once the plan has used up its model budget for the day: the rule-based reader answers. */
  { allowLLM = true, plan }: { allowLLM?: boolean; plan?: PlanContext } = {},
): Promise<AssistantTurn> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey && allowLLM) {
    try {
      return await modelTurn(history, state, pool, apiKey, plan);
    } catch (err) {
      console.error("The assistant's model call failed, falling back to rules:", (err as Error).message);
    }
  }
  return rulesTurn(history, state, pool);
}
