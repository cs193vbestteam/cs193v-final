import { SLOT_LABELS } from "@/lib/constraints";
import type { Dim, Proposal } from "@/lib/evaluate";
import { PlanOptions, type OptionTile } from "./PlanOptions";
import type { StoredResult } from "@/lib/events";
import type { Tally } from "@/lib/mediator";
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

export function ResultCard({ result, sample = false }: { result: StoredResult; sample?: boolean }) {
  const place = (id: string) => result.places?.[id] ?? getRestaurant(id);
  const r = result.proposal ? place(result.proposal.restaurantId) : undefined;
  const headline =
    result.status === "agreed"
      ? "Everyone's in"
      : result.status === "compromise"
        ? "Works for everyone, a stretch for some"
        : "No plan works for everyone yet";
  const tone =
    result.status === "agreed"
      ? { border: "border-moss/35", text: "text-moss", stamp: "border-moss text-moss" }
      : result.status === "compromise"
        ? { border: "border-amber/40", text: "text-amber-ink", stamp: "border-amber text-amber-ink" }
        : { border: "border-seal/35", text: "text-seal-ink", stamp: "border-seal text-seal-ink" };
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
            when: SLOT_LABELS[o.proposal.slot],
            cuisine: p.cuisine,
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

  return (
    <div className={`relative overflow-hidden rounded-2xl border bg-surface ${tone.border}`}>
      <div className="px-4 pt-4">
        <div className={`font-mono text-[0.75rem] uppercase tracking-[0.14em] ${tone.text}`}>{headline}</div>
        {showPlan ? (
          <div className="mt-2">
            <div className="font-serif text-[1.75rem] leading-tight">{r.name}</div>
            <div className="mt-1 text-sm text-ink-2">
              {SLOT_LABELS[result.proposal!.slot]} · ~${r.pricePerPerson}/person
              {r.travelMin !== undefined ? ` · ${r.travelMin} min away` : ""} · {r.cuisine}
            </div>
            {sample && <p className="mt-1 text-xs text-amber-ink">Sample place, not a real restaurant.</p>}
            {result.explanation && <p className="mt-2 text-sm italic text-ink-2">{result.explanation}</p>}
            {tiles.length > 1 && (
              <p className="mt-2 text-xs text-ink-3">Best fit of {tiles.length} places that work for the group.</p>
            )}
            <PlanOptions tiles={tiles} sample={sample} />
          </div>
        ) : (
          <p className="mt-2 text-sm text-ink-2">
            {result.conflicts?.length
              ? `The sticking point is ${result.conflicts.map((d) => DIM_LABEL[d]).join(", then ")}. Someone may need to loosen that, then re-run.`
              : "Someone may need to loosen a constraint. Try chatting with your assistant again, then re-run."}
          </p>
        )}
        {reservations.length > 0 && (
          <ul className="mt-3 space-y-1 text-xs text-ink-2">
            {reservations.map((x, i) => (
              <li key={i} className="flex items-center gap-2">
                <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-amber" />
                {x.name} still has reservations about the {x.dim}.
              </li>
            ))}
          </ul>
        )}
        {result.concessionLevel > 0 && result.status !== "no_deal" && (
          <p className="mt-2 text-xs text-ink-3">
            Reached after {result.concessionLevel} concession step{result.concessionLevel === 1 ? "" : "s"}; nobody saw
            what anyone gave up.
          </p>
        )}
        {result.status === "agreed" && (
          <div
            className={`stamp pointer-events-none absolute right-3 top-3 rounded-md border-2 px-2 py-0.5 font-mono text-[0.75rem] font-medium uppercase tracking-[0.18em] ${tone.stamp}`}
            aria-hidden
          >
            sealed
          </div>
        )}
      </div>

      <div className="my-4 border-t border-dashed border-line-strong" />

      {outcomeOnly ? (
        <div className="px-4 pb-4 text-xs text-ink-2">
          <p className="font-mono text-[0.75rem] uppercase tracking-wider text-ink-3">
            {roundCount} round{roundCount === 1 ? "" : "s"}, {result.participants} people
          </p>
          <p className="mt-2 text-ink-3">
            With {result.participants === 2 ? "two" : "so few"} people, how the assistants got here stays hidden: any
            count would be one person&apos;s answer.
          </p>
        </div>
      ) : (
        <details className="group px-4 pb-4 text-xs text-ink-2">
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
                          <span className="text-ink-3"> · {SLOT_LABELS[p.proposal.slot]}</span>
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
                        {place(f.proposal.restaurantId)?.name ?? "?"} · {SLOT_LABELS[f.proposal.slot]}
                      </span>
                      <span className="flex items-center gap-2 font-mono text-[0.75rem] text-ink-3">
                        <span className="text-ink" aria-label={`${Math.round(f.relative * 100)}% of the pick's score`}>
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
            Only anonymous counts and dimension names are shown. For the final pick each assistant scores the finalists
            from 1 to 5 and sends the scores masked, so only how the finalists compare for the whole group can be read,
            never anyone&apos;s score.
            {typeof result.leakedDims === "number" &&
              ` The mediator saw ${result.leakedDims} dimension name${result.leakedDims === 1 ? "" : "s"} in total, and no numbers.`}
          </p>
        </details>
      )}
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
