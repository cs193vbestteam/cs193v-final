import Link from "next/link";
import { Fragment } from "react";
import { CountUp, DotGrid } from "./Effects";
import { HeroDemo } from "./HeroDemo";
import { LandingMotion } from "./LandingMotion";

/** What people say in the group chat when they mean something else. */
const EXCUSES = ["whatever works", "I'm easy", "anything's fine", "up to you", "I don't mind", "you pick"];

/** The problem, as three exchanges: what someone means, and how it sounds once it is said out loud. */
const SOUNDS_LIKE: { said: string; heard: string }[] = [
  { said: "$30 max", heard: "sounds cheap" },
  { said: "not that far", heard: "sounds difficult" },
  { said: "whatever", heard: "the loudest person decides" },
];

/** The grid in step two: how many of four people could make each place at each time. One cell wins. */
const SCORES = [
  [1, 2, 2, 3, 2],
  [2, 3, 4, 3, 1],
  [1, 2, 3, 2, 2],
  [0, 1, 2, 2, 1],
];
const SCORE_TIMES = ["5:30", "6:00", "7:00", "7:30", "8:00"];
const SCORE_PLACES = ["Kiku", "Olive Tree", "Luca's", "Bao Bar"];

const STEPS = [
  {
    n: "01",
    title: "Tell your assistant the truth",
    body: "A one-minute private chat: budget, when you're free, what you won't eat. Nobody else in your group sees it.",
    scene: (
      <div className="scene-chat">
        <span aria-hidden className="orb" style={{ "--s": "4.5rem" } as React.CSSProperties}>
          <b />
          <b />
          <b />
          <i />
        </span>
        <p className="mt-4 font-serif text-3xl leading-none">Hello, Sam</p>
        <p className="mt-1.5 text-sm text-ink-2">I can help with your plan today.</p>
        <div className="mt-6 w-full space-y-2.5 text-left text-sm">
          <div className="flex justify-end">
            <span className="bubble-mine rounded-[1.25rem] rounded-br-md px-4 py-2">
              after 6 only, under $30, no spicy
            </span>
          </div>
          <div className="flex">
            <span className="bubble-theirs rounded-[1.25rem] rounded-bl-md px-4 py-2 text-ink">
              Got it, noted privately.
            </span>
          </div>
        </div>
      </div>
    ),
  },
  {
    n: "02",
    title: "Every option gets scored",
    body: "Once everyone is done, a program scores every place and start time against what each person said. No AI picks the plan, and nobody's answers are shown to anyone.",
    scene: (
      <div>
        <div className="flex flex-wrap items-center gap-2 font-mono text-xs">
          <span className="rounded-md border border-line-strong bg-surface px-2 py-1 text-ink-2">
            <CountUp to={60} /> places
          </span>
          <span aria-hidden className="text-ink-3">
            ×
          </span>
          <span className="rounded-md border border-line-strong bg-surface px-2 py-1 text-ink-2">
            <CountUp to={14} /> start times
          </span>
          <span className="rounded-md border border-moss/30 bg-moss-soft px-2 py-1 text-moss">
            every open option scored
          </span>
        </div>
        {/* A picture of the scoring, not a table of real results: the sentence above says what it shows. */}
        <div aria-hidden className="score-grid mt-5">
          <span />
          {SCORE_TIMES.map((t) => (
            <span key={t} className="score-head">
              {t}
            </span>
          ))}
          {SCORES.map((row, r) => (
            <Fragment key={SCORE_PLACES[r]}>
              <span className="score-place">{SCORE_PLACES[r]}</span>
              {row.map((n, c) => (
                <span
                  key={c}
                  className="score-cell"
                  data-best={n === 4 || undefined}
                  style={{ "--fill": n / 4, "--i": r * 5 + c } as React.CSSProperties}
                >
                  {n}
                </span>
              ))}
            </Fragment>
          ))}
        </div>
        <p className="mt-3 font-mono text-[0.75rem] uppercase tracking-[0.12em] text-ink-3">how many of 4 could come</p>
      </div>
    ),
  },
  {
    n: "03",
    title: "A short list for the group",
    body: "The plan is the one the fewest people would have to miss, and among those the one that suits the group best, with up to five more places. The group gets the answer and nothing else.",
    scene: (
      <div className="scene-result">
        <div className="plan-ticket plan-ticket-paper">
          <div className="plan-ticket-main">
            <p className="plan-ticket-eyebrow">Settle · the plan</p>
            <p className="plan-ticket-title">Olive Tree Mezze</p>
            <dl className="plan-ticket-facts">
              <div>
                <dt>When</dt>
                <dd>Sat 7:00 PM</dd>
              </div>
              <div>
                <dt>Each</dt>
                <dd>About $27</dd>
              </div>
            </dl>
          </div>
          <div className="plan-ticket-stub">
            <p className="plan-ticket-eyebrow">Can come</p>
            <p className="plan-ticket-count">4/4</p>
            <p className="plan-ticket-eyebrow">everyone</p>
          </div>
        </div>
        <ul className="mt-6 space-y-1.5 font-mono text-[0.75rem] uppercase tracking-[0.12em] text-paper/65">
          <li>also fits · Kiku Izakaya</li>
          <li>also fits · Luca&apos;s Kitchen</li>
        </ul>
      </div>
    ),
  },
];

const LEDGER: { label: string; mine: string; width: number }[] = [
  { label: "When", mine: "Dinner only, from 6pm", width: 1 },
  { label: "Budget", mine: "Up to $30, can stretch to $40", width: 2 },
  { label: "Travel", mine: "15 minutes max", width: 1 },
  { label: "Diet", mine: "No spicy food", width: 1 },
];

const KEPT_SAFE = [
  [
    "Your chat is stored scrambled",
    "What you tell your assistant, and the limits it notes, are encrypted in our database. They cannot be read from a copy of the database alone.",
  ],
  [
    "We never keep your password",
    "Only a one-way fingerprint of it, enough to check that you typed it right. Nobody can read your password back, us included.",
  ],
  [
    "Your email is not kept readable",
    "It is encrypted too. We can tell that it is you when you log in without storing it in a form anyone could read.",
  ],
];

const d = (s: number) => ({ "--d": `${s}s` }) as React.CSSProperties;
const w = (i: number) => ({ "--i": i }) as React.CSSProperties;

export function Landing() {
  return (
    <div className="pb-8">
      <LandingMotion />
      {/* Hero: the headline runs the full width; the demo sits under its last word. */}
      <section data-scene="hero" className="relative pt-10 sm:pt-14 lg:pt-16">
        <div
          aria-hidden
          className="pointer-events-none absolute -right-40 -top-40 -z-10 h-[38rem] w-[38rem] rounded-full opacity-80 blur-3xl"
          style={{ background: "radial-gradient(closest-side, var(--color-paper-2), transparent 70%)" }}
        />
        <div className="rise flex items-baseline justify-between gap-6" style={d(0)}>
          <p className="eyebrow">Group decisions · private constraints</p>
          <p className="eyebrow hidden sm:block">First edition · dinner</p>
        </div>
        {/* Two lines: what is wrong, then what to do about it. The first is sized to stay on one line. */}
        <div className="hero-title-box mt-5">
          <h1 className="display hero-title blur-words">
            <span className="hero-line">
              <span style={w(0)}>Your</span> <span style={w(1)}>group</span> <span style={w(2)}>chat</span>{" "}
              <span style={w(3)}>is</span>{" "}
              <span style={w(4)}>
                <span className="strike-draw">stuck</span>.
              </span>
            </span>{" "}
            {/* Once "stuck" is crossed out, the answer drops in, comes to rest, and is underlined. */}
            <span className="hero-line">
              <em className="settle-word">
                Settle
                <svg aria-hidden viewBox="0 0 300 24" preserveAspectRatio="none">
                  <path d="M4 15 C 70 4, 150 22, 296 9" pathLength={1} />
                </svg>
              </em>{" "}
              <span className="settle-after">it.</span>
            </span>
          </h1>
        </div>

        <div className="mt-10 grid gap-12 lg:mt-14 lg:grid-cols-12 lg:gap-8">
          <div className="lg:col-span-5 lg:pt-6">
            <p className="lede rise max-w-md" style={d(0.2)}>
              Everyone says &ldquo;whatever works&rdquo; and nobody means it. Settle lets each person tell their own
              assistant the real constraints, then picks the plan that fits the group, so nobody has to secretly suffer
              through it.
            </p>
            <div className="rise mt-8 flex flex-wrap items-center gap-3" style={d(0.3)}>
              <Link href="/signup" className="btn btn-lg" data-magnet>
                Start a plan
                <Arrow />
              </Link>
              <Link href="/login" className="btn-ghost btn-lg">
                Log in
              </Link>
            </div>
            <p className="rise mt-4 text-sm text-ink-2" style={d(0.35)}>
              Got a plan code from a friend?{" "}
              <Link href="/guest" className="link text-ink">
                Continue as a guest
              </Link>
            </p>
            <dl
              className="rise mt-10 grid max-w-md grid-cols-3 border-t border-line pt-4 font-mono text-[0.75rem] uppercase tracking-[0.12em] text-ink-3"
              style={d(0.4)}
            >
              {[
                ["Cost", "Free"],
                ["Takes", "A minute"],
                ["Group sees", "The plan"],
              ].map(([k, v]) => (
                <div key={k}>
                  <dt>{k}</dt>
                  <dd className="mt-1 font-serif text-xl normal-case tracking-normal text-ink">{v}</dd>
                </div>
              ))}
            </dl>
          </div>
          {/* The demo comes in once the headline's first line is there (see --hold in globals.css). */}
          <div className="rise lg:col-span-6 lg:col-start-7" style={d(1)}>
            {/* Settles back as the page moves on (LandingMotion). Its own wrapper: the one above is
                held by its entrance, the one below by the pointer. */}
            <div data-recede>
              <div data-tilt>
                <HeroDemo />
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* What everyone says instead */}
      <section className="framed mt-24 py-8 sm:mt-32 sm:py-10">
        {/* The strip's frame: two dashed rules and a mark at each corner, drawn as it is scrolled to
            (LandingMotion). Without it they are simply there. */}
        <i aria-hidden className="frame-line" data-edge="top" />
        <i aria-hidden className="frame-line" data-edge="bottom" />
        {["tl", "tr", "bl", "br"].map((c) => (
          <i key={c} aria-hidden className="frame-mark" data-corner={c} />
        ))}
        <p data-arrive className="eyebrow text-center">
          What everyone says instead
        </p>
        {/* Two rows that slide past each other as the page scrolls (LandingMotion); without it the six
            sit still. The repeats only fill the rows and are not read out. */}
        <div className="excuses mt-5">
          {[EXCUSES.slice(0, 3), EXCUSES.slice(3)].map((row, r) => (
            <ul key={r} className="excuses-row" data-dir={r ? "right" : "left"}>
              {row.map((e) => (
                <li key={e}>&ldquo;{e}&rdquo;</li>
              ))}
              {[...row, ...row].map((e, i) => (
                <li key={i} aria-hidden className="excuses-fill">
                  &ldquo;{e}&rdquo;
                </li>
              ))}
            </ul>
          ))}
        </div>
      </section>

      {/* Why it happens: the one dark page in the book. */}
      <section data-corners className="inked mt-24 sm:mt-32">
        <DotGrid />
        <div className="grid gap-10 lg:grid-cols-12">
          <p className="eyebrow !text-paper/65 lg:col-span-3">The problem</p>
          <p
            data-read
            className="font-serif text-[clamp(1.75rem,3.4vw,2.75rem)] leading-[1.14] tracking-[-0.01em] lg:col-span-9"
          >
            Everyone has real limits: a budget, a Saturday that only works after six, a 20-minute radius. But saying{" "}
            <em>&ldquo;$30 max&rdquo;</em> in the group sounds cheap, and <em>&ldquo;not that far&rdquo;</em> sounds
            difficult. So everyone says &ldquo;whatever&rdquo;, the information stays hidden, and the loudest person
            decides.
          </p>
        </div>
        <dl data-arrive className="mt-12 grid border-t border-paper/20 sm:mt-16 sm:grid-cols-3">
          {SOUNDS_LIKE.map((x, i) => (
            <div
              key={x.said}
              data-arrive-item
              className={`border-paper/20 py-5 sm:py-6 ${i ? "border-t sm:border-l sm:border-t-0 sm:pl-6" : ""} sm:pr-6`}
            >
              <dt className="font-serif text-3xl italic sm:text-4xl">&ldquo;{x.said}&rdquo;</dt>
              <dd className="mt-2 font-mono text-[0.75rem] uppercase tracking-[0.14em] text-paper/65">
                <span aria-hidden>→ </span>
                {x.heard}
              </dd>
            </div>
          ))}
        </dl>
      </section>

      {/* How it works */}
      <section className="mt-24 sm:mt-32">
        {/* The heading's two halves start together and part as it is scrolled to, a rule opening
            between them (LandingMotion). Without it they sit apart, as they end up. */}
        <div className="split-head">
          <h2 className="display text-5xl sm:text-7xl">
            <span data-split="left">How it</span> <i aria-hidden className="split-head-rule" />{" "}
            <span data-split="right">works</span>
          </h2>
          <span className="split-head-note">three steps · one answer</span>
        </div>
        {/* Three sheets, one under the other. On a wide screen with motion allowed LandingMotion turns
            them into one sheet that stays put while the three steps are read past it. */}
        <ol className="stack mt-10">
          {STEPS.map((s, i) => (
            <li
              key={s.n}
              className="stack-card"
              data-corners
              data-tone={i === 2 ? "ink" : i === 1 ? "paper" : "surface"}
              style={w(i)}
            >
              <div className="stack-copy">
                <span aria-hidden className="step-num">
                  {s.n}
                </span>
                <h3 className="mt-6 font-serif text-4xl leading-[1.02] sm:text-5xl">{s.title}</h3>
                <p className="stack-body mt-4 max-w-md leading-relaxed">{s.body}</p>
              </div>
              <div className="stack-scene">{s.scene}</div>
            </li>
          ))}
        </ol>
        {/* The best cell of step two on its way to being step three's ticket (LandingMotion). */}
        <div aria-hidden className="flight-chip" />
      </section>

      {/* Privacy ledger */}
      <section className="mt-24 sm:mt-32">
        <div data-arrive className="grid gap-6 lg:grid-cols-12 lg:items-end">
          <h2 data-arrive-item className="display text-5xl sm:text-7xl lg:col-span-7">
            Your limits stay <em>yours</em>.
          </h2>
          <p data-arrive-item className="lede lg:col-span-5">
            To find a plan, a program on our server reads what everyone told their assistant. What it read goes no
            further: the group gets the plan and, with three or more people, how many can come. Here is what that looks
            like.
          </p>
        </div>
        <div
          data-arrive
          data-ledger
          className="mt-10 overflow-hidden rounded-[1.5rem] border border-ink bg-surface shadow-[var(--shadow-lift)]"
        >
          <div className="hidden border-b border-ink font-mono text-[0.75rem] uppercase tracking-[0.14em] text-ink-3 sm:grid sm:grid-cols-[7rem_1fr_1fr]">
            <div className="px-6 py-3.5">Field</div>
            <div className="px-6 py-3.5">What your assistant knows</div>
            <div className="border-l border-line bg-paper-2/60 px-6 py-3.5">What the group ever sees</div>
          </div>
          {LEDGER.map((row) => (
            <div key={row.label} className="grid border-b border-line last:border-b-0 sm:grid-cols-[7rem_1fr_1fr]">
              <div className="px-6 pt-4 font-mono text-[0.75rem] uppercase tracking-[0.14em] text-ink-3 sm:py-5">
                {row.label}
              </div>
              <div className="px-6 pb-2 pt-1 font-serif text-xl sm:py-4 sm:text-2xl">{row.mine}</div>
              <div className="flex items-center gap-2 px-6 pb-4 pt-1 sm:border-l sm:border-line sm:bg-paper-2/60 sm:py-5">
                <span className="shrink-0 whitespace-nowrap font-mono text-[0.75rem] uppercase tracking-[0.14em] text-ink-3 sm:hidden">
                  group sees
                </span>
                <span className="redact min-w-0 shrink" style={{ width: `${row.width * 3.5 + 2}rem` }} />
                <span className="rounded-md border border-line-strong bg-surface px-2 py-0.5 font-mono text-xs text-ink-2">
                  nothing
                </span>
              </div>
            </div>
          ))}
        </div>
        <div data-arrive className="mt-8 grid gap-x-8 sm:grid-cols-3">
          {KEPT_SAFE.map(([title, body]) => (
            <div key={title} data-arrive-item className="border-t border-line-strong py-5">
              <div className="font-serif text-2xl leading-tight text-ink">{title}</div>
              <p className="mt-2 text-sm leading-relaxed text-ink-2">{body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Closing */}
      <section data-arrive className="relative mt-24 border-t border-ink pt-14 text-center sm:mt-32 sm:pt-20">
        <Seal />
        <h2 data-arrive-item className="display mx-auto max-w-4xl text-[clamp(2.75rem,9vw,7rem)]">
          Stop saying <em>&ldquo;whatever works.&rdquo;</em>
        </h2>
        <p data-arrive-item className="lede mx-auto mt-6 max-w-lg">
          First version: picking a restaurant and a time for a meal. Trips, roommates and chores come next.
        </p>
        <div data-arrive-item className="mt-8 flex justify-center gap-3">
          <Link href="/signup" className="btn btn-lg">
            Start a plan
            <Arrow />
          </Link>
          <Link href="/login" className="btn-ghost btn-lg">
            Log in
          </Link>
        </div>
      </section>
    </div>
  );
}

function Arrow() {
  return (
    <svg aria-hidden width="14" height="14" viewBox="0 0 16 16" fill="none" className="-mr-1">
      <path
        d="M3 8h9M8.5 3.5 13 8l-4.5 4.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Four separate lines run into one, and the one ends in a full stop: everyone's own limits,
 * one plan, settled. The full stop is the red dot of the wordmark. Decoration only.
 */
function Seal() {
  return (
    <svg aria-hidden viewBox="0 0 240 96" fill="none" className="seal">
      <g stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="text-ink">
        <path d="M4 8 C 70 8, 78 48, 132 48" />
        <path d="M4 34 C 60 34, 80 48, 132 48" />
        <path d="M4 62 C 60 62, 80 48, 132 48" />
        <path d="M4 88 C 70 88, 78 48, 132 48" />
        <path d="M132 48 H 208" strokeWidth="3.5" />
      </g>
      {[8, 34, 62, 88].map((y) => (
        <circle key={y} cx="4" cy={y} r="3.5" className="fill-ink" />
      ))}
      <circle cx="224" cy="48" r="9" className="fill-seal" />
    </svg>
  );
}
