/**
 * The site's motion, as numbers every page shares, so that no page moves at its own pace.
 *
 * Two kinds of movement and no others:
 *  - ARRIVE: a block comes in once, when it is scrolled to. The same distance, blur, time and ease
 *    as `.rise` in globals.css, which brings in whatever is on screen when a page opens.
 *  - SCRUB: a change tied to the scrollbar, which stops when scrolling stops. Every one of them
 *    trails the scrollbar by the same amount.
 */
export const ARRIVE = { y: 22, blur: 4, duration: 0.9, ease: "expo.out", stagger: 0.08, start: "top 88%" } as const;
export const SCRUB = 0.6;

/** A sheet that settles back as the page moves past it: how far, on every page that has one. */
export const RECEDE = { scale: 0.96 } as const;

/** Motion runs only where the person has not asked for less of it. */
export const MOTION_OK = "(prefers-reduced-motion: no-preference)";
