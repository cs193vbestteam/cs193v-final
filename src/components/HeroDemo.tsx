/**
 * The hero's one idea: a three-day group thread collapses into one line.
 * Pure CSS keyframes (see globals.css .demo-*), so it costs nothing to run
 * and resolves to the final state under prefers-reduced-motion.
 */
export const DEMO_THREAD: { who: string; text: string; link?: boolean }[] = [
  { who: "Alex", text: "sooo what's the move saturday" },
  { who: "Sam", text: "whatever works for me 🤷" },
  { who: "Jo", text: "same honestly" },
  { who: "Mia", text: "somewhere not crazy expensive?" },
  { who: "Alex", text: "i'm out until like 6" },
  { who: "Sam", text: "yelp.com/olive-tree-mezze", link: true },
  { who: "Jo", text: "anyone??" },
  { who: "Mia", text: "bump" },
];

export const DEMO_RESULT = { when: "Sat 7pm", where: "Olive Tree Mezze", cost: "~$27 each" };

export function HeroDemo() {
  return (
    <div className="demo relative mx-auto w-full max-w-md" aria-label="A group chat collapsing into one agreed plan">
      <div className="relative overflow-hidden rounded-[1.5rem] border border-line bg-surface shadow-[var(--shadow-lift)]">
        <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-3 font-mono text-[0.6875rem] uppercase tracking-[0.14em]">
          <span className="whitespace-nowrap text-ink-3">the crew · 4</span>
          <span className="demo-count whitespace-nowrap text-seal">day 3 · nothing yet</span>
        </div>
        <ol className="space-y-2.5 px-5 py-5">
          {DEMO_THREAD.map((m, i) => (
            <li
              key={i}
              className="demo-msg flex items-baseline gap-2.5 text-[0.9375rem] leading-snug"
              style={{ "--i": i } as React.CSSProperties}
            >
              <span className="w-9 shrink-0 font-mono text-[0.6875rem] uppercase tracking-wider text-ink-3">
                {m.who}
              </span>
              <span
                className={m.link ? "truncate text-ink-3 underline decoration-line underline-offset-2" : "text-ink"}
              >
                {m.text}
              </span>
            </li>
          ))}
        </ol>

        {/* The one line everyone actually needed */}
        <div className="demo-result pointer-events-none absolute inset-x-5 top-1/2 -translate-y-1/2">
          <div className="relative rounded-2xl border border-ink bg-ink px-5 py-4 text-paper shadow-[var(--shadow-lift)]">
            <div className="font-mono text-[0.6875rem] uppercase tracking-[0.14em] text-paper/60">
              settle · to the group
            </div>
            <div className="mt-1.5 font-serif text-2xl leading-tight">
              {DEMO_RESULT.when} · {DEMO_RESULT.where}
            </div>
            <div className="mt-1 text-sm text-paper/75">{DEMO_RESULT.cost} · 11 min away · mediterranean</div>
            <div className="demo-seal absolute -right-2 -top-4 rounded-md border-2 border-seal px-2 py-0.5 font-mono text-[0.625rem] font-medium uppercase tracking-[0.18em] text-seal bg-paper">
              everyone&apos;s in
            </div>
          </div>
        </div>
      </div>
      <p className="mt-3 text-center font-mono text-[0.6875rem] uppercase tracking-[0.14em] text-ink-3">
        8 messages → 1 line. nobody said a number out loud.
      </p>
    </div>
  );
}
