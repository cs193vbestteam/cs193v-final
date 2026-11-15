import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Carries "who pays for this model call" from the request handler (events.ts, via spend.ts)
 * down to the code that talks to the API, without that code importing the database: the
 * negotiation's LLM modules must not be able to reach storage (tests/isolation.test.ts).
 */

export type Usage = { input_tokens?: number; output_tokens?: number };
type Recorder = (usage: Usage | undefined) => Promise<void>;

const store = new AsyncLocalStorage<Recorder>();

/** Runs `fn` with every reported usage passed to `record`. */
export function chargeTo<T>(record: Recorder, fn: () => Promise<T>): Promise<T> {
  return store.run(record, fn);
}

/** Called with the `usage` block of each API reply. Outside `chargeTo` (tests, scripts) it does nothing. */
export async function recordUsage(usage: Usage | undefined): Promise<void> {
  await store.getStore()?.(usage);
}
