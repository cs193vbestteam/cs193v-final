import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeAgent } from "@/lib/agent";
import { createUser } from "@/lib/auth";
import {
  ConstraintsSchema,
  describeConstraints,
  emptyConstraints,
  mergeConstraints,
  nextProbe,
  type Constraints,
} from "@/lib/constraints";
import { resetDbForTests } from "@/lib/db";
import {
  createEvent,
  getMyConstraints,
  getMyMessages,
  getResult,
  joinEvent,
  runNegotiation,
  sendMessage,
  setReady,
} from "@/lib/events";
import { PENDING_QUESTIONS, answerPending, extractRules, extractStart, ruleTurn } from "@/lib/extract-rules";
import { centroid, haversineKm, travelMinutes, type LatLng } from "@/lib/geo";
import { toPool, type PlaceResult } from "@/lib/places";
import { addDays, todayPacific } from "@/lib/plan-date";
import { summarize } from "@/lib/pool";
import { openOn, weekdayOf } from "@/lib/opening-hours";
import { compile } from "@/lib/preferences";
import { RESTAURANTS, type Restaurant } from "@/lib/restaurants";
import { MAX_START_KM, START_UNAVAILABLE, canLocate, resolveStart, startNotFound } from "@/lib/start-point";

const fixture = JSON.parse(readFileSync(path.join(__dirname, "fixtures/places-nearby.json"), "utf8")) as {
  places: PlaceResult[];
};

const STANFORD: LatLng = { lat: 37.4275, lng: -122.1697 };
const MOUNTAIN_VIEW: LatLng = { lat: 37.3861, lng: -122.0839 };
const NEW_YORK: LatLng = { lat: 40.7128, lng: -74.006 };
/** A Saturday, when every place in the fixture is open; the plans below are made for the next one. */
const SATURDAY = "2026-11-21";
const nextSaturday = () => {
  const today = todayPacific();
  return addDays(today, (6 - weekdayOf(today) + 7) % 7);
};
const POOL = toPool(fixture.places, STANFORD).map((r) => openOn(r, SATURDAY));

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const found = (p: LatLng) => ({ places: [{ location: { latitude: p.lat, longitude: p.lng } }] });

/** A Places stand-in: geocodes the names in `known`, and serves the fixture as the nearby page. */
function placesFetch(known: Record<string, LatLng>) {
  const geocoded: { textQuery: string; locationBias?: unknown }[] = [];
  const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { textQuery?: string; includedTypes?: string[] };
    if (String(url).includes("searchText")) {
      geocoded.push(body as { textQuery: string });
      const hit = Object.keys(known).find((name) => body.textQuery!.toLowerCase().includes(name.toLowerCase()));
      return json(hit ? found(known[hit]) : { places: [] });
    }
    return json(body.includedTypes?.join() === "restaurant" ? fixture : { places: [] });
  });
  return { fetcher: fetcher as unknown as typeof fetch, geocoded };
}

const essentials: Constraints = {
  ...emptyConstraints(),
  availableSlots: ["18:00"],
  budgetMax: 60,
  maxTravelMin: 10,
  dietaryConfirmed: true,
  // The cuisine question comes before the start point; these tests begin after it.
  probesAsked: ["cuisine"],
};

describe("geo", () => {
  it("estimates travel at city speed, never under three minutes", () => {
    expect(travelMinutes(STANFORD, STANFORD)).toBe(3);
    const km = haversineKm(STANFORD, MOUNTAIN_VIEW);
    expect(km).toBeGreaterThan(8);
    expect(km).toBeLessThan(10);
    expect(travelMinutes(STANFORD, MOUNTAIN_VIEW)).toBe(Math.round(km / (25 / 60)));
  });
  it("finds the centre of a set of points", () => {
    expect(centroid([])).toBeNull();
    expect(
      centroid([
        { lat: 10, lng: 20 },
        { lat: 20, lng: 40 },
      ]),
    ).toEqual({ lat: 15, lng: 30 });
  });
});

describe("candidate coordinates", () => {
  it("Places candidates carry their location; the seed pool has none", () => {
    expect(POOL.length).toBeGreaterThan(0);
    for (const r of POOL) expect(r.location).toEqual({ lat: expect.any(Number), lng: expect.any(Number) });
    expect(RESTAURANTS.every((r) => r.location === undefined)).toBe(true);
  });
});

describe("start point in constraints", () => {
  const start = { label: "Mountain View", ...MOUNTAIN_VIEW };

  it("defaults to none, including for constraints stored before this field existed", () => {
    expect(emptyConstraints().startPoint).toBeNull();
    const legacy: Record<string, unknown> = emptyConstraints();
    delete legacy.startPoint;
    expect(ConstraintsSchema.parse(legacy).startPoint).toBeNull();
  });

  it("is set by a resolved point and cleared by a null startText", () => {
    const withStart = mergeConstraints(essentials, { startPoint: start });
    expect(withStart.startPoint).toEqual(start);
    expect(mergeConstraints(withStart, { budgetMax: 40 }).startPoint).toEqual(start);
    expect(mergeConstraints(withStart, { startText: null }).startPoint).toBeNull();
  });

  it("is not changed by unresolved text: coordinates only come from geocoding", () => {
    expect(mergeConstraints(essentials, { startText: "Mountain View" }).startPoint).toBeNull();
  });

  it("shows up in the owner's own summary", () => {
    expect(describeConstraints(mergeConstraints(essentials, { startPoint: start }))).toContain(
      "Coming from: Mountain View",
    );
    expect(describeConstraints(essentials).join()).not.toContain("Coming from");
  });

  it("is asked about only when the plan can use it and it is not known yet", () => {
    expect(nextProbe(essentials)).toBe("concession");
    expect(nextProbe(essentials, { askStart: true })).toBe("start_point");
    expect(nextProbe({ ...essentials, startPoint: start }, { askStart: true })).toBe("concession");
    expect(nextProbe({ ...essentials, probesAsked: ["cuisine", "start_point"] }, { askStart: true })).toBe(
      "concession",
    );
    expect(nextProbe(emptyConstraints(), { askStart: true })).toBeNull();
  });
});

describe("reading a start point from the chat (rules)", () => {
  it.each([
    ["I'm coming from Mountain View", "Mountain View"],
    ["I'll be driving from downtown Palo Alto, so not too far please", "downtown Palo Alto"],
    ["i live near Castro Street and I'm free Saturday", "Castro Street"],
    ["I'm based in Menlo Park.", "Menlo Park"],
    ["Leaving from the Caltrain station!", "the Caltrain station"],
  ])("%s → %s", (text, place) => {
    expect(extractStart(text)).toBe(place);
    expect(extractRules(text).startText).toBe(place);
  });

  it("does not mistake distances or budgets for a start point", () => {
    for (const text of [
      "max 20 minutes from campus",
      "under $40",
      "Saturday dinner only",
      "nothing from the sea please",
    ])
      expect(extractStart(text), text).toBeUndefined();
  });

  it("asks once the essentials are in, and only when the plan can use it", () => {
    const before = { ...essentials, dietaryConfirmed: false };
    expect(ruleTurn("no restrictions", before).update.pending).toBe("concession");
    const turn = ruleTurn("no restrictions", before, { askStart: true });
    expect(turn.update.pending).toBe("start_point");
    expect(turn.update.probesAsked).toEqual(["start_point"]);
    // Without the cuisine question behind them, that one comes first.
    expect(ruleTurn("no restrictions", { ...before, probesAsked: [] }, { askStart: true }).update.pending).toBe(
      "cuisine",
    );
    expect(turn.reply).toContain(PENDING_QUESTIONS.start_point);
  });

  it("takes the answer to the question as a place, then moves on", () => {
    const asked: Constraints = { ...essentials, pending: "start_point", probesAsked: ["cuisine", "start_point"] };
    expect(answerPending("Mountain View", "start_point", asked.weights)).toEqual({
      startText: "Mountain View",
      pending: null,
    });
    expect(answerPending("near Koreatown", "start_point", asked.weights)).toEqual({
      startText: "Koreatown",
      pending: null,
    });
    const turn = ruleTurn("from downtown Palo Alto", asked, { askStart: true });
    expect(turn.update.startText).toBe("downtown Palo Alto");
    expect(turn.update.pending).toBe("concession");
  });

  it("lets the person skip", () => {
    const asked: Constraints = { ...essentials, pending: "start_point", probesAsked: ["cuisine", "start_point"] };
    for (const text of ["skip", "I'd rather not", "no"])
      expect(answerPending(text, "start_point", asked.weights), text).toEqual({ pending: null });
    const turn = ruleTurn("skip", asked, { askStart: true });
    expect(turn.update.startText).toBeUndefined();
    expect(turn.update.pending).toBe("concession");
  });

  it("does not read another constraint as a place", () => {
    const asked: Constraints = { ...essentials, pending: "start_point", probesAsked: ["cuisine", "start_point"] };
    expect(answerPending("actually my budget is $25", "start_point", asked.weights)).toBeNull();
    const turn = ruleTurn("actually my budget is $25", asked, { askStart: true });
    expect(turn.update.budgetMax).toBe(25);
    expect(turn.update.startText).toBeUndefined();
  });
});

describe("resolveStart", () => {
  const update = { startText: "Mountain View", budgetMax: 30 };

  it("geocodes the text near the candidate pool and keeps the rest of the update", async () => {
    const { fetcher, geocoded } = placesFetch({ "Mountain View": MOUNTAIN_VIEW });
    const out = await resolveStart(update, "Got it.", POOL, "k", fetcher);
    expect(out.update).toEqual({ budgetMax: 30, startPoint: { label: "Mountain View", ...MOUNTAIN_VIEW } });
    expect(out.reply).toBe("Got it.");
    expect(geocoded).toHaveLength(1);
    expect(geocoded[0].textQuery).toBe("Mountain View");
    const bias = geocoded[0].locationBias as { circle: { center: { latitude: number; longitude: number } } };
    expect(haversineKm({ lat: bias.circle.center.latitude, lng: bias.circle.center.longitude }, STANFORD)).toBeLessThan(
      5,
    );
  });

  it("leaves an update without a start point alone and makes no call", async () => {
    const { fetcher, geocoded } = placesFetch({});
    expect(await resolveStart({ budgetMax: 30 }, "ok", POOL, "k", fetcher)).toEqual({
      update: { budgetMax: 30 },
      reply: "ok",
    });
    expect(await resolveStart({ startText: null }, "ok", POOL, "k", fetcher)).toEqual({
      update: { startText: null },
      reply: "ok",
    });
    expect(geocoded).toHaveLength(0);
  });

  it("says so, and keeps the rest, when the place can't be found", async () => {
    const { fetcher } = placesFetch({});
    const out = await resolveStart({ startText: "Zzyzx Qwerty", budgetMax: 30 }, "Got it.", POOL, "k", fetcher);
    expect(out.update).toEqual({ budgetMax: 30 });
    expect(out.reply).toBe(`Got it. ${startNotFound("Zzyzx Qwerty")}`);
  });

  it("rejects a match in the wrong part of the world", async () => {
    expect(haversineKm(NEW_YORK, STANFORD)).toBeGreaterThan(MAX_START_KM);
    const { fetcher } = placesFetch({ Chelsea: NEW_YORK });
    const out = await resolveStart({ startText: "Chelsea" }, "Got it.", POOL, "k", fetcher);
    expect(out.update).toEqual({});
    expect(out.reply).toContain(startNotFound("Chelsea"));
  });

  it("falls back to the plan's location when the geocoder errors", async () => {
    const boom = vi.fn(async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const out = await resolveStart(update, "Got it.", POOL, "k", boom);
    expect(out.update).toEqual({ budgetMax: 30 });
    expect(out.reply).toContain(startNotFound("Mountain View"));
  });

  it("is unavailable without a key or on a pool without coordinates, and never calls out", async () => {
    const { fetcher, geocoded } = placesFetch({ "Mountain View": MOUNTAIN_VIEW });
    for (const [pool, key] of [
      [POOL, undefined],
      [RESTAURANTS, "k"],
    ] as const) {
      expect(canLocate(pool, key)).toBe(false);
      const out = await resolveStart(update, "Got it.", pool, key, fetcher);
      expect(out.update).toEqual({ budgetMax: 30 });
      expect(out.reply).toBe(`Got it. ${START_UNAVAILABLE}`);
    }
    expect(canLocate(POOL, "k")).toBe(true);
    expect(geocoded).toHaveLength(0);
  });
});

describe("an assistant judges its own person's trip", () => {
  const sushi = POOL.find((r) => r.id === "ChIJ_sushi")!;
  const lookup = (id: string) => POOL.find((r) => r.id === id);
  const prefs = compile(essentials); // at most 10 min, hard limit 20
  const proposal = { restaurantId: sushi.id, slot: "18:00" as const };

  it("two people with the same preferences can disagree because they start in different places", () => {
    expect(sushi.travelMin).toBe(3); // from the plan's location
    expect(travelMinutes(MOUNTAIN_VIEW, sushi.location!)).toBeGreaterThan(20);
    const nearby = makeAgent(prefs, lookup, STANFORD);
    const farAway = makeAgent(prefs, lookup, MOUNTAIN_VIEW);
    expect(nearby.judge(proposal, 0)).toEqual({ verdict: "accept" });
    expect(farAway.judge(proposal, 0)).toEqual({ verdict: "reject", dim: "distance" });
    expect(farAway.bucket(proposal, 0)).toBe(1);
    expect(nearby.bucket(proposal, 0)).toBeGreaterThan(1);
  });

  it("uses the plan-wide estimate without a start point, or for a candidate without coordinates", () => {
    expect(makeAgent(prefs, lookup).judge(proposal, 0)).toEqual({ verdict: "accept" });
    const unlocated: Restaurant = { ...sushi, location: undefined };
    const agent = makeAgent(prefs, () => unlocated, MOUNTAIN_VIEW);
    expect(agent.judge(proposal, 0)).toEqual({ verdict: "accept" });
  });

  it("answers in verdicts and buckets only: the start point is not reachable from the agent", () => {
    const agent = makeAgent(prefs, lookup, MOUNTAIN_VIEW);
    expect(Object.keys(agent).sort()).toEqual(["bucket", "freeAt", "judge"]);
    expect(JSON.stringify(agent)).toBe("{}");
    expect(JSON.stringify(agent.judge(proposal, 0))).not.toMatch(/37\.|122\.|\d{2}/);
  });
});

describe("the group result", () => {
  it("omits travel time for candidates with coordinates and keeps it for the seed", () => {
    const real = summarize(POOL, [POOL[0].id]);
    expect(real[POOL[0].id]).toEqual({
      name: POOL[0].name,
      cuisine: POOL[0].cuisine,
      pricePerPerson: POOL[0].pricePerPerson,
    });
    const seed = summarize(RESTAURANTS, [RESTAURANTS[0].id]);
    expect(seed[RESTAURANTS[0].id].travelMin).toBe(RESTAURANTS[0].travelMin);
  });
});

describe("end to end with a real-places pool", () => {
  let n = 0;
  const makeUser = (name: string) =>
    createUser({ email: `${name}${n++}@start.dev`, displayName: name, password: "password123" });

  beforeEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    process.env.GOOGLE_PLACES_API_KEY = "test-places-key";
    resetDbForTests();
    vi.stubGlobal("fetch", placesFetch({ Stanford: STANFORD, "Mountain View": MOUNTAIN_VIEW }).fetcher);
  });
  afterEach(() => {
    delete process.env.GOOGLE_PLACES_API_KEY;
    vi.unstubAllGlobals();
  });

  it("a member's own start point changes the outcome and never reaches the group", async () => {
    const a = await makeUser("Alice");
    const b = await makeUser("Bob");
    const event = await createEvent(a.id, "Saturday dinner", "Stanford, CA", "meal", nextSaturday());
    expect(event.poolSource).toBe("places");
    await joinEvent(event.inviteCode, b.id);

    const prefs = "Saturday dinner only, under $60, max 10 minutes away, no restrictions";
    for (const u of [a, b]) {
      await sendMessage(event.id, u.id, prefs);
      await setReady(event.id, u.id, true);
    }
    // With the essentials in, the assistant asks about cuisine, then where they are coming from.
    await sendMessage(event.id, b.id, "no preference");
    await setReady(event.id, b.id, true);
    const chat = await getMyMessages(event.id, b.id);
    expect(chat[chat.length - 1].content).toContain(PENDING_QUESTIONS.start_point);

    // Nobody has given a start point: both are measured from the plan's location and agree.
    expect((await runNegotiation(event.id, a.id)).status).toBe("agreed");

    // Bob turns out to be coming from Mountain View, more than 20 minutes from every candidate.
    await sendMessage(event.id, b.id, "Mountain View");
    const bobs = await getMyConstraints(event.id, b.id);
    expect(bobs.startPoint).toEqual({ label: "Mountain View", ...MOUNTAIN_VIEW });
    expect((await getMyConstraints(event.id, a.id)).startPoint).toBeNull();
    await setReady(event.id, b.id, true);

    const result = await runNegotiation(event.id, a.id);
    expect(result.status).toBe("no_deal");

    const stored = JSON.stringify(await getResult(event.id, a.id));
    expect(stored).not.toMatch(/Mountain View|startPoint|37\.38|122\.08/);
    for (const place of Object.values(result.places)) expect(place).not.toHaveProperty("travelMin");
    // Alice's own chat and summary say nothing about where Bob is.
    expect(JSON.stringify(await getMyMessages(event.id, a.id))).not.toContain("Mountain View");
  });

  it("tells the person when their start point can't be placed, and keeps the plan's location", async () => {
    const a = await makeUser("Alice");
    const event = await createEvent(a.id, "Saturday dinner", "Stanford, CA", "meal", nextSaturday());
    await sendMessage(event.id, a.id, "Saturday dinner only, under $60, max 10 minutes away, no restrictions");
    await sendMessage(event.id, a.id, "no preference"); // the cuisine question
    const { messages, constraints } = await sendMessage(event.id, a.id, "Zzyzx Qwerty");
    expect(constraints.startPoint).toBeNull();
    expect(messages[messages.length - 1].content).toContain(startNotFound("Zzyzx Qwerty"));
  });
});
