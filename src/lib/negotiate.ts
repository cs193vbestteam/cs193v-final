import { SLOTS, type Slot } from "./constraints";
import type { Judgement, Proposal, Reason, Verdict } from "./evaluate";
import { RESTAURANTS, type Restaurant } from "./restaurants";

/**
 * The negotiation engine.
 *
 * Privacy by construction: the engine never receives anyone's constraints.
 * It only gets one opaque `Assistant` function per member, which answers
 * yes / meh / no (+ a reason category) for a proposal. The engine adapts
 * its next proposals from those answers alone, round by round.
 */

export type Assistant = (p: Proposal) => Judgement;

export type Tally = { yes: number; meh: number; no: number; reasons: Partial<Record<Reason, number>> };

export type RoundLog = { round: number; proposals: { proposal: Proposal; tally: Tally }[] };

export type NegotiationResult = {
  status: "agreed" | "compromise" | "no_option";
  proposal: Proposal | null;
  tally: Tally | null;
  rounds: RoundLog[];
};

export type NegotiateOptions = {
  restaurants?: Restaurant[];
  maxRounds?: number;
  perRound?: number;
};

type Hints = {
  priceCeiling: number; // proposals at/above this got a "no" for price
  priceSoftCeiling: number; // proposals at/above this got a "meh" for price
  travelCeiling: number;
  travelSoftCeiling: number;
  badSlots: Set<Slot>; // a "no" for time with an otherwise-open restaurant
  badRestaurants: Set<string>; // rejected for diet
  riskyFlags: { spicy: number; seafoodHeavy: number; notVeg: number; notHalal: number };
  mehCuisines: Map<string, number>;
};

const key = (p: Proposal) => `${p.restaurantId}@${p.slot}`;

function tallyOf(judgements: Judgement[]): Tally {
  const t: Tally = { yes: 0, meh: 0, no: 0, reasons: {} };
  for (const j of judgements) {
    t[j.verdict]++;
    if (j.reason) t.reasons[j.reason] = (t.reasons[j.reason] ?? 0) + 1;
  }
  return t;
}

/** Lower is better. */
function scoreTally(t: Tally): number {
  return t.no * 100 + t.meh * 10;
}

function learn(h: Hints, r: Restaurant, judgements: Judgement[]) {
  for (const j of judgements) {
    if (!j.reason) continue;
    const hard = j.verdict === "no";
    switch (j.reason) {
      case "price":
        if (hard) h.priceCeiling = Math.min(h.priceCeiling, r.pricePerPerson);
        else h.priceSoftCeiling = Math.min(h.priceSoftCeiling, r.pricePerPerson);
        break;
      case "distance":
        if (hard) h.travelCeiling = Math.min(h.travelCeiling, r.travelMin);
        else h.travelSoftCeiling = Math.min(h.travelSoftCeiling, r.travelMin);
        break;
      case "diet":
        h.badRestaurants.add(r.id);
        if (r.spicy) h.riskyFlags.spicy++;
        if (r.seafoodHeavy) h.riskyFlags.seafoodHeavy++;
        if (!r.vegetarianFriendly) h.riskyFlags.notVeg++;
        if (!r.halal) h.riskyFlags.notHalal++;
        break;
      case "cuisine":
        h.mehCuisines.set(r.cuisine, (h.mehCuisines.get(r.cuisine) ?? 0) + 1);
        break;
      case "time":
        break; // handled per-slot below
    }
  }
}

function heuristic(h: Hints, r: Restaurant, slot: Slot): number {
  let s = 0;
  if (r.pricePerPerson >= h.priceCeiling) s += 1000;
  else if (r.pricePerPerson >= h.priceSoftCeiling) s += 50;
  if (r.travelMin >= h.travelCeiling) s += 1000;
  else if (r.travelMin >= h.travelSoftCeiling) s += 50;
  if (h.badSlots.has(slot)) s += 1000;
  if (h.badRestaurants.has(r.id)) s += 1000;
  if (r.spicy) s += 40 * h.riskyFlags.spicy;
  if (r.seafoodHeavy) s += 40 * h.riskyFlags.seafoodHeavy;
  if (!r.vegetarianFriendly) s += 40 * h.riskyFlags.notVeg;
  if (!r.halal) s += 40 * h.riskyFlags.notHalal;
  s += 15 * (h.mehCuisines.get(r.cuisine) ?? 0);
  // Mild prior: start mid-range and nearby, so early rounds are informative.
  s += Math.abs(r.pricePerPerson - 30) * 0.3 + r.travelMin * 0.2;
  return s;
}

export function negotiate(assistants: Assistant[], opts: NegotiateOptions = {}): NegotiationResult {
  const restaurants = opts.restaurants ?? RESTAURANTS;
  const maxRounds = opts.maxRounds ?? 5;
  const perRound = opts.perRound ?? 3;

  if (assistants.length === 0) return { status: "no_option", proposal: null, tally: null, rounds: [] };

  const candidates: { r: Restaurant; slot: Slot }[] = [];
  for (const r of restaurants) for (const slot of SLOTS) if (r.open.includes(slot)) candidates.push({ r, slot });

  const hints: Hints = {
    priceCeiling: Infinity,
    priceSoftCeiling: Infinity,
    travelCeiling: Infinity,
    travelSoftCeiling: Infinity,
    badSlots: new Set(),
    badRestaurants: new Set(),
    riskyFlags: { spicy: 0, seafoodHeavy: 0, notVeg: 0, notHalal: 0 },
    mehCuisines: new Map(),
  };
  const tried = new Map<string, { proposal: Proposal; tally: Tally }>();
  const rounds: RoundLog[] = [];

  for (let round = 1; round <= maxRounds; round++) {
    const ranked = candidates
      .filter((c) => !tried.has(key({ restaurantId: c.r.id, slot: c.slot })))
      .map((c, i) => ({ ...c, score: heuristic(hints, c.r, c.slot), i }))
      .sort((a, b) => a.score - b.score || a.i - b.i);

    // Prefer distinct restaurants within a round so each round explores more.
    const picks: typeof ranked = [];
    for (const c of ranked) {
      if (picks.length >= perRound) break;
      if (!picks.some((p) => p.r.id === c.r.id)) picks.push(c);
    }
    if (picks.length === 0) break;

    const log: RoundLog = { round, proposals: [] };
    let winner: { proposal: Proposal; tally: Tally } | null = null;

    for (const { r, slot } of picks) {
      const proposal: Proposal = { restaurantId: r.id, slot };
      const judgements = assistants.map((ask) => ask(proposal));
      const tally = tallyOf(judgements);
      learn(hints, r, judgements);
      // A time "no" at a restaurant that IS open then means a person can't make that slot.
      if (judgements.some((j) => j.verdict === "no" && j.reason === "time")) hints.badSlots.add(slot);

      const entry = { proposal, tally };
      tried.set(key(proposal), entry);
      log.proposals.push(entry);
      if (!winner && tally.yes === assistants.length) winner = entry;
    }
    rounds.push(log);
    if (winner) return { status: "agreed", ...winner, rounds };
  }

  const best = [...tried.values()].sort((a, b) => scoreTally(a.tally) - scoreTally(b.tally))[0];
  if (!best || best.tally.no > 0) {
    return { status: "no_option", proposal: best?.proposal ?? null, tally: best?.tally ?? null, rounds };
  }
  return { status: "compromise", ...best, rounds };
}

export function verdictEmoji(v: Verdict): string {
  return v === "yes" ? "✓" : v === "meh" ? "~" : "✗";
}
