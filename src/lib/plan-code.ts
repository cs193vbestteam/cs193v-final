/**
 * The plan code out of whatever someone typed or pasted: the code itself in any case, or a whole
 * invite link. Returns "" when there is nothing that could be a code, so a lookup is never made
 * with odd input.
 */
export function planCodeFrom(input: unknown): string {
  if (typeof input !== "string") return "";
  const text = input.trim();
  const fromLink = /\/e\/([A-Za-z0-9]+)/.exec(text)?.[1];
  const code = (fromLink ?? text).replace(/[\s-]/g, "").toLowerCase();
  return /^[a-z0-9]{4,32}$/.test(code) ? code : "";
}
