"use client";

import { useRef } from "react";

/** One option on the shortlist, as the group may see it: public facts about the place and nothing about people. */
export type OptionTile = {
  key: string;
  name: string;
  when: string;
  cuisine: string;
  pricePerPerson: number;
  travelMin?: number;
  rating?: number;
  ratingCount?: number;
  address?: string;
  mapsUrl?: string;
  /** False when it is a stretch for someone. Left out for a group of two. */
  everyoneIn?: boolean;
};

/**
 * The flag of the country a cuisine is named after, to scan the list by (#161). Only where the
 * cuisine names one country: "Mediterranean" or "restaurant" gets no flag rather than a wrong one.
 */
const FLAGS: [RegExp, string][] = [
  [/\bmexican\b/, "🇲🇽"],
  [/\bitalian\b/, "🇮🇹"],
  [/\bjapanese\b/, "🇯🇵"],
  [/\bkorean\b/, "🇰🇷"],
  [/\bchinese\b/, "🇨🇳"],
  [/\bthai\b/, "🇹🇭"],
  [/\bvietnamese\b/, "🇻🇳"],
  [/\bindian\b/, "🇮🇳"],
  [/\bamerican\b/, "🇺🇸"],
  [/\bfrench\b/, "🇫🇷"],
  [/\bgreek\b/, "🇬🇷"],
  [/\bspanish\b/, "🇪🇸"],
  [/\bturkish\b/, "🇹🇷"],
  [/\blebanese\b/, "🇱🇧"],
  [/\bbrazilian\b/, "🇧🇷"],
  [/\bindonesian\b/, "🇮🇩"],
];
function flagFor(kind: string): string | null {
  const words = kind.toLowerCase();
  return FLAGS.find(([pattern]) => pattern.test(words))?.[1] ?? null;
}

/**
 * The plan as a pop-out: a button on the page, and a window listing every option on the shortlist,
 * one tile each, best fit for the group at the top. The window is a native <dialog>, so Escape and
 * the backdrop close it and the page behind it cannot be clicked while it is open.
 */
export function PlanOptions({ tiles, sentence }: { tiles: OptionTile[]; sentence?: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  if (tiles.length === 0) return null;
  return (
    <>
      {/* Outlined: once there is a plan, the one filled button on the page is "Share with the group". */}
      <button type="button" className="btn-ghost btn-sm mt-3 w-full" onClick={() => dialog.current?.showModal()}>
        {tiles.length === 1 ? "See the plan" : `See all ${tiles.length} options`}
      </button>
      <dialog
        ref={dialog}
        aria-label="The plan"
        className="m-auto w-[min(34rem,calc(100vw-2rem))] rounded-2xl border border-line bg-surface p-0 text-ink backdrop:bg-ink/40"
        // A click on the backdrop lands on the dialog element itself; one inside lands on a child.
        onClick={(e) => e.target === e.currentTarget && dialog.current?.close()}
      >
        <div className="max-h-[85vh] overflow-y-auto p-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="font-serif text-2xl leading-tight">The plan</div>
              <p className="mt-1 text-sm text-ink-2">
                {tiles.length === 1
                  ? "One place works for the group."
                  : `${tiles.length} places that work for the group, best fit first.`}
              </p>
            </div>
            <button type="button" className="btn-ghost btn-sm shrink-0" onClick={() => dialog.current?.close()}>
              Close
            </button>
          </div>
          <ol className="mt-4 space-y-3">
            {tiles.map((t, i) => (
              <li
                key={t.key}
                className={`rounded-xl border p-4 ${i === 0 ? "border-moss/30 bg-moss-soft" : "border-line"} rise`}
                style={{ "--d": `${i * 0.06}s` } as React.CSSProperties}
              >
                <div className="flex items-start gap-3.5">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-3">
                      <div className="font-mono text-[0.75rem] uppercase tracking-wider text-ink-3">
                        {i === 0 ? "1 · Best fit" : `${i + 1}`}
                      </div>
                      {t.everyoneIn === true && (
                        <div className="font-mono text-[0.75rem] uppercase tracking-wider text-moss">
                          Everyone&apos;s in
                        </div>
                      )}
                      {t.everyoneIn === false && (
                        <div className="font-mono text-[0.75rem] uppercase tracking-wider text-amber-ink">
                          A stretch for some
                        </div>
                      )}
                    </div>
                    <div className="mt-0.5 font-serif text-2xl leading-tight">{t.name}</div>
                    {/* One fact to a chip, so the eye can run down a column of times or of costs. */}
                    <ul className="mt-2 flex flex-wrap gap-1.5">
                      <li className="option-fact">{t.when.split(" · ").pop()}</li>
                      <li className="option-fact">~${t.pricePerPerson}/person</li>
                      {t.travelMin !== undefined && <li className="option-fact">{t.travelMin} min away</li>}
                      <li className="option-fact">
                        {flagFor(t.cuisine) && (
                          <span aria-hidden className="mr-1">
                            {flagFor(t.cuisine)}
                          </span>
                        )}
                        {t.cuisine}
                      </li>
                      {t.rating !== undefined && (
                        <li className="option-fact">
                          ★ {t.rating.toFixed(1)}
                          {t.ratingCount ? ` (${t.ratingCount.toLocaleString("en-US")})` : ""}
                          <span className="sr-only"> on Google</span>
                        </li>
                      )}
                    </ul>
                    {(t.address || (t.mapsUrl && /^https:\/\//.test(t.mapsUrl))) && (
                      <div className="mt-2 flex flex-wrap items-baseline gap-x-3 text-sm text-ink-2">
                        {t.address && <span>{t.address}</span>}
                        {t.mapsUrl && /^https:\/\//.test(t.mapsUrl) && (
                          <a href={t.mapsUrl} target="_blank" rel="noopener noreferrer" className="py-1 underline">
                            Open in Google Maps
                          </a>
                        )}
                      </div>
                    )}
                  </div>
                </div>
                {i === 0 && sentence && <p className="mt-2 text-sm italic text-ink-2">{sentence}</p>}
              </li>
            ))}
          </ol>
        </div>
      </dialog>
    </>
  );
}
