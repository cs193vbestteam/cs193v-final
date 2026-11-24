import Link from "next/link";
import { CreateEventForm } from "@/components/CreateEventForm";
import { Landing } from "@/components/Landing";
import { DEFAULT_PLAN_SIZE, MAX_PLAN_SIZE, MIN_PLAN_SIZE, listMyEvents } from "@/lib/events";
import { formatPlanDate, latestPlanDate, todayPacific } from "@/lib/plan-date";
import { currentUser } from "@/lib/session";
import { yelpDatasetDir } from "@/lib/yelp-pool";

export default async function Home() {
  const user = await currentUser();
  if (!user) return <Landing />;
  const events = await listMyEvents(user.id);
  const open = events.filter((e) => !e.decided || e.stuck).length;
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
          <CreateEventForm
            minDate={todayPacific()}
            maxDate={latestPlanDate()}
            sizes={Array.from({ length: MAX_PLAN_SIZE - MIN_PLAN_SIZE + 1 }, (_, i) => MIN_PLAN_SIZE + i)}
            defaultSize={DEFAULT_PLAN_SIZE}
            realPlaces={realPlaces}
          />
        )}
      </section>

      <section className="mt-12">
        <div data-arrive className="flex items-baseline justify-between border-b border-line pb-3">
          <h2 className="font-serif text-2xl">Your plans</h2>
          <span className="font-mono text-xs uppercase tracking-wider text-ink-3">
            {events.length} total{open ? ` · ${open} open` : ""}
          </span>
        </div>
        {events.length === 0 ? (
          <p data-arrive className="py-8 text-sm text-ink-3">
            Nothing yet. Your first plan will show up here.
          </p>
        ) : (
          <ul className="mt-5 grid gap-4 sm:grid-cols-2">
            {events.map((e, i) => (
              <li key={e.id} data-arrive>
                {/* Each plan is the ticket it was started as: ink once it is decided, paper while it is open. */}
                <Link
                  href={`/e/${e.inviteCode}`}
                  className="plan-stub spot"
                  data-decided={(e.decided && !e.stuck) || undefined}
                >
                  <span className="plan-stub-main">
                    <span className="plan-stub-eyebrow">
                      No. {String(events.length - i).padStart(2, "0")}
                      {e.date ? ` · ${formatPlanDate(e.date)}` : ""}
                    </span>
                    <span className="plan-stub-title">{e.title}</span>
                    <span className="plan-stub-where">{e.location ?? "Sample places"}</span>
                  </span>
                  <span className="plan-stub-end">
                    <span className={`pill ${e.stuck ? "pill-seal" : e.decided ? "pill-moss" : "pill-amber"}`}>
                      {e.stuck ? "Stuck" : e.decided ? "Decided" : "Collecting"}
                    </span>
                    <span aria-hidden className="plan-stub-go">
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
