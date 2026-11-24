"use client";

import { useRef } from "react";
import { usePathname } from "next/navigation";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { ARRIVE, MOTION_OK, RECEDE, SCRUB } from "@/lib/motion";

gsap.registerPlugin(useGSAP, ScrollTrigger);

/**
 * The motion every page has, wired from marks in the markup. It sits once in the layout.
 *
 *  - `data-arrive`: comes in when scrolled to. With `data-arrive-item` children, they come in one
 *    after another and the block itself stays put. Blocks that reach the screen together are
 *    staggered together, so a long list comes in a screenful at a time.
 *  - `data-recede`: settles back as the page scrolls past it, like a sheet being covered.
 *  - `data-progress`: a line that is as full as the page is read.
 *
 * A page that is all on screen when it opens uses `.rise` (CSS) and needs none of this.
 *
 * Until a marked block is taken over here it is kept clear by CSS (globals.css, "Arrive"), so it
 * does not show for a moment and then fade out. That rule gives up after a few seconds, and does
 * not apply at all without JavaScript or with reduced motion: then everything is simply there.
 *
 * A block that has not arrived yet is see-through, never hidden: it is still read out, found by
 * a search of the page, and reachable with the keyboard. Moving focus into one brings it in.
 */
export function PageMotion() {
  const anchor = useRef<HTMLSpanElement>(null);
  const pathname = usePathname();

  useGSAP(
    () => {
      const main = anchor.current?.parentElement;
      if (!main) return;
      const mm = gsap.matchMedia();

      mm.add(MOTION_OK, (media) => {
        /** Takes over every marked block that has not been taken over yet. */
        const wire = () => {
          const groups = [...main.querySelectorAll<HTMLElement>("[data-arrive]:not([data-arrive-ready])")];
          const targets = groups.flatMap((group) => {
            const items = [...group.querySelectorAll<HTMLElement>("[data-arrive-item]")];
            return items.length ? items : [group];
          });
          if (targets.length) {
            gsap.set(targets, { opacity: 0, y: ARRIVE.y, filter: `blur(${ARRIVE.blur}px)` });
            for (const group of groups) group.setAttribute("data-arrive-ready", "");
            ScrollTrigger.batch(targets, {
              start: ARRIVE.start,
              once: true,
              onEnter: (batch) =>
                gsap.to(batch, {
                  opacity: 1,
                  y: 0,
                  filter: "blur(0px)",
                  duration: ARRIVE.duration,
                  ease: ARRIVE.ease,
                  stagger: ARRIVE.stagger,
                  overwrite: true,
                  // Left in place, a filter or transform would keep each block on its own layer,
                  // and a transform would trap anything fixed or sticky inside it.
                  clearProps: "filter,transform",
                }),
            });
          }

          for (const sheet of main.querySelectorAll<HTMLElement>("[data-recede='page']:not([data-recede-ready])")) {
            sheet.setAttribute("data-recede-ready", "");
            gsap.to(sheet, {
              scale: RECEDE.scale,
              transformOrigin: "50% 0%",
              ease: "none",
              scrollTrigger: { trigger: sheet, start: "bottom 62%", end: "bottom top", scrub: SCRUB },
            });
          }

          for (const line of main.querySelectorAll<HTMLElement>("[data-progress]:not([data-progress-ready])")) {
            line.setAttribute("data-progress-ready", "");
            gsap.fromTo(
              line,
              { scaleX: 0 },
              {
                scaleX: 1,
                transformOrigin: "0% 50%",
                ease: "none",
                scrollTrigger: {
                  trigger: document.documentElement,
                  start: "top top",
                  end: "bottom bottom",
                  scrub: SCRUB,
                },
              },
            );
          }
        };
        wire();

        // Tabbing into a block that has not been scrolled to must not land on something unseen.
        const show = (event: FocusEvent) => {
          const at = event.target instanceof Element ? event.target : null;
          const waiting = at?.closest<HTMLElement>("[data-arrive-item], [data-arrive]");
          if (waiting && getComputedStyle(waiting).opacity !== "1") {
            gsap.to(waiting, { opacity: 1, y: 0, filter: "blur(0px)", duration: 0.2, overwrite: true });
          }
        };
        main.addEventListener("focusin", show);

        // A plan page gains blocks while it is open (the plan itself, once it is found). Whatever
        // is added later is taken over the same way.
        let queued = 0;
        media.add("again", () => {
          queued = 0;
          wire();
          ScrollTrigger.refresh();
        });
        const watcher = new MutationObserver((changes) => {
          const added = changes.some((c) =>
            [...c.addedNodes].some(
              (n) => n instanceof HTMLElement && (n.matches("[data-arrive]") || n.querySelector("[data-arrive]")),
            ),
          );
          if (added && !queued) queued = requestAnimationFrame(() => media.again());
        });
        watcher.observe(main, { childList: true, subtree: true });

        return () => {
          main.removeEventListener("focusin", show);
          watcher.disconnect();
          cancelAnimationFrame(queued);
          for (const name of ["data-arrive-ready", "data-recede-ready", "data-progress-ready"]) {
            for (const el of main.querySelectorAll(`[${name}]`)) el.removeAttribute(name);
          }
        };
      });

      return () => mm.revert();
    },
    { dependencies: [pathname], revertOnUpdate: true },
  );

  return <span ref={anchor} hidden />;
}
