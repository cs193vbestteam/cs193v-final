import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The hero's colour wash is positioned partly outside the viewport on purpose.
 * Both the root and the body must clip horizontally, or phones can drag the
 * page sideways (issue #2). `hidden` would break the sticky header, so it has to be `clip`.
 */
const css = readFileSync(path.resolve(__dirname, "../src/app/globals.css"), "utf8");
const rule = (selector: string) => css.match(new RegExp(`(?:^|\\n)${selector}\\s*\\{([^}]*)\\}`))?.[1] ?? "";

describe("horizontal overflow is clipped at the root", () => {
  it.each(["html", "body"])("%s clips overflow-x", (selector) => {
    expect(rule(selector)).toMatch(/overflow-x:\s*clip/);
  });
});
