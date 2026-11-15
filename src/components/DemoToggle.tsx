"use client";

import { useState } from "react";

/**
 * Pause and play for the looping hero demo. Anything that moves by itself for more than five
 * seconds needs a way to stop it (WCAG 2.2.2); the pause is applied in CSS through data-paused.
 */
export function DemoToggle() {
  const [paused, setPaused] = useState(false);
  return (
    <button
      type="button"
      className="link text-xs text-ink-2"
      aria-pressed={paused}
      onClick={(e) => {
        const demo = e.currentTarget.closest<HTMLElement>(".demo");
        if (demo) demo.dataset.paused = String(!paused);
        setPaused(!paused);
      }}
    >
      {paused ? "Play animation" : "Pause animation"}
    </button>
  );
}
