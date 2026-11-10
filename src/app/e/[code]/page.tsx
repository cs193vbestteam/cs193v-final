import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { PlanDangerZone } from "@/components/DangerActions";
import { AutoRefresh, CopyInvite, NegotiateButton } from "@/components/GroupActions";
import { PrivateChat } from "@/components/PrivateChat";
import { ResultCard } from "@/components/ResultCard";
import { joinEventAction } from "@/app/actions";
import { describeConstraints, missingFields } from "@/lib/constraints";
import { getEventByCode, getMyConstraints, getMyMessages, getResult, isMember, listMembers } from "@/lib/events";
import { requireUser } from "@/lib/session";

export default async function EventPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const user = await requireUser(`/e/${code}`);
  const event = await getEventByCode(code);
  if (!event) notFound();

  if (!(await isMember(event.id, user.id))) {
    return (
      <div className="mx-auto mt-16 max-w-lg text-center sm:mt-24">
        <p className="eyebrow rise">You&apos;ve been invited to</p>
        <h1 className="display rise mt-4 text-5xl sm:text-6xl" style={{ "--d": "0.08s" } as React.CSSProperties}>
          {event.title}
        </h1>
        <p className="lede rise mx-auto mt-5 max-w-md" style={{ "--d": "0.16s" } as React.CSSProperties}>
          You&apos;ll get a private assistant. Tell it what actually works for you. Nobody else will see it, only the
          final plan.
        </p>
        <form
          action={joinEventAction.bind(null, code)}
          className="rise mt-8"
          style={{ "--d": "0.24s" } as React.CSSProperties}
        >
          <button className="btn px-8">Join plan</button>
        </form>
      </div>
    );
  }

  const [members, messages, constraints, result] = await Promise.all([
    listMembers(event.id, user.id),
    getMyMessages(event.id, user.id),
    getMyConstraints(event.id, user.id),
    getResult(event.id, user.id),
  ]);
  const me = members.find((m) => m.userId === user.id)!;
  const readyCount = members.filter((m) => m.ready).length;
  const h = await headers();
  const origin = `${h.get("x-forwarded-proto") ?? "http"}://${h.get("host")}`;
  const status = result
    ? result.status === "agreed"
      ? { label: "Decided", cls: "pill-moss" }
      : result.status === "compromise"
        ? { label: "Compromise", cls: "pill-amber" }
        : { label: "Stuck", cls: "pill-seal" }
    : readyCount === members.length && members.length >= 2
      ? { label: "Ready to negotiate", cls: "pill-moss" }
      : { label: "Collecting", cls: "pill-amber" };

  return (
    <div className="mt-6 sm:mt-10">
      <AutoRefresh />
      <div className="rise flex flex-wrap items-end justify-between gap-x-6 gap-y-3 border-b border-line pb-5">
        <div className="min-w-0">
          <p className="eyebrow">
            Plan · {code}
            {event.location ? ` · near ${event.location}` : ""}
            {` · ${event.poolSize} ${event.poolSource === "places" ? "real places" : "seed places"}`}
          </p>
          <h1 className="display mt-2 truncate text-4xl sm:text-5xl">{event.title}</h1>
        </div>
        <div className="flex items-center gap-3">
          <span className="font-mono text-xs uppercase tracking-wider text-ink-3">
            {readyCount} of {members.length} ready
          </span>
          <span className={`pill ${status.cls}`}>{status.label}</span>
        </div>
      </div>

      <div className="mt-6 grid gap-5 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="rise" style={{ "--d": "0.1s" } as React.CSSProperties}>
          <PrivateChat
            eventId={event.id}
            inviteCode={code}
            initialMessages={messages}
            initialSummary={describeConstraints(constraints)}
            initialMissing={missingFields(constraints)}
            ready={me.ready}
          />
        </div>
        <aside className="space-y-5">
          <section className="card rise" style={{ "--d": "0.18s" } as React.CSSProperties}>
            <div className="flex items-baseline justify-between">
              <h2 className="font-serif text-xl">The group</h2>
              <span className="font-mono text-[0.6875rem] uppercase tracking-wider text-ink-3">
                {members.length} joined
              </span>
            </div>
            <ul className="mt-3 divide-y divide-line">
              {members.map((m) => (
                <li key={m.userId} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                  <span className="flex min-w-0 items-center gap-2.5">
                    <span
                      aria-hidden
                      className={`h-2 w-2 shrink-0 rounded-full ${m.ready ? "bg-moss" : "bg-amber dot-live"}`}
                    />
                    <span className="truncate">
                      {m.displayName}
                      {m.userId === user.id && <span className="text-ink-3"> (you)</span>}
                    </span>
                  </span>
                  <span
                    className={`font-mono text-[0.6875rem] uppercase tracking-wider ${m.ready ? "text-moss" : "text-ink-3"}`}
                  >
                    {m.ready ? "done" : "chatting…"}
                  </span>
                </li>
              ))}
            </ul>
            <div className="mt-4">
              <CopyInvite url={`${origin}/e/${code}`} />
            </div>
            <div className="mt-4 border-t border-line pt-3.5">
              <PlanDangerZone
                eventId={event.id}
                inviteCode={code}
                isCreator={event.creatorId === user.id}
                title={event.title}
              />
            </div>
          </section>

          <section className="card rise" style={{ "--d": "0.26s" } as React.CSSProperties}>
            <h2 className="font-serif text-xl">The plan</h2>
            <div className="mt-3">
              {result ? (
                <ResultCard result={result} />
              ) : (
                <p className="rounded-xl border border-dashed border-line-strong px-4 py-5 text-center text-sm text-ink-3">
                  No plan yet. Once everyone&apos;s done, the assistants will talk it out.
                </p>
              )}
            </div>
            <div className="mt-4">
              <NegotiateButton
                eventId={event.id}
                inviteCode={code}
                readyCount={readyCount}
                memberCount={members.length}
                decided={!!result}
              />
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}
