import { SLOT_LABELS } from "@/lib/constraints";
import type { StoredResult } from "@/lib/events";
import type { Tally } from "@/lib/negotiate";
import { getRestaurant } from "@/lib/restaurants";

const REASON_LABEL: Record<string, string> = { time: "timing", price: "price", diet: "diet", distance: "distance", cuisine: "cuisine" };

export function ResultCard({ result }: { result: StoredResult }) {
  const r = result.proposal ? getRestaurant(result.proposal.restaurantId) : undefined;
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
        ? { border: "border-amber/40", text: "text-amber", stamp: "border-amber text-amber" }
        : { border: "border-seal/35", text: "text-seal", stamp: "border-seal text-seal" };
  const tried = result.rounds.reduce((n, round) => n + round.proposals.length, 0);
  const showPlan = r && result.proposal && result.status !== "no_option";

  return (
    <div className={`relative overflow-hidden rounded-2xl border bg-surface ${tone.border}`}>
      <div className="px-4 pt-4">
        <div className={`font-mono text-[0.6875rem] uppercase tracking-[0.14em] ${tone.text}`}>{headline}</div>
        {showPlan ? (
          <div className="mt-2">
            <div className="font-serif text-[1.75rem] leading-tight">{r.name}</div>
            <div className="mt-1 text-sm text-ink-2">
              {SLOT_LABELS[result.proposal!.slot]} · ~${r.pricePerPerson}/person · {r.travelMin} min away · {r.cuisine}
            </div>
          </div>
        ) : (
          <p className="mt-2 text-sm text-ink-2">
            Someone may need to loosen a constraint. Try chatting with your assistant again, then re-run.
          </p>
        )}
        {result.status === "agreed" && (
          <div
            className={`stamp pointer-events-none absolute right-3 top-3 rounded-md border-2 px-2 py-0.5 font-mono text-[0.625rem] font-medium uppercase tracking-[0.18em] ${tone.stamp}`}
            aria-hidden
          >
            sealed
          </div>
        )}
      </div>

      {/* Ticket perforation */}
      <div className="my-4 border-t border-dashed border-line-strong" />

      <details className="group px-4 pb-4 text-xs text-ink-2">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-2 font-mono text-[0.6875rem] uppercase tracking-wider text-ink-3 marker:hidden [&::-webkit-details-marker]:hidden">
          <span>
            How they decided: {result.rounds.length} round{result.rounds.length === 1 ? "" : "s"}, {tried} options, {result.participants} people
          </span>
          <span aria-hidden className="transition-transform duration-300 group-open:rotate-180">↓</span>
        </summary>
        <ol className="mt-3 space-y-3">
          {result.rounds.map((round) => (
            <li key={round.round}>
              <div className="font-mono text-[0.6875rem] uppercase tracking-wider text-ink-3">Round {round.round}</div>
              <ul className="mt-1.5 space-y-1.5">
                {round.proposals.map((p) => {
                  const name = getRestaurant(p.proposal.restaurantId)?.name ?? "?";
                  const reasons = Object.keys(p.tally.reasons).map((k) => REASON_LABEL[k] ?? k);
                  return (
                    <li key={`${p.proposal.restaurantId}-${p.proposal.slot}`} className="grid grid-cols-[1fr_4rem] items-center gap-3">
                      <span className="truncate">
                        <span className="text-ink">{name}</span>
                        <span className="text-ink-3"> · {SLOT_LABELS[p.proposal.slot]}</span>
                        {reasons.length > 0 && <span className="text-ink-3"> · {reasons.join(", ")}</span>}
                      </span>
                      <TallyBar tally={p.tally} people={result.participants} />
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ol>
        <p className="mt-3 text-ink-3">Only anonymous counts are shown. Nobody&apos;s individual answers or numbers are revealed.</p>
      </details>
    </div>
  );
}

/** A tiny tally: one segment per person, coloured by verdict. */
function TallyBar({ tally, people }: { tally: Tally; people: number }) {
  const segments = [
    ...Array.from({ length: tally.yes }, () => "bg-moss"),
    ...Array.from({ length: tally.meh }, () => "bg-amber"),
    ...Array.from({ length: tally.no }, () => "bg-seal"),
  ];
  while (segments.length < people) segments.push("bg-line");
  return (
    <span
      className="flex gap-0.5"
      role="img"
      aria-label={`${tally.yes} yes, ${tally.meh} meh, ${tally.no} no`}
      title={`${tally.yes}✓ ${tally.meh}~ ${tally.no}✗`}
    >
      {segments.map((cls, i) => (
        <span key={i} className={`h-1.5 flex-1 rounded-full ${cls}`} />
      ))}
    </span>
  );
}
