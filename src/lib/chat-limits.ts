/**
 * Size limits on the private chat (#84). Plain numbers with no imports, so the browser's input
 * and the server's check read the same values. The server check is the one that counts.
 */

/** The longest message a person can send. Enough for a paragraph about a meal, not for an essay prompt. */
export const MAX_MESSAGE_CHARS = 500;

/** From this many characters the input shows how many are left. */
export const MESSAGE_HINT_FROM = 400;

/** The longest text of the model's that is ever shown: about 100 tokens. */
export const MAX_REPLY_CHARS = 400;

/**
 * The most the model may write in one call. The reply and the structured record come back in
 * the same response, so this cannot be the reply cap. The largest realistic answer (a
 * full-length reply and every field a 500-character message could fill) is about 1,500
 * characters of JSON, which is about 500 tokens at three characters a token, a deliberately
 * pessimistic rate, and about 380 at the usual four. So this stays at 512: anything lower
 * could cut a legitimate answer short, and it was measured rather than guessed
 * (tests/assistant-on-topic.test.ts builds that answer and checks it fits). An answer that
 * does run out of room arrives as broken JSON and the rule-based reader takes the turn.
 */
export const MAX_OUTPUT_TOKENS = 512;
