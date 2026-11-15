import { z } from "zod";
import { RUBRIC, TOOL, stateBlock } from "./assistant-prompt";
import { CUISINES, missingFields, type Cuisine, type Pending, type MissingField } from "./constraints";
import { enforceLimits, type ChatTurn } from "./extract";
import { ruleTurn } from "./extract-rules";
import { PLACE_TYPE_OF, SEAFOOD_TYPE, applyLegacyUpdate, toRulesView } from "./legacy-adapter";
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
  type PersonPreferences,
  type StartTime,
  type Strength,
} from "./optimizer-input";
import type { Restaurant } from "./restaurants";
import { canLocate, resolveStart } from "./start-point";

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
  travel: z.object({ idealMin: z.number().optional(), maxMin: z.number().optional(), strength: StrengthIn }),
  startText: z.string().trim().min(2).max(120),
  dietary: z.array(z.enum(DIETARY_NEEDS)),
  nothingTheyCannotEat: z.boolean(),
  saidWhatTheyCannotEat: z.boolean(),
  cuisine: z.object({
    liked: z.array(z.string()).optional(),
    excluded: z.array(z.string()).optional(),
    strength: StrengthIn,
  }),
  style: z.object({
    wanted: z.array(z.enum(STYLES)).optional(),
    excluded: z.array(z.enum(STYLES)).optional(),
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

const ToolOutput = z.object({
  reply: z.string().trim().min(1),
  asks: z.string().optional(),
  dontMind: z.array(z.string()).optional(),
  update: z.record(z.string(), z.unknown()).optional(),
});
export type AssistantOutput = z.infer<typeof ToolOutput>;

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

/** A cuisine word from the model as a Google Places type name, or null if it is not one we can look for. */
function cuisineType(word: string): string | null {
  const w = word
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/_restaurant$/, "");
  if ((CUISINES as readonly string[]).includes(w)) return PLACE_TYPE_OF[w as Cuisine];
  return w === "seafood" ? SEAFOOD_TYPE : null;
}

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

// ---------------------------------------------------------------------------------------
// Applying a model turn
// ---------------------------------------------------------------------------------------

const QUESTION_END = /[?？]\s*["')\]]*$/;

/** A reply with its questions taken out, for when the assistant has none left to ask. */
export function withoutQuestions(reply: string): string {
  const kept = reply
    // Chinese and Japanese sentences are not separated by spaces.
    .split(/(?<=[.!?])\s+|(?<=[。！？])\s*/)
    .filter((sentence) => sentence.trim() && !QUESTION_END.test(sentence.trim()));
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
      lastAsked: asked,
      turns: before.chat.turns + 1,
    },
  };
  return { state, reply: capped ? `${withoutQuestions(reply)} ${closingLine(state)}` : reply };
}

const CANNOT_CHECK = /can(?:no|')t (?:be )?check|cannot (?:be )?check|not (?:be )?checked|unable to check/i;
const NOT_A_CANDIDATE =
  /not (?:among|one of|on|in) (?:this plan|the plan|the candidates|the list)|isn'?t (?:among|one of)/i;

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

  let prefs: PersonPreferences = state.prefs;
  const answered = new Set<Variable>(state.chat.answered);
  /** Store the first candidate that keeps the whole record valid; otherwise leave it and say so. */
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
    const merged = { ...(prefs.travel ?? {}), ...given };
    const strengthFor = (b: { maxMin?: number }): Strength => {
      const s = blocks.travel!.strength ?? prefs.travel?.strength ?? "mild";
      return s === "must" && b.maxMin === undefined ? "strong" : s;
    };
    if (put("travel", { ...merged, strength: strengthFor(merged) }, { ...given, strength: strengthFor(given) }))
      answered.add("travel");
  }

  if (blocks.dietary?.length && put("dietary", uniq([...(prefs.dietary ?? []), ...blocks.dietary])))
    answered.add("diet");
  // "No pork", said in passing before the question was ever asked, still answers it.
  if (blocks.nothingTheyCannotEat || blocks.saidWhatTheyCannotEat) answered.add("diet");

  const unknownCuisines: string[] = [];
  if (blocks.cuisine) {
    const resolve = (words: readonly string[] | undefined) =>
      (words ?? []).flatMap((w) => {
        const type = cuisineType(w);
        if (!type && w.trim()) unknownCuisines.push(w.trim());
        return type ? [type] : [];
      });
    const liked = resolve(blocks.cuisine.liked);
    const excluded = resolve(blocks.cuisine.excluded).filter((t) => !liked.includes(t));
    if (liked.length || excluded.length) {
      const scores = Object.fromEntries(
        Object.entries(prefs.cuisine?.scores ?? {}).filter(([type]) => !excluded.includes(type)),
      );
      for (const type of liked) scores[type] = 1;
      const out = uniq([...(prefs.cuisine?.excluded ?? []).filter((t) => !liked.includes(t)), ...excluded]);
      const block = {
        ...(Object.keys(scores).length ? { scores } : {}),
        ...(out.length ? { excluded: out } : {}),
        strength: blocks.cuisine.strength ?? prefs.cuisine?.strength ?? "mild",
      };
      // Being told what someone will not eat does not say what they would like.
      if (put("cuisine", block) && (liked.length || state.chat.lastAsked === "cuisine")) answered.add("cuisine");
    }
  }

  if (blocks.style) {
    const wanted = uniq([
      ...(prefs.style?.wanted ?? []).filter((s) => !blocks.style!.excluded?.includes(s)),
      ...(blocks.style.wanted ?? []),
    ]);
    const excluded = uniq([
      ...(prefs.style?.excluded ?? []).filter((s) => !blocks.style!.wanted?.includes(s)),
      ...(blocks.style.excluded ?? []).filter((s) => !blocks.style!.wanted?.includes(s)),
    ]);
    if (wanted.length || excluded.length)
      put("style", {
        ...(wanted.length ? { wanted } : {}),
        ...(excluded.length ? { excluded } : {}),
        strength: blocks.style.strength ?? prefs.style?.strength ?? "mild",
      });
  }

  if (blocks.priority?.length) put("priority", uniq(blocks.priority));

  const unmatched: string[] = [];
  const named = (names: readonly string[]) =>
    names.map((name) => {
      const id = matchRestaurant(name, pool);
      if (!id) unmatched.push(name);
      return { name, id };
    });
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
  if (blocks.notes?.length) {
    const notes = [...(prefs.notes ?? [])];
    for (const note of blocks.notes) {
      if (notes.some((n) => n.text.toLowerCase() === note.text.toLowerCase())) continue;
      notes.push(note);
      if (note.type === "allergy") allergyNoted = true;
      else otherNoted = true;
    }
    put("notes", notes.slice(-LIMITS.notes));
  }
  // An allergy answers "anything you can't eat?". So does a note or an excluded food given in reply to it.
  const saidWhatTheyAvoid = otherNoted || Boolean(blocks.cuisine?.excluded?.length);
  if (allergyNoted || (state.chat.lastAsked === "diet" && saidWhatTheyAvoid)) answered.add("diet");

  // "I don't mind" settles a question and changes nothing that is already recorded.
  for (const v of output.dontMind ?? []) if (isVariable(v)) answered.add(v);

  let reply = output.reply;
  if (unknownCuisines.length)
    reply += ` (I couldn't match ${uniq(unknownCuisines)
      .map((w) => `"${w}"`)
      .join(" or ")} to a cuisine I can look for, so I left that out.)`;
  if (unmatched.length && !NOT_A_CANDIDATE.test(reply))
    reply += ` (${uniq(unmatched)
      .map((n) => `"${n}"`)
      .join(
        " and ",
      )} ${unmatched.length > 1 ? "are" : "is"} not among this plan's places, so I can't count ${unmatched.length > 1 ? "them" : "it"}; I've kept the name.)`;
  if ((allergyNoted || otherNoted) && !CANNOT_CHECK.test(reply))
    reply += " (That is noted for you. I can't check restaurants for it, so it won't change which places are picked.)";
  if (dropped.length)
    reply += ` (I couldn't record what you said about ${uniq(dropped)
      .map((d) => (d === "dietary" ? "diet" : d))
      .join(" and ")}; could you say it another way?)`;

  return {
    state: { ...state, prefs, chat: { ...state.chat, answered: [...answered] } },
    reply,
    asks: isVariable(output.asks) ? output.asks : null,
    startText: blocks.startText,
    dropped,
  };
}

// ---------------------------------------------------------------------------------------
// The two paths
// ---------------------------------------------------------------------------------------

async function callModel(history: ChatTurn[], state: MemberState, apiKey: string): Promise<AssistantOutput> {
  const model = process.env.ANTHROPIC_MODEL || "claude-haiku-5-5";
  const messages = history.slice(-20).map((t) => ({ role: t.role, content: t.content }));
  // The API requires the first message to be from the user.
  while (messages.length && messages[0].role !== "user") messages.shift();

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model,
      max_tokens: 512,
      system: `${RUBRIC}\n\n${stateBlock(state)}`,
      tools: [TOOL],
      tool_choice: { type: "tool", name: TOOL.name },
      messages,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}`);
  const data = (await res.json()) as { content?: { type: string; input?: unknown }[] };
  return ToolOutput.parse(data.content?.find((b) => b.type === "tool_use")?.input);
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

async function modelTurn(
  history: ChatTurn[],
  state: MemberState,
  pool: readonly Restaurant[],
  apiKey: string,
): Promise<AssistantTurn> {
  const latest = [...history].reverse().find((t) => t.role === "user")?.content ?? "";
  const output = await callModel(history, state, apiKey);
  const applied = applyAssistantOutput(state, output, pool, latest);
  const placed = await withStart(applied.state, applied.reply, applied.startText, pool);
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
  { allowLLM = true }: { allowLLM?: boolean } = {},
): Promise<AssistantTurn> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey && allowLLM) {
    try {
      return await modelTurn(history, state, pool, apiKey);
    } catch (err) {
      console.error("The assistant's model call failed, falling back to rules:", (err as Error).message);
    }
  }
  return rulesTurn(history, state, pool);
}
