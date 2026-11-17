import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { canAttend, optimize } from "@/lib/optimizer";
import { OptimizerResultSchema, checkResult } from "@/lib/optimizer-handoff";
import { AREAS, CASES_DIR, buildInput, type CasesFile, type PlacesFile } from "../sim/optimizer-cases";

/**
 * The recorded rounds: real restaurant pools from three areas (identities removed) and groups
 * of three or four made-up people. Each case holds the optimizer to the plan it chose when the
 * case was recorded, so a change to the scoring that moves a result shows up here and has to
 * be looked at. How to record again: sim/optimizer-cases.ts.
 */
const read = <T>(file: string) => JSON.parse(readFileSync(path.join(CASES_DIR, file), "utf8")) as T;

describe.each(AREAS)("recorded cases: $label", (area) => {
  const places = read<PlacesFile>(`${area.id}.places.json`);
  const { cases } = read<CasesFile>(`${area.id}.cases.json`);

  it("has a pool and three groups of three or four people", () => {
    expect(existsSync(path.join(CASES_DIR, `${area.id}.places.json`))).toBe(true);
    expect(places.places.length).toBeGreaterThan(50);
    expect(cases).toHaveLength(3);
    for (const c of cases) expect([3, 4]).toContain(c.members.length);
  });

  it.each(cases)("$name", (c) => {
    const input = buildInput(area, places, c.members);
    const result = optimize(input);
    expect(OptimizerResultSchema.safeParse(result).success).toBe(true);
    expect(checkResult(input, result)).toEqual([]);
    expect(result).toEqual(c.expected);

    // The count is the number of people a hard rule keeps out, for the choice and every alternative.
    if (result.restaurantId === null) return;
    for (const choice of [result, ...result.alternatives]) {
      const r = input.candidates.find((x) => x.id === choice.restaurantId)!;
      const out = input.people.filter((p) => !canAttend(p.prefs, r, choice.startTime)).length;
      expect(choice.cannotCome).toBe(out);
    }
  });
});
