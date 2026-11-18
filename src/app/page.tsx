import Link from "next/link";
import { CreateEventForm } from "@/components/CreateEventForm";
import { Landing } from "@/components/Landing";
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
        {user.guest ? (
          <p className="text-sm text-ink-2">
            You are here as a guest, and guests can join plans but not start them.{" "}
            <Link className="link text-ink" href="/signup">
              Add an email and password
            </Link>{" "}
            to start your own. The plans you have joined stay with you.
          </p>
        ) : (
          <>
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
          </>
        )}
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
