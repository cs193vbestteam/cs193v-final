import { TRAVEL_MODES, type TravelMode } from "./geo";
import { z } from "zod";
import {
  PENDING,
  PROBES,
  StartPointSchema,
  clockLabel,
  describeSlots,
  type MissingField,
  type Slot,
} from "./constraints";
import { describeTypes } from "./cuisine-table";
import {
  MEAL_RANGES,
  PersonPreferencesSchema,
  START_TIMES,
  startTimesIn,
  type Feature,
  type PersonPreferences,
  type StartTime,
  type Strength,
  type TimeRange,
} from "./optimizer-input";

/**
 * What is stored, encrypted, for one member of a plan (#83):
 *
 *   prefs       their preferences in the format the optimizer reads (optimizer-input.ts).
 *               This is the only record of what they want.
 *   chat        where the conversation stands: which questions have been asked and answered,
 *               and how many replies the assistant has given.
 *   startPoint  where they travel from, if they said. Kept beside `prefs` because the optimizer
 *               is handed travel minutes, never an address.
 *
 * The current negotiation engine still reads the older `Constraints`; legacy-adapter.ts
 * converts on the way in. Nothing here knows about that engine.
 */

/** What the assistant may ask about. Everything else is recorded only when the person brings it up. */
export const VARIABLES = ["time", "budget", "travel", "diet", "cuisine"] as const;
export type Variable = (typeof VARIABLES)[number];

/** A person can press "I'm done" once these two are settled. Everything else may stay empty. */
export const REQUIRED: readonly Variable[] = ["time", "diet"];

/** After this many replies the assistant stops asking and only confirms. */
export const MAX_ASSISTANT_TURNS = 8;

const ChatStateSchema = z.object({
  /** Variables the assistant has asked about. Each is asked at most once (see `allowedToAsk`). */
  asked: z.array(z.enum(VARIABLES)).default([]),
  /** Variables the person has answered, or said they do not mind about. */
  answered: z.array(z.enum(VARIABLES)).default([]),
  /** Replies the assistant has given, not counting the opening message. */
  turns: z.number().int().min(0).default(0),
  /** The variable the last reply asked about, so a short answer is read against it. */
  lastAsked: z.enum(VARIABLES).nullable().default(null),
  /**
   * Other variables the same reply asked about in passing ("a budget, or a travel time?").
   * For display only: it marks them in the progress. It does not count them as asked.
   */
  alsoAsked: z.array(z.enum(VARIABLES)).default([]),
  /**
   * The person has been told, once, where their travel is measured from and that they can name
   * their own start (assistant.ts). Without it "ten minutes on foot" would be measured from the
   * plan's location and they would never know.
   */
  startTold: z.boolean().default(false),
  /** Bookkeeping for the rule-based fallback only (extract-rules.ts). The model path ignores it. */
  rules: z
    .object({
      pending: z.enum(PENDING).nullable().default(null),
      probesAsked: z.array(z.enum(PROBES)).default([]),
    })
    .default({ pending: null, probesAsked: [] }),
});
export type ChatState = z.infer<typeof ChatStateSchema>;

export const MemberStateSchema = z.object({
  version: z.literal(2),
  prefs: PersonPreferencesSchema,
  chat: ChatStateSchema,
  startPoint: StartPointSchema.nullable().default(null),
  /** How they said they travel, kept here until there is a travel limit in `prefs` to carry it. */
  travelMode: z.enum(TRAVEL_MODES).nullable().default(null),
});
export type MemberState = z.infer<typeof MemberStateSchema>;

export function emptyMemberState(): MemberState {
  return {
    version: 2,
    prefs: { version: 1 },
    chat: {
      asked: [],
      answered: [],
      turns: 0,
      lastAsked: null,
      alsoAsked: [],
      startTold: false,
      rules: { pending: null, probesAsked: [] },
    },
    startPoint: null,
    travelMode: null,
  };
}

export function parseMemberState(raw: unknown): MemberState {
  return MemberStateSchema.parse(raw);
}

/** What still has to be settled before "I'm done". Named as the chat panel already names them. */
export function missingRequired(state: MemberState): MissingField[] {
  const missing: MissingField[] = [];
  if (!state.chat.answered.includes("time")) missing.push("time");
  if (!state.chat.answered.includes("diet")) missing.push("diet");
  return missing;
}

/**
 * One of the five things the assistant asks about, whether this person has answered it, and
 * whether it is the one the assistant's last message asked about.
 */
export type AnswerStep = { topic: Variable; label: string; required: boolean; done: boolean; asking: boolean };

const STEP_LABEL: Record<Variable, string> = {
  time: "When",
  budget: "Budget",
  travel: "Distance",
  diet: "Diet",
  cuisine: "Food",
};

/**
 * How far through the questions a person is, for the bar above "I'm done". A required topic is
 * done exactly when `missingRequired` stops listing it, so the bar and the button never disagree.
 * An optional one also counts once something is recorded for it, however it came up.
 */
export function answerProgress(state: MemberState): AnswerStep[] {
  const { prefs, chat } = state;
  const recorded: Record<Variable, boolean> = {
    time: false,
    diet: false,
    budget: !!prefs.budget,
    travel: !!prefs.travel,
    cuisine: !!(Object.keys(prefs.cuisine?.scores ?? {}).length || prefs.cuisine?.excluded?.length),
  };
  return VARIABLES.map((topic) => {
    const done = chat.answered.includes(topic) || recorded[topic];
    return {
      topic,
      label: STEP_LABEL[topic],
      required: REQUIRED.includes(topic),
      done,
      // An answered question is no longer the open one, even if it was the last one asked.
      asking: (chat.lastAsked === topic || chat.alsoAsked.includes(topic)) && !done,
    };
  });
}

/**
 * The variables the assistant may ask about in its next reply. Decided here, not by the prompt:
 * nothing once the turn cap is reached; otherwise what is unanswered and has not been asked.
 * The two required ones stay askable until answered, because nobody can finish without them.
 */
export function allowedToAsk(state: MemberState): Variable[] {
  const { asked, answered, turns } = state.chat;
  if (turns >= MAX_ASSISTANT_TURNS) return [];
  // The two things the plan cannot do without may be asked until they are answered.
  const needed = REQUIRED.filter((v) => !answered.includes(v));
  // Everything else shares ONE question (#156): people in the user test wanted to stop after a
  // few messages. Once any of them has been asked about, none of the others is.
  const optional = VARIABLES.filter((v) => !REQUIRED.includes(v));
  const extra = optional.some((v) => asked.includes(v)) ? [] : optional.filter((v) => !answered.includes(v));
  return VARIABLES.filter((v) => needed.includes(v) || extra.includes(v));
}

/** Whether what the person wants changed between two states. Chat bookkeeping does not count. */
export function preferencesChanged(before: MemberState, after: MemberState): boolean {
  return (
    JSON.stringify(before.prefs) !== JSON.stringify(after.prefs) ||
    JSON.stringify(before.startPoint) !== JSON.stringify(after.startPoint)
  );
}

// ---------------------------------------------------------------------------------------
// Start times as sets and ranges
// ---------------------------------------------------------------------------------------

/** Every start time covered by a list of ranges. */
export function timesIn(ranges: readonly TimeRange[] | undefined): StartTime[] {
  const covered = new Set((ranges ?? []).flatMap(startTimesIn));
  return START_TIMES.filter((t) => covered.has(t));
}

/** A set of start times as the fewest ranges that cover exactly it. */
export function toRanges(times: readonly StartTime[]): TimeRange[] {
  const ranges: TimeRange[] = [];
  for (const t of START_TIMES.filter((x) => times.includes(x))) {
    const last = ranges.at(-1);
    if (last && START_TIMES.indexOf(t) === START_TIMES.indexOf(last.to) + 1) last.to = t;
    else ranges.push({ from: t, to: t });
  }
  return ranges;
}

/** The start times a person can make: all of them, minus the ones they ruled out. */
export function availableTimes(prefs: PersonPreferences): StartTime[] {
  const blocked = timesIn(prefs.time?.unavailable);
  const open = START_TIMES.filter((t) => !blocked.includes(t));
  // "Only dinner" said as a must: nothing but the times they named.
  if (prefs.time?.strength === "must" && prefs.time.preferred?.length) {
    const only = timesIn(prefs.time.preferred);
    return open.filter((t) => only.includes(t));
  }
  return open;
}

// ---------------------------------------------------------------------------------------
// The summary shown to the owner, and to nobody else
// ---------------------------------------------------------------------------------------

/**
 * How a strength reads to its owner. `must` is the heaviest weight the optimizer has, not a
 * guarantee (optimizer.ts), so it is not called a must here: the words promise what the
 * program does.
 */
/** A feature of a place, as its owner reads it in their summary and in the assistant's replies. */
export const FEATURE_WORDS: Record<Feature, string> = {
  groups: "room for a group",
  kids: "good for children",
  outdoor: "outdoor seating",
  wheelchair: "a step-free entrance",
  reservable: "takes reservations",
  alcohol: "serves alcohol",
  parking: "parking",
  dogs: "dogs allowed",
  live_music: "live music",
  well_rated: "well reviewed",
  atmosphere: "a nice atmosphere",
};

/** The same, as the end of "places that …", for a reply. */
export const FEATURE_PHRASES: Record<Feature, string> = {
  groups: "have room for a group",
  kids: "are good for children",
  outdoor: "have outdoor seating",
  wheelchair: "have a step-free entrance",
  reservable: "take reservations",
  alcohol: "serve alcohol",
  parking: "have parking",
  dogs: "allow dogs",
  live_music: "have live music",
  well_rated: "are well reviewed on Google",
  atmosphere: "are known for a nice atmosphere",
};

// "must" is a limit the person stated ("up to $50", "has to be Thai"), not a ranking. It used to
// read "(matters most)", the words of the separate "Matters most:" line, and a person who had only
// named a budget was told it was what mattered most to them. That line is the only place those
// words appear now, and it is there only when the person said so.
const STRENGTH_WORDS: Record<Strength, string> = { must: " (a must)", strong: " (matters a lot)", mild: "" };
/** For a number with "up to" in front of it: the words already say it is a limit. */
const LIMIT_WORDS: Record<Strength, string> = { ...STRENGTH_WORDS, must: "" };
const MEAL_WORDS: Record<keyof typeof MEAL_RANGES, string> = {
  brunch: "brunch",
  lunch: "lunch",
  afternoon_tea: "afternoon tea",
  dinner: "dinner",
  late_night: "late night",
};

/**
 * The times a meal can start, in the person's own terms. These are start times on the hour, and
 * "Free: 5:00 PM to 7:00 PM" read as "must be over by 7" to someone who had said "dinner before
 * 8". So an open end is said as one: "from 7:00 PM", "before 8:00 PM", "dinner before 8:00 PM".
 */
export function describeStarts(times: readonly StartTime[]): string {
  if (times.length === START_TIMES.length) return "any time";
  const ranges = toRanges(times);
  if (ranges.length !== 1) return describeSlots(times as Slot[]);
  const { from, to } = ranges[0];
  const after = START_TIMES[START_TIMES.indexOf(to) + 1];
  if (!after) return `from ${clockLabel(from)}`;
  if (from === START_TIMES[0]) return `before ${clockLabel(after)}`;
  // The first hours of a meal: "dinner before 8:00 PM".
  const meal = (Object.keys(MEAL_RANGES) as (keyof typeof MEAL_RANGES)[]).find(
    (m) => MEAL_RANGES[m].from === from && to < MEAL_RANGES[m].to,
  );
  if (meal) return `${MEAL_WORDS[meal]} before ${clockLabel(after)}`;
  return from === to ? clockLabel(from) : `${clockLabel(from)} to ${clockLabel(to)}`;
}

const PRIORITY_WORDS: Record<string, string> = {
  time: "the time",
  budget: "the budget",
  travel: "the distance",
  cuisine: "the food",
  style: "the kind of place",
};

/** How a way of travelling is said after a number of minutes. */
export const MODE_WORDS: Record<TravelMode, string> = {
  walk: "on foot",
  bike: "by bike",
  drive: "by car",
  transit: "by transit",
};

/** What the assistant has recorded, in plain words. Shown ONLY to the person it is about. */
export function describeState(state: MemberState): string[] {
  const { prefs, chat } = state;
  const settled = (v: Variable) => chat.answered.includes(v);
  const lines: string[] = [];

  if (prefs.time) {
    lines.push(`Can start: ${describeStarts(availableTimes(prefs))}`);
    if (prefs.time.strength !== "must" && prefs.time.preferred?.length)
      lines.push(
        `Best time: ${describeSlots(timesIn(prefs.time.preferred) as Slot[])}${STRENGTH_WORDS[prefs.time.strength]}`,
      );
  } else if (settled("time")) lines.push("Can start: any time");

  if (prefs.budget) {
    const { ideal, max, strength } = prefs.budget;
    const text =
      max !== undefined && ideal !== undefined && ideal < max
        ? `ideally $${ideal}, up to $${max}/person`
        : max !== undefined
          ? `up to $${max}/person`
          : `around $${ideal}/person`;
    lines.push(`Budget: ${text}${LIMIT_WORDS[strength]}`);
  } else if (settled("budget")) lines.push("Budget: no limit");

  if (prefs.travel) {
    const { idealMin, maxMin, strength } = prefs.travel;
    const text =
      maxMin !== undefined && idealMin !== undefined && idealMin < maxMin
        ? `ideally ${idealMin} min, up to ${maxMin} min`
        : maxMin !== undefined
          ? `up to ${maxMin} min`
          : `around ${idealMin} min`;
    const how = prefs.travel.mode ? ` ${MODE_WORDS[prefs.travel.mode]}` : "";
    lines.push(`Travel: ${text}${how}${LIMIT_WORDS[strength]}`);
  } else if (state.travelMode) lines.push(`Travel: ${MODE_WORDS[state.travelMode]}, no limit given`);
  else if (settled("travel")) lines.push("Travel: any distance");
  if (state.startPoint) lines.push(`Coming from: ${state.startPoint.label}`);

  const allergies = (prefs.notes ?? []).filter((n) => n.type === "allergy");
  if (prefs.dietary?.length) lines.push(`Diet: ${prefs.dietary.join(", ")}`);
  else if (settled("diet")) lines.push(`Diet: ${allergies.length ? "see the note below" : "no restrictions"}`);

  // What they asked for scores 1. Lower scores are the next best things code added (cuisine-table.ts)
  // and are not something the person said, so they are not listed. Labels come from the table:
  // people see "Korean, hot pot", never a type name.
  const liked = Object.entries(prefs.cuisine?.scores ?? {})
    .filter(([, score]) => score === 1)
    .map(([type]) => type);
  const excluded = prefs.cuisine?.excluded ?? [];
  if (liked.length)
    lines.push(`Would like to eat: ${describeTypes(liked).join(", ")}${STRENGTH_WORDS[prefs.cuisine!.strength]}`);
  else if (!excluded.length && !prefs.cuisine?.avoided?.length && settled("cuisine"))
    lines.push("Cuisine: no preference");
  if (excluded.length) lines.push(`Not for them: ${describeTypes(excluded).join(", ")}`);
  if (prefs.cuisine?.avoided?.length)
    lines.push(`Would rather not have: ${describeTypes(prefs.cuisine.avoided).join(", ")}`);

  if (prefs.style?.wanted?.length)
    lines.push(
      `Kind of place: ${prefs.style.wanted.map((s) => s.replaceAll("_", " ")).join(", ")}${STRENGTH_WORDS[prefs.style.strength]}`,
    );
  if (prefs.style?.excluded?.length)
    lines.push(`Not this kind of place: ${prefs.style.excluded.map((s) => s.replaceAll("_", " ")).join(", ")}`);

  if (prefs.features?.needed?.length)
    lines.push(`Needs: ${prefs.features.needed.map((f) => FEATURE_WORDS[f]).join(", ")}`);
  if (prefs.features?.wanted?.length)
    lines.push(
      `Nice to have: ${prefs.features.wanted.map((f) => FEATURE_WORDS[f]).join(", ")}${STRENGTH_WORDS[prefs.features.strength]}`,
    );

  // Whether a named place is among the plan's places is not known until its pool is complete.
  const named = (r: { name: string }) => r.name;
  if (prefs.wantedRestaurants?.length)
    lines.push(`Would like to go to: ${prefs.wantedRestaurants.map(named).join(", ")}`);
  if (prefs.excludedRestaurants?.length)
    lines.push(`Would rather not go to: ${prefs.excludedRestaurants.map(named).join(", ")}`);

  if (prefs.priority?.length)
    lines.push(`Matters most: ${prefs.priority.map((d) => PRIORITY_WORDS[d]).join(", then ")}`);

  for (const note of prefs.notes ?? [])
    lines.push(
      `${note.type === "allergy" ? "Allergy note (only you see this)" : "Note (only you see this)"}: ${note.text}`,
    );
  return lines;
}
