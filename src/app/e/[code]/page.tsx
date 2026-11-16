import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { PlanDangerZone } from "@/components/DangerActions";
import { AutoRefresh, CopyInvite, NegotiateButton, ShareMessage } from "@/components/GroupActions";
import { CreatorControls } from "@/components/CreatorControls";
import { PrivateChat } from "@/components/PrivateChat";
import { ResultCard } from "@/components/ResultCard";
import { joinEventAction } from "@/app/actions";
import {
  MAX_PLAN_SIZE,
  MIN_PLAN_SIZE,
  countMembers,
  getEventByCode,
  getMyConstraints,
  getMyMessages,
  getResult,
  isMember,
  listMembers,
} from "@/lib/events";
import { formatPlanDate, formatWhen } from "@/lib/plan-date";
import { getRestaurant } from "@/lib/restaurants";
import { scenarioFor } from "@/lib/scenario";
import { nudgeMessage, resultMessage } from "@/lib/share";
import { currentUser, requireUser } from "@/lib/session";

// Finding a plan can make a few LLM calls per round (agents + mediator); give it room on Vercel.
export const maxDuration = 60;

const POOL_LABEL = { places: "real places", yelp: "places from the Yelp Open Dataset", seed: "sample places" } as const;

/** The tab is named after the plan, for people who are signed in; the plan's name is on the invitation anyway. */
export async function generateMetadata({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const event = (await currentUser()) ? await getEventByCode(code) : null;
  return { title: event ? `${event.title} — Settle` : "Plan — Settle" };
}

export default async function EventPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const user = await requireUser(`/e/${code}`);
  const event = await getEventByCode(code);
  if (!event) notFound();

  if (!(await isMember(event.id, user.id))) {
    const full = (await countMembers(event.id)) >= event.maxMembers;
    return (
      <div className="mx-auto mt-16 max-w-lg text-center sm:mt-24">
        <p className="eyebrow rise">You&apos;ve been invited to</p>
        <h1 className="display rise mt-4 text-5xl sm:text-6xl" style={{ "--d": "0.08s" } as React.CSSProperties}>
          {event.title}
        </h1>
        <p className="lede rise mx-auto mt-5 max-w-md" style={{ "--d": "0.16s" } as React.CSSProperties}>
          You&apos;ll get a private assistant. Tell it what actually works for you. Nobody else in the group will see
          it, only the final plan.
        </p>
        {full ? (
          <p
            role="status"
            className="rise mx-auto mt-8 max-w-md rounded-xl border border-line-strong px-4 py-4 text-sm text-ink-2"
            style={{ "--d": "0.24s" } as React.CSSProperties}
          >
            <strong className="font-medium text-ink">This plan is full.</strong> It has room for {event.maxMembers}{" "}
            people and all the places are taken. Whoever created it can make room; ask them, then open this link again.
          </p>
        ) : (
          <form
            action={joinEventAction.bind(null, code)}
            className="rise mt-8"
            style={{ "--d": "0.24s" } as React.CSSProperties}
          >
            <button className="btn px-8">Join plan</button>
          </form>
        )}
      </div>
    );
  }

  const [members, messages, constraints, result] = await Promise.all([
    listMembers(event.id, user.id),
    getMyMessages(event.id, user.id),
    getMyConstraints(event.id, user.id),
    getResult(event.id, user.id),
  ]);
  const { describeConstraints, missingFields } = scenarioFor(event.scenario);
  const me = members.find((m) => m.userId === user.id)!;
  const readyCount = members.filter((m) => m.ready).length;
  const h = await headers();
  const origin = `${h.get("x-forwarded-proto") ?? "http"}://${h.get("host")}`;
  const planUrl = `${origin}/e/${code}`;
  const chosen =
    result?.proposal && result.status !== "no_deal"
      ? (result.places?.[result.proposal.restaurantId] ?? getRestaurant(result.proposal.restaurantId))
      : undefined;
  const shareResult =
    result?.proposal && chosen
      ? resultMessage({
          title: event.title,
          place: chosen.name,
          when: formatWhen(event.date, result.proposal.slot),
          options: result.options?.length ?? 1,
          url: planUrl,
        })
      : null;
  // The creator can nudge while the group is still collecting; a count only, never who.
  const nudge =
    !result && event.creatorId === user.id && members.length >= 2 && readyCount < members.length
      ? nudgeMessage({ title: event.title, ready: readyCount, members: members.length, url: planUrl })
      : null;
  const status = result
    ? result.status === "agreed"
      ? { label: "Decided", cls: "pill-moss" }
      : result.status === "compromise"
        ? { label: "Compromise", cls: "pill-amber" }
        : result.status === "partial"
          ? { label: "Not everyone", cls: "pill-amber" }
          : { label: "Stuck", cls: "pill-seal" }
    : readyCount === members.length && members.length >= 2
      ? { label: "Ready to negotiate", cls: "pill-moss" }
      : { label: "Collecting", cls: "pill-amber" };

  // Plans without real restaurant data say so wherever a place is named.
  const sample = event.poolSource === "seed";

  return (
    <div className="mt-6 sm:mt-10">
      <AutoRefresh />
      <div className="rise flex flex-wrap items-end justify-between gap-x-6 gap-y-3 border-b border-line pb-5">
        <div className="min-w-0">
          <p className="eyebrow">
            Plan · {code}
            {event.date ? ` · ${formatPlanDate(event.date)}` : ""}
            {event.location ? ` · near ${event.location}` : ""}
            {/* Real places arrive in two batches: a first search, then the rest once everyone is done.
                Until the plan is decided the count is only the first batch, so it is left out. */}
            {` · ${event.poolSource !== "places" || result ? `${event.poolSize} ` : ""}${POOL_LABEL[event.poolSource]}`}
          </p>
          <h1 className="display mt-2 break-words text-4xl sm:text-5xl">{event.title}</h1>
          {sample && (
            <p className="mt-2 max-w-xl text-sm text-ink-2">
              <span className="pill pill-amber mr-2">Sample data</span>
              {event.location
                ? `Real places near ${event.location} could not be loaded, so this plan`
                : "This plan"}{" "}
              picks from {event.poolSize} made-up restaurants. They are not real places.
            </p>
          )}
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
            lastOne={!result && members.length >= 2 && members.every((m) => m.ready || m.userId === user.id)}
          />
        </div>
        <aside className="space-y-5">
          <section className="card rise" style={{ "--d": "0.18s" } as React.CSSProperties}>
            <div className="flex items-baseline justify-between">
              <h2 className="font-serif text-xl">The group</h2>
              <span className="font-mono text-[0.75rem] uppercase tracking-wider text-ink-3">
                {members.length} of {event.maxMembers} joined
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
                    className={`font-mono text-[0.75rem] uppercase tracking-wider ${m.ready ? "text-moss" : "text-ink-3"}`}
                  >
                    {m.ready ? "done" : "chatting…"}
                  </span>
                </li>
              ))}
            </ul>
            <div className="mt-4">
              <CopyInvite url={planUrl} />
            </div>
            {nudge && (
              <div className="mt-2">
                <ShareMessage label="Nudge the group" message={nudge} />
              </div>
            )}
            {event.creatorId === user.id && (
              <div className="mt-4 border-t border-line pt-3.5">
                <CreatorControls
                  eventId={event.id}
                  inviteCode={code}
                  others={members
                    .filter((m) => m.userId !== user.id)
                    .map((m) => ({ userId: m.userId, displayName: m.displayName }))}
                  joined={members.length}
                  maxMembers={event.maxMembers}
                  minSize={MIN_PLAN_SIZE}
                  maxSize={MAX_PLAN_SIZE}
                />
              </div>
            )}
            <div className="mt-4 border-t border-line pt-3.5">
              <PlanDangerZone
                eventId={event.id}
                inviteCode={code}
                isCreator={event.creatorId === user.id}
                title={event.title}
                nextOwner={members.find((m) => m.userId !== user.id)?.displayName}
              />
            </div>
          </section>

          <section className="card rise" style={{ "--d": "0.26s" } as React.CSSProperties}>
            <h2 className="font-serif text-xl">The plan</h2>
            <div className="mt-3">
              {result ? (
                <ResultCard result={result} sample={sample} date={event.date} />
              ) : (
                <p className="rounded-xl border border-dashed border-line-strong px-4 py-5 text-center text-sm text-ink-3">
                  No plan yet. As soon as everyone&apos;s done, the assistants talk it out. Nobody has to press
                  anything.
                </p>
              )}
            </div>
            {shareResult && (
              <div className="mt-4">
                <ShareMessage label="Share with the group" message={shareResult} primary />
              </div>
            )}
            <div className={shareResult ? "mt-2" : "mt-4"}>
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
