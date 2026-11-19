"use client";

import { useState } from "react";

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
export function CodeSlots({ id, name, value, onChange, length = 8, invalid = false, describedBy }: Props) {
  const [focused, setFocused] = useState(false);
  return (
    <div className="code-slots" data-invalid={invalid || undefined} data-focused={focused || undefined}>
      <input
        id={id}
        name={name}
        className="code-slots-input"
        value={value}
        onChange={(e) => onChange(tidy(e.target.value, length))}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        required
        // Room for a pasted link; `tidy` keeps only the code.
        maxLength={200}
        autoComplete="off"
        autoCapitalize="characters"
        autoCorrect="off"
        spellCheck={false}
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
      />
      <div aria-hidden className="code-slots-row">
        {Array.from({ length }, (_, i) => (
          <span
            key={i}
            className="code-slot"
            data-filled={i < value.length || undefined}
            data-active={(focused && i === Math.min(value.length, length - 1)) || undefined}
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

/** A plan's code shown one character per slot, landing left to right. For reading, not typing. */
export function PlanCode({ code }: { code: string }) {
  return (
    <span className="code-slots-row code-slots-shown">
      <span className="sr-only">{code.toUpperCase().split("").join(" ")}</span>
      {[...code].map((ch, i) => (
        <span aria-hidden key={i} className="code-slot" data-filled style={{ "--i": i } as React.CSSProperties}>
          <b>{ch}</b>
        </span>
      ))}
    </span>
  );
}
