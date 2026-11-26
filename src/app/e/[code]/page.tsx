import { cache } from "react";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { Avatar } from "@/components/Avatar";
import { PlanDangerZone } from "@/components/DangerActions";
import { AutoRefresh, CopyInvite, NegotiateButton, ShareMessage } from "@/components/GroupActions";
import { Countdown } from "@/components/Countdown";
import { CreatorControls } from "@/components/CreatorControls";
import { PlanCode } from "@/components/CodeSlots";
import { DecryptedText } from "@/components/Effects";
import { NotifyToggle, PlanReadyWatcher } from "@/components/NotifyToggle";
import { PrivateChat } from "@/components/PrivateChat";
import { ResultCard } from "@/components/ResultCard";
import { joinEventAction } from "@/app/actions";
import {
  MAX_PLAN_SIZE,
  MIN_PLAN_SIZE,
  canRerun,
  countMembers,
  getEventByCode,
  getMyConstraints,
  myPlanMatches,
  getMyMessages,
  getResult,
  isMember,
  listMembers,
  planPulse,
} from "@/lib/events";
import { avatarFor, groupAvatars } from "@/lib/avatar";
import { PlanAvatar } from "@/components/HeaderAvatar";
import { formatPlanDate, formatWhen } from "@/lib/plan-date";
import { getRestaurant } from "@/lib/restaurants";
import { scenarioFor } from "@/lib/scenario";
import { nudgeMessage, resultMessage } from "@/lib/share";
import { currentUser, requireUser } from "@/lib/session";

// Finding a plan can make a few LLM calls per round (agents + mediator); give it room on Vercel.
export const maxDuration = 60;

const POOL_LABEL = { places: "real places", yelp: "places from the Yelp Open Dataset", seed: "sample places" } as const;

/** Read once per request: the tab's title and the page both need the plan, and reading it decrypts its pool. */
const eventByCode = cache(getEventByCode);

/** The tab is named after the plan, for people who are signed in; the plan's name is on the invitation anyway. */
export async function generateMetadata({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const event = (await currentUser()) ? await eventByCode(code) : null;
  return { title: event ? `${event.title} — Settle` : "Plan — Settle" };
}

export default async function EventPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const user = await requireUser(`/e/${code}`);
  const event = await eventByCode(code);
  if (!event) notFound();

  if (!(await isMember(event.id, user.id))) {
    const full = (await countMembers(event.id)) >= event.maxMembers;
    return (
      <div className="mx-auto mt-16 max-w-lg text-center sm:mt-24">
        <p className="eyebrow rise">You&apos;ve been invited to</p>
        <h1 className="display rise mt-4 text-5xl sm:text-6xl" style={{ "--d": "0.08s" } as React.CSSProperties}>
          {event.title}
        </h1>
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

  // The pulse is read first: if something changes while the rest loads, the page's pulse is
  // the older one and the next check re-renders, rather than the change being missed.
  const pulse = await planPulse(event.id, user.id);
  const [members, messages, constraints, result] = await Promise.all([
    listMembers(event.id, user.id),
    getMyMessages(event.id, user.id),
    getMyConstraints(event.id, user.id),
    getResult(event.id, user.id),
  ]);
  const rerunnable = result ? await canRerun(event.id, user.id) : true;
  const { describeConstraints, missingFields, answerProgress } = scenarioFor(event.scenario);
  const me = members.find((m) => m.userId === user.id)!;
  // `members` comes in join order, which is what keeps each person's animal the same on every visit.
  const avatars = groupAvatars(members.map((m) => m.userId));
  const readyCount = members.filter((m) => m.ready).length;
  const h = await headers();
  const origin = `${h.get("x-forwarded-proto") ?? "http"}://${h.get("host")}`;
  const planUrl = `${origin}/e/${code}`;
  // What this person asked for that the plan gives them: for their eyes only, never in the shared result.
  const mine =
    result?.proposal && result.status !== "no_deal" && result.engine === "optimizer"
      ? await myPlanMatches(event.id, user.id, result.proposal)
      : [];
  const chosen =
    result?.proposal && result.status !== "no_deal"
      ? (result.places?.[result.proposal.restaurantId] ?? getRestaurant(result.proposal.restaurantId))
      : undefined;
  // A result is only as good as the answers it was made from. Once someone is not done again
  // (they changed something, or joined afterwards) it is shown as out of date until it is re-run (#140).
  // That lasts until the re-run itself: being done again does not make the old plan current.
  const stale =
    result && (readyCount < members.length || rerunnable)
      ? members.length > result.participants
        ? "joined"
        : "changed"
      : null;
  const shareResult =
    !stale && result?.proposal && chosen
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
  const status = stale
    ? { label: "Best so far", cls: "pill-amber" }
    : result
      ? result.status === "agreed"
        ? { label: "Decided", cls: "pill-moss" }
        : result.status === "compromise"
          ? { label: "Compromise", cls: "pill-amber" }
          : result.status === "partial"
            ? { label: "Not everyone", cls: "pill-amber" }
            : { label: "Stuck", cls: "pill-seal" }
      : readyCount === members.length && members.length >= 2
        ? { label: "Everyone's done", cls: "pill-moss" }
        : { label: "Collecting", cls: "pill-amber" };

  // Plans without real restaurant data say so wherever a place is named.
  const sample = event.poolSource === "seed";

  // For someone who is done: whether anything is left for them, and what the group is waiting for (#153).
  const waiting = members.length - readyCount;
  const isCreator = event.creatorId === user.id;
  const creatorName = members.find((m) => m.userId === event.creatorId)?.displayName ?? "the organizer";
  const others = `${waiting} other ${waiting === 1 ? "person" : "people"}`;
  const next = !me.ready
    ? null
    : result && !stale
      ? result.status === "no_deal"
        ? { text: "No plan works yet. Change an answer to try again.", href: "#plan", link: "See why" }
        : { text: "The plan is ready.", href: "#plan", link: "See the plan" }
      : members.length < 2
        ? {
            text: "Now invite the others.",
            href: "#group",
            link: "Invite people",
          }
        : waiting > 0
          ? {
              text: `Waiting for ${others} to finish.`,
            }
          : result
            ? { text: "Everyone is done. The plan can be updated.", href: "#plan", link: "Re-run it" }
            : isCreator
              ? { text: "Everyone is done.", href: "#plan", link: "Find a plan" }
              : { text: `Waiting for ${creatorName} to find the plan.` };

  const share = shareResult && <ShareMessage label="Share with the group" message={shareResult} primary />;
  const rerun = (
    <NegotiateButton
      eventId={event.id}
      inviteCode={code}
      readyCount={readyCount}
      memberCount={members.length}
      decided={!!result}
      noPlan={result?.status === "no_deal"}
      canRerun={rerunnable}
      isCreator={isCreator}
    />
  );
  // A settled plan needs no more invitations on show; they stay one click away.
  const settled = !!result && !stale;
  const invite = (
    <>
      <CopyInvite url={planUrl} />
      <div className="mt-3 text-center">
        <p className="eyebrow">Plan code</p>
        <div className="mt-2">
          <PlanCode code={code} />
        </div>
      </div>
    </>
  );

  return (
    <div className="mt-6 sm:mt-10">
      <AutoRefresh eventId={event.id} pulse={pulse} />
      <PlanReadyWatcher eventId={event.id} title={event.title} ready={!!result} />
      {/* The header shows the same animal as the group list does for this person. */}
      <PlanAvatar name={avatars.get(user.id) ?? avatarFor(user.id)} />
      <div className="rise flex flex-wrap items-end justify-between gap-x-6 gap-y-3 border-b border-line pb-5">
        <div className="min-w-0">
          <p className="eyebrow">
            Plan · <DecryptedText text={code} />
            {event.date ? ` · ${formatPlanDate(event.date)}` : ""}
            {event.location ? ` · near ${event.location}` : ""}
            {/* Real places arrive in two batches: a first search, then the rest once everyone is done.
                Until the plan is decided the count is only the first batch, so it is left out. */}
            {` · ${event.poolSource !== "places" || result ? `${event.poolSize} ` : ""}${POOL_LABEL[event.poolSource]}`}
          </p>
          {/* Once there is a plan, the place is the headline and the plan's own name steps back. */}
          <h1 className={`display mt-2 break-words ${result ? "text-3xl sm:text-4xl" : "text-4xl sm:text-5xl"}`}>
            {event.title}
          </h1>
        </div>
        <div className="flex items-center gap-3">
          <span className="font-mono text-xs uppercase tracking-wider text-ink-3">
            {readyCount} of {members.length} ready
          </span>
          <span className={`pill ${status.cls}`}>{status.label}</span>
        </div>
      </div>

      {/* Once there is a plan it is the first thing on the page. In the side column, below the group,
          a tester did not notice it had arrived (#154). */}
      {result && (
        // Settles back as the page scrolls on to the chat and the group (PageMotion). Its own wrapper:
        // the section inside is held by its entrance.
        <div data-recede="page">
          <section
            id="plan"
            aria-labelledby="plan-heading"
            className="plan-hero rise sealed-trace mt-6 scroll-mt-24"
            data-tone={chosen && !stale ? "ink" : "paper"}
            style={{ "--d": "0.06s" } as React.CSSProperties}
          >
            {/* The one dark block on the page: where, when and what it costs, then what to do with it. */}
            <h2 id="plan-heading" className="plan-hero-label">
              The plan
            </h2>
            <ResultCard
              result={result}
              sample={sample}
              date={event.date}
              stale={stale}
              mine={mine}
              lateJoiner={stale === "joined" && !me.ready}
              actions={share}
              rerun={rerun}
            />
          </section>
        </div>
      )}

      <div className="mt-6 grid gap-5 lg:grid-cols-[minmax(0,1fr)_22rem]">
        {/* Beside the group and the plan, the chat is exactly as tall as the two of them together. */}
        <div
          className="rise lg:relative lg:min-h-[max(34rem,min(46rem,calc(100dvh-16rem)))]"
          style={{ "--d": "0.1s" } as React.CSSProperties}
        >
          <PrivateChat
            eventId={event.id}
            inviteCode={code}
            name={user.displayName}
            initialMessages={messages}
            initialSummary={describeConstraints(constraints)}
            initialMissing={missingFields(constraints)}
            initialProgress={answerProgress(constraints)}
            ready={me.ready}
            lastOne={!result && members.length >= 2 && members.every((m) => m.ready || m.userId === user.id)}
            next={next}
          />
        </div>
        <aside className="space-y-5">
          <section id="group" data-arrive className="card scroll-mt-24">
            <h2 className="font-serif text-xl">The group</h2>
            {/* The list below shows who is in; the count is read out for those who cannot glance at it. */}
            <p className="sr-only">
              {members.length} joined · limit {event.maxMembers}
            </p>
            <ul className="mt-3 divide-y divide-line">
              {members.map((m) => (
                <li key={m.userId} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                  <span className="flex min-w-0 items-center gap-2.5">
                    <Avatar name={avatars.get(m.userId) ?? avatarFor(m.userId)} ready={m.ready} />
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
            {settled ? (
              <details className="group mt-3 border-t border-line pt-3">
                <summary className="flex cursor-pointer list-none items-center justify-between text-sm [&::-webkit-details-marker]:hidden">
                  <span className="link">Invite someone else</span>
                  <span aria-hidden className="text-ink-3 transition-transform duration-300 group-open:rotate-180">
                    ↓
                  </span>
                </summary>
                <div className="mt-4">{invite}</div>
              </details>
            ) : (
              <div className="mt-4">{invite}</div>
            )}
            {nudge && (
              <div className="mt-2">
                <ShareMessage label="Nudge the group" message={nudge} />
              </div>
            )}
            {/* What is rarely needed sits behind one word: the creator's controls, leaving, deleting. */}
            <details className="more mt-4 border-t border-line pt-3">
              <summary>More</summary>
              <div className="mt-3 space-y-3">
                {event.creatorId === user.id && (
                  <div>
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
                <div>
                  <PlanDangerZone
                    eventId={event.id}
                    inviteCode={code}
                    isCreator={event.creatorId === user.id}
                    title={event.title}
                    nextOwner={members.find((m) => m.userId !== user.id)?.displayName}
                  />
                </div>
              </div>
            </details>
          </section>

          {!result && (
            <section id="plan" data-arrive className="card scroll-mt-24">
              <h2 className="font-serif text-xl">The plan</h2>
              <p className="mt-3 rounded-xl border border-dashed border-line-strong px-4 py-5 text-center text-sm text-ink-3">
                {members.length < 2
                  ? "Invite at least one more person."
                  : readyCount < members.length
                    ? "Waiting for everyone to finish."
                    : isCreator
                      ? "Everyone is done."
                      : `Waiting for ${creatorName} to find the plan.`}
                {event.decideAt !== null && (
                  <span className="mt-1 block font-mono text-xs uppercase tracking-wider">
                    <Countdown until={event.decideAt} />
                  </span>
                )}
              </p>
              <div className="mt-4 text-center">
                <NotifyToggle eventId={event.id} />
              </div>
              <div className="mt-4">{rerun}</div>
            </section>
          )}
        </aside>
      </div>
    </div>
  );
}
