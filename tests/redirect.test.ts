import { describe, expect, it } from "vitest";
import { safeNext } from "@/lib/redirect";

const ORIGIN = "https://tacit.example";

describe("post-authentication redirect", () => {
  it.each([
    "/", "/e/abcd2345", "/e/abcd2345?from=invite#chat", "/plans?next=https://example.com",
    "/caf%C3%A9", "/plans#//example.com",
  ])("preserves the local destination %s", (value) => {
    expect(safeNext(value)).toBe(value);
  });

  it.each([
    "https://example.com", "http://example.com", "//example.com", "///example.com",
    "/\\example.com", "/\\\\example.com", "\\\\example.com",
    "/\t/example.com", "/\n/example.com", "/\r/example.com",
    "javascript:alert(1)", "data:text/html,test", "e/abcd2345", "", " /e/abcd2345",
    "/e/abcd2345\u0000", "/e/abcd2345\u007f",
  ])("rejects the unsafe or malformed destination %j", (value) => {
    expect(safeNext(value)).toBe("/");
    expect(new URL(safeNext(value), ORIGIN).origin).toBe(ORIGIN);
  });

  it("falls back to home for missing fields and uploaded form values", () => {
    expect(safeNext(null)).toBe("/");
    expect(safeNext(new File(["//example.com"], "next.txt"))).toBe("/");
  });
});
