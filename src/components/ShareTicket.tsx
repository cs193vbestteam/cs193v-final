"use client";

import { useEffect, useRef, useState } from "react";

export type TicketFacts = {
  /** The plan's own name. */
  title: string;
  place: string;
  /** "Fri, Dec 4" */
  date: string;
  /** "7:00 PM" */
  time: string;
  /** "~$30/person" */
  cost: string;
  /** "Thai" */
  kind: string;
};

const W = 1200;
const H = 630;

/**
 * Draws the plan as a ticket: what the group already sees on the page (place, day, time, cost,
 * kind) and nothing of anyone's own answers. Drawn in the browser, so the picture is never stored
 * and no address serves it.
 */
function drawTicket(canvas: HTMLCanvasElement, t: TicketFacts, fonts: { serif: string; sans: string; mono: string }) {
  const g = canvas.getContext("2d");
  if (!g) return;
  const css = getComputedStyle(document.documentElement);
  const color = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  const ink = color("--color-ink", "#16140f");
  const paper = color("--color-paper", "#ece7dc");
  const seal = color("--color-seal", "#c2452d");
  const dim = "rgb(236 231 220 / 0.55)";
  const rule = "rgb(236 231 220 / 0.22)";

  g.clearRect(0, 0, W, H);
  g.fillStyle = paper;
  g.fillRect(0, 0, W, H);

  // The ticket, with a bite out of each side where the stub tears off.
  const x = 60;
  const y = 60;
  const w = W - 120;
  const h = H - 120;
  const tear = x + w - 250;
  g.fillStyle = ink;
  g.beginPath();
  g.roundRect(x, y, w, h, 36);
  g.fill();
  g.fillStyle = paper;
  for (const cy of [y, y + h]) {
    g.beginPath();
    g.arc(tear, cy, 18, 0, Math.PI * 2);
    g.fill();
  }
  g.strokeStyle = rule;
  g.lineWidth = 3;
  g.setLineDash([3, 12]);
  g.lineCap = "round";
  g.beginPath();
  g.moveTo(tear, y + 34);
  g.lineTo(tear, y + h - 34);
  g.stroke();
  g.setLineDash([]);

  const label = (text: string, lx: number, ly: number, align: CanvasTextAlign = "left") => {
    g.font = `500 20px ${fonts.mono}`;
    g.fillStyle = dim;
    g.textAlign = align;
    // Canvas has no letter-spacing everywhere yet; thin spaces keep the tracked, stamped look.
    g.fillText(text.toUpperCase().split("").join(" "), lx, ly);
  };

  const left = x + 56;
  const room = tear - left - 56;
  label(`Settle · ${t.title}`.slice(0, 48), left, y + 74);

  // The place is the headline: as large as fits on one line, down to a floor, then cut.
  let size = 112;
  g.textAlign = "left";
  g.fillStyle = paper;
  let name = t.place;
  for (; size > 56; size -= 4) {
    g.font = `400 ${size}px ${fonts.serif}`;
    if (g.measureText(name).width <= room) break;
  }
  g.font = `400 ${size}px ${fonts.serif}`;
  while (g.measureText(name).width > room && name.length > 4) name = `${name.slice(0, -2).trimEnd()}…`;
  g.fillText(name, left, y + 74 + 60 + size * 0.78);

  // Three facts under a rule.
  const top = y + h - 150;
  g.fillStyle = rule;
  g.fillRect(left, top, room, 2);
  const facts: [string, string][] = [
    ["Date", t.date],
    ["Cost", t.cost],
    ["Kind", t.kind],
  ];
  facts.forEach(([k, v], i) => {
    const fx = left + (room / facts.length) * i;
    label(k, fx, top + 48);
    g.font = `500 34px ${fonts.sans}`;
    g.fillStyle = paper;
    g.textAlign = "left";
    let value = v;
    while (g.measureText(value).width > room / facts.length - 24 && value.length > 4)
      value = `${value.slice(0, -2).trimEnd()}…`;
    g.fillText(value, fx, top + 96);
  });

  // The stub: the time, which is what people ask each other.
  const mid = tear + (x + w - tear) / 2;
  const [clock, half = ""] = t.time.split(" ");
  label("Starts", mid, y + 150, "center");
  g.font = `400 84px ${fonts.serif}`;
  g.fillStyle = seal;
  g.textAlign = "center";
  g.fillText(clock, mid, y + 250);
  g.font = `500 30px ${fonts.sans}`;
  g.fillStyle = paper;
  g.fillText(half, mid, y + 296);
  label(t.date, mid, y + h - 70, "center");
}

/**
 * "Share with the group": opens the plan as a ticket, to copy or save as a picture, with the text
 * message (plan and link) beside it for a chat that takes text better.
 */
export function ShareTicket({ ticket, message }: { ticket: TicketFacts; message: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const probe = useRef<HTMLSpanElement>(null);
  const [note, setNote] = useState("");

  async function open() {
    dialog.current?.showModal();
    setNote("");
    // The page's own typefaces, read from elements that use them, once they have loaded.
    await document.fonts?.ready;
    const family = (cls: string) => {
      const el = probe.current?.querySelector(`.${cls}`);
      return el ? getComputedStyle(el).fontFamily : "sans-serif";
    };
    if (canvas.current)
      drawTicket(canvas.current, ticket, {
        serif: family("font-serif"),
        sans: family("font-sans"),
        mono: family("font-mono"),
      });
  }

  useEffect(() => {
    if (!note) return;
    const timer = setTimeout(() => setNote(""), 3000);
    return () => clearTimeout(timer);
  }, [note]);

  const png = () =>
    new Promise<Blob>((resolve, reject) =>
      canvas.current?.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("no image"))), "image/png"),
    );

  async function copyImage() {
    try {
      // Given as a promise: Safari only allows the clipboard inside the click itself.
      await navigator.clipboard.write([new ClipboardItem({ "image/png": png() })]);
      setNote("Picture copied.");
    } catch {
      setNote("Couldn’t copy the picture here. Download it instead.");
    }
  }

  async function download() {
    const url = URL.createObjectURL(await png());
    const a = document.createElement("a");
    a.href = url;
    a.download = `${ticket.title.replace(/[^\w-]+/g, "-").replace(/^-|-$/g, "") || "plan"}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function copyMessage() {
    try {
      await navigator.clipboard.writeText(message);
      setNote("Message copied.");
    } catch {
      setNote("Couldn’t copy. Select the text below.");
    }
  }

  return (
    <>
      <button type="button" className="btn w-full" onClick={open}>
        Share with the group
      </button>
      <dialog
        ref={dialog}
        aria-label="Share the plan"
        className="m-auto w-[min(40rem,calc(100vw-2rem))] rounded-2xl border border-line bg-surface p-0 text-ink backdrop:bg-ink/40"
        // A click on the backdrop lands on the dialog element itself; one inside lands on a child.
        onClick={(e) => e.target === e.currentTarget && dialog.current?.close()}
      >
        <div className="max-h-[90vh] overflow-y-auto p-5">
          <span ref={probe} aria-hidden className="sr-only">
            <span className="font-serif">a</span>
            <span className="font-sans">a</span>
            <span className="font-mono">a</span>
          </span>
          <canvas
            ref={canvas}
            width={W}
            height={H}
            role="img"
            aria-label={`${ticket.place}, ${ticket.date}, ${ticket.time}, ${ticket.cost}, ${ticket.kind}`}
            className="block h-auto w-full rounded-xl"
          />
          <div className="mt-4 grid gap-2 sm:grid-cols-3">
            <button type="button" className="btn btn-sm" onClick={copyImage}>
              Copy picture
            </button>
            <button type="button" className="btn-ghost btn-sm" onClick={download}>
              Download
            </button>
            <button type="button" className="btn-ghost btn-sm" onClick={copyMessage}>
              Copy message
            </button>
          </div>
          <p role="status" className="mt-2 min-h-5 text-center text-xs text-ink-3">
            {note}
          </p>
          {note.startsWith("Couldn’t copy. Select") && (
            <textarea
              className="input mt-1 text-xs"
              rows={3}
              readOnly
              aria-label="Message for the group"
              value={message}
              onFocus={(event) => event.currentTarget.select()}
            />
          )}
          <div className="mt-3 text-center">
            <button type="button" className="link link-small" onClick={() => dialog.current?.close()}>
              Close
            </button>
          </div>
        </div>
      </dialog>
    </>
  );
}
