"use client";

import { useRef } from "react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { DrawSVGPlugin } from "gsap/DrawSVGPlugin";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { SplitText } from "gsap/SplitText";
import { ARRIVE, MOTION_OK, RECEDE, SCRUB } from "@/lib/motion";

gsap.registerPlugin(useGSAP, ScrollTrigger, SplitText, DrawSVGPlugin);

/**
 * What the landing page does as it is scrolled, beyond blocks arriving (that is PageMotion, on
 * every page). The numbers are the site's own (lib/motion.ts), so this page keeps the same gait.
 *
 * What carries from one screen to the next:
 *  - the chat on the first screen settles back as its phrases run across the strip under it;
 *  - the dark sheet opens out of that strip and is read at the speed it is scrolled;
 *  - "how it works" is one sheet that stays put while its three steps are read past it, and the
 *    best cell of the scoring grid leaves the grid and becomes the plan's ticket;
 *  - sheets square their corners off as they meet the edge of the screen;
 *  - the four lines of the closing mark are drawn into one.
 *
 * Nothing is hidden in CSS: every starting state is set here. Without JavaScript, or with reduced
 * motion asked for, the page is simply all there.
 */
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export function LandingMotion() {
  const anchor = useRef<HTMLSpanElement>(null);

  useGSAP(() => {
    const root = anchor.current?.parentElement;
    if (!root) return;
    const q = gsap.utils.selector(root);
    const mm = gsap.matchMedia();

    mm.add({ motion: MOTION_OK, wide: "(min-width: 900px) and (min-height: 620px)" }, (context) => {
      const { motion, wide } = context.conditions as { motion: boolean; wide: boolean };
      if (!motion) return;

      /* First screen → strip: the chat settles back while what was said in it runs across. */
      const hero = q("[data-scene='hero']")[0];
      const demo = q("[data-recede]")[0];
      if (hero && demo) {
        gsap.to(demo, {
          scale: RECEDE.scale,
          yPercent: 4,
          y: 0,
          transformOrigin: "50% 100%",
          ease: "none",
          scrollTrigger: { trigger: hero, start: "bottom 92%", end: "bottom 20%", scrub: SCRUB },
        });
      }
      const strip = q(".excuses")[0];
      if (strip) {
        strip.setAttribute("data-live", "");
        const [left, right] = q(".excuses-row");
        const across = { trigger: strip, start: "top bottom", end: "bottom top", scrub: SCRUB };
        if (left) gsap.fromTo(left, { xPercent: -4 }, { xPercent: -36, ease: "none", scrollTrigger: across });
        if (right) gsap.fromTo(right, { xPercent: -40 }, { xPercent: -8, ease: "none", scrollTrigger: across });
      }

      /* The strip's frame is drawn from the middle outwards, and its corners are set last. */
      const framed = q(".framed")[0];
      if (framed) {
        gsap
          .timeline({
            defaults: { ease: "none" },
            scrollTrigger: { trigger: framed, start: "top 94%", end: "top 58%", scrub: SCRUB },
          })
          .from(q(".frame-line"), { scaleX: 0, transformOrigin: "50% 50%", duration: 0.75 })
          .from(q(".frame-mark"), { scale: 0, rotation: 90, duration: 0.25 });
      }

      /* Strip → dark sheet: it opens out of the strip, then is read as it is scrolled. */
      const inked = q(".inked")[0];
      if (inked) {
        gsap.fromTo(
          inked,
          // A small box in the middle of where the sheet will be, which grows into the sheet.
          { clipPath: "inset(36% 40% 36% 40% round 2rem)" },
          {
            // Past its own edge at the end, so the shadow under the sheet is not cut off.
            clipPath: "inset(-8% -8% -8% -8% round 2rem)",
            ease: "power1.inOut",
            scrollTrigger: { trigger: inked, start: "top 100%", end: "top 30%", scrub: SCRUB },
          },
        );
        const said = q("[data-read]")[0];
        if (said) {
          // `aria: "none"`: the words stay ordinary text, read out as one paragraph.
          const split = SplitText.create(said, { type: "words", aria: "none" });
          gsap.from(split.words, {
            // Half strength is still 4.9:1 on the dark sheet, so the unread words can be read.
            opacity: 0.5,
            ease: "none",
            stagger: 0.1,
            scrollTrigger: { trigger: said, start: "top 78%", end: "bottom 52%", scrub: SCRUB },
          });
        }
      }

      /* "How it works": the heading's halves part, a rule opens between them, the note lands under it. */
      const head = q(".split-head")[0];
      const rule = q(".split-head-rule")[0];
      if (head && rule) {
        const half = () => rule.offsetWidth / 2;
        gsap
          .timeline({
            defaults: { ease: "none" },
            scrollTrigger: { trigger: head, start: "top 90%", end: "top 48%", scrub: SCRUB, invalidateOnRefresh: true },
          })
          .from(q("[data-split='left']"), { x: half, duration: 0.8 }, 0)
          .from(q("[data-split='right']"), { x: () => -half(), duration: 0.8 }, 0)
          .from(rule, { scaleX: 0, transformOrigin: "50% 50%", duration: 0.8 }, 0)
          .from(q(".split-head-note"), { opacity: 0, duration: 0.2 }, 0.8);
      }

      /* How it works. Each picture has something it does when it is its turn. */
      const stack = q(".stack")[0];
      const cards = q(".stack-card");
      const copies = q(".stack-copy");
      const scenes = q(".stack-scene");
      const best = q(".score-cell[data-best]")[0];
      const ticket = q(".scene-result .plan-ticket")[0];
      const rest = q(".scene-result ul")[0];
      const chip = q(".flight-chip")[0];
      const said = gsap
        .timeline({ paused: true })
        .from(q(".scene-chat .flex"), { y: 12, opacity: 0, duration: 0.5, ease: ARRIVE.ease, stagger: 0.4 }, 0.2);
      const scored = gsap.timeline({ paused: true }).from(q(".score-cell"), {
        scale: 0.55,
        opacity: 0,
        duration: 0.45,
        ease: "back.out(1.6)",
        stagger: { each: 0.03, from: "start" },
      });

      if (wide && stack && scenes.length === 3 && best && ticket && chip) {
        /* Wide: the words run past on the left; one sheet stays on the right and shows the picture of
           the step being read. The layout itself is CSS, under data-live. */
        stack.setAttribute("data-live", "");

        /* Step two → three: the best cell leaves the grid and becomes the ticket. */
        const state = { t: 0 };
        const place = () => {
          const t = state.t;
          // Where the two ends are right now: the page may be moving while this runs.
          const from = best.getBoundingClientRect();
          const to = ticket.getBoundingClientRect();
          const go = gsap.parseEase("power2.inOut")(gsap.utils.clamp(0, 1, t / 0.8));
          gsap.set(chip, {
            x: lerp(from.left, to.left, go),
            y: lerp(from.top, to.top, go),
            width: lerp(from.width, to.width, go),
            height: lerp(from.height, to.height, go),
            borderRadius: lerp(10, 20, go),
            // There from the first moment of the flight; gone once the ticket has taken over.
            autoAlpha: t <= 0.02 || t >= 0.98 ? 0 : 1 - gsap.utils.clamp(0, 1, (t - 0.7) / 0.25),
          });
          const landed = gsap.utils.clamp(0, 1, (t - 0.62) / 0.38);
          gsap.set(ticket, { opacity: landed, scale: lerp(0.94, 1, gsap.parseEase("power2.out")(landed)) });
          if (rest) gsap.set(rest, { opacity: gsap.utils.clamp(0, 1, (t - 0.85) / 0.15) });
        };
        const flight = gsap.to(state, { t: 1, duration: 1, ease: "none", paused: true, onUpdate: place });
        place();

        let active = -1;
        const show = (i: number) => {
          if (i === active) return;
          const from = active;
          active = i;
          scenes.forEach((scene, k) => {
            gsap.to(scene, {
              opacity: k === i ? 1 : 0,
              scale: k === i ? 1 : RECEDE.scale,
              duration: from < 0 ? 0 : 0.45,
              ease: "power3.out",
              overwrite: "auto",
            });
          });
          copies.forEach((copy, k) => {
            gsap.to(copy, { opacity: k === i ? 1 : 0.32, duration: from < 0 ? 0 : 0.45, overwrite: "auto" });
          });
          if (i === 2) {
            // Straight from the grid: let the grid finish, so there is a cell to leave it.
            scored.progress(1);
            flight.play();
          } else {
            flight.reverse();
          }
        };
        show(0);
        copies.forEach((copy, i) => {
          ScrollTrigger.create({
            trigger: copy,
            // The step whose words are across the middle of the screen is the one shown.
            start: "top 55%",
            end: "bottom 55%",
            onToggle: (self) => {
              if (!self.isActive) return;
              show(i);
              if (i === 1 && scored.progress() === 0) scored.play();
            },
          });
        });
        // The first picture plays as it comes into view, not when its words reach the middle.
        ScrollTrigger.create({ trigger: scenes[0], start: "top 75%", once: true, onEnter: () => said.play() });
      } else {
        /* Narrow: nothing is tied to the scrollbar. Each sheet arrives when it is scrolled to, and its
           picture then plays once by itself. */
        const landed = gsap.timeline({ paused: true });
        if (ticket) landed.from(ticket, { opacity: 0, scale: 0.94, y: 12, duration: 0.7, ease: ARRIVE.ease }, 0.15);
        if (rest) landed.from(rest.children, { opacity: 0, y: 8, duration: 0.5, ease: ARRIVE.ease, stagger: 0.12 });
        const plays = [said, scored, landed];
        cards.forEach((card, i) => {
          gsap.set(card, { opacity: 0, y: ARRIVE.y });
          ScrollTrigger.create({
            trigger: card,
            start: "top 82%",
            once: true,
            onEnter: () => {
              gsap.to(card, { opacity: 1, y: 0, duration: ARRIVE.duration, ease: ARRIVE.ease });
              plays[i]?.play();
            },
          });
        });
      }

      /* Corners: a sheet's corners are round in the open and square off as it meets the edge of the
         screen, top or bottom, so it leaves and enters flush. Followed a little behind the scroll. */
      const cornered = q("[data-corners]").map((el) => ({
        el,
        max: parseFloat(getComputedStyle(el).borderTopLeftRadius) || 32,
        top: -1,
        bottom: -1,
      }));
      const corners = () => {
        const tall = window.innerHeight;
        const k = 1 - Math.pow(1 - 0.16, gsap.ticker.deltaRatio());
        for (const c of cornered) {
          const r = c.el.getBoundingClientRect();
          // No box (the wide layout), or nowhere near the screen.
          if (!r.height || r.bottom < -c.max || r.top > tall + c.max) continue;
          const top = gsap.utils.clamp(0, c.max, r.top);
          const bottom = gsap.utils.clamp(0, c.max, tall - r.bottom);
          const nextTop = c.top < 0 || Math.abs(top - c.top) < 0.1 ? top : c.top + (top - c.top) * k;
          const nextBottom =
            c.bottom < 0 || Math.abs(bottom - c.bottom) < 0.1 ? bottom : c.bottom + (bottom - c.bottom) * k;
          if (nextTop === c.top && nextBottom === c.bottom) continue;
          c.top = nextTop;
          c.bottom = nextBottom;
          c.el.style.borderRadius = `${nextTop}px ${nextTop}px ${nextBottom}px ${nextBottom}px`;
        }
      };
      if (cornered.length) gsap.ticker.add(corners);

      /* The ledger: what the group sees is inked out, one row after another. */
      const ledger = q("[data-ledger]")[0];
      if (ledger) {
        gsap.from(ledger.querySelectorAll(".redact"), {
          scaleX: 0,
          transformOrigin: "0% 50%",
          duration: ARRIVE.duration,
          ease: ARRIVE.ease,
          stagger: ARRIVE.stagger * 1.5,
          scrollTrigger: { trigger: ledger, start: "top 70%", once: true },
        });
      }

      /* Closing: four lines are drawn into one, and the one ends in the full stop. */
      const seal = q(".seal")[0];
      if (seal) {
        const lines = seal.querySelectorAll("path");
        const starts = seal.querySelectorAll("circle:not(.fill-seal)");
        const stop = seal.querySelector(".fill-seal");
        const draw = gsap.timeline({
          defaults: { ease: "none" },
          scrollTrigger: { trigger: seal, start: "top 88%", end: "top 46%", scrub: SCRUB },
        });
        draw
          .from(starts, { scale: 0, transformOrigin: "50% 50%", stagger: 0.04, duration: 0.15 })
          .from([...lines].slice(0, 4), { drawSVG: 0, duration: 0.5 }, 0.1)
          .from(lines[4], { drawSVG: 0, duration: 0.25 })
          .from(stop, { scale: 0, transformOrigin: "50% 50%", ease: "back.out(2.4)", duration: 0.2 });
      }

      return () => {
        strip?.removeAttribute("data-live");
        stack?.removeAttribute("data-live");
        gsap.ticker.remove(corners);
        for (const c of cornered) c.el.style.borderRadius = "";
      };
    });

    // Fonts arriving late change every measured position below them.
    document.fonts?.ready.then(() => ScrollTrigger.refresh()).catch(() => {});
    return () => mm.revert();
  });

  return <span ref={anchor} hidden />;
}
