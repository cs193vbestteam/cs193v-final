import { headers } from "next/headers";
import { notFound } from "next/navigation";
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
      <div className="mx-auto mt-16 max-w-md card text-center">
        <p className="text-sm text-muted">You've been invited to</p>
        <h1 className="mt-1 text-2xl font-semibold">{event.title}</h1>
        <p className="mt-3 text-sm text-muted">
          You'll get a private assistant. Tell it what actually works for you. Nobody else will see it.
        </p>
        <form action={joinEventAction.bind(null, code)} className="mt-5">
          <button className="btn w-full">Join plan</button>
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

  return (
    <div className="mt-4">
      <AutoRefresh />
      <h1 className="mb-4 text-2xl font-semibold">{event.title}</h1>
      <div className="grid gap-4 md:grid-cols-[1fr_20rem]">
        <PrivateChat
          eventId={event.id}
          inviteCode={code}
          initialMessages={messages}
          initialSummary={describeConstraints(constraints)}
          initialMissing={missingFields(constraints)}
          ready={me.ready}
        />
        <aside className="space-y-4">
          <section className="card space-y-3">
            <h2 className="font-semibold">Group</h2>
            <ul className="space-y-1 text-sm">
              {members.map((m) => (
                <li key={m.userId} className="flex justify-between">
                  <span>{m.displayName}{m.userId === user.id && " (you)"}</span>
                  <span className={m.ready ? "text-emerald-600" : "text-muted"}>{m.ready ? "done ✓" : "chatting…"}</span>
                </li>
              ))}
            </ul>
            <CopyInvite url={`${origin}/e/${code}`} />
          </section>
          <section className="card space-y-3">
            <h2 className="font-semibold">The plan</h2>
            {result ? <ResultCard result={result} /> : <p className="text-sm text-muted">No plan yet.</p>}
            <NegotiateButton eventId={event.id} inviteCode={code} readyCount={readyCount} decided={!!result} />
          </section>
        </aside>
      </div>
    </div>
  );
}
