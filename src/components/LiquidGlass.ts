"use client";

import { useEffect, type RefObject } from "react";

/**
 * Glass that bends what is behind it. Every `.liquid` element under `root` gets a backdrop filter
 * that pushes the picture behind it sideways near its edges, the way a thick pane does, so a
 * message sliding under the message box is seen to curve as it passes the rim.
 *
 * The bending is an SVG displacement map sized to the element: red says how far to move a point
 * across, green how far down, grey leaves it alone. Only Chromium runs an SVG filter as a backdrop
 * filter, so everywhere else, and with "reduce transparency" set, the element keeps the plain
 * frosted look its stylesheet gives it. It is decoration; nothing depends on it.
 */

const SVG = "http://www.w3.org/2000/svg";

/** A map for a `w` by `h` box: neutral in the middle, pulling harder toward each edge over `rim` px. */
function mapFor(w: number, h: number, rim: number): string {
  const stops = (size: number, channel: (v: number) => string) => {
    const r = Math.min(rim / size, 0.5);
    return [
      [0, 0],
      [r * 0.35, 84],
      [r, 128],
      [1 - r, 128],
      [1 - r * 0.35, 172],
      [1, 255],
    ]
      .map(([at, v]) => `<stop offset="${at}" stop-color="${channel(v)}"/>`)
      .join("");
  };
  const svg =
    `<svg xmlns="${SVG}" width="${w}" height="${h}">` +
    `<defs>` +
    `<linearGradient id="x" x1="0" x2="1" y1="0" y2="0">${stops(w, (v) => `rgb(${v},0,0)`)}</linearGradient>` +
    `<linearGradient id="y" x1="0" x2="0" y1="0" y2="1">${stops(h, (v) => `rgb(0,${v},0)`)}</linearGradient>` +
    `</defs>` +
    `<rect width="${w}" height="${h}" fill="#000"/>` +
    `<rect width="${w}" height="${h}" fill="url(#x)"/>` +
    `<rect width="${w}" height="${h}" fill="url(#y)" style="mix-blend-mode:screen"/>` +
    `</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function canBend(): boolean {
  if (typeof window === "undefined" || typeof CSS === "undefined") return false;
  if (window.matchMedia?.("(prefers-reduced-transparency: reduce)").matches) return false;
  // Safari and Firefox accept the syntax in places but do not run the filter on the backdrop.
  return /Chrom(e|ium)\//.test(navigator.userAgent) && CSS.supports("backdrop-filter", "url(#a)");
}

export function useLiquidGlass(root: RefObject<HTMLElement | null>, redrawOn: unknown) {
  useEffect(() => {
    const host = root.current;
    if (!host || !canBend() || typeof ResizeObserver === "undefined") return;

    const defs = document.createElementNS(SVG, "svg");
    defs.setAttribute("aria-hidden", "true");
    defs.setAttribute("width", "0");
    defs.setAttribute("height", "0");
    defs.style.position = "absolute";
    host.appendChild(defs);
    const made = new Map<string, string>();
    const dressed = new Set<HTMLElement>();
    let frame = 0;

    function filterFor(w: number, h: number, depth: number): string {
      const key = `${w}x${h}x${depth}`;
      const had = made.get(key);
      if (had) return had;
      const id = `liquid-${key}-${Math.random().toString(36).slice(2, 7)}`;
      const filter = document.createElementNS(SVG, "filter");
      filter.setAttribute("id", id);
      filter.setAttribute("x", "0");
      filter.setAttribute("y", "0");
      filter.setAttribute("width", "100%");
      filter.setAttribute("height", "100%");
      filter.setAttribute("color-interpolation-filters", "sRGB");
      const image = document.createElementNS(SVG, "feImage");
      image.setAttribute("href", mapFor(w, h, Math.min(h / 2, depth * 0.7)));
      image.setAttribute("x", "0");
      image.setAttribute("y", "0");
      image.setAttribute("width", String(w));
      image.setAttribute("height", String(h));
      image.setAttribute("result", "map");
      const bend = document.createElementNS(SVG, "feDisplacementMap");
      bend.setAttribute("in", "SourceGraphic");
      bend.setAttribute("in2", "map");
      bend.setAttribute("scale", String(depth));
      bend.setAttribute("xChannelSelector", "R");
      bend.setAttribute("yChannelSelector", "G");
      filter.append(image, bend);
      defs.appendChild(filter);
      made.set(key, id);
      return id;
    }

    function dress() {
      frame = 0;
      for (const el of host!.querySelectorAll<HTMLElement>(".liquid")) {
        const w = Math.round(el.offsetWidth);
        const h = Math.round(el.offsetHeight);
        if (!w || !h) continue;
        const depth = Number(el.dataset.liquid) || 28;
        el.style.backdropFilter = `url(#${filterFor(w, h, depth)}) blur(${el.dataset.liquidBlur ?? "1.5"}px) saturate(150%) brightness(1.04)`;
        dressed.add(el);
      }
    }
    const queue = () => {
      frame ||= requestAnimationFrame(dress);
    };

    dress();
    const resized = new ResizeObserver(queue);
    resized.observe(host);
    return () => {
      resized.disconnect();
      cancelAnimationFrame(frame);
      for (const el of dressed) el.style.removeProperty("backdrop-filter");
      defs.remove();
    };
  }, [root, redrawOn]);
}
