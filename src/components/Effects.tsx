"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Small motion effects, written here rather than installed: no library is loaded for them.
 * Every one is decoration. The page reads the same with all of them off, they are all off under
 * "reduce motion", and none keeps moving on its own (WCAG 2.2.2): each either runs once and
 * stops, or moves only while the pointer does.
 */

const reducedMotion = () =>
  typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
const finePointer = () =>
  typeof window !== "undefined" && !!window.matchMedia?.("(hover: hover) and (pointer: fine)").matches;

/**
 * One listener for the whole page:
 *  - a soft light on cards that follows the pointer (`.card`, `.spot`),
 *  - a button that leans toward the pointer (`[data-magnet]`),
 *  - a panel that tilts toward the pointer (`[data-tilt]`),
 *  - a few sparks where a main button is pressed (`.btn`).
 */
export function PointerEffects() {
  useEffect(() => {
    if (reducedMotion()) return;
    const hover = finePointer();
    let lit: HTMLElement | null = null;
    let leaning: HTMLElement | null = null;
    let tilted: HTMLElement | null = null;

    const settle = (el: HTMLElement | null, props: string[]) => props.forEach((p) => el?.style.removeProperty(p));

    function move(e: PointerEvent) {
      const target = e.target instanceof Element ? e.target : null;

      const card = target?.closest<HTMLElement>(".card, .spot") ?? null;
      if (card !== lit) {
        lit?.style.setProperty("--spot", "0");
        lit = card;
      }
      if (card) {
        const r = card.getBoundingClientRect();
        card.style.setProperty("--mx", `${e.clientX - r.left}px`);
        card.style.setProperty("--my", `${e.clientY - r.top}px`);
        card.style.setProperty("--spot", "1");
      }

      const magnet = target?.closest<HTMLElement>("[data-magnet]") ?? null;
      if (magnet !== leaning) {
        settle(leaning, ["--lean-x", "--lean-y"]);
        leaning = magnet;
      }
      if (magnet) {
        const r = magnet.getBoundingClientRect();
        magnet.style.setProperty("--lean-x", `${((e.clientX - (r.left + r.width / 2)) * 0.18).toFixed(1)}px`);
        magnet.style.setProperty("--lean-y", `${((e.clientY - (r.top + r.height / 2)) * 0.3).toFixed(1)}px`);
      }

      const tilt = target?.closest<HTMLElement>("[data-tilt]") ?? null;
      if (tilt !== tilted) {
        settle(tilted, ["--tilt-x", "--tilt-y"]);
        tilted = tilt;
      }
      if (tilt) {
        const r = tilt.getBoundingClientRect();
        const x = (e.clientX - r.left) / r.width - 0.5;
        const y = (e.clientY - r.top) / r.height - 0.5;
        tilt.style.setProperty("--tilt-x", `${(-y * 5).toFixed(2)}deg`);
        tilt.style.setProperty("--tilt-y", `${(x * 6).toFixed(2)}deg`);
      }
    }

    function leave() {
      lit?.style.setProperty("--spot", "0");
      settle(leaning, ["--lean-x", "--lean-y"]);
      settle(tilted, ["--tilt-x", "--tilt-y"]);
      lit = leaning = tilted = null;
    }

    function spark(e: MouseEvent) {
      const button = e.target instanceof Element ? e.target.closest<HTMLElement>(".btn") : null;
      // A press from the keyboard has no place to draw from; a disabled button did nothing.
      if (!button || button.matches(":disabled") || (e.clientX === 0 && e.clientY === 0)) return;
      const burst = document.createElement("span");
      burst.className = "sparks";
      burst.setAttribute("aria-hidden", "true");
      burst.style.left = `${e.clientX}px`;
      burst.style.top = `${e.clientY}px`;
      for (let i = 0; i < 8; i++) {
        const line = document.createElement("i");
        line.style.setProperty("--a", `${i * 45}deg`);
        burst.appendChild(line);
      }
      document.body.appendChild(burst);
      setTimeout(() => burst.remove(), 600);
    }

    if (hover) {
      document.addEventListener("pointermove", move, { passive: true });
      document.documentElement.addEventListener("pointerleave", leave);
    }
    document.addEventListener("click", spark);
    return () => {
      document.removeEventListener("pointermove", move);
      document.documentElement.removeEventListener("pointerleave", leave);
      document.removeEventListener("click", spark);
    };
  }, []);
  return null;
}

/** Runs `start` the first time the element is on screen. Returns false where that cannot be watched. */
function onceVisible(el: Element, start: () => void): (() => void) | false {
  if (typeof IntersectionObserver === "undefined") return false;
  const io = new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        io.disconnect();
        start();
      }
    },
    { threshold: 0.4 },
  );
  io.observe(el);
  return () => io.disconnect();
}

/**
 * A number that counts up to its value the first time it is seen. The real value is what the
 * server renders and what a screen reader is given; only the visible digits move.
 */
export function CountUp({ to, duration = 1100 }: { to: number; duration?: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [shown, setShown] = useState(to);
  useEffect(() => {
    const el = ref.current;
    if (!el || reducedMotion()) return;
    let frame = 0;
    const stop = onceVisible(el, () => {
      const began = performance.now();
      const tick = (now: number) => {
        const t = Math.min(1, (now - began) / duration);
        setShown(Math.round(to * (1 - Math.pow(1 - t, 4))));
        if (t < 1) frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
    });
    return () => {
      if (stop) stop();
      cancelAnimationFrame(frame);
    };
  }, [to, duration]);
  return (
    <span ref={ref} className="tabular-nums">
      <span aria-hidden>{shown}</span>
      <span className="sr-only">{to}</span>
    </span>
  );
}

const GLYPHS = "abcdefghjkmnpqrstuvwxyz23456789";

/**
 * Text that settles out of scrambled letters, left to right, once. Used for a plan's code.
 * A screen reader gets the real text and none of the scramble.
 */
export function DecryptedText({ text, duration = 900 }: { text: string; duration?: number }) {
  const [shown, setShown] = useState(text);
  useEffect(() => {
    if (reducedMotion()) return;
    const began = performance.now();
    let frame = 0;
    let last = 0;
    const tick = (now: number) => {
      const settled = Math.floor(((now - began) / duration) * text.length);
      if (settled >= text.length) return setShown(text);
      // New letters about twenty times a second: fast enough to read as a scramble, slow enough not to flicker.
      if (now - last > 50) {
        last = now;
        setShown(
          [...text]
            .map((ch, i) =>
              i < settled || !/[a-z0-9]/i.test(ch) ? ch : GLYPHS[Math.floor(Math.random() * GLYPHS.length)],
            )
            .join(""),
        );
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [text, duration]);
  return (
    <span>
      <span aria-hidden>{shown}</span>
      <span className="sr-only">{text}</span>
    </span>
  );
}

/**
 * A field of dots behind the dark section, treated as the surface of water: the dots near the
 * pointer swell and warm, and the pointer leaves rings that travel outward, push the dots aside
 * and die away. A press makes a bigger ring. Only the dots move, never the words in front of them.
 * It is drawn once, then only while the pointer moves and for the second or so a ring lasts, so
 * nothing animates unattended.
 */
export function DotGrid() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const host = canvas?.parentElement;
    const ctx = canvas?.getContext?.("2d");
    if (!canvas || !host || !ctx) return;
    const GAP = 26;
    const REACH = 130;
    /** How long a ring lasts (ms), how fast it spreads (px/ms), and how wide its crest is (px). */
    const LIFE = 1500;
    const SPEED = 0.32;
    const CREST = 26;
    let pointer: { x: number; y: number } | null = null;
    let rings: { x: number; y: number; born: number; power: number }[] = [];
    let dropped = { x: -999, y: -999 };
    let frame = 0;

    function draw() {
      frame = 0;
      const { width, height } = host!.getBoundingClientRect();
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      if (canvas!.width !== Math.round(width * ratio) || canvas!.height !== Math.round(height * ratio)) {
        canvas!.width = Math.round(width * ratio);
        canvas!.height = Math.round(height * ratio);
      }
      ctx!.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx!.clearRect(0, 0, width, height);
      const now = performance.now();
      rings = rings.filter((r) => now - r.born < LIFE);
      for (let y = GAP / 2; y < height; y += GAP) {
        for (let x = GAP / 2; x < width; x += GAP) {
          const near = pointer ? Math.max(0, 1 - Math.hypot(x - pointer.x, y - pointer.y) / REACH) : 0;
          // Each ring pushes a dot outward as its crest passes, less and less as the ring ages.
          let dx = 0;
          let dy = 0;
          let lift = 0;
          for (const ring of rings) {
            const age = now - ring.born;
            const away = Math.hypot(x - ring.x, y - ring.y) || 1;
            const off = (away - age * SPEED) / CREST;
            if (off > 3 || off < -3) continue;
            const push = Math.exp(-off * off) * (1 - age / LIFE) * ring.power;
            dx += ((x - ring.x) / away) * push * 9;
            dy += ((y - ring.y) / away) * push * 9;
            lift += push;
          }
          const glow = Math.min(1, near + lift * 0.7);
          ctx!.beginPath();
          ctx!.arc(x + dx, y + dy, 1 + near * 2.2 + Math.min(lift, 1.5) * 1.4, 0, Math.PI * 2);
          ctx!.fillStyle = glow > 0.02 ? `rgb(240 138 102 / ${0.14 + glow * 0.6})` : "rgb(243 238 227 / 0.1)";
          ctx!.fill();
        }
      }
      if (rings.length) queue();
    }
    function queue() {
      frame ||= requestAnimationFrame(draw);
    }

    function drop(x: number, y: number, power: number) {
      rings.push({ x, y, born: performance.now(), power });
      if (rings.length > 14) rings.shift();
      dropped = { x, y };
    }
    function move(e: PointerEvent) {
      const r = host!.getBoundingClientRect();
      pointer = { x: e.clientX - r.left, y: e.clientY - r.top };
      // A new ring every so often along the pointer's path: that trail of rings is the wake.
      if (Math.hypot(pointer.x - dropped.x, pointer.y - dropped.y) > 46) drop(pointer.x, pointer.y, 0.6);
      queue();
    }
    function press(e: PointerEvent) {
      const r = host!.getBoundingClientRect();
      drop(e.clientX - r.left, e.clientY - r.top, 1.5);
      queue();
    }
    function leave() {
      pointer = null;
      queue();
    }

    draw();
    const resized = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(queue);
    resized?.observe(host);
    if (!reducedMotion() && finePointer()) {
      host.addEventListener("pointermove", move, { passive: true });
      host.addEventListener("pointerleave", leave);
      host.addEventListener("pointerdown", press);
    }
    return () => {
      resized?.disconnect();
      host.removeEventListener("pointermove", move);
      host.removeEventListener("pointerleave", leave);
      host.removeEventListener("pointerdown", press);
      cancelAnimationFrame(frame);
    };
  }, []);
  return <canvas ref={ref} aria-hidden className="dot-grid" />;
}
