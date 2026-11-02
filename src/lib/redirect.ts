/** Only allow redirects to local paths (prevents open redirects via ?next=). */
export function safeNext(value: FormDataEntryValue | null): string {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    /[\\\u0000-\u001f\u007f]/.test(value)
  ) {
    return "/";
  }
  // Browsers normalize backslashes into slashes and remove some control
  // characters. Reject them before the value reaches the redirect handler.
  return value;
}
