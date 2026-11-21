import type { Dim, Proposal } from "@/lib/evaluate";
import { PlanOptions, type OptionTile } from "./PlanOptions";
import type { StoredResult } from "@/lib/events";
import type { Tally } from "@/lib/mediator";
import { formatWhen } from "@/lib/plan-date";
import { getRestaurant } from "@/lib/restaurants";

export const DIM_LABEL: Record<Dim, string> = {
  time: "timing",
  price: "price",
  diet: "diet",
  distance: "distance",
  cuisine: "cuisine",
};

function describeDims(t: Tally): string {
  const parts: string[] = [];
  for (const [dim, n] of Object.entries(t.rejectDims) as [Dim, number][])
    parts.push(`${n}× reject · ${DIM_LABEL[dim]}`);
  for (const [dim, n] of Object.entries(t.dims) as [Dim, number][]) parts.push(`${n}× reluctant · ${DIM_LABEL[dim]}`);
  return parts.join(", ");
}

export function ResultCard({
  result,
  sample = false,
  date,
  stale = null,
  actions,
  rerun,
}: {
  result: StoredResult;
  sample?: boolean;
  date?: string | null;
  /**
   * Someone is not done (#140): they changed their answers after this was decided ("changed"),
   * or the group has grown since ("joined"). The plan stays on the page, but it no longer
   * claims to work for the people it was made for.
   */
  stale?: "changed" | "joined" | null;
  /** The buttons that act on the plan (share it, run it again); the page owns them. */
  actions?: React.ReactNode;
  /** Running it again comes last: it is the one thing here most people never need. */
  rerun?: React.ReactNode;
}) {
  const when = (slot: string) => formatWhen(date, slot);
  const place = (id: string) => result.places?.[id] ?? getRestaurant(id);
  const r = result.proposal ? place(result.proposal.restaurantId) : undefined;
  // The optimizer's results say who can come, not who agreed: it does not ask anyone to accept.
  const byOptimizer = result.engine === "optimizer";
  const canCome = result.participants - (result.cannotCome ?? 0);
  const headline = stale
    ? "Out of date"
    : result.status === "agreed"
      ? byOptimizer
        ? "Everyone can come"
        : "Everyone's in"
      : result.status === "compromise"
        ? "Works for everyone, a stretch for some"
        : result.status === "partial"
          ? `Works for ${canCome} of ${result.participants}`
          : result.noPlan === "no_candidates"
            ? "Nothing is open that day"
            : byOptimizer && result.participants === 2
              ? "No plan works for both of you yet"
              : "No plan works for everyone yet";
  const tone = stale
    ? { border: "border-amber/40", text: "text-amber-ink", stamp: "border-amber text-amber-ink" }
    : result.status === "agreed"
      ? { border: "border-moss/35", text: "text-moss", stamp: "border-moss text-moss" }
      : result.status === "compromise" || result.status === "partial"
        ? { border: "border-amber/40", text: "text-amber-ink", stamp: "border-amber text-amber-ink" }
        : { border: "border-seal/35", text: "text-seal-ink", stamp: "border-seal text-seal-ink" };
  // What the place serves: the optimizer's results say it in Google's terms, older ones by cuisine.
  const kindOf = (p: { kind?: string; cuisine: string | null }) => p.kind ?? p.cuisine ?? "restaurant";
  const tried = result.rounds.reduce((n, round) => n + round.proposals.length, 0);
  // Small groups get the outcome only: any count would be one person's answer (events.ts, forGroupSize).
  const outcomeOnly = result.detail === "outcome";
  const roundCount = result.roundCount ?? result.rounds.length;
  const showPlan = r && result.proposal && result.status !== "no_deal";
  const names = result.memberNames ?? [];
  // One tile per option on the shortlist, the plan first. Results stored before shortlists have the plan only.
  const listed = result.options?.length ? result.options : result.proposal ? [{ proposal: result.proposal }] : [];
  const tiles: OptionTile[] = showPlan
    ? listed.flatMap((o: { proposal: Proposal; everyoneIn?: boolean }) => {
        const p = place(o.proposal.restaurantId);
        if (!p) return [];
        return [
          {
            key: `${o.proposal.restaurantId}-${o.proposal.slot}`,
            name: p.name,
            when: when(o.proposal.slot),
            cuisine: kindOf(p),
            pricePerPerson: p.pricePerPerson,
            ...(p.travelMin !== undefined ? { travelMin: p.travelMin } : {}),
            ...(p.rating !== undefined ? { rating: p.rating, ratingCount: p.ratingCount } : {}),
            ...(p.address ? { address: p.address } : {}),
            ...(p.mapsUrl ? { mapsUrl: p.mapsUrl } : {}),
            ...(o.everyoneIn !== undefined ? { everyoneIn: o.everyoneIn } : {}),
          },
        ];
      })
    : [];
  const reservations = (result.reservations ?? []).map((x) => ({
    name: names[x.member] ?? "Someone",
    dim: DIM_LABEL[x.dim],
  }));

  const facts = (() => {
    if (!showPlan) return [];
    const [day, time] = when(result.proposal!.slot).split(" · ");
    return [
      { label: time ? "Date" : "Time", value: day },
      ...(time ? [{ label: "Time", value: time }] : []),
      { label: "Cost", value: `~$${r.pricePerPerson}/person` },
      ...(r.travelMin !== undefined ? [{ label: "Travel", value: `${r.travelMin} min away` }] : []),
      { label: "Kind", value: kindOf(r) },
    ];
  })();

  return (
    <div className="plan-hero-body">
      <div className="plan-hero-main">
        <div className="flex items-start justify-between gap-4">
          <div className={`plan-hero-verdict ${tone.text}`}>
            <span aria-hidden className="plan-hero-dot" />
            {headline}
          </div>
          {result.status === "agreed" && !stale && (
            <div
              className={`stamp pointer-events-none rounded-md border-2 px-2 py-0.5 font-mono text-[0.75rem] font-medium uppercase tracking-[0.18em] ${tone.stamp}`}
              aria-hidden
            >
              sealed
            </div>
          )}
        </div>
        {stale && (
          <p role="status" className="mt-3 max-w-2xl text-sm text-ink-2">
            {stale === "joined"
              ? "Someone joined after this was decided, so it does not count them yet."
              : "Someone's answers have changed since this was decided, so it may no longer fit."}{" "}
            Re-run it once everyone is done.
          </p>
        )}
        {showPlan ? (
          <>
            <div className="plan-hero-name">{r.name}</div>
            <dl className="plan-hero-facts">
              {facts.map((f) => (
                <div key={f.label}>
                  <dt>{f.label}</dt>
                  <dd>{f.value}</dd>
                </div>
              ))}
            </dl>
            {result.status === "partial" && (
              <p className="mt-4 max-w-2xl text-sm text-ink-2">
                This is the closest plan there is. A diet, a time or a place someone ruled out keeps{" "}
                {result.cannotCome === 1 ? "one person" : `${result.cannotCome} people`} from coming; no other place and
                time leaves out fewer.
              </p>
            )}
            {result.explanation && <p className="mt-4 max-w-2xl text-sm italic text-ink-2">{result.explanation}</p>}
            {(sample || tiles.length > 1) && (
              <p className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-3">
                {tiles.length > 1 && (
                  <span>
                    {result.status === "partial"
                      ? `Best fit of ${tiles.length} places that as many people can come to.`
                      : `Best fit of ${tiles.length} places that work for the group.`}
                  </span>
                )}
                {sample && <span className="text-amber-ink">Sample place, not a real restaurant.</span>}
              </p>
            )}
          </>
        ) : (
          <p className="plan-hero-none">
            {result.noPlan === "no_candidates"
              ? "None of the places found can take a start time on the plan's date. Try another date or location."
              : result.noPlan === "nobody_can_come"
                ? "Every place and time breaks a diet, a time or an exclusion for every person. Someone may need to loosen one. Try chatting with your assistant again, then re-run."
                : result.conflicts?.length
                  ? `The sticking point is ${result.conflicts.map((d) => DIM_LABEL[d]).join(", then ")}. Someone may need to loosen that, then re-run.`
                  : "Someone may need to loosen a constraint. Try chatting with your assistant again, then re-run."}
          </p>
        )}
        {reservations.length > 0 && (
          <ul className="mt-4 space-y-1 text-xs text-ink-2">
            {reservations.map((x, i) => (
              <li key={i} className="flex items-center gap-2">
                <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-amber" />
                {x.name} still has reservations about the {x.dim}.
              </li>
            ))}
          </ul>
        )}
        {result.concessionLevel > 0 && result.status !== "no_deal" && (
          <p className="mt-3 text-xs text-ink-3">
            Reached after {result.concessionLevel} concession step{result.concessionLevel === 1 ? "" : "s"}; nobody saw
            what anyone gave up.
          </p>
        )}
      </div>

      {/* What to do with the plan: one filled button, the rest outlined. */}
      <div className="plan-hero-actions">
        {actions}
        <PlanOptions tiles={tiles} sample={sample} />
        {rerun && <div className="mt-3">{rerun}</div>}
      </div>

      <div className="plan-hero-how">
        {byOptimizer ? (
          <details className="group text-xs text-ink-2">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-2 font-mono text-[0.75rem] uppercase tracking-wider text-ink-3 marker:hidden [&::-webkit-details-marker]:hidden">
              <span>
                How it was decided: {(result.optionsScored ?? 0).toLocaleString("en-US")} options, {result.participants}{" "}
                people, no model
              </span>
              <span aria-hidden className="transition-transform duration-300 group-open:rotate-180">
                ↓
              </span>
            </summary>
            <p className="mt-2 max-w-3xl text-ink-3">
              Every place and start time was scored by code against what each person told their own assistant. The plan
              is the one that leaves out the fewest people, and among those the one that suits the group best.
              Nobody&apos;s answers or scores are shown, here or to anyone in the group
              {outcomeOnly ? "." : "; the only number about people is how many can come."}
            </p>
          </details>
        ) : outcomeOnly ? (
          <div className="text-xs text-ink-2">
            <p className="font-mono text-[0.75rem] uppercase tracking-wider text-ink-3">
              {roundCount} round{roundCount === 1 ? "" : "s"}, {result.participants} people
            </p>
            <p className="mt-2 text-ink-3">
              With {result.participants === 2 ? "two" : "so few"} people, how the assistants got here stays hidden: any
              count would be one person&apos;s answer.
            </p>
          </div>
        ) : (
          <details className="group text-xs text-ink-2">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-2 font-mono text-[0.75rem] uppercase tracking-wider text-ink-3 marker:hidden [&::-webkit-details-marker]:hidden">
              <span>
                How they decided: {result.rounds.length} round{result.rounds.length === 1 ? "" : "s"}, {tried} options,{" "}
                {result.participants} people
              </span>
              <span aria-hidden className="transition-transform duration-300 group-open:rotate-180">
                ↓
              </span>
            </summary>

            <ol className="mt-3 space-y-3">
              {result.rounds.map((round) => (
                <li key={round.round}>
                  <div className="flex items-baseline justify-between font-mono text-[0.75rem] uppercase tracking-wider text-ink-3">
                    <span>Round {round.round}</span>
                    {round.level > 0 && <span className="text-amber-ink">concession step {round.level}</span>}
                  </div>
                  <ul className="mt-1.5 space-y-1.5">
                    {round.proposals.map((p) => {
                      const name = place(p.proposal.restaurantId)?.name ?? "?";
                      const why = describeDims(p.tally);
                      return (
                        <li
                          key={`${p.proposal.restaurantId}-${p.proposal.slot}`}
                          className="grid grid-cols-[1fr_4rem] items-center gap-3"
                        >
                          <span className="truncate" title={why || undefined}>
                            {p.retried && (
                              <span className="text-amber-ink" title="asked again after a concession step">
                                ↺{" "}
                              </span>
                            )}
                            <span className="text-ink">{name}</span>
                            <span className="text-ink-3"> · {when(p.proposal.slot)}</span>
                            {why && <span className="text-ink-3"> · {why}</span>}
                          </span>
                          <TallyBar tally={p.tally} people={result.participants} />
                        </li>
                      );
                    })}
                  </ul>
                </li>
              ))}
            </ol>

            {result.finalists?.length > 0 && (
              <div className="mt-4">
                <div className="font-mono text-[0.75rem] uppercase tracking-wider text-ink-3">
                  Final pick · group score relative to the pick
                </div>
                <ul className="mt-1.5 space-y-1">
                  {result.finalists.map((f) => {
                    const chosen =
                      result.proposal &&
                      f.proposal.restaurantId === result.proposal.restaurantId &&
                      f.proposal.slot === result.proposal.slot;
                    return (
                      <li
                        key={`${f.proposal.restaurantId}-${f.proposal.slot}`}
                        className="flex items-center justify-between gap-3"
                      >
                        <span className={chosen ? "text-ink" : "text-ink-2"}>
                          {chosen ? "★ " : ""}
                          {place(f.proposal.restaurantId)?.name ?? "?"} · {when(f.proposal.slot)}
                        </span>
                        <span className="flex items-center gap-2 font-mono text-[0.75rem] text-ink-3">
                          <span
                            className="text-ink"
                            aria-label={`${Math.round(f.relative * 100)}% of the pick's score`}
                          >
                            {chosen ? "pick" : `×${f.relative.toFixed(2)}`}
                          </span>
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}

            <p className="mt-3 text-ink-3">
              Only anonymous counts and dimension names are shown. For the final pick each assistant scores the
              finalists from 1 to 5 and sends the scores masked, so only how the finalists compare for the whole group
              can be read, never anyone&apos;s score.
              {typeof result.leakedDims === "number" &&
                ` The mediator saw ${result.leakedDims} dimension name${result.leakedDims === 1 ? "" : "s"} in total, and no numbers.`}
            </p>
          </details>
        )}
      </div>
    </div>
  );
}

/** A tiny tally: one segment per person, coloured by verdict. */
function TallyBar({ tally, people }: { tally: Tally; people: number }) {
  const segments = [
    ...Array.from({ length: tally.accept }, () => "bg-moss"),
    ...Array.from({ length: tally.reluctant }, () => "bg-amber"),
    ...Array.from({ length: tally.reject }, () => "bg-seal"),
  ];
  while (segments.length < people) segments.push("bg-line");
  return (
    <span
      className="flex gap-0.5"
      role="img"
      aria-label={`${tally.accept} accept, ${tally.reluctant} reluctant, ${tally.reject} reject`}
      title={`${tally.accept} accept · ${tally.reluctant} reluctant · ${tally.reject} reject`}
    >
      {segments.map((cls, i) => (
        <span key={i} className={`h-1.5 flex-1 rounded-full ${cls}`} />
      ))}
    </span>
  );
}
