"use client";

import { useEffect, useRef, useState } from "react";
import { OPENING_COOKIE } from "@/lib/opening";

/** How long the mark is on the sheet before it leaves for the header (ms). The CSS draws it within this. */
const HOLD = 2300;
/** Where the four lines start, in the mark's own drawing (the same one as at the foot of the page). */
const STARTS = [8, 34, 62, 88];
const FLY = 700;
const EASE = "cubic-bezier(0.76, 0, 0.24, 1)";

/**
 * The opening of the first page: a paper sheet with the mark from the foot of the page on it.
 * Four lines are drawn into one, and the one ends in the seal. The lines then run out into the
 * seal and the word is written where they were, which leaves the seal as its full stop. Then the
 * wordmark travels to its place in the header while the sheet lifts off the page.
 *
 * It is in the server's HTML, so the page is never seen before it. It never takes a click: any
 * key, tap or scroll ends it at once. Drawing and a late fade are plain CSS, so without this
 * script the sheet still goes away. With reduced motion asked for it is not shown at all.
 */
export function Opening() {
  const sheet = useRef<HTMLDivElement>(null);
  const mark = useRef<HTMLSpanElement>(null);
  const [gone, setGone] = useState(false);

  useEffect(() => {
    document.cookie = `${OPENING_COOKIE}=1; path=/; SameSite=Lax`;
    const root = sheet.current?.parentElement;
    const paper = sheet.current;
    const word = mark.current;
    if (!root || !paper || !word) return;
    let left = false;
    const leave = (fly: boolean) => {
      if (left) return;
      left = true;
      // From here the page under the sheet runs its own entrance.
      root.setAttribute("data-leaving", "");
      if (typeof paper.animate !== "function") return setGone(true);
      const home = document.querySelector<HTMLElement>("header a[aria-label='Settle home']")?.getBoundingClientRect();
      const from = word.getBoundingClientRect();
      const time = fly && home && from.height > 0 ? FLY : 280;
      if (fly && home && from.height > 0) {
        const scale = home.height / from.height;
        word.animate(
          [
            { transform: "none" },
            { transform: `translate(${home.left - from.left}px, ${home.top - from.top}px) scale(${scale})` },
          ],
          { duration: time, easing: EASE, fill: "forwards" },
        );
      } else {
        word.animate([{ opacity: 1 }, { opacity: 0 }], { duration: time, fill: "forwards" });
      }
      paper
        .animate([{ opacity: 1 }, { opacity: 0 }], { duration: time, easing: "ease-in-out", fill: "forwards" })
        .finished.then(
          () => setGone(true),
          () => setGone(true),
        );
    };
    const timer = setTimeout(() => leave(true), HOLD);
    const skip = () => leave(false);
    const events = ["pointerdown", "keydown", "wheel", "touchmove"] as const;
    events.forEach((name) => window.addEventListener(name, skip, { passive: true }));
    return () => {
      clearTimeout(timer);
      events.forEach((name) => window.removeEventListener(name, skip));
    };
  }, []);

  if (gone) return null;
  return (
    <div className="opening" aria-hidden>
      <div ref={sheet} className="opening-sheet" />
      <span ref={mark} className="opening-mark">
        <span className="opening-word">Settle</span>
        <span className="opening-stop">
          <svg className="opening-lines" viewBox="0 0 212 96" fill="none">
            <g stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              {STARTS.map((y, i) => (
                <path key={y} d={`M4 ${y} C ${i % 3 ? 60 : 70} ${y}, ${i % 3 ? 80 : 78} 48, 132 48`} pathLength={1} />
              ))}
              <path d="M132 48 H 208" strokeWidth="3.5" pathLength={1} />
            </g>
            {STARTS.map((y, i) => (
              <circle key={y} cx="4" cy={y} r="3.5" fill="currentColor" style={{ "--i": i } as React.CSSProperties} />
            ))}
          </svg>
          <span className="opening-dot" />
        </span>
      </span>
    </div>
  );
}
