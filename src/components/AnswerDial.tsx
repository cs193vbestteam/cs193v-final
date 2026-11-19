"use client";

import { useEffect, useRef, useState } from "react";
import type { AnswerStep } from "@/lib/member-state";

/**
 * The answer progress as a ring of five ticks, one per question, with the count in the middle.
 * When a question is settled its tick fills and a comet runs round the ring to it. The ring is
 * a picture of the list beside it and says nothing the list does not, so it is hidden from
 * screen readers.
 */

const SWEEP = 300; // degrees the ring covers; the gap sits at the bottom
const START = 120; // where it begins, measured clockwise from three o'clock
const GAP = 9; // degrees between ticks
const R = 40;
const TAIL = 46; // degrees of trail behind the comet's head

const point = (deg: number) => {
  const a = (deg * Math.PI) / 180;
  return `${(50 + R * Math.cos(a)).toFixed(2)} ${(50 + R * Math.sin(a)).toFixed(2)}`;
};
const arc = (from: number, to: number) => `M ${point(from)} A ${R} ${R} 0 ${to - from > 180 ? 1 : 0} 1 ${point(to)}`;

export function AnswerDial({ progress }: { progress: AnswerStep[] }) {
  const span = SWEEP / progress.length;
  const done = progress.filter((s) => s.done).length;
  const doneKey = progress.map((s) => (s.done ? "1" : "0")).join("");
  const seen = useRef(doneKey);
  const [comet, setComet] = useState<{ run: number; to: number } | null>(null);

  useEffect(() => {
    const before = seen.current;
    seen.current = doneKey;
    // The furthest tick that has just been filled is where the comet lands.
    const fresh = [...doneKey].map((d, i) => d === "1" && before[i] !== "1").lastIndexOf(true);
    if (fresh < 0) return;
    setComet((c) => ({ run: (c?.run ?? 0) + 1, to: (fresh + 1) * span - GAP / 2 }));
  }, [doneKey, span]);

  return (
    <svg
      aria-hidden
      viewBox="0 0 100 100"
      className="answer-dial"
      data-complete={done === progress.length || undefined}
    >
      {progress.map((s, i) => {
        const d = arc(START + i * span + GAP / 2, START + (i + 1) * span - GAP / 2);
        return (
          <g key={s.topic} data-done={s.done || undefined} data-needed={(!s.done && s.required) || undefined}>
            <path d={d} className="answer-dial-track" />
            <path d={d} pathLength={1} className="answer-dial-fill" />
          </g>
        );
      })}
      {comet && (
        <path
          key={comet.run}
          d={arc(START, START + SWEEP)}
          pathLength={SWEEP}
          className="answer-dial-comet"
          style={{ "--tail": TAIL, "--land": TAIL - comet.to, "--sweep": SWEEP + TAIL } as React.CSSProperties}
        />
      )}
      {/* The count alone: at this size "of 5" would be too small to read, and it is written out beside the dial. */}
      <text x="50" y="62" textAnchor="middle" className="answer-dial-count">
        {done}
      </text>
    </svg>
  );
}
