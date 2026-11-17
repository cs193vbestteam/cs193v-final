import Link from "next/link";
import { CreateEventForm } from "@/components/CreateEventForm";
import { HeroDemo } from "@/components/HeroDemo";
import { Reveal } from "@/components/Reveal";
import { DEFAULT_PLAN_SIZE, MAX_PLAN_SIZE, MIN_PLAN_SIZE, listMyEvents } from "@/lib/events";
import { latestPlanDate, todayPacific } from "@/lib/plan-date";
import { currentUser } from "@/lib/session";
import { yelpDatasetDir } from "@/lib/yelp-pool";

export default async function Home() {
  const user = await currentUser();
  if (!user) return <Landing />;
  const events = await listMyEvents(user.id);
  const open = events.filter((e) => !e.decided).length;
  // Whether a plan can get real restaurants here decides what the form promises.
  const realPlaces = !!process.env.GOOGLE_PLACES_API_KEY?.trim() || !!yelpDatasetDir();
  return (
    <div className="mx-auto mt-10 max-w-3xl sm:mt-16">
      <div className="rise" style={{ "--d": "0.05s" } as React.CSSProperties}>
        <p className="eyebrow">
          {events.length ? "Welcome back" : "Welcome"}, {user.displayName}
        </p>
        <h1 className="display mt-3 text-5xl sm:text-6xl">
          What are we <em>actually</em> doing?
        </h1>
        <p className="lede mt-4 max-w-xl">
          Name the plan, drop the invite link in the group chat, and let everyone tell their own assistant the truth.
        </p>
      </div>

      <section className="card rise mt-8" style={{ "--d": "0.15s" } as React.CSSProperties}>
        <p className="eyebrow mb-3">New plan</p>
        <CreateEventForm
          minDate={todayPacific()}
          maxDate={latestPlanDate()}
          sizes={Array.from({ length: MAX_PLAN_SIZE - MIN_PLAN_SIZE + 1 }, (_, i) => MIN_PLAN_SIZE + i)}
          defaultSize={DEFAULT_PLAN_SIZE}
        />
        <p className="mt-3 text-xs text-ink-3">
          {realPlaces
            ? "Add a place to choose from real restaurants nearby. Leave it blank and the plan uses made-up sample restaurants."
            : "Sample data: plans in this version pick from made-up sample restaurants, not real places."}
        </p>
      </section>

      <section className="rise mt-12" style={{ "--d": "0.25s" } as React.CSSProperties}>
        <div className="flex items-baseline justify-between border-b border-line pb-3">
          <h2 className="font-serif text-2xl">Your plans</h2>
          <span className="font-mono text-xs uppercase tracking-wider text-ink-3">
            {events.length} total{open ? ` · ${open} open` : ""}
          </span>
        </div>
        {events.length === 0 ? (
          <p className="py-8 text-sm text-ink-3">Nothing yet. Your first plan will show up here.</p>
        ) : (
          <ul className="divide-y divide-line">
            {events.map((e, i) => (
              <li key={e.id} className="rise" style={{ "--d": `${0.3 + i * 0.05}s` } as React.CSSProperties}>
                <Link
                  href={`/e/${e.inviteCode}`}
                  className="group flex items-center justify-between gap-4 py-4 transition-colors hover:text-seal-ink"
                >
                  <span className="flex min-w-0 items-baseline gap-3">
                    <span className="font-mono text-xs text-ink-3">{String(i + 1).padStart(2, "0")}</span>
                    <span className="truncate font-serif text-xl">{e.title}</span>
                  </span>
                  <span className="flex shrink-0 items-center gap-3">
                    <span className={`pill ${e.decided ? "pill-moss" : "pill-amber"}`}>
                      {e.decided ? "Decided" : "Collecting"}
                    </span>
                    <span
                      aria-hidden
                      className="text-ink-3 transition-transform duration-500 ease-out group-hover:translate-x-1"
                    >
                      →
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

const STEPS = [
  {
    n: "01",
    title: "Tell your assistant the truth",
    body: "A one-minute private chat: budget, when you're free, what you won't eat. Nobody else in your group sees it.",
    demo: (
      <div className="space-y-2 text-sm">
        <div className="flex justify-end">
          <span className="rounded-2xl rounded-br-md bg-ink px-3 py-1.5 text-paper">
            after 6 only, under $40, no spicy
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
      <div className="rounded-xl border border-ink bg-ink px-3 py-2 text-paper">
        <div className="font-serif text-lg leading-tight">Sat 7pm · Olive Tree Mezze</div>
        <div className="text-xs text-paper/70">~$27 each · everyone can come</div>
      </div>
    ),
  },
];

const LEDGER: { label: string; mine: string; width: number }[] = [
  { label: "When", mine: "Dinner only, from 6pm", width: 1 },
  { label: "Budget", mine: "Up to $40, can stretch to $50", width: 2 },
  { label: "Travel", mine: "15 minutes max", width: 1 },
  { label: "Diet", mine: "No spicy food", width: 1 },
];

function Landing() {
  return (
    <div className="pb-8">
      {/* Hero */}
      <section className="relative grid items-center gap-12 pt-10 sm:pt-16 lg:grid-cols-[1.05fr_0.95fr] lg:gap-10 lg:pt-20">
        <div
          aria-hidden
          className="pointer-events-none absolute -right-40 -top-40 -z-10 h-[34rem] w-[34rem] rounded-full opacity-70 blur-3xl"
          style={{ background: "radial-gradient(closest-side, var(--color-paper-2), transparent 70%)" }}
        />
        <div className="max-w-xl">
          <p className="eyebrow rise" style={{ "--d": "0s" } as React.CSSProperties}>
            Group decisions · private constraints
          </p>
          <h1
            className="display rise mt-5 text-[clamp(3rem,8.5vw,5.75rem)]"
            style={{ "--d": "0.08s" } as React.CSSProperties}
          >
            Group plans, <em>without</em> the group chat.
          </h1>
          <p className="lede rise mt-6" style={{ "--d": "0.18s" } as React.CSSProperties}>
            Everyone says &ldquo;whatever works&rdquo; and nobody means it. Settle lets each person tell their own
            assistant the real constraints, then picks the plan that fits the group, so nobody has to secretly suffer
            through it.
          </p>
          <div
            className="rise mt-8 flex flex-wrap items-center gap-3"
            style={{ "--d": "0.28s" } as React.CSSProperties}
          >
            <Link href="/signup" className="btn">
              Start a plan
            </Link>
            <Link href="/login" className="btn-ghost">
              Log in
            </Link>
            <span className="ml-1 font-mono text-[0.75rem] uppercase tracking-[0.14em] text-ink-3">
              free · takes a minute
            </span>
          </div>
        </div>
        <div className="rise" style={{ "--d": "0.3s" } as React.CSSProperties}>
          <HeroDemo />
        </div>
      </section>

      {/* Why it happens */}
      <Reveal as="section" className="mt-28 grid gap-8 border-t border-line pt-10 lg:grid-cols-[0.4fr_0.6fr]">
        <p className="eyebrow">The problem</p>
        <p className="font-serif text-2xl leading-snug text-ink sm:text-[2rem]">
          Everyone has real limits: a budget, a Saturday that only works after six, a 20-minute radius. But saying{" "}
          <em className="text-seal-ink">&ldquo;$40 max&rdquo;</em> in the group sounds cheap, and
          <em className="text-seal-ink"> &ldquo;not that far&rdquo;</em> sounds difficult. So everyone says
          &ldquo;whatever&rdquo;, the information stays hidden, and the loudest person decides.
        </p>
      </Reveal>

      {/* How it works */}
      <section className="mt-28">
        <Reveal className="flex items-end justify-between border-t border-line pt-10">
          <h2 className="display text-4xl sm:text-5xl">How it works</h2>
          <span className="hidden font-mono text-xs uppercase tracking-[0.14em] text-ink-3 sm:inline">
            three steps · one answer
          </span>
        </Reveal>
        <ol className="mt-10 grid gap-5 md:grid-cols-3">
          {STEPS.map((s, i) => (
            <Reveal as="li" key={s.n} delay={i * 0.12} className="card flex flex-col">
              <span className="font-serif text-5xl leading-none text-ink-3">{s.n}</span>
              <h3 className="mt-6 font-serif text-2xl leading-tight">{s.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-ink-2">{s.body}</p>
              <div className="mt-auto pt-6">{s.demo}</div>
            </Reveal>
          ))}
        </ol>
      </section>

      {/* Privacy ledger */}
      <section className="mt-28">
        <Reveal className="border-t border-line pt-10">
          <h2 className="display text-4xl sm:text-5xl">
            Your limits stay <em>yours</em>.
          </h2>
          <p className="lede mt-4 max-w-2xl">
            To find a plan, a program on our server reads what everyone told their assistant. What it read goes no
            further: the group gets the plan and, with three or more people, how many can come. Here is what that looks
            like.
          </p>
        </Reveal>
        <Reveal
          delay={0.1}
          className="mt-10 overflow-hidden rounded-[1.5rem] border border-line bg-surface shadow-[var(--shadow-card)]"
        >
          <div className="hidden border-b border-line font-mono text-[0.75rem] uppercase tracking-[0.14em] text-ink-3 sm:grid sm:grid-cols-[6rem_1fr_1fr]">
            <div className="px-5 py-3">Field</div>
            <div className="px-5 py-3">What your assistant knows</div>
            <div className="border-l border-line px-5 py-3">What the group ever sees</div>
          </div>
          {LEDGER.map((row) => (
            <div key={row.label} className="grid border-b border-line last:border-b-0 sm:grid-cols-[6rem_1fr_1fr]">
              <div className="px-5 pt-4 font-mono text-[0.75rem] uppercase tracking-[0.14em] text-ink-3 sm:py-4">
                {row.label}
              </div>
              <div className="px-5 pb-2 pt-1 text-[0.9375rem] sm:py-4">{row.mine}</div>
              <div className="flex items-center gap-2 px-5 pb-4 pt-1 sm:border-l sm:border-line sm:py-4">
                <span className="font-mono text-[0.75rem] uppercase tracking-[0.14em] text-ink-3 sm:hidden">
                  group sees
                </span>
                <span className="redact" style={{ width: `${row.width * 3.5 + 2}rem` }} />
                <span className="rounded-md border border-line-strong bg-paper-2 px-2 py-0.5 font-mono text-xs text-ink-2">
                  nothing
                </span>
              </div>
            </div>
          ))}
        </Reveal>
        <Reveal delay={0.15} className="mt-6 grid gap-3 font-mono text-xs text-ink-2 sm:grid-cols-3">
          {[
            ["AES-256-GCM", "private chats and constraints are encrypted at rest"],
            ["bcrypt · cost 12", "passwords are salted and hashed, never stored"],
            ["HMAC blind index", "emails are looked up without being readable"],
          ].map(([k, v]) => (
            <div key={k} className="rounded-xl border border-line bg-paper-2/50 px-4 py-3">
              <div className="text-ink">{k}</div>
              <div className="mt-1 leading-relaxed text-ink-3">{v}</div>
            </div>
          ))}
        </Reveal>
      </section>

      {/* Closing */}
      <Reveal as="section" className="mt-28 border-t border-line pt-12 text-center sm:pt-16">
        <h2 className="display mx-auto max-w-3xl text-[clamp(2.5rem,7vw,4.75rem)]">
          Stop saying <em>&ldquo;whatever works.&rdquo;</em>
        </h2>
        <p className="lede mx-auto mt-5 max-w-lg">
          First version: picking a restaurant and a time for a meal. Trips, roommates and chores come next.
        </p>
        <div className="mt-8 flex justify-center gap-3">
          <Link href="/signup" className="btn">
            Start a plan
          </Link>
          <Link href="/login" className="btn-ghost">
            Log in
          </Link>
        </div>
      </Reveal>
    </div>
  );
}
