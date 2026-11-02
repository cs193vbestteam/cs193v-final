import { SLOT_LABELS } from "@/lib/constraints";
import type { StoredResult } from "@/lib/events";
import { getRestaurant } from "@/lib/restaurants";

const REASON_LABEL: Record<string, string> = { time: "timing", price: "price", diet: "diet", distance: "distance", cuisine: "cuisine" };

export function ResultCard({ result }: { result: StoredResult }) {
  const r = result.proposal ? getRestaurant(result.proposal.restaurantId) : undefined;
  const headline =
    result.status === "agreed"
      ? "Everyone's in ✓"
      : result.status === "compromise"
        ? "Works for everyone (a stretch for some)"
        : "No plan works for everyone yet";
  const tone =
    result.status === "agreed" ? "border-emerald-200 bg-emerald-50" : result.status === "compromise" ? "border-amber-200 bg-amber-50" : "border-red-200 bg-red-50";
  const tried = result.rounds.reduce((n, round) => n + round.proposals.length, 0);

  return (
    <div className={`rounded-2xl border p-4 ${tone}`}>
      <div className="text-sm font-medium">{headline}</div>
      {r && result.proposal && result.status !== "no_option" && (
        <div className="mt-2">
          <div className="text-lg font-semibold">{r.name}</div>
          <div className="text-sm text-muted">
            {SLOT_LABELS[result.proposal.slot]} · ~${r.pricePerPerson}/person · {r.travelMin} min away · {r.cuisine}
          </div>
        </div>
      )}
      {result.status === "no_option" && (
        <p className="mt-1 text-sm text-muted">Someone may need to loosen a constraint. Try chatting with your assistant again.</p>
      )}
      <details className="mt-3 text-xs text-muted">
        <summary className="cursor-pointer">
          How they decided: {result.rounds.length} round{result.rounds.length === 1 ? "" : "s"}, {tried} options, {result.participants} people
        </summary>
        <ol className="mt-2 space-y-1">
          {result.rounds.map((round) => (
            <li key={round.round}>
              <span className="font-medium">Round {round.round}:</span>{" "}
              {round.proposals
                .map((p) => {
                  const name = getRestaurant(p.proposal.restaurantId)?.name ?? "?";
                  const reasons = Object.keys(p.tally.reasons).map((k) => REASON_LABEL[k] ?? k);
                  return `${name} (${SLOT_LABELS[p.proposal.slot]}): ${p.tally.yes}✓ ${p.tally.meh}~ ${p.tally.no}✗${reasons.length ? ` [${reasons.join(", ")}]` : ""}`;
                })
                .join(" · ")}
            </li>
          ))}
        </ol>
        <p className="mt-2 italic">Only anonymous counts are shown. Nobody's individual answers or numbers are revealed.</p>
      </details>
    </div>
  );
}
