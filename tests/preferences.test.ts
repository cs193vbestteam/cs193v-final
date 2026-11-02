import { describe, expect, it } from "vitest";
import { emptyConstraints, mergeConstraints } from "@/lib/constraints";
import { compile, relax, PreferencesSchema, TRAVEL_GRACE_MIN } from "@/lib/preferences";

const c = (o: Parameters<typeof mergeConstraints>[1]) => mergeConstraints(emptyConstraints(), o);

describe("compile", () => {
  it("produces a schema-valid hard/soft/concession_order document", () => {
    const p = compile(c({ budgetMax: 40, budgetFlex: 10, maxTravelMin: 15, availableSlots: ["sat_dinner"], dietary: ["no_spicy"] }));
    expect(PreferencesSchema.parse(p)).toEqual(p);
    expect(p.hard).toEqual(
      expect.arrayContaining([
        { dim: "time", op: "in", val: ["sat_dinner"] },
        { dim: "diet", op: "requires", val: ["no_spicy"] },
        { dim: "price", op: "<=", val: 50 },
        { dim: "distance", op: "<=", val: 15 + TRAVEL_GRACE_MIN },
      ]),
    );
    expect(p.soft).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ dim: "price", ideal: 40, tolerance: 10 }),
        expect.objectContaining({ dim: "distance", ideal: 15, tolerance: TRAVEL_GRACE_MIN }),
        expect.objectContaining({ dim: "cuisine", prefer: [], avoid: [] }),
      ]),
    );
  });

  it("uses the elicited concession order and pads it with the defaults", () => {
    expect(compile(c({ concessionOrder: ["budget"] })).concession_order).toEqual(["budget", "cuisine", "travel"]);
    expect(compile(c({})).concession_order).toEqual(["cuisine", "travel", "budget"]);
  });

  it("carries the elicited weights", () => {
    const p = compile(c({ budgetMax: 30, weights: { budget: 0.6 } }));
    expect(p.soft.find((s) => s.dim === "price")).toMatchObject({ weight: 0.6 });
  });

  it("omits unknown fields rather than inventing them", () => {
    const p = compile(c({}));
    expect(p.hard).toEqual([]);
    expect(p.soft.map((s) => s.dim)).toEqual(["cuisine"]);
  });
});

describe("relax", () => {
  const base = compile(c({ budgetMax: 40, budgetFlex: 10, maxTravelMin: 20, dislikedCuisines: ["thai"], concessionOrder: ["cuisine", "budget", "travel"] }));

  it("level 0 is the identity", () => {
    expect(relax(base, 0)).toBe(base);
  });

  it("loosens dimensions in concession order, one per level, and never touches hard rules", () => {
    const l1 = relax(base, 1);
    expect(l1.soft.find((s) => s.dim === "cuisine")).toMatchObject({ avoidScore: expect.closeTo(1 / 3, 5) });
    expect(l1.soft.find((s) => s.dim === "price")).toMatchObject({ tolerance: 10 });
    const l2 = relax(base, 2);
    expect(l2.soft.find((s) => s.dim === "price")).toMatchObject({ tolerance: 15 });
    expect(l2.soft.find((s) => s.dim === "distance")).toMatchObject({ tolerance: 10 });
    const l3 = relax(base, 3);
    expect(l3.soft.find((s) => s.dim === "distance")).toMatchObject({ tolerance: 15 });
    expect(l3.hard).toEqual(base.hard);
  });

  it("opens a small band when the tolerance was zero", () => {
    const strict = compile(c({ budgetMax: 40, budgetFlex: 0, concessionOrder: ["budget"] }));
    expect(relax(strict, 1).soft.find((s) => s.dim === "price")).toMatchObject({ tolerance: 4 });
  });

  it("does not mutate its input", () => {
    const snapshot = JSON.stringify(base);
    relax(base, 3);
    expect(JSON.stringify(base)).toBe(snapshot);
  });
});
