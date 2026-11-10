import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Privacy by construction, checked structurally: the modules that run the
 * negotiation must not be able to reach preferences in storage. We walk the
 * static import graph from each of them and assert it never touches the
 * database, the crypto layer, the vault or the data-access layer.
 */
const SRC = path.resolve(__dirname, "../src/lib");
const FORBIDDEN = ["db", "crypto", "vault", "events", "auth", "session", "extract", "extract-rules"];
const ENTRY_POINTS = ["negotiate", "mediator", "evaluate", "preferences", "agent", "agent-llm", "mediator-llm"];

function imports(file: string): string[] {
  const src = readFileSync(path.join(SRC, `${file}.ts`), "utf8");
  const out: string[] = [];
  for (const m of src.matchAll(/^\s*import[^'"]*['"]([^'"]+)['"]/gm)) out.push(m[1]);
  for (const m of src.matchAll(/^\s*export\s+[^'"]*from\s+['"]([^'"]+)['"]/gm)) out.push(m[1]);
  return out;
}

function reachable(entry: string): Set<string> {
  const seen = new Set<string>();
  const stack = [entry];
  while (stack.length) {
    const cur = stack.pop()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const spec of imports(cur)) {
      if (!spec.startsWith("./")) continue; // packages are fine; only our own modules matter
      stack.push(spec.replace(/^\.\//, "").replace(/\.ts$/, ""));
    }
  }
  return seen;
}

describe("the mediator cannot reach anyone's preferences", () => {
  it.each(ENTRY_POINTS)("%s.ts imports no storage, crypto or vault module (transitively)", (entry) => {
    const graph = reachable(entry);
    for (const bad of FORBIDDEN)
      expect(graph.has(bad), `${entry} reaches ${bad} via ${[...graph].join(" → ")}`).toBe(false);
  });

  it("the negotiation modules never mention the stored column or decryption", () => {
    for (const f of ENTRY_POINTS) {
      const src = readFileSync(path.join(SRC, `${f}.ts`), "utf8");
      expect(src, `${f}.ts`).not.toMatch(/constraints_enc|decrypt/);
    }
  });

  it("only the vault and the agent handle a person's start point; the mediator never sees it", () => {
    for (const f of ["negotiate", "mediator", "mediator-llm", "evaluate", "preferences", "pool"]) {
      const src = readFileSync(path.join(SRC, `${f}.ts`), "utf8");
      expect(src, `${f}.ts`).not.toMatch(/startPoint|startText|start-point/);
    }
    // The agent takes the point as an argument and closes over it; it never reads it from anywhere.
    expect(reachable("agent").has("start-point")).toBe(false);
    expect(readFileSync(path.join(SRC, "vault.ts"), "utf8")).toMatch(/makeAgent\([^;]*constraints\.startPoint\)/);
  });

  it("runNegotiation itself decrypts nothing; it only asks the vault for agents", () => {
    const src = readFileSync(path.join(SRC, "events.ts"), "utf8");
    const start = src.indexOf("export async function runNegotiation");
    const end = src.indexOf("export async function", start + 1);
    const body = src.slice(start, end);
    expect(body).toMatch(/agentsForEvent\(/);
    expect(body).not.toMatch(/constraints_enc|decrypt|ConstraintsSchema|compile\(/);
  });

  it("the vault exposes agents, never preference values", () => {
    const src = readFileSync(path.join(SRC, "vault.ts"), "utf8");
    expect(src).toMatch(/import "server-only"/);
    const exported = [...src.matchAll(/^export (?:async )?function (\w+)/gm)].map((m) => m[1]);
    expect(exported).toEqual(["agentsForEvent"]);
    expect(src).not.toMatch(/return\s+\{[^}]*(constraints|prefs|preferences)\b/);
  });
});
