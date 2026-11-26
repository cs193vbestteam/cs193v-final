"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

/** "2 h 05 min", "12 min", "under a minute". */
export function timeLeft(ms: number): string {
  const min = Math.ceil(ms / 60_000);
  if (min <= 1) return "under a minute";
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const rest = min % 60;
  return rest ? `${h} h ${String(rest).padStart(2, "0")} min` : `${h} h`;
}

/**
 * How long until a timed plan works itself out. At zero it asks the page for fresh data, which is
 * also what gets the plan worked out (planPulseAction).
 */
export function Countdown({ until }: { until: number }) {
  const router = useRouter();
  // The server and the browser read the clock at different moments, so the first text is drawn in the browser.
  const [left, setLeft] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => setLeft(until - Date.now());
    tick();
    const id = setInterval(tick, 15_000);
    return () => clearInterval(id);
  }, [until]);
  useEffect(() => {
    if (left !== null && left <= 0) router.refresh();
  }, [left, router]);
  if (left === null) return null;
  return <span>{left > 0 ? `Plan in ${timeLeft(left)}` : "Time is up"}</span>;
}
