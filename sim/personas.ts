/**
 * MiroFish-style persona simulation against the real app.
 *
 *   seed document ──LLM──▶ N personas with personalities + HIDDEN true constraints
 *   each persona chats with Settle's private assistant (the real server-side
 *   code: createUser / createEvent / joinEvent / sendMessage / setReady)
 *   the real negotiation runs ──▶ personas see only the public plan and react
 *
 * Measures what the unit tests cannot: does natural, messy, in-character chat
 * actually get turned into the right constraints, and does the plan that
 * comes out feel right to the people whose numbers were never shared.
 *
 * Personas run on Claude via Anthropic's OpenAI-compatible endpoint (ANTHROPIC_API_KEY,
 * from the environment or .env.local); OPENROUTER_API_KEY or LLM_API_KEY + LLM_BASE_URL
 * override. Uses a throwaway SQLite file so local.db is untouched.
 * --llm-assistant also puts the assistant under test on the LLM path (needs ANTHROPIC_API_KEY).
 *
 *   node --require ./sim/shims/server-only.cjs --import tsx sim/personas.ts [--people 5] [--seed sim/seeds/friends.md]
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";

// ── env: Settle's .env.local (encryption key) + an LLM key from the usual places ──
function loadEnvFile(file: string) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
const ROOT = path.resolve(__dirname, "..");
loadEnvFile(path.join(ROOT, ".env.local"));

const args = process.argv.slice(2);
const arg = (name: string, def: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const PEOPLE = Number(arg("people", "5"));
const SEED_FILE = arg("seed", path.join(ROOT, "sim/seeds/friends.md"));
const OUT_DIR = arg("out", path.join(ROOT, "sim/out"));
const MAX_TURNS = Number(arg("turns", "14"));
const LOCATION = arg("location", "");

const LLM_KEY = process.env.LLM_API_KEY || process.env.OPENROUTER_API_KEY || process.env.ANTHROPIC_API_KEY;
// Default to Claude directly (Anthropic's OpenAI-compatible endpoint); OPENROUTER_API_KEY or LLM_* override.
const LLM_BASE =
  process.env.LLM_BASE_URL ||
  (process.env.LLM_API_KEY ? "https://api.openai.com/v1" : process.env.OPENROUTER_API_KEY ? "https://openrouter.ai/api/v1" : "https://api.anthropic.com/v1");
const LLM_MODEL = process.env.PERSONA_MODEL || process.env.LLM_MODEL_NAME || (process.env.OPENROUTER_API_KEY && !process.env.LLM_API_KEY ? "anthropic/claude-haiku-5.5" : "claude-haiku-5-5");
if (!LLM_KEY) {
  console.error("No LLM key. Put ANTHROPIC_API_KEY in .env.local (or run with OPENROUTER_API_KEY / LLM_API_KEY + LLM_BASE_URL).");
  process.exit(1);
}

// Throwaway database for this run.
mkdirSync(OUT_DIR, { recursive: true });
const DB_FILE = path.join(OUT_DIR, "personas.db");
for (const f of [DB_FILE, `${DB_FILE}-journal`, `${DB_FILE}-wal`, `${DB_FILE}-shm`]) if (existsSync(f)) rmSync(f);
process.env.DATABASE_URL = `file:${DB_FILE}`;
delete process.env.DATABASE_AUTH_TOKEN;
// The assistant under test runs on the rule-based path unless --llm-assistant is given.
if (!args.includes("--llm-assistant")) delete process.env.ANTHROPIC_API_KEY;
delete process.env.GOOGLE_PLACES_API_KEY;

// ── LLM client (OpenAI-compatible, like MiroFish's) ──
type Msg = { role: "system" | "user" | "assistant"; content: string };
let llmCalls = 0;
async function chat(messages: Msg[], opts: { json?: boolean; temperature?: number; maxTokens?: number } = {}): Promise<string> {
  llmCalls++;
  const body: Record<string, unknown> = { model: LLM_MODEL, messages, max_tokens: opts.maxTokens ?? 400 };
  // Claude 5 models reject `temperature` on the OpenAI-compatible endpoint; other providers still take it.
  if (!/api\.anthropic\.com/.test(LLM_BASE)) body.temperature = opts.temperature ?? 0.8;
  if (opts.json) body.response_format = { type: "json_object" };
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`${LLM_BASE}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${LLM_KEY}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    if (res.status === 429 || res.status >= 500) {
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      continue;
    }
    if (!res.ok) {
      const text = await res.text();
      // Some OpenAI-compatible endpoints (Anthropic's among them) reject response_format: ask again without it and parse leniently.
      if (res.status === 400 && body.response_format && /response_format/i.test(text)) {
        delete body.response_format;
        continue;
      }
      throw new Error(`LLM ${res.status}: ${text.slice(0, 300)}`);
    }
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return data.choices?.[0]?.message?.content?.trim() ?? "";
  }
  throw new Error("LLM: gave up after retries");
}
function parseJson<T>(text: string): T {
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  const start = cleaned.search(/[[{]/);
  return JSON.parse(cleaned.slice(start)) as T;
}

// ── Settle (imported after env is set so db/crypto pick it up) ──
async function settle() {
  const constraints = await import("../src/lib/constraints");
  const events = await import("../src/lib/events");
  const auth = await import("../src/lib/auth");
  const preferences = await import("../src/lib/preferences");
  const evaluate = await import("../src/lib/evaluate");
  const restaurants = await import("../src/lib/restaurants");
  return { ...constraints, ...events, ...auth, ...preferences, ...evaluate, ...restaurants };
}

// ── Personas ──
type Hidden = {
  availableSlots: string[];
  budgetMax: number;
  budgetFlex: number;
  maxTravelMin: number;
  dietary: string[];
  likedCuisines: string[];
  dislikedCuisines: string[];
  budgetVsTravel: "budget" | "travel";
  cuisineVsTravel: "cuisine" | "travel";
  concessionOrder: ("budget" | "travel" | "cuisine")[];
};
type Persona = {
  name: string;
  age: number;
  mbti: string;
  bio: string;
  persona: string;
  texting_style: string;
  openness: "forthcoming" | "vague" | "evasive";
  hidden: Hidden;
};

async function generatePersonas(seed: string, T: Awaited<ReturnType<typeof settle>>): Promise<Persona[]> {
  const sys = `You generate realistic simulated people for a social simulation (in the style of OASIS/MiroFish agent profiles).
Return ONLY a JSON object {"personas": [...]} with exactly ${PEOPLE} personas. Each persona:
{
  "name": first name, all distinct,
  "age": integer,
  "mbti": e.g. "INTP",
  "bio": one sentence,
  "persona": 3-5 sentences: personality, how they behave in group chats, what they would never say out loud and why,
  "texting_style": how they type (length, punctuation, slang, emoji, typos), 1-2 sentences,
  "openness": "forthcoming" | "vague" | "evasive"  (at least one "vague" and one "evasive"),
  "hidden": {
    "availableSlots": subset of ${JSON.stringify(T.SLOTS)} (1 to 5 items, realistic),
    "budgetMax": integer dollars per person 15..70,
    "budgetFlex": integer 0..15 (how far over they'd tolerate),
    "maxTravelMin": integer minutes 5..40,
    "dietary": subset of ${JSON.stringify(T.DIETARY)} (most people: []),
    "likedCuisines": 0-2 of ${JSON.stringify(T.CUISINES)},
    "dislikedCuisines": 0-2 of ${JSON.stringify(T.CUISINES)}, not overlapping liked,
    "budgetVsTravel": "budget" or "travel"  (which they'd rather protect),
    "cuisineVsTravel": "cuisine" or "travel",
    "concessionOrder": a permutation of ["budget","travel","cuisine"]: what they'd give up first
  }
}
Make the hidden constraints diverse and in tension with each other, but such that at least one restaurant could plausibly work for the group. The "hidden" block is ground truth the person knows about themselves but would not post in a group chat.`;
  const out = await chat([{ role: "system", content: sys }, { role: "user", content: `Seed document:\n\n${seed}` }], { json: true, temperature: 0.9, maxTokens: 2500 });
  const parsed = parseJson<{ personas: Persona[] }>(out);
  return parsed.personas.slice(0, PEOPLE);
}

const personaSystem = (p: Persona, T: Awaited<ReturnType<typeof settle>>) => `You are ${p.name}, ${p.age}, ${p.mbti}. ${p.bio}
${p.persona}
Texting style: ${p.texting_style}

You are texting with a private assistant inside an app your friends use to pick a restaurant for this weekend. Only you can see this chat; the group only ever sees the final plan. The assistant asks you questions; answer them as ${p.name} would, in character, in ONE short text message (max 25 words). Stay honest about your real situation, but you are "${p.openness}": a forthcoming person just answers; a vague person hedges first ("whatever works", "not fussed") and only gives specifics when pushed; an evasive person dodges once or twice and gives roundabout answers.

Your real situation (ground truth, in your own head):
- Free: ${p.hidden.availableSlots.map((s) => T.SLOT_LABELS[s as keyof typeof T.SLOT_LABELS] ?? s).join(", ")} (and NOT free at other times)
- Budget: about $${p.hidden.budgetMax} a head${p.hidden.budgetFlex ? `, could stretch to $${p.hidden.budgetMax + p.hidden.budgetFlex} if it's really worth it` : ", and that's firm"}
- Travel: up to ${p.hidden.maxTravelMin} minutes
- Diet: ${p.hidden.dietary.length ? p.hidden.dietary.map((d) => T.DIETARY_LABELS[d as keyof typeof T.DIETARY_LABELS] ?? d).join(", ") : "no restrictions"}
- Likes: ${p.hidden.likedCuisines.join(", ") || "nothing in particular"}; would rather avoid: ${p.hidden.dislikedCuisines.join(", ") || "nothing in particular"}
- If forced to choose, you protect your ${p.hidden.budgetVsTravel} over the other; a lukewarm cuisine bothers you ${p.hidden.cuisineVsTravel === "cuisine" ? "more" : "less"} than 10 extra minutes of travel
- If something has to give you'd drop, in order: ${p.hidden.concessionOrder.join(" → ")}

Never mention that you are an AI or that these are "constraints". Never dump everything at once; answer what was asked, the way you text. When the assistant says it has everything it needs, reply exactly: done`;

type Turn = { who: "assistant" | "persona"; text: string };

async function runPersonaChat(p: Persona, userId: string, eventId: string, T: Awaited<ReturnType<typeof settle>>) {
  const transcript: Turn[] = [];
  const history: Msg[] = [{ role: "system", content: personaSystem(p, T) }];
  let messages = await T.getMyMessages(eventId, userId);
  let last = messages[messages.length - 1];
  transcript.push({ who: "assistant", text: last.content });
  history.push({ role: "user", content: last.content });
  let done = false;
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const reply = (await chat(history, { temperature: 0.9, maxTokens: 80 })).replace(/^"|"$/g, "");
    history.push({ role: "assistant", content: reply });
    transcript.push({ who: "persona", text: reply });
    if (/^\W*done\W*$/i.test(reply)) {
      done = true;
      break;
    }
    const res = await T.sendMessage(eventId, userId, reply);
    messages = res.messages;
    last = messages[messages.length - 1];
    transcript.push({ who: "assistant", text: last.content });
    history.push({ role: "user", content: last.content });
  }
  const constraints = await T.getMyConstraints(eventId, userId);
  const missing = T.missingFields(constraints);
  let ready = false;
  if (missing.length === 0) {
    await T.setReady(eventId, userId, true);
    ready = true;
  }
  return { transcript, constraints, missing, ready, done, turns: transcript.filter((t) => t.who === "persona").length };
}

// ── Elicitation accuracy: what the assistant wrote down vs the ground truth ──
function setEq(a: readonly string[], b: readonly string[]) {
  const A = new Set(a), B = new Set(b);
  return A.size === B.size && [...A].every((x) => B.has(x));
}
function jaccard(a: readonly string[], b: readonly string[]) {
  const A = new Set(a), B = new Set(b);
  const inter = [...A].filter((x) => B.has(x)).length;
  const uni = new Set([...A, ...B]).size;
  return uni === 0 ? 1 : inter / uni;
}
type Accuracy = ReturnType<typeof accuracy>;
function accuracy(h: Hidden, c: { availableSlots: string[] | null; budgetMax: number | null; budgetFlex: number; maxTravelMin: number | null; dietary: string[]; dietaryConfirmed: boolean; likedCuisines: string[]; dislikedCuisines: string[]; weights: Record<string, number>; concessionOrder: string[] | null }) {
  return {
    slotsExact: setEq(h.availableSlots, c.availableSlots ?? []),
    slotsJaccard: jaccard(h.availableSlots, c.availableSlots ?? []),
    budgetWithin5: c.budgetMax !== null && Math.abs(c.budgetMax - h.budgetMax) <= 5,
    budgetDelta: c.budgetMax === null ? null : c.budgetMax - h.budgetMax,
    flexCaptured: h.budgetFlex > 0 ? c.budgetFlex > 0 : c.budgetFlex === 0,
    travelWithin5: c.maxTravelMin !== null && Math.abs(c.maxTravelMin - h.maxTravelMin) <= 5,
    travelDelta: c.maxTravelMin === null ? null : c.maxTravelMin - h.maxTravelMin,
    dietExact: c.dietaryConfirmed && setEq(h.dietary, c.dietary),
    likesJaccard: jaccard(h.likedCuisines, c.likedCuisines),
    dislikesJaccard: jaccard(h.dislikedCuisines, c.dislikedCuisines),
    budgetVsTravelRight: (c.weights.budget > c.weights.travel) === (h.budgetVsTravel === "budget") || c.weights.budget === c.weights.travel ? (c.weights.budget !== c.weights.travel) : false,
    concessionFirstRight: !!c.concessionOrder && c.concessionOrder[0] === h.concessionOrder[0],
  };
}

async function main() {
  const T = await settle();
  const seed = readFileSync(SEED_FILE, "utf8");
  console.log(`model ${LLM_MODEL} via ${LLM_BASE}\nseed ${SEED_FILE}\n`);

  console.log("generating personas…");
  const personas = await generatePersonas(seed, T);
  for (const p of personas) console.log(`  ${p.name} (${p.age}, ${p.mbti}, ${p.openness})`);

  // Real app objects
  const stamp = Date.now();
  const users = [] as { id: string; persona: Persona }[];
  for (const [i, p] of personas.entries()) {
    const u = await T.createUser({ email: `${p.name.toLowerCase()}${i}.${stamp}@personas.test`, displayName: p.name, password: "persona-pass-1234" });
    users.push({ id: u.id, persona: p });
  }
  const event = await T.createEvent(users[0].id, "Dinner this weekend", LOCATION || null);
  for (const u of users.slice(1)) await T.joinEvent(event.inviteCode, u.id);

  console.log("\nchatting with the assistant…");
  const chats = [] as { persona: Persona; userId: string; run: Awaited<ReturnType<typeof runPersonaChat>>; acc: Accuracy }[];
  for (const u of users) {
    const run = await runPersonaChat(u.persona, u.id, event.id, T);
    const acc = accuracy(u.persona.hidden, run.constraints);
    chats.push({ persona: u.persona, userId: u.id, run, acc });
    console.log(`  ${u.persona.name}: ${run.turns} turns, ready=${run.ready}${run.missing.length ? ` (still missing ${run.missing.join(",")})` : ""}`);
  }

  // Negotiation (only possible if everyone got to ready)
  const allReady = chats.every((c) => c.run.ready);
  let result: Awaited<ReturnType<typeof T.runNegotiation>> | null = null;
  let negotiationError: string | null = null;
  if (allReady) {
    try {
      result = await T.runNegotiation(event.id, users[0].id);
    } catch (e) {
      negotiationError = (e as Error).message;
    }
  }

  // Reactions: personas see the public plan only; compare with their true bucket
  const reactions = [] as { name: string; rating: number; comment: string; trueBucket: number; trueVerdict: string }[];
  if (result?.proposal) {
    const r = result.places[result.proposal.restaurantId] ?? T.getRestaurant(result.proposal.restaurantId);
    const line = `${T.SLOT_LABELS[result.proposal.slot]} · ${r?.name} · ~$${r?.pricePerPerson}/person · ${r?.travelMin} min away · ${r?.cuisine}`;
    for (const c of chats) {
      const sys = personaSystem(c.persona, T);
      const out = await chat(
        [
          { role: "system", content: sys },
          { role: "user", content: `The app just posted this to the group chat: "${line}". Rate how happy you honestly are with this plan from 1 (no way) to 5 (perfect) and say why in one short message, in character. Return ONLY JSON: {"rating": n, "comment": "..."}` },
        ],
        { json: true, temperature: 0.7, maxTokens: 120 },
      );
      const parsed = parseJson<{ rating: number; comment: string }>(out);
      const truePrefs = T.compile(T.mergeConstraints(T.emptyConstraints(), {
        availableSlots: c.persona.hidden.availableSlots as never,
        budgetMax: c.persona.hidden.budgetMax,
        budgetFlex: c.persona.hidden.budgetFlex,
        maxTravelMin: c.persona.hidden.maxTravelMin,
        dietary: c.persona.hidden.dietary as never,
        dietaryConfirmed: true,
        likedCuisines: c.persona.hidden.likedCuisines as never,
        dislikedCuisines: c.persona.hidden.dislikedCuisines as never,
        concessionOrder: c.persona.hidden.concessionOrder,
      }));
      const full = T.getRestaurant(result.proposal.restaurantId);
      const trueBucket = full ? T.bucket(truePrefs, full, result.proposal.slot) : 0;
      const trueVerdict = full ? T.evaluate(truePrefs, full, result.proposal.slot).verdict : "?";
      reactions.push({ name: c.persona.name, rating: Number(parsed.rating), comment: parsed.comment, trueBucket, trueVerdict });
    }
  }

  // ── Report ──
  const md: string[] = [];
  md.push(`# Persona simulation against Settle`, ``, `Model: \`${LLM_MODEL}\` · ${personas.length} personas · assistant on the rule-based path · ${llmCalls} LLM calls · ${new Date().toISOString()}`, ``);
  md.push(`Seed: \`${path.relative(ROOT, SEED_FILE)}\``, ``);
  md.push(`## Personas`, ``);
  for (const p of personas) {
    md.push(`### ${p.name} (${p.age}, ${p.mbti}, ${p.openness})`, ``, p.bio, ``, p.persona, ``, `_Texting style:_ ${p.texting_style}`, ``, "```json", JSON.stringify(p.hidden), "```", ``);
  }
  md.push(`## Elicitation accuracy`, ``, `What the assistant wrote down vs. the persona's ground truth.`, ``);
  md.push(`| person | turns | ready | slots exact | slots J | budget Δ | flex ok | travel Δ | diet exact | likes J | dislikes J | budget/travel weight | concession first |`);
  md.push(`|---|---:|---|---|---:|---:|---|---:|---|---:|---:|---|---|`);
  for (const c of chats) {
    const a = c.acc;
    md.push(`| ${c.persona.name} | ${c.run.turns} | ${c.run.ready ? "yes" : `no (${c.run.missing.join(", ")})`} | ${a.slotsExact ? "✓" : "✗"} | ${a.slotsJaccard.toFixed(2)} | ${a.budgetDelta ?? "–"} | ${a.flexCaptured ? "✓" : "✗"} | ${a.travelDelta ?? "–"} | ${a.dietExact ? "✓" : "✗"} | ${a.likesJaccard.toFixed(2)} | ${a.dislikesJaccard.toFixed(2)} | ${a.budgetVsTravelRight ? "✓" : "✗"} | ${a.concessionFirstRight ? "✓" : "✗"} |`);
  }
  const rate = (k: keyof Accuracy) => `${Math.round((chats.filter((c) => c.acc[k] === true).length / chats.length) * 100)}%`;
  md.push(``, `Exact slots ${rate("slotsExact")} · budget within $5 ${rate("budgetWithin5")} · travel within 5 min ${rate("travelWithin5")} · diet exact ${rate("dietExact")} · weight direction ${rate("budgetVsTravelRight")} · first concession ${rate("concessionFirstRight")}`, ``);

  md.push(`## Negotiation`, ``);
  if (!allReady) md.push(`Not run: ${chats.filter((c) => !c.run.ready).map((c) => c.persona.name).join(", ")} never reached "ready" (the assistant was still missing essentials after ${MAX_TURNS} turns).`, ``);
  else if (negotiationError) md.push(`Failed: ${negotiationError}`, ``);
  else if (result) {
    const r = result.proposal ? (result.places[result.proposal.restaurantId] ?? T.getRestaurant(result.proposal.restaurantId)) : null;
    md.push(`**${result.status}** after ${result.rounds.length} round(s), concession level ${result.concessionLevel}, ${result.leakedDims} dimension names seen by the mediator.`, ``);
    if (result.proposal && r) md.push(`Plan: **${r.name}**, ${T.SLOT_LABELS[result.proposal.slot]}, ~$${r.pricePerPerson}/person, ${r.travelMin} min, ${r.cuisine}.`, ``);
    if (result.reservations.length) md.push(`Reservations: ${result.reservations.map((x) => `${result!.memberNames[x.member]} (${x.dim})`).join(", ")}`, ``);
    if (result.conflicts.length) md.push(`Conflicts: ${result.conflicts.join(", ")}`, ``);
    for (const round of result.rounds) {
      md.push(`- Round ${round.round}${round.level ? ` (concession ${round.level})` : ""}: ` + round.proposals.map((p) => {
        const pr = result!.places[p.proposal.restaurantId] ?? T.getRestaurant(p.proposal.restaurantId);
        return `${p.retried ? "↺ " : ""}${pr?.name} ${T.SLOT_LABELS[p.proposal.slot]} ${p.tally.accept}/${p.tally.reluctant}/${p.tally.reject}`;
      }).join(" · "));
    }
    md.push(``);
  }

  if (reactions.length) {
    md.push(`## Reactions (personas see only the public plan)`, ``, `| person | says | true verdict | true bucket | comment |`, `|---|---:|---|---:|---|`);
    for (const x of reactions) md.push(`| ${x.name} | ${x.rating}/5 | ${x.trueVerdict} | ${x.trueBucket} | ${x.comment.replace(/\|/g, "/")} |`);
    const agree = reactions.filter((x) => Math.abs(x.rating - x.trueBucket) <= 1).length;
    md.push(``, `Self-reported rating within 1 of the true utility bucket: ${agree}/${reactions.length}.`, ``);
  }

  md.push(`## Transcripts`, ``);
  for (const c of chats) {
    md.push(`### ${c.persona.name}`, ``);
    for (const t of c.run.transcript) md.push(`- **${t.who === "assistant" ? "assistant" : c.persona.name}:** ${t.text.replace(/\n/g, " ")}`);
    md.push(``, `Assistant's summary: ${T.describeConstraints(c.run.constraints).join(" · ") || "(nothing)"}`, ``);
  }

  const outMd = path.join(OUT_DIR, "personas-report.md");
  writeFileSync(outMd, md.join("\n"));
  writeFileSync(path.join(OUT_DIR, "personas-run.json"), JSON.stringify({ model: LLM_MODEL, personas, chats: chats.map((c) => ({ name: c.persona.name, run: c.run, acc: c.acc })), result, reactions }, null, 2));
  console.log(`\nwrote ${outMd}`);
  if (result) console.log(`negotiation: ${result.status}`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
