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
 *  - each "how it works" sheet settles back as the next covers it;
 *  - the best cell of the scoring grid leaves the grid and becomes the plan's ticket;
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

      /* How it works: a sheet settles back as the next one covers it. */
      const cards = q(".stack-card");
      if (wide) {
        cards.forEach((card, i) => {
          const next = cards[i + 1];
          if (!next) return;
          gsap.to(card, {
            scale: RECEDE.scale,
            transformOrigin: "50% 0%",
            ease: "none",
            scrollTrigger: {
              trigger: next,
              start: "top bottom",
              end: () => `top ${parseFloat(getComputedStyle(next).top) || 0}px`,
              scrub: SCRUB,
              invalidateOnRefresh: true,
            },
          });
        });
      }

      /* Step two: the grid fills in as its sheet comes up. */
      const cells = q(".score-cell");
      const grid = q(".score-grid")[0];
      if (grid && cells.length) {
        gsap.from(cells, {
          scale: 0.55,
          autoAlpha: 0,
          ease: "back.out(1.6)",
          stagger: { each: 0.04, from: "start" },
          scrollTrigger: { trigger: grid, start: "top 88%", end: "top 42%", scrub: SCRUB },
        });
      }

      /* Step two → three: the best cell leaves the grid and becomes the ticket. */
      const best = q(".score-cell[data-best]")[0];
      const ticket = q(".scene-result .plan-ticket")[0];
      const chip = q(".flight-chip")[0];
      const last = cards[2];
      if (wide && best && ticket && chip && last) {
        const rest = q(".scene-result ul")[0];
        const state = { t: 0 };
        const place = () => {
          const t = state.t;
          // Where the two ends are right now: both sheets move while this runs.
          const from = best.getBoundingClientRect();
          const to = ticket.getBoundingClientRect();
          const go = gsap.parseEase("power2.inOut")(gsap.utils.clamp(0, 1, t / 0.8));
          const width = lerp(from.width, to.width, go);
          const height = lerp(from.height, to.height, go);
          gsap.set(chip, {
            x: lerp(from.left, to.left, go),
            y: lerp(from.top, to.top, go),
            width,
            height,
            borderRadius: lerp(10, 20, go),
            // There from the first moment of the flight; gone once the ticket has taken over.
            autoAlpha: t <= 0.02 || t >= 0.98 ? 0 : 1 - gsap.utils.clamp(0, 1, (t - 0.7) / 0.25),
          });
          const landed = gsap.utils.clamp(0, 1, (t - 0.62) / 0.38);
          gsap.set(ticket, { opacity: landed, scale: lerp(0.94, 1, gsap.parseEase("power2.out")(landed)) });
          if (rest) gsap.set(rest, { opacity: gsap.utils.clamp(0, 1, (t - 0.85) / 0.15) });
        };
        gsap.to(state, {
          t: 1,
          ease: "none",
          onUpdate: place,
          scrollTrigger: {
            trigger: last,
            start: "top 92%",
            end: () => `top ${(parseFloat(getComputedStyle(last).top) || 0) + 40}px`,
            scrub: SCRUB,
            invalidateOnRefresh: true,
            onRefresh: place,
          },
        });
        place();
      }

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
      };
    });

    // Fonts arriving late change every measured position below them.
    document.fonts?.ready.then(() => ScrollTrigger.refresh()).catch(() => {});
    return () => mm.revert();
  });

  return <span ref={anchor} hidden />;
}
