import { z } from "zod";
import { PENDING, PROBES, StartPointSchema, describeSlots, type MissingField, type Slot } from "./constraints";
import { describeTypes } from "./cuisine-table";
import {
  PersonPreferencesSchema,
  START_TIMES,
  startTimesIn,
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
      rules: { pending: null, probesAsked: [] },
    },
    startPoint: null,
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
  return VARIABLES.filter((v) => !answered.includes(v) && (!asked.includes(v) || REQUIRED.includes(v)));
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
const STRENGTH_WORDS: Record<Strength, string> = { must: " (matters most)", strong: " (matters a lot)", mild: "" };
const PRIORITY_WORDS: Record<string, string> = {
  time: "the time",
  budget: "the budget",
  travel: "the distance",
  cuisine: "the food",
  style: "the kind of place",
};

/** What the assistant has recorded, in plain words. Shown ONLY to the person it is about. */
export function describeState(state: MemberState): string[] {
  const { prefs, chat } = state;
  const settled = (v: Variable) => chat.answered.includes(v);
  const lines: string[] = [];

  if (prefs.time) {
    lines.push(`Free: ${describeSlots(availableTimes(prefs) as Slot[])}`);
    if (prefs.time.strength !== "must" && prefs.time.preferred?.length)
      lines.push(
        `Would like: ${describeSlots(timesIn(prefs.time.preferred) as Slot[])}${STRENGTH_WORDS[prefs.time.strength]}`,
      );
  } else if (settled("time")) lines.push("Free: any time");

  if (prefs.budget) {
    const { ideal, max, strength } = prefs.budget;
    const text =
      max !== undefined && ideal !== undefined && ideal < max
        ? `ideally $${ideal}, up to $${max}/person`
        : max !== undefined
          ? `up to $${max}/person`
          : `around $${ideal}/person`;
    lines.push(`Budget: ${text}${STRENGTH_WORDS[strength]}`);
  } else if (settled("budget")) lines.push("Budget: no limit");

  if (prefs.travel) {
    const { idealMin, maxMin, strength } = prefs.travel;
    const text =
      maxMin !== undefined && idealMin !== undefined && idealMin < maxMin
        ? `ideally ${idealMin} min, up to ${maxMin} min`
        : maxMin !== undefined
          ? `up to ${maxMin} min`
          : `around ${idealMin} min`;
    lines.push(`Travel: ${text}${STRENGTH_WORDS[strength]}`);
  } else if (settled("travel")) lines.push("Travel: any distance");
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
  else if (!excluded.length && settled("cuisine")) lines.push("Cuisine: no preference");
  if (excluded.length) lines.push(`Not for them: ${describeTypes(excluded).join(", ")}`);

  if (prefs.style?.wanted?.length)
    lines.push(
      `Kind of place: ${prefs.style.wanted.map((s) => s.replaceAll("_", " ")).join(", ")}${STRENGTH_WORDS[prefs.style.strength]}`,
    );
  if (prefs.style?.excluded?.length)
    lines.push(`Not this kind of place: ${prefs.style.excluded.map((s) => s.replaceAll("_", " ")).join(", ")}`);

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
