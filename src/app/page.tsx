import Link from "next/link";
import { CreateEventForm } from "@/components/CreateEventForm";
import { listMyEvents } from "@/lib/events";
import { currentUser } from "@/lib/session";

export default async function Home() {
  const user = await currentUser();
  if (!user) return <Landing />;
  const events = await listMyEvents(user.id);
  return (
    <div className="mx-auto mt-6 max-w-2xl space-y-6">
      <section className="card">
        <h2 className="mb-3 font-semibold">Start a new plan</h2>
        <CreateEventForm />
        <p className="mt-2 text-xs text-muted">You'll get an invite link to drop in your group chat.</p>
      </section>
      <section className="card">
        <h2 className="mb-3 font-semibold">Your plans</h2>
        {events.length === 0 ? (
          <p className="text-sm text-muted">No plans yet.</p>
        ) : (
          <ul className="divide-y divide-stone-100">
            {events.map((e) => (
              <li key={e.id}>
                <Link href={`/e/${e.inviteCode}`} className="flex items-center justify-between py-3 hover:text-accent">
                  <span>{e.title}</span>
                  <span className={`rounded-full px-2 py-0.5 text-xs ${e.decided ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"}`}>
                    {e.decided ? "Decided" : "Collecting"}
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

function Landing() {
  const steps = [
    ["Tell your assistant the truth", "A one-minute private chat: budget, when you're free, what you won't eat. Nobody else sees it."],
    ["Assistants negotiate", "The system proposes plans; each assistant only answers works / a stretch / doesn't work."],
    ["One message to the group", "\"Sat 7pm, Sakura Table, ~$45 — everyone's in.\" No 20-message thread."],
  ];
  return (
    <div className="mx-auto mt-12 max-w-3xl text-center">
      <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">
        Group plans, <span className="text-accent">without the group chat.</span>
      </h1>
      <p className="mx-auto mt-4 max-w-xl text-muted">
        Everyone says "whatever works" and nobody means it. Tacit lets each person share their real constraints privately, then finds the plan nobody has to secretly suffer through.
      </p>
      <div className="mt-6 flex justify-center gap-3">
        <Link href="/signup" className="btn">Get started</Link>
        <Link href="/login" className="btn-ghost">Log in</Link>
      </div>
      <div className="mt-12 grid gap-4 text-left sm:grid-cols-3">
        {steps.map(([title, body], i) => (
          <div key={title} className="card">
            <div className="mb-2 text-sm font-semibold text-accent">{i + 1}</div>
            <h3 className="font-medium">{title}</h3>
            <p className="mt-1 text-sm text-muted">{body}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
