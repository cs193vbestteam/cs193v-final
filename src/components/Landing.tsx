import Link from "next/link";
import { HeroDemo } from "./HeroDemo";
import { Reveal } from "./Reveal";

/** What people say in the group chat when they mean something else. */
const EXCUSES = ["whatever works", "I'm easy", "anything's fine", "up to you", "I don't mind", "you pick"];

/** The problem, as three exchanges: what someone means, and how it sounds once it is said out loud. */
const SOUNDS_LIKE: { said: string; heard: string }[] = [
  { said: "$30 max", heard: "sounds cheap" },
  { said: "not that far", heard: "sounds difficult" },
  { said: "whatever", heard: "the loudest person decides" },
];

const STEPS = [
  {
    n: "01",
    title: "Tell your assistant the truth",
    body: "A one-minute private chat: budget, when you're free, what you won't eat. Nobody else in your group sees it.",
    demo: (
      <div className="space-y-2 text-sm">
        <div className="flex justify-end">
          <span className="rounded-2xl rounded-br-md bg-ink px-3 py-1.5 text-paper">
            after 6 only, under $30, no spicy
          </span>
        </div>
        <div className="flex">
          <span className="rounded-2xl rounded-bl-md bg-paper-2 px-3 py-1.5">Got it, noted privately.</span>
        </div>
      </div>
    ),
  },
  {
    n: "02",
    title: "Every option gets scored",
    body: "Once everyone is done, a program scores every place and start time against what each person said. No AI picks the plan, and nobody's answers are shown to anyone.",
    demo: (
      <div className="flex flex-wrap items-center gap-2 font-mono text-xs">
        <span className="rounded-md border border-line-strong bg-paper-2 px-2 py-1 text-ink-2">60 places</span>
        <span aria-hidden className="text-ink-3">
          ×
        </span>
        <span className="rounded-md border border-line-strong bg-paper-2 px-2 py-1 text-ink-2">14 start times</span>
        <span className="rounded-md border border-moss/30 bg-moss-soft px-2 py-1 text-moss">
          every open option scored
        </span>
      </div>
    ),
  },
  {
    n: "03",
    title: "A short list for the group",
    body: "The plan is the one the fewest people would have to miss, and among those the one that suits the group best, with up to five more places. The group gets the answer and nothing else.",
    demo: (
      <div className="rounded-xl border border-ink bg-ink px-4 py-3 text-paper shadow-[var(--shadow-lift)]">
        <div className="font-serif text-xl leading-tight">Sat 7pm · Olive Tree Mezze</div>
        <div className="mt-0.5 text-xs text-paper/70">~$27 each · everyone can come</div>
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
    "AES-256-GCM",
  ],
  [
    "We never keep your password",
    "Only a one-way fingerprint of it, enough to check that you typed it right. Nobody can read your password back, us included.",
    "bcrypt, cost 12",
  ],
  [
    "Your email is not kept readable",
    "It is encrypted too. We can tell that it is you when you log in without storing it in a form anyone could read.",
    "HMAC blind index",
  ],
];

const d = (s: number) => ({ "--d": `${s}s` }) as React.CSSProperties;

export function Landing() {
  return (
    <div className="pb-8">
      {/* Hero: the headline runs the full width; the demo sits under its last word. */}
      <section className="relative pt-10 sm:pt-14 lg:pt-16">
        <div
          aria-hidden
          className="pointer-events-none absolute -right-40 -top-40 -z-10 h-[38rem] w-[38rem] rounded-full opacity-80 blur-3xl"
          style={{ background: "radial-gradient(closest-side, var(--color-paper-2), transparent 70%)" }}
        />
        <div className="rise flex items-baseline justify-between gap-6" style={d(0)}>
          <p className="eyebrow">Group decisions · private constraints</p>
          <p className="eyebrow hidden sm:block">First edition · dinner</p>
        </div>
        <h1 className="display hero-title rise mt-5" style={d(0.08)}>
          Group plans, <em>without</em> the <span className="strike-draw">group chat</span>.
        </h1>

        <div className="mt-10 grid gap-12 lg:mt-14 lg:grid-cols-12 lg:gap-8">
          <div className="lg:col-span-5 lg:pt-6">
            <p className="lede rise max-w-md" style={d(0.2)}>
              Everyone says &ldquo;whatever works&rdquo; and nobody means it. Settle lets each person tell their own
              assistant the real constraints, then picks the plan that fits the group, so nobody has to secretly suffer
              through it.
            </p>
            <div className="rise mt-8 flex flex-wrap items-center gap-3" style={d(0.3)}>
              <Link href="/signup" className="btn btn-lg">
                Start a plan
                <Arrow />
              </Link>
              <Link href="/login" className="btn-ghost btn-lg">
                Log in
              </Link>
            </div>
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
          <div className="rise lg:col-span-6 lg:col-start-7" style={d(0.35)}>
            <HeroDemo />
          </div>
        </div>
      </section>

      {/* What everyone says instead */}
      <Reveal as="section" className="mt-24 border-y border-line py-8 sm:mt-32 sm:py-10">
        <p className="eyebrow text-center">What everyone says instead</p>
        <ul className="excuses mt-5">
          {EXCUSES.map((e) => (
            <li key={e}>&ldquo;{e}&rdquo;</li>
          ))}
        </ul>
      </Reveal>

      {/* Why it happens: the one dark page in the book. */}
      <Reveal as="section" className="inked mt-24 sm:mt-32">
        <div className="grid gap-10 lg:grid-cols-12">
          <p className="eyebrow !text-paper/65 lg:col-span-3">The problem</p>
          <p className="font-serif text-[clamp(1.75rem,3.4vw,2.75rem)] leading-[1.14] tracking-[-0.01em] lg:col-span-9">
            Everyone has real limits: a budget, a Saturday that only works after six, a 20-minute radius. But saying{" "}
            <em>&ldquo;$30 max&rdquo;</em> in the group sounds cheap, and <em>&ldquo;not that far&rdquo;</em> sounds
            difficult. So everyone says &ldquo;whatever&rdquo;, the information stays hidden, and the loudest person
            decides.
          </p>
        </div>
        <dl className="mt-12 grid border-t border-paper/20 sm:mt-16 sm:grid-cols-3">
          {SOUNDS_LIKE.map((x, i) => (
            <div
              key={x.said}
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
      </Reveal>

      {/* How it works */}
      <section className="mt-24 sm:mt-32">
        <Reveal className="flex items-end justify-between">
          <h2 className="display text-5xl sm:text-7xl">How it works</h2>
          <span className="hidden font-mono text-xs uppercase tracking-[0.14em] text-ink-3 sm:inline">
            three steps · one answer
          </span>
        </Reveal>
        <ol className="mt-10 border-t border-ink">
          {STEPS.map((s, i) => (
            <Reveal as="li" key={s.n} delay={i * 0.08} className="step">
              <span aria-hidden className="step-num">
                {s.n}
              </span>
              <div>
                <h3 className="font-serif text-3xl leading-[1.05] sm:text-[2.5rem]">{s.title}</h3>
                <p className="mt-3 max-w-md leading-relaxed text-ink-2">{s.body}</p>
              </div>
              <div className="step-demo">{s.demo}</div>
            </Reveal>
          ))}
        </ol>
      </section>

      {/* Privacy ledger */}
      <section className="mt-24 sm:mt-32">
        <Reveal className="grid gap-6 lg:grid-cols-12 lg:items-end">
          <h2 className="display text-5xl sm:text-7xl lg:col-span-7">
            Your limits stay <em>yours</em>.
          </h2>
          <p className="lede lg:col-span-5">
            To find a plan, a program on our server reads what everyone told their assistant. What it read goes no
            further: the group gets the plan and, with three or more people, how many can come. Here is what that looks
            like.
          </p>
        </Reveal>
        <Reveal
          delay={0.1}
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
        </Reveal>
        <Reveal delay={0.15} className="mt-8 grid gap-x-8 sm:grid-cols-3">
          {KEPT_SAFE.map(([title, body, how]) => (
            <div key={title} className="border-t border-line-strong py-5">
              <p className="font-mono text-xs uppercase tracking-[0.12em] text-ink-3">{how}</p>
              <div className="mt-2 font-serif text-2xl leading-tight text-ink">{title}</div>
              <p className="mt-2 text-sm leading-relaxed text-ink-2">{body}</p>
            </div>
          ))}
        </Reveal>
      </section>

      {/* Closing */}
      <Reveal as="section" className="relative mt-24 border-t border-ink pt-14 text-center sm:mt-32 sm:pt-20">
        <Seal />
        <h2 className="display mx-auto max-w-4xl text-[clamp(2.75rem,9vw,7rem)]">
          Stop saying <em>&ldquo;whatever works.&rdquo;</em>
        </h2>
        <p className="lede mx-auto mt-6 max-w-lg">
          First version: picking a restaurant and a time for a meal. Trips, roommates and chores come next.
        </p>
        <div className="mt-8 flex justify-center gap-3">
          <Link href="/signup" className="btn btn-lg">
            Start a plan
            <Arrow />
          </Link>
          <Link href="/login" className="btn-ghost btn-lg">
            Log in
          </Link>
        </div>
      </Reveal>
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

/** A wax seal with the promise set around its rim. Decoration: the words are already on the page. */
function Seal() {
  return (
    <svg aria-hidden viewBox="0 0 200 200" className="seal">
      <defs>
        <path id="seal-rim" d="M100,100 m-74,0 a74,74 0 1,1 148,0 a74,74 0 1,1 -148,0" />
      </defs>
      <circle cx="100" cy="100" r="96" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="100" cy="100" r="58" fill="none" stroke="currentColor" strokeWidth="1" />
      <text fontSize="13.5" letterSpacing="3.4" fill="currentColor" fontFamily="var(--font-mono)">
        <textPath href="#seal-rim">NOBODY SAID A NUMBER OUT LOUD · SETTLED IN PRIVATE ·</textPath>
      </text>
      <text
        x="100"
        y="118"
        textAnchor="middle"
        fontSize="58"
        fontStyle="italic"
        fill="currentColor"
        fontFamily="var(--font-serif)"
      >
        S.
      </text>
    </svg>
  );
}
