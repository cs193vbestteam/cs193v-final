"use client";

import { useState } from "react";

/** The longest code a plan can have (older plans). */
const LONGEST = 8;

/** A plan code as someone might type or paste it, cut down to what fits the slots. */
function tidy(raw: string, length: number): string {
  const fromLink = /\/e\/([A-Za-z0-9]+)/.exec(raw)?.[1];
  return (fromLink ?? raw)
    .replace(/[^A-Za-z0-9]/g, "")
    .toLowerCase()
    .slice(0, length);
}

type Props = {
  id: string;
  name: string;
  value: string;
  onChange: (code: string) => void;
  length?: number;
  /** The last code was refused: the slots shake once and take the warning colour. */
  invalid?: boolean;
  describedBy?: string;
};

/**
 * A plan code typed into one slot per character. There is one real text field under the slots,
 * so typing, pasting (a whole invite link works), autofill and screen readers behave as for any
 * input; the slots are only how its value is drawn.
 */
export function CodeSlots({ id, name, value, onChange, length = 6, invalid = false, describedBy }: Props) {
  const [focused, setFocused] = useState(false);
  // Codes are six digits now; plans made before that have up to eight letters and digits, so the
  // row grows to fit one, and letters are still taken.
  const slots = Math.max(length, value.length);
  return (
    <div className="code-slots" data-invalid={invalid || undefined} data-focused={focused || undefined}>
      <input
        id={id}
        name={name}
        className="code-slots-input"
        value={value}
        onChange={(e) => onChange(tidy(e.target.value, LONGEST))}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        required
        // Room for a pasted link; `tidy` keeps only the code.
        maxLength={200}
        autoComplete="off"
        // New codes are digits, so a phone offers its number pad. An older code with letters in it
        // can still be pasted, alone or as its link.
        inputMode="numeric"
        autoCapitalize="characters"
        autoCorrect="off"
        spellCheck={false}
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
      />
      <div aria-hidden className="code-slots-row">
        {Array.from({ length: slots }, (_, i) => (
          <span
            key={i}
            className="code-slot"
            data-filled={i < value.length || undefined}
            data-active={(focused && i === Math.min(value.length, slots - 1)) || undefined}
            style={{ "--i": i } as React.CSSProperties}
          >
            {/* Keyed by its character, so a new one drops in afresh. */}
            {value[i] && <b key={value[i]}>{value[i]}</b>}
          </span>
        ))}
      </div>
    </div>
  );
}

/**
 * A plan's code shown one character per slot, landing left to right. The slots are separate boxes,
 * so selecting them with the mouse copies one character at best (#162): the whole row is a button
 * that copies the code instead.
 */
export function PlanCode({ code }: { code: string }) {
  const [status, setStatus] = useState<"copied" | "failed" | null>(null);

  async function copy() {
    try {
      if (typeof navigator.clipboard?.writeText !== "function") throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(code.toUpperCase());
      setStatus("copied");
    } catch {
      setStatus("failed");
    }
    setTimeout(() => setStatus(null), 2000);
  }

  return (
    <span className="flex flex-col items-center gap-1.5">
      <button
        type="button"
        className="code-copy"
        onClick={copy}
        aria-label={`Copy plan code ${code.toUpperCase().split("").join(" ")}`}
      >
        <span aria-hidden className="code-slots-row code-slots-shown">
          {[...code].map((ch, i) => (
            <span key={i} className="code-slot" data-filled style={{ "--i": i } as React.CSSProperties}>
              <b>{ch}</b>
            </span>
          ))}
        </span>
      </button>
      <span role="status" className="font-mono text-[0.75rem] uppercase tracking-wider text-ink-3">
        {status === "copied"
          ? "Copied"
          : status === "failed"
            ? `Could not copy. The code is ${code.toUpperCase()}`
            : ""}
      </span>
    </span>
  );
}
