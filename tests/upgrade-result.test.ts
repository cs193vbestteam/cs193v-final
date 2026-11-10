import { describe, expect, it } from "vitest";
import { upgradeResult } from "@/lib/events";

describe("upgradeResult", () => {
  it("maps a pre-protocol yes/meh/no result onto the new shape so old plans still render", () => {
    const legacy = {
      status: "agreed",
      proposal: { restaurantId: "olive-tree", slot: "sat_dinner" },
      tally: { yes: 2, meh: 0, no: 0, reasons: {} },
      rounds: [
        {
          round: 1,
          proposals: [
            {
              proposal: { restaurantId: "saffron", slot: "fri_dinner" },
              tally: { yes: 0, meh: 1, no: 1, reasons: { time: 1, diet: 1 } },
            },
          ],
        },
      ],
      participants: 2,
      decidedAt: 1,
    };
    const up = upgradeResult(legacy);
    expect(up.status).toBe("agreed");
    expect(up.tally).toEqual({ accept: 2, reluctant: 0, reject: 0, dims: {}, rejectDims: {} });
    expect(up.rounds[0].level).toBe(0);
    expect(up.rounds[0].proposals[0].tally).toMatchObject({
      accept: 0,
      reluctant: 1,
      reject: 1,
      dims: { time: 1, diet: 1 },
    });
    expect(up.finalists).toEqual([]);
    expect(up.reservations).toEqual([]);
    expect(up.conflicts).toEqual([]);
    expect(up.memberNames).toEqual([]);
    expect(up.leakedDims).toBe(0);
  });

  it("renames no_option to no_deal and leaves new-shape results untouched", () => {
    expect(upgradeResult({ status: "no_option", rounds: [], tally: null }).status).toBe("no_deal");
    const fresh = {
      status: "compromise",
      proposal: null,
      tally: { accept: 1, reluctant: 1, reject: 0, dims: { price: 1 }, rejectDims: {} },
      rounds: [{ round: 4, level: 1, proposals: [] }],
      concessionLevel: 1,
      finalists: [
        {
          proposal: { restaurantId: "x", slot: "sat_dinner" },
          tally: { accept: 1, reluctant: 1, reject: 0, dims: {}, rejectDims: {} },
          buckets: [5, 3],
          nash: 15,
          min: 3,
        },
      ],
      reservations: [{ member: 1, dim: "price" }],
      conflicts: [],
      leakedDims: 7,
      memberNames: ["A", "B"],
      places: { x: { name: "X", cuisine: "thai", pricePerPerson: 20, travelMin: 5 } },
      participants: 2,
      decidedAt: 2,
    };
    // Shape only: what a group of this size may see is decided by forGroupSize, not here.
    // Except for one thing: finalists stored with their sorted buckets and Nash product keep only how they compare.
    const { proposal, tally } = fresh.finalists[0];
    const upgraded = upgradeResult(fresh);
    expect(upgraded).toEqual({
      ...fresh,
      finalists: [{ proposal, tally, relative: 1 }],
      detail: "full",
      roundCount: 1,
    });
    expect(JSON.stringify(upgraded)).not.toMatch(/buckets|nash/);

    // Several stored finalists: each keeps its Nash product as a share of the best one.
    const two = upgradeResult({
      ...fresh,
      finalists: [
        { ...fresh.finalists[0], nash: 12 },
        { ...fresh.finalists[0], nash: 15 },
      ],
    });
    expect(two.finalists.map((f) => f.relative)).toEqual([0.8, 1]);
  });
});
